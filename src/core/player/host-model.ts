/**
 * What is known about every CDN host, for this page only.
 *
 * - Speed: per host and video, its recent first-byte times, transfer rates and chunk gaps. An
 *   edge's speed depends on whether it has the video cached, so the next video starts unmeasured.
 * - Reliability: cooldowns, files a host lacks, signature families it refuses, dead addresses.
 */

import flru from 'flru';
import { p50 } from 'fast-percentile';
import type { SignatureFamily } from './cdn-classify';
import type { MediaFile } from './registry';

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
  /** 412 / 429 / 503 */
  Throttled = 'throttled',
  ServerError = 'server-error',
  /** TypeError before any header, fast: DNS / TLS / CORS */
  ConnectFail = 'connect-fail',
  /** TypeError before any header */
  Network = 'network',
  Stall = 'stall',
  /** Two hosts sent different bytes for the same range */
  Integrity = 'integrity'
}

/** What a request of `bytes` to a host is expected to take */
export interface HostEstimate {
  /** ms */
  ttfb: number,
  /** Bytes per ms of one request */
  rate: number,
  /** Expected ms to receive `bytes` */
  eta: number,
  /** This host's throughput on this video is known */
  measured: boolean,
  /** Usual gap between the chunks of a request, ms, `null` if unknown */
  gap: number | null
}

/** The last `SAMPLES` of one host on one video, newest last */
interface Speed {
  /** ms */
  readonly ttfb: number[],
  /** Bytes per ms of one request */
  readonly rate: number[],
  /** 90th percentile gap between the chunks of a request, ms */
  readonly gap: number[]
}

/** One host's reliability. Times are performance.now() ms */
interface HostRecord {
  /** Last request that ended: idle for `WARM_MS`, its connection is assumed closed */
  lastUsedAt: number,
  /** No new requests to the host until then */
  cooldownUntil: number,
  /** Consecutive failures: grows the backoff, reset by a success */
  failureStreak: number,
  /** Key of the last signed address this host served: tried first on it */
  provenAddress: string | null,
  readonly acceptedFamilies: Set<SignatureFamily>,
  /** Signature families this host refuses (Akamai with upos signatures), until */
  readonly refusedFamilies: Map<SignatureFamily, number>
}

const KiB = 1024;
/** What a request is assumed to deliver before anything is measured */
const PRIOR_RATE = 768 * KiB / 1000;
const PRIOR_TTFB = 350;
const SAMPLES = 8;
/** A connection idle for longer is probably closed: a new one costs about another first byte */
const WARM_MS = 30 * 1000;
/** Nothing arrived from any host for this long: failures are the viewer's network, not the hosts */
const NETWORK_DOWN_MS = 3000;
/** Failures that the viewer's own network going away produces on every host at once */
const CONNECTION_FAILURES = new Set<MediaOutcome>([
  MediaOutcome.ConnectFail,
  MediaOutcome.Network,
  MediaOutcome.Stall,
  MediaOutcome.Truncated,
  MediaOutcome.Reset
]);

const hosts = new Map<string, HostRecord>();
/** video key -> hostname -> speed */
const speeds = flru<Map<string, Speed>>(32);
/** file key -> hostname -> excluded until */
const exclusions = flru<Map<string, number>>(256);
/** Signed addresses (pathname + search) no host will serve */
const bannedAddresses = flru<true>(512);
/** Signed addresses some host has served */
const acceptedAddresses = flru<true>(1024);
/** Last time bytes arrived from any host */
let lastBytesAt = -Infinity;

export function estimate(hostname: string, file: MediaFile, bytes: number): HostEstimate {
  const own = speedsOf(file).get(hostname);
  const rate = own && robust(own.rate, false);
  const typical = typicalSpeed(file);
  const cold = performance.now() - get(hostname).lastUsedAt > WARM_MS;
  const ttfb = ((own && robust(own.ttfb, true)) ?? typical.ttfb) * (cold ? 2 : 1);
  return {
    ttfb,
    rate: rate ?? typical.rate,
    eta: ttfb + bytes / (rate ?? typical.rate),
    measured: rate != null,
    gap: own ? robust(own.gap, true) : null
  };
}

/** The median over the hosts measured on this video, else what is assumed */
export function typicalSpeed(file: MediaFile) {
  const ttfbs: number[] = [];
  const rates: number[] = [];
  for (const speed of speedsOf(file).values()) {
    const ttfb = robust(speed.ttfb, true);
    const rate = robust(speed.rate, false);
    if (ttfb !== null) ttfbs.push(ttfb);
    if (rate !== null) rates.push(rate);
  }
  return { ttfb: ttfbs.length > 0 ? p50(ttfbs) : PRIOR_TTFB, rate: rates.length > 0 ? p50(rates) : PRIOR_RATE };
}

/** Bytes arrived from some host: the network works */
export function noteBytes(now: number) {
  lastBytesAt = now;
}

export function isCoolingDown(hostname: string, now: number) {
  return get(hostname).cooldownUntil > now;
}

export function isExcluded(hostname: string, file: MediaFile, now: number) {
  return (exclusions.get(file.key)?.get(hostname) ?? 0) > now;
}

export function isFamilyRefused(hostname: string, family: SignatureFamily, now: number) {
  return (get(hostname).refusedFamilies.get(family) ?? 0) > now;
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

/**
 * @param sample `ttfb` in ms, or how long it waited without one when that says the host is slow;
 * `rate` in bytes per ms after the first chunk, `partial` when the transfer was cut short (only
 * counted until a full one is known); `gap` in ms
 */
export function recordSpeed(hostname: string, file: MediaFile, sample: { ttfb: number | null, rate: number | null, partial: boolean, gap: number | null }) {
  const byHost = speedsOf(file);
  let speed = byHost.get(hostname);
  if (speed === undefined) {
    speed = { ttfb: [], rate: [], gap: [] };
    byHost.set(hostname, speed);
  }
  const { ttfb, rate, gap } = sample;
  push(speed.ttfb, ttfb);
  push(speed.rate, rate !== null && rate > 0 && (!sample.partial || speed.rate.length === 0) ? rate : null);
  push(speed.gap, gap);
}

/**
 * @param alive another request to the host is delivering right now: a connection-level failure
 * is then one bad connection, and the host stays available for the retry
 */
export function recordOutcome(hostname: string, file: MediaFile, address: { key: string, family: SignatureFamily }, outcome: MediaOutcome, now: number, alive: boolean) {
  get(hostname).lastUsedAt = now;
  if (CONNECTION_FAILURES.has(outcome) && (alive || now - lastBytesAt > NETWORK_DOWN_MS)) {
    return;
  }
  const host = get(hostname);
  switch (outcome) {
    case MediaOutcome.Ok:
      lastBytesAt = now;
      host.failureStreak = 0;
      host.acceptedFamilies.add(address.family);
      host.refusedFamilies.delete(address.family);
      host.provenAddress = address.key;
      acceptedAddresses.set(address.key, true);
      break;
    case MediaOutcome.Truncated:
    case MediaOutcome.Reset:
    case MediaOutcome.Stall:
      cooldown(host, now, 500);
      break;
    case MediaOutcome.BadRange:
    case MediaOutcome.StaleObject:
    case MediaOutcome.NoRange:
    case MediaOutcome.Unverifiable:
    case MediaOutcome.Redirect:
    case MediaOutcome.Missing:
    case MediaOutcome.Integrity:
      exclude(hostname, file, Infinity);
      break;
    case MediaOutcome.Expired:
      bannedAddresses.set(address.key, true);
      break;
    case MediaOutcome.Refused:
      if (!acceptedAddresses.has(address.key)) {
        if (host.acceptedFamilies.has(address.family)) {
          // The host works and no host has served this address: the address is the problem
          bannedAddresses.set(address.key, true);
        } else {
          exclude(hostname, file, now + 60 * 1000);
        }
      } else if (host.acceptedFamilies.has(address.family)) {
        // Both work elsewhere: something between this host and this file, not the address
        exclude(hostname, file, now + 60 * 1000);
      } else {
        // The address works elsewhere: this host refuses the whole signature family (Akamai)
        host.refusedFamilies.set(address.family, now + 30 * 60 * 1000);
      }
      break;
    case MediaOutcome.Throttled:
      cooldown(host, now, 2000 * (2 ** Math.min(host.failureStreak, 3)));
      break;
    case MediaOutcome.ServerError:
    case MediaOutcome.Network:
      cooldown(host, now, 1000 * (2 ** Math.min(host.failureStreak, 5)));
      break;
    case MediaOutcome.ConnectFail:
      cooldown(host, now, 60 * 1000 * (2 ** Math.min(host.failureStreak, 2)));
      break;
    default:
      break;
  }
}

function get(hostname: string): HostRecord {
  let host = hosts.get(hostname);
  if (host === undefined) {
    host = { lastUsedAt: -Infinity, cooldownUntil: 0, failureStreak: 0, provenAddress: null, acceptedFamilies: new Set(), refusedFamilies: new Map() };
    hosts.set(hostname, host);
  }
  return host;
}

function speedsOf(file: MediaFile) {
  let byHost = speeds.get(file.videoKey);
  if (byHost === undefined) {
    byHost = new Map();
    speeds.set(file.videoKey, byHost);
  }
  return byHost;
}

function cooldown(host: HostRecord, now: number, ms: number) {
  host.failureStreak++;
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

/** The median, but a sudden turn for the worse shows at once: the two latest, both 2x worse than it */
function robust(samples: readonly number[], higherIsWorse: boolean): number | null {
  const len = samples.length;
  if (len === 0) {
    return null;
  }
  const median = p50(samples as number[]);
  const latest = samples[len - 1];
  const previous = samples[len - 2];
  if (higherIsWorse && len >= 3 && latest > 2 * median && previous > 2 * median) {
    return Math.min(latest, previous);
  }
  if (!higherIsWorse && len >= 3 && latest < median / 2 && previous < median / 2) {
    return Math.max(latest, previous);
  }
  return median;
}

function push(samples: number[], value: number | null) {
  if (value !== null) {
    samples.push(value);
    samples.splice(0, samples.length - SAMPLES);
  }
}
