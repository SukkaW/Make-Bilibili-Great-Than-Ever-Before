/**
 * What is known about every CDN host, shared by every phase. Nothing here outlives the page.
 *
 * A TTFB is network time plus the edge's own time, and the edge's time depends on whether it has
 * the file cached; throughput too (a miss streams from an upper layer or the origin). Page JS
 * cannot split the two (no Timing-Allow-Origin, cache headers are not exposed), so nothing here
 * tries to, and no speed figure is taken for a property of the host alone:
 *
 * - host x file: what was measured. The truth when it exists.
 * - file baseline: the median over the hosts measured on the file. A cold file (an unpopular
 *   video, cached nowhere) raises it by itself, so unmeasured hosts are expected to be slow too.
 * - host factor, within one video: this host / the other hosts, on the same files. All of a
 *   video's representations share its popularity, so it carries from one file of the video to the
 *   others, but not to the next video, where the caches differ: that one starts neutral, and the
 *   warm-up measures it within moments.
 *
 * An expectation for a host and a file is the measurement, else the file baseline x the host
 * factor, else the video's baseline x the host factor.
 *
 * Reliability (cooldowns, signature families a host refuses, files it lacks, dead addresses) is
 * per page. A failure may be the viewer's network rather than the host: several hosts failing at
 * once while nothing arrives anywhere is an outage, and blames no host.
 */

import { clamp } from 'foxts/clamp';
import flru from 'flru';
import { p50 } from 'fast-percentile';
import { logger } from '../../logger';
import type { SignatureFamily } from './cdn-classify';
import type { MediaFile, MediaKind } from './registry';
import { WindowStats, WorseWhen } from './window-stats';

/** How a media request ended, from the point of view of its host, address and file */
export enum MediaOutcome {
  /** Validated 206, complete */
  Ok = 'ok',
  /** Aborted by us: race lost, piece done elsewhere, job over */
  Canceled = 'canceled',
  /** Validated 206, but the body ended early */
  Truncated = 'truncated',
  /** Validated 206, then the connection broke */
  Reset = 'reset',
  BadRange = 'bad-range',
  /** The file's total size differs from what other hosts said: another version of the file */
  StaleObject = 'stale-object',
  /** The request reaches past the end of the file */
  EofClamp = 'eof-clamp',
  /** 206 without a readable Content-Range */
  Unverifiable = 'unverifiable',
  /** 200: Range ignored */
  NoRange = 'no-range',
  /** Redirected off to a P2P CDN */
  Redirect = 'redirect',
  /** 401 / 403 with a signature past its deadline */
  Expired = 'expired',
  /** 401 / 403 */
  Refused = 'refused',
  /** 404 / 410 */
  Missing = 'missing',
  /** 412 / 429 */
  Throttled = 'throttled',
  /** 503 */
  Overloaded = 'overloaded',
  ServerError = 'server-error',
  /** TypeError before any header, fast: DNS / TLS / CORS */
  ConnectFail = 'connect-fail',
  /** TypeError before any header */
  Network = 'network',
  TtfbTimeout = 'ttfb-timeout',
  Stall = 'stall',
  /** Two hosts sent different bytes for the same range */
  Integrity = 'integrity'
}

/** What one finished media request says about its host's speed */
export interface MediaSample {
  readonly hostname: string,
  readonly file: MediaFile,
  /** The request opened a new connection (the host was idle) */
  readonly cold: boolean,
  /** Headers minus start, ms */
  readonly ttfb: number | null,
  /** Timed out without headers after this long: the true TTFB is at least that */
  readonly censoredTtfb?: number,
  /** Bytes per ms after the first chunk */
  readonly rate: number | null,
  /** Weight of the rate sample: less for transfers cut short */
  readonly rateWeight?: number,
  /** 90th percentile gap between chunks, ms */
  readonly gap: number | null
}

/** The signed address a request used */
export interface MediaAddressRef {
  /** pathname + search: identifies the signature, whatever the host */
  readonly key: string,
  /** Which hosts can verify the signature */
  readonly family: SignatureFamily
}

/** What a request of `bytes` to a host is expected to take, for this file */
export interface HostEstimate {
  /** Expected time to first byte, connection setup included when cold */
  ttfb: number,
  /** Expected bytes per ms of one request */
  rate: number,
  /** Expected ms to receive `bytes` */
  eta: number,
  /** This host's throughput is known (not just a first byte) */
  measured: boolean
}

/**
 * Per host and file, in ms, before the job's urgency scales them. Soft thresholds start a duplicate
 * on another host while the request keeps running; hard ones abort it, but only when something else
 * can carry its bytes.
 */
export interface HostTimeouts {
  /** No first byte after this long: start a duplicate elsewhere */
  ttfbSoft: number,
  /** No first byte after this long: give up on the request */
  ttfbHard: number,
  /** No new byte after this long, once bytes have flowed: start a duplicate elsewhere */
  stallSoft: number,
  /** No new byte after this long: give up on the request */
  stallHard: number
}

/** Per host, within one video: how it compares with the other hosts on that video's files */
interface HostStats {
  /** This host's TTFB / the other hosts' TTFB on the same file, over open connections */
  readonly ttfbFactor: WindowStats,
  /** This host's throughput / the other hosts' throughput on the same file */
  readonly rateFactor: WindowStats,
  /** Bytes per ms of one request, whichever of the video's files */
  readonly rate: WindowStats,
  /** 90th percentile gap between chunks of a request, ms: the base of the stall thresholds */
  readonly gap: WindowStats
}

/** Host x file */
interface ObjectStats {
  /** Time to first byte over an open connection, ms */
  readonly ttfb: WindowStats,
  /** Bytes per ms of one request for this file */
  readonly rate: WindowStats
}

/**
 * One video: all its representations share its popularity, so how the hosts compare on one of its
 * files says something about the others. Nothing carries over to the next video.
 */
interface VideoStats {
  /** hostname -> kind -> stats */
  readonly hosts: Map<string, Record<MediaKind, HostStats>>,
  /** Every TTFB over an open connection on the video's files, ms: before a file has a baseline */
  readonly ttfb: Record<MediaKind, WindowStats>,
  /** Every request's bytes per ms on the video's files */
  readonly rate: Record<MediaKind, WindowStats>
}

/** How the expectations fare on this page, per media kind */
interface PageStats {
  /** Measured TTFB / expected TTFB: how far reality overshoots the expectation, for the timeouts */
  readonly overshoot: WindowStats,
  /** TTFB on a new connection / the TTFB expected over an open one: the connection setup cost */
  readonly coldRatio: WindowStats
}

/** Everything known about one host's reliability, for this page. Times are performance.now() ms */
interface HostRecord {
  readonly hostname: string,
  /** Last request that ended: after `WARM_CONNECTION_MS` idle, the connection is assumed closed */
  lastUsedAt: number,
  /** No new requests to the host until then */
  cooldownUntil: number,
  /** Consecutive failures (5xx, network, timeout): grows the backoff; reset by a success */
  failureStreak: number,
  /** Consecutive 412 / 429 / 503: grows their backoff; reset by a success 10 s after the last one */
  throttleStreak: number,
  lastThrottleAt: number,
  /** Key of the last signed address this host served: tried first on it */
  provenAddress: string | null,
  /** Signature families this host has served */
  readonly acceptedFamilies: Set<SignatureFamily>,
  /** Signature families this host refuses (Akamai with upos signatures), until */
  readonly refusedFamilies: Map<SignatureFamily, number>,
  /** Recent unexplained 401 / 403: two within 60 s count as a family refusal */
  refusedStrikes: number[]
}

/** A failure that might be ours, not the host's: what to restore if it was */
interface RecentFailure {
  readonly at: number,
  readonly host: HostRecord,
  readonly cooldownUntil: number,
  readonly failureStreak: number
}

/** What an expected TTFB rests on: only a measured one is worth learning from */
type Basis = 'object' | 'file' | 'video' | 'prior';

const KiB = 1024;
/** What a request is assumed to deliver before anything is measured */
const PRIOR_RATE = 768 * KiB / 1000;
const PRIOR_TTFB = 350;
/** How far TTFBs overshoot the expected one (p75, p90), before that is measured */
const PRIOR_OVERSHOOT_P75 = 1.3;
const PRIOR_OVERSHOOT_P90 = 1.8;
/** TCP + TLS 1.3 take about two more round trips than a request over an open connection */
const PRIOR_COLD_RATIO = 2;
/** Speed samples from shorter transfers are mostly round trip */
export const MIN_RATE_SAMPLE_BYTES = 48 * KiB;
/** A host factor outside this range is noise */
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5;
/** A connection idle for longer is probably closed */
const WARM_CONNECTION_MS = 30 * 1000;
const SESSION = Infinity;
/** Connection level failures from this many hosts within `OUTAGE_WINDOW_MS`, no byte anywhere: ours */
const OUTAGE_HOSTS = 2;
const OUTAGE_WINDOW_MS = 3000;

/** Failures that the viewer's own network going away produces on every host at once */
const CONNECTION_FAILURES = new Set<MediaOutcome>([
  MediaOutcome.ConnectFail,
  MediaOutcome.Network,
  MediaOutcome.TtfbTimeout,
  MediaOutcome.Stall,
  MediaOutcome.Truncated,
  MediaOutcome.Reset
]);

const hosts = new Map<string, HostRecord>();
/** file key -> hostname -> stats */
const objects = flru<Map<string, ObjectStats>>(128);
/** video key -> stats */
const videos = flru<VideoStats>(16);
/** file key -> hostname -> excluded until */
const exclusions = flru<Map<string, number>>(256);
/** Signed addresses (pathname + search), each new playinfo brings new ones: bounded */
const bannedAddresses = flru<true>(512);
/** Addresses some host has served */
const acceptedAddresses = flru<true>(1024);
const page: Record<MediaKind, PageStats> = { video: createPageStats(), audio: createPageStats() };
/** The video of the latest sample, for the debug snapshot */
let currentVideo: string | null = null;

/** Connection level failures of the last `OUTAGE_WINDOW_MS` */
let recentFailures: RecentFailure[] = [];
/** Last time bytes arrived from any host, native request or ours */
let lastBytesAt = -Infinity;
/** The viewer's network is down since then: failures are not the hosts' fault */
let outageSince: number | null = null;

function get(hostname: string): HostRecord {
  let host = hosts.get(hostname);
  if (host === undefined) {
    host = {
      hostname,
      // Never: `performance.now()` starts near 0, where `0` would read as "just now"
      lastUsedAt: -Infinity,
      cooldownUntil: 0,
      failureStreak: 0,
      throttleStreak: 0,
      lastThrottleAt: -Infinity,
      provenAddress: null,
      acceptedFamilies: new Set(),
      refusedFamilies: new Map(),
      refusedStrikes: []
    };
    hosts.set(hostname, host);
  }
  return host;
}

function objectStats(hostname: string, file: MediaFile, create: true): ObjectStats;
function objectStats(hostname: string, file: MediaFile, create: false): ObjectStats | undefined;
function objectStats(hostname: string, file: MediaFile, create: boolean): ObjectStats | undefined {
  let byHost = objects.get(file.key);
  if (byHost === undefined) {
    if (!create) return undefined;
    byHost = new Map();
    objects.set(file.key, byHost);
  }
  let stats = byHost.get(hostname);
  if (stats === undefined && create) {
    stats = { ttfb: new WindowStats(WorseWhen.Higher, 8), rate: new WindowStats(WorseWhen.Lower, 8) };
    byHost.set(hostname, stats);
  }
  return stats;
}

function videoStats(file: MediaFile, create: true): VideoStats;
function videoStats(file: MediaFile, create: false): VideoStats | undefined;
function videoStats(file: MediaFile, create: boolean): VideoStats | undefined {
  let stats = videos.get(file.videoKey);
  if (stats === undefined && create) {
    stats = {
      hosts: new Map(),
      ttfb: { video: createVideoWindow(WorseWhen.Higher), audio: createVideoWindow(WorseWhen.Higher) },
      rate: { video: createVideoWindow(WorseWhen.Lower), audio: createVideoWindow(WorseWhen.Lower) }
    };
    videos.set(file.videoKey, stats);
  }
  return stats;
}

/** This host within the file's video, `undefined` when it has not served any of it */
function hostStats(host: HostRecord, file: MediaFile, create: true): Record<MediaKind, HostStats>;
function hostStats(host: HostRecord, file: MediaFile, create: false): Record<MediaKind, HostStats> | undefined;
function hostStats(host: HostRecord, file: MediaFile, create: boolean): Record<MediaKind, HostStats> | undefined {
  const video = create ? videoStats(file, true) : videoStats(file, false);
  if (video === undefined) {
    return undefined;
  }
  let stats = video.hosts.get(host.hostname);
  if (stats === undefined && create) {
    stats = { video: createHostStats(), audio: createHostStats() };
    video.hosts.set(host.hostname, stats);
  }
  return stats;
}

/** Median over the hosts measured on the file, `except` left out */
function fileBaseline(file: MediaFile, now: number, except: string | null) {
  const ttfbs: number[] = [];
  const rates: number[] = [];
  const byHost = objects.get(file.key);
  if (byHost !== undefined) {
    for (const [hostname, stats] of byHost) {
      if (hostname === except) continue;
      const ttfb = stats.ttfb.estimate(now);
      if (ttfb !== null) ttfbs.push(ttfb);
      const rate = stats.rate.estimate(now);
      if (rate !== null) rates.push(rate);
    }
  }
  return { ttfb: median(ttfbs), rate: median(rates) };
}

function ttfbFactor(host: HostRecord, file: MediaFile, now: number) {
  const stats = hostStats(host, file, false);
  return stats?.[file.kind].ttfbFactor.estimate(now) ?? stats?.[otherKind(file.kind)].ttfbFactor.estimate(now) ?? null;
}

function rateFactor(host: HostRecord, file: MediaFile, now: number) {
  const stats = hostStats(host, file, false);
  return stats?.[file.kind].rateFactor.estimate(now) ?? stats?.[otherKind(file.kind)].rateFactor.estimate(now) ?? null;
}

function hostRate(host: HostRecord, file: MediaFile, now: number) {
  return hostStats(host, file, false)?.[file.kind].rate.estimate(now) ?? null;
}

/**
 * A request over an open connection: what it is expected to take, and what the TTFB expectation
 * rests on. The measurement, else the file's baseline times the host factor, else the video's.
 */
function expect(host: HostRecord, file: MediaFile, now: number): { ttfb: number, rate: number, basis: Basis } {
  const stats = objectStats(host.hostname, file, false);
  const objectTtfb = stats?.ttfb.estimate(now) ?? null;
  const objectRate = stats?.rate.estimate(now) ?? null;
  if (objectTtfb !== null && objectRate !== null) {
    return { ttfb: objectTtfb, rate: objectRate, basis: 'object' };
  }

  const base = fileBaseline(file, now, host.hostname);
  const video = videoStats(file, false);
  const videoTtfb = video?.ttfb[file.kind].estimate(now) ?? null;

  let basis: Basis = 'prior';
  if (objectTtfb !== null) basis = 'object';
  else if (base.ttfb !== null) basis = 'file';
  else if (videoTtfb !== null) basis = 'video';

  const factor = rateFactor(host, file, now) ?? 1;
  let rate = objectRate;
  if (rate === null && base.rate !== null) rate = base.rate * factor;
  rate ??= hostRate(host, file, now) ?? (video?.rate[file.kind].estimate(now) ?? PRIOR_RATE) * factor;

  return {
    ttfb: objectTtfb ?? (base.ttfb ?? videoTtfb ?? PRIOR_TTFB) * (ttfbFactor(host, file, now) ?? 1),
    rate,
    basis
  };
}

/**
 * This host's throughput on this video is known. A first byte alone (the warm-up's small
 * requests) says nothing about how a host keeps delivering
 */
function isMeasured(host: HostRecord, file: MediaFile, now: number) {
  return (objectStats(host.hostname, file, false)?.rate.estimate(now) ?? null) !== null
    || rateFactor(host, file, now) !== null
    || hostRate(host, file, now) !== null;
}

function coldRatio(kind: MediaKind, now: number) {
  return Math.max(1, page[kind].coldRatio.estimate(now) ?? PRIOR_COLD_RATIO);
}

function isColdConnection(host: HostRecord, now: number) {
  return now - host.lastUsedAt > WARM_CONNECTION_MS;
}

function cooldown(host: HostRecord, now: number, ms: number) {
  host.cooldownUntil = Math.max(host.cooldownUntil, now + ms);
}

function exclude(hostname: string, file: MediaFile, until: number) {
  let byHost = exclusions.get(file.key);
  if (byHost === undefined) {
    byHost = new Map();
    exclusions.set(file.key, byHost);
  }
  byHost.set(hostname, until);
}

export function estimate(hostname: string, file: MediaFile, bytes: number, now: number): HostEstimate {
  const host = get(hostname);
  const expected = expect(host, file, now);
  const ttfb = isColdConnection(host, now) ? expected.ttfb * coldRatio(file.kind, now) : expected.ttfb;
  return {
    ttfb,
    rate: expected.rate,
    eta: ttfb + bytes / expected.rate,
    measured: isMeasured(host, file, now)
  };
}

/** Bytes arrived from some host: the network works */
export function noteBytes(now: number) {
  lastBytesAt = Math.max(lastBytesAt, now);
  if (outageSince !== null) {
    logger.info(`[player-interceptor] the network is back after ${Math.round((now - outageSince) / 1000)} s`);
    outageSince = null;
  }
}

/**
 * Several hosts failing together while no byte arrives from anywhere is the viewer's network, not
 * the hosts: the penalties of those failures are taken back. One host failing while others
 * deliver stays that host's fault.
 */
function checkOutage(now: number) {
  recentFailures = recentFailures.filter(failure => now - failure.at <= OUTAGE_WINDOW_MS);
  const since = recentFailures.length === 0 ? now : recentFailures[0].at;
  if (lastBytesAt >= since) {
    return;
  }
  const failedHosts = new Set<HostRecord>();
  for (let i = 0, len = recentFailures.length; i < len; i++) {
    failedHosts.add(recentFailures[i].host);
  }
  if (failedHosts.size < OUTAGE_HOSTS) {
    return;
  }
  // The oldest record per host holds what it was before the outage
  for (let i = recentFailures.length - 1; i >= 0; i--) {
    const { host, cooldownUntil, failureStreak } = recentFailures[i];
    host.cooldownUntil = cooldownUntil;
    host.failureStreak = failureStreak;
  }
  recentFailures = [];
  outageSince = since;
  logger.warn(`[player-interceptor] ${failedHosts.size} CDN hosts failed at once with nothing arriving: the network is down, not the hosts`);
}

export function isCold(hostname: string, now: number) {
  return isColdConnection(get(hostname), now);
}

export function isCoolingDown(hostname: string, now: number) {
  return get(hostname).cooldownUntil > now;
}

export function isExcluded(hostname: string, file: MediaFile, now: number) {
  const until = exclusions.get(file.key)?.get(hostname);
  return until !== undefined && until > now;
}

export function isFamilyRefused(hostname: string, family: SignatureFamily, now: number) {
  const until = get(hostname).refusedFamilies.get(family);
  return until !== undefined && until > now;
}

export function acceptsFamily(hostname: string, family: SignatureFamily) {
  return get(hostname).acceptedFamilies.has(family);
}

export function isAddressBanned(key: string) {
  return bannedAddresses.has(key);
}

export function provenAddress(hostname: string) {
  return get(hostname).provenAddress;
}

/** Per host and file: when to help a request (soft) and when to give up on it (hard) */
export function timeouts(hostname: string, file: MediaFile, now: number): HostTimeouts {
  const host = get(hostname);
  const stats = objectStats(hostname, file, false);
  const expected = expect(host, file, now);
  const { overshoot } = page[file.kind];

  let ttfbSoft = 600;
  let ttfbHard = 2400;
  if (expected.basis !== 'prior') {
    const p75 = stats?.ttfb.quantile(0.75, now) ?? expected.ttfb * Math.max(1, overshoot.quantile(0.75, now) ?? PRIOR_OVERSHOOT_P75);
    const p90 = stats?.ttfb.quantile(0.9, now) ?? expected.ttfb * Math.max(1, overshoot.quantile(0.9, now) ?? PRIOR_OVERSHOOT_P90);
    ttfbSoft = clamp(1.5 * p75 + 50, 200, 1200);
    ttfbHard = clamp(3 * p90, 1000, 3000);
  }
  if (isColdConnection(host, now)) {
    const allowance = Math.min(1500, expected.ttfb * (coldRatio(file.kind, now) - 1));
    ttfbSoft += allowance;
    ttfbHard += allowance;
  }

  const gap = hostStats(host, file, false)?.[file.kind].gap.quantile(0.9, now) ?? null;
  const stallSoft = gap === null ? 600 : clamp(4 * gap, 300, 1000);
  return { ttfbSoft, ttfbHard, stallSoft, stallHard: 2 * stallSoft };
}

/** What one request gets through on this file: its baseline, else its video's */
export function typicalRate(file: MediaFile, now: number) {
  return fileBaseline(file, now, null).rate ?? videoStats(file, false)?.rate[file.kind].estimate(now) ?? PRIOR_RATE;
}

/** How long a request on this file waits for its first byte: its baseline, else its video's */
export function typicalTtfb(file: MediaFile, now: number) {
  return fileBaseline(file, now, null).ttfb ?? videoStats(file, false)?.ttfb[file.kind].estimate(now) ?? PRIOR_TTFB;
}

export function recordSample(sample: MediaSample, now: number) {
  const host = get(sample.hostname);
  host.lastUsedAt = Math.max(host.lastUsedAt, now);
  const { kind } = sample.file;
  const conditions = page[kind];
  // Before the sample joins them: what it was expected to be, and what the other hosts got
  const expected = expect(host, sample.file, now);
  const others = fileBaseline(sample.file, now, sample.hostname);
  const stats = objectStats(sample.hostname, sample.file, true);
  const video = videoStats(sample.file, true);
  const own = hostStats(host, sample.file, true)[kind];
  currentVideo = sample.file.videoKey;

  const ttfb = sample.ttfb ?? sample.censoredTtfb ?? null;
  if (ttfb !== null) {
    if (sample.cold) {
      // Connection setup on top of the request: kept out of the TTFB figures
      if (expected.basis !== 'prior') {
        conditions.coldRatio.add(clamp(ttfb / expected.ttfb, 0.5, 10), now);
      }
    } else {
      if (expected.basis !== 'prior') {
        conditions.overshoot.add(clamp(ttfb / expected.ttfb, 0.1, 10), now);
      }
      if (others.ttfb !== null) {
        own.ttfbFactor.add(clamp(ttfb / others.ttfb, MIN_FACTOR, MAX_FACTOR), now);
      }
      stats.ttfb.add(ttfb, now);
      video.ttfb[kind].add(ttfb, now);
    }
  }
  if (sample.rate !== null && sample.rate > 0) {
    const weight = sample.rateWeight ?? 1;
    if (others.rate !== null) {
      own.rateFactor.add(clamp(sample.rate / others.rate, MIN_FACTOR, MAX_FACTOR), now, weight);
    }
    stats.rate.add(sample.rate, now, weight);
    own.rate.add(sample.rate, now, weight);
    video.rate[kind].add(sample.rate, now, weight);
  }
  if (sample.gap !== null) {
    own.gap.add(sample.gap, now);
  }
}

/**
 * @param alive other requests to the host are delivering right now: a connection-level failure
 * is then one bad connection, and the host stays available for the retry
 */
export function recordOutcome(hostname: string, file: MediaFile, address: MediaAddressRef | null, outcome: MediaOutcome, now: number, alive = false) {
  const host = get(hostname);
  host.lastUsedAt = Math.max(host.lastUsedAt, now);

  const connectionFailure = CONNECTION_FAILURES.has(outcome);
  if (connectionFailure) {
    if (outageSince !== null || alive) {
      // The viewer's network is down, or just this connection: not this host's fault
      return;
    }
    recentFailures.push({ at: now, host, cooldownUntil: host.cooldownUntil, failureStreak: host.failureStreak });
  }

  switch (outcome) {
    case MediaOutcome.Ok: {
      noteBytes(now);
      host.failureStreak = 0;
      if (address !== null) {
        host.acceptedFamilies.add(address.family);
        host.refusedFamilies.delete(address.family);
        host.provenAddress = address.key;
        acceptedAddresses.set(address.key, true);
      }
      if (now - host.lastThrottleAt > 10 * 1000) {
        host.throttleStreak = 0;
      }
      break;
    }
    case MediaOutcome.Canceled:
    case MediaOutcome.EofClamp:
      break;
    case MediaOutcome.Truncated:
    case MediaOutcome.Reset:
    case MediaOutcome.Stall:
      host.failureStreak++;
      cooldown(host, now, 500);
      break;
    case MediaOutcome.TtfbTimeout:
      host.failureStreak++;
      cooldown(host, now, 2000);
      break;
    case MediaOutcome.BadRange:
    case MediaOutcome.StaleObject:
    case MediaOutcome.NoRange:
    case MediaOutcome.Unverifiable:
    case MediaOutcome.Redirect:
    case MediaOutcome.Missing:
    case MediaOutcome.Integrity:
      exclude(hostname, file, SESSION);
      break;
    case MediaOutcome.Expired:
      if (address !== null) bannedAddresses.set(address.key, true);
      break;
    case MediaOutcome.Refused: {
      if (address === null) {
        exclude(hostname, file, now + 60 * 1000);
      } else if (host.acceptedFamilies.has(address.family)) {
        // The host works: this address is the problem
        bannedAddresses.set(address.key, true);
      } else if (acceptedAddresses.has(address.key)) {
        // The address works elsewhere: this host refuses the whole signature family (Akamai)
        host.refusedFamilies.set(address.family, now + 30 * 60 * 1000);
      } else {
        exclude(hostname, file, now + 60 * 1000);
        host.refusedStrikes = host.refusedStrikes.filter(at => now - at < 60 * 1000);
        host.refusedStrikes.push(now);
        if (host.refusedStrikes.length >= 2) {
          host.refusedFamilies.set(address.family, now + 10 * 60 * 1000);
        }
      }
      break;
    }
    case MediaOutcome.Throttled:
    case MediaOutcome.Overloaded: {
      host.throttleStreak++;
      host.lastThrottleAt = now;
      const base = outcome === MediaOutcome.Throttled ? 3000 : 1500;
      cooldown(host, now, base * (2 ** Math.min(host.throttleStreak - 1, 3)));
      break;
    }
    case MediaOutcome.ServerError:
    case MediaOutcome.Network:
      host.failureStreak++;
      cooldown(host, now, Math.min(30 * 1000, 1000 * (2 ** Math.min(host.failureStreak - 1, 5))));
      break;
    case MediaOutcome.ConnectFail:
      host.failureStreak++;
      cooldown(host, now, Math.min(5 * 60 * 1000, 60 * 1000 * (2 ** Math.min(host.failureStreak - 1, 2))));
      break;
    default:
      break;
  }
  if (connectionFailure) {
    checkOutage(now);
  }
}

export function snapshot(now: number) {
  const video = currentVideo === null ? undefined : videos.get(currentVideo);
  return Array.from(hosts.values(), (host) => {
    const stats = video?.hosts.get(host.hostname)?.video;
    const ttfb = stats?.ttfbFactor.estimate(now) ?? null;
    const rate = stats?.rateFactor.estimate(now) ?? null;
    const abs = stats?.rate.estimate(now) ?? null;
    return {
      hostname: host.hostname,
      ttfbVsPeers: ttfb === null ? null : Math.round(ttfb * 100) / 100,
      rateVsPeers: rate === null ? null : Math.round(rate * 100) / 100,
      rateKiBps: abs === null ? null : Math.round(abs * 1000 / KiB),
      samples: stats?.rate.count(now) ?? 0,
      coolingDownMs: Math.max(0, Math.round(host.cooldownUntil - now)),
      acceptedFamilies: Array.from(host.acceptedFamilies),
      refusedFamilies: Array.from(host.refusedFamilies.keys()).filter(family => (host.refusedFamilies.get(family) ?? 0) > now)
    };
  });
}

/** The current video's baseline, how the expectations fare, and whether the network is down */
export function pageSnapshot(kind: MediaKind, now: number) {
  const video = currentVideo === null ? undefined : videos.get(currentVideo);
  const videoRate = video?.rate[kind].estimate(now) ?? null;
  const { overshoot } = page[kind];
  return {
    outage: outageSince !== null,
    video: currentVideo,
    videoTtfbMs: video?.ttfb[kind].estimate(now) ?? null,
    videoRateKiBps: videoRate === null ? null : Math.round(videoRate * 1000 / KiB),
    overshootP75: overshoot.quantile(0.75, now),
    overshootP90: overshoot.quantile(0.9, now),
    coldRatio: coldRatio(kind, now)
  };
}

/** One file: its baseline, and per host what it got and how that compares with the others */
export function fileSnapshot(file: MediaFile, now: number) {
  const baseline = fileBaseline(file, now, null);
  const perHost: Array<{ hostname: string, ttfbMs: number | null, ttfbVsOthers: number | null, rateKiBps: number | null }> = [];
  const byHost = objects.get(file.key);
  if (byHost !== undefined) {
    for (const [hostname, stats] of byHost) {
      const ttfb = stats.ttfb.estimate(now);
      const rate = stats.rate.estimate(now);
      const others = fileBaseline(file, now, hostname).ttfb;
      perHost.push({
        hostname,
        ttfbMs: ttfb === null ? null : Math.round(ttfb),
        ttfbVsOthers: ttfb === null || others === null ? null : Math.round(ttfb / others * 100) / 100,
        rateKiBps: rate === null ? null : Math.round(rate * 1000 / KiB)
      });
    }
  }
  return {
    ttfbMs: baseline.ttfb === null ? null : Math.round(baseline.ttfb),
    rateKiBps: baseline.rate === null ? null : Math.round(baseline.rate * 1000 / KiB),
    perHost
  };
}

function createHostStats(): HostStats {
  return {
    ttfbFactor: new WindowStats(WorseWhen.Higher, 32, 10 * 60 * 1000, 3 * 60 * 1000),
    rateFactor: new WindowStats(WorseWhen.Lower, 32, 10 * 60 * 1000, 3 * 60 * 1000),
    rate: new WindowStats(WorseWhen.Lower, 32, 10 * 60 * 1000, 3 * 60 * 1000),
    gap: new WindowStats(WorseWhen.Higher, 32, 10 * 60 * 1000, 3 * 60 * 1000)
  };
}

function createVideoWindow(worse: WorseWhen) {
  return new WindowStats(worse, 48, 2 * 60 * 1000, 45 * 1000);
}

function createPageStats(): PageStats {
  return {
    overshoot: new WindowStats(WorseWhen.Higher, 48, 5 * 60 * 1000, 2 * 60 * 1000),
    coldRatio: new WindowStats(WorseWhen.Higher, 24, 10 * 60 * 1000, 3 * 60 * 1000)
  };
}

/**
 * The middle value, the mean of the two middle ones for an even count: a baseline over a handful
 * of hosts must not be just the fastest of two
 */
function median(values: number[]) {
  const len = values.length;
  if (len === 0) {
    return null;
  }
  const lower = p50(values);
  if (len % 2 === 1) {
    return lower;
  }
  // The upper middle value: `lower` again if it fills the middle, else the next larger one
  let atMost = 0;
  let upper = Infinity;
  for (let i = 0; i < len; i++) {
    if (values[i] <= lower) {
      atMost++;
    } else if (values[i] < upper) {
      upper = values[i];
    }
  }
  return atMost > len / 2 ? lower : (lower + upper) / 2;
}

function otherKind(kind: MediaKind): MediaKind {
  return kind === 'video' ? 'audio' : 'video';
}
