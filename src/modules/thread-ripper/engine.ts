/**
 * The serve phase: a media range the player asks for is split into pieces, fetched from many
 * interchangeable CDN hosts at once, checked, and put together as the XHR's response.
 *
 * - Pieces: a range taking more than a couple of round trips is cut into pieces of about a second
 *   of transfer each.
 * - Owners: a piece goes on its own only to a host measured to finish it within `ETA_BAND` of the
 *   best one; before any is measured, to any (the addresses Bilibili listed first). No host is
 *   trusted for what it is, the player's own included. Others only race.
 * - Races: a request in one piece starts on several hosts, and a piece without a first byte or
 *   stalled gets a racer elsewhere. Once both racers receive, the one behind goes, except one on a
 *   host never measured before it has `PROBE_BYTES`, enough to measure the host.
 * - Exploring: a host never measured is unknown, never ranked against measured ones. Racers that
 *   explore go to such hosts, and each request with several pieces races one of them on one
 * - Offload: with slots free and nothing waiting, the piece expected to finish last has its tail
 *   cut off to the fastest measured host not on it, so that both finish together.
 * - Failure: retried on other hosts; when none is left, the XHR fails, and the player's retry goes
 *   to the browser.
 * - Warm-up: the init segment and index of every representation the player may switch to from
 *   what it asks for (same kind, for video same codec), fetched ahead; a request for them is served
 *   from the copy once it is there.
 */

import { clamp } from 'foxts/clamp';
import { noop } from 'foxts/noop';
import { p } from 'fast-percentile';
import { ibytes, prettyBandwidth } from 'xbits';
import { logger } from '../../logger';
import type { MediaServePhase } from '../../core/player';
import { CandidateTier } from '../../core/player/candidates';
import type { MediaCandidate } from '../../core/player/candidates';
import { MediaOutcome } from '../../core/player/host-model';
import type { HostEstimate } from '../../core/player/host-model';
import type { ByteRange } from '../../core/player/range';
import { byteRangeLength, parseContentRange } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import type { MakeBilibiliGreatThanEverBeforeHook, XhrResponder } from '../../types';
import type { SyntheticXhrSink } from '../../utils/xhr-override';
import { classifyError, classifyResponse, isRetryable } from './classify';
import type { AbortReason } from './classify';

const KiB = 1024;
const MiB = 1024 * KiB;
/** Attempts in flight across all jobs */
const GLOBAL_CAP = 32;
/** Slots only critical and urgent work may take */
const URGENT_RESERVE = 2;
/**
 * Attempts in flight per host: Chrome opens at most six connections to one host, and a seventh
 * would wait inside the browser. The CDN throttles per request, so several to one host add up
 */
const HOST_CAP = 6;
/** Pieces per host that may carry them on its own */
const PIECES_PER_HOST = 4;
const MAX_PIECES = 16;
const MIN_PIECE = 192 * KiB;
const MAX_PIECE = 4 * MiB;
const MAX_SERVED_LENGTH = 64 * MiB;
/** Failed attempts per piece before the job fails */
const MAX_TRIES = 6;
/** Committed, but no byte arrived for this long: the job fails */
const JOB_STALL_MS = 8000;
const TICK_MS = 50;
/** Duplicates per piece at most */
const MAX_EXTRA = 2;
/** A racer this far behind the leader is only comparing bytes */
const LAGGARD_BYTES = 64 * KiB;
/** A racer on a host never measured runs at least this far, enough to measure the host */
const PROBE_BYTES = 64 * KiB;
/** Init segments and indexes kept, the oldest dropped first */
const MAX_HEADERS = 64;
/** A piece this small is about latency: it goes to the host expected to finish it first */
const SMALL_PIECE = 256 * KiB;
/**
 * A piece goes on its own only to a host expected to finish it within this factor of the best
 * one: on a slower host the whole request would wait for that piece
 */
const ETA_BAND = 1.25;
/** Neither half of a split is smaller */
const STEAL_MIN = 192 * KiB;
/** Speed samples from shorter transfers are mostly round trip; below `FULL_SAMPLE`, cut short */
const MIN_SAMPLE = 16 * KiB;
const FULL_SAMPLE = 48 * KiB;
/** A host delivered bytes this recently: it works, and a failure is that one request's */
const ALIVE_MS = 2000;
/** After a failed job, the player's retry of the same range goes to the browser */
const NATIVE_RETRY_MS = 30 * 1000;
/** This many failed jobs within a minute: the browser takes every request for 30 s */
const FAILURES_TO_TURN_OFF = 3;

/** Urgency, most urgent first: init and index, what the player asked for, the warm-up */
const CRITICAL = 0;
const URGENT = 1;
const RELAXED = 2;
/** Scales the timeouts: critical work is helped sooner */
const URGENCY_FACTOR = [0.7, 0.85, 2] as const;
/** Hosts a request in one piece starts on */
const RACE_WIDTH = [3, 2, 1] as const;
/** The gaps between an attempt's chunks are reported as their 90th percentile */
const p90 = p(90);

/** One piece of a job's range */
interface Segment {
  /** Inclusive. Moves in when its tail is split off */
  end: number,
  /** Everything below it is written. Only ever moves forward */
  frontier: number,
  /** In flight: one, more while raced */
  readonly attempts: Set<Attempt>,
  /** Failed attempts */
  tries: number,
  /** Hosts tried since the piece last made progress */
  readonly tried: Set<string>,
  /** Duplicates started for it */
  extra: number,
  /** Waiting for a slot */
  queued: boolean
}

/** One fetch() of (the rest of) a piece from one host. Times are performance.now() ms, `0` = not yet */
interface Attempt {
  readonly job: Job,
  readonly seg: Segment,
  readonly hostname: string,
  readonly candidate: MediaCandidate,
  readonly role: 'primary' | 'dup',
  readonly controller: AbortController,
  /** Set when we abort it ourselves */
  abortReason: AbortReason | null,
  /**
   * No first byte after `ttfbSoft`, or silence after bytes flowed for `stallSoft`: a racer goes on.
   * Silent for twice `stallSoft`, the request goes. Before the job's urgency scales them
   */
  readonly ttfbSoft: number,
  readonly stallSoft: number,
  readonly startedAt: number,
  /** A validated response arrived */
  headersAt: number,
  firstByteAt: number,
  /** Left out of speed measurements: it arrives with the first byte */
  firstChunkBytes: number,
  lastByteAt: number,
  /** Received so far, bytes other attempts already wrote included */
  bytes: number,
  /** Absolute offset of the next byte it receives */
  pos: number,
  /** Recent (time, bytes) samples, for its current speed */
  readonly meter: Array<[time: number, bytes: number]>,
  /** Gaps between chunks, for its host's stall threshold */
  readonly gaps: number[],
  /** Its host was never measured: it is not cut loose before `PROBE_BYTES`, so that it gets measured */
  readonly probe: boolean
}

/** One range the player asked for, or a warm-up, answered by many attempts across hosts */
interface Job {
  readonly file: MediaFile,
  readonly range: ByteRange,
  /** What of `range` the player asked for: all of it, unless a request for the init segment or index fetches both */
  readonly served: ByteRange,
  readonly length: number,
  readonly cls: typeof CRITICAL | typeof URGENT | typeof RELAXED,
  readonly createdAt: number,
  /** Every acceptable URL of the file, by host */
  readonly candidates: ReadonlyMap<string, readonly MediaCandidate[]>,
  /** Page-realm memory: it is handed to the page as the XHR response */
  readonly buffer: ArrayBuffer,
  readonly bytes: Uint8Array,
  readonly segments: Segment[],
  /** The player's request it answers, `null` for a warm-up */
  readonly sink: SyntheticXhrSink | null,
  /** From the first valid response: the warm-up's copy is served with it */
  contentType: string,
  state: 'running' | 'done' | 'failed',
  /** Headers went to the page */
  committed: boolean,
  /** The whole file's size, from the first valid Content-Range */
  total: number | null,
  /** Distinct bytes written: the XHR progress */
  covered: number,
  lastProgressAt: number
}

type JobParams = Pick<Job, 'file' | 'range' | 'served' | 'cls'> & { candidates: readonly MediaCandidate[] };

/** A host that could take a piece, with the URL it would get */
interface HostOption {
  readonly hostname: string,
  readonly candidate: MediaCandidate,
  readonly estimate: HostEstimate,
  /** Attempts in flight on it */
  readonly active: number
}

/** A file's init segment and index, fetched ahead of the player */
interface CachedHeader {
  readonly range: ByteRange,
  /** `null` while the warm-up runs, and for good if it failed */
  bytes: Uint8Array | null,
  total: number | null,
  contentType: string
}

export function createThreadRipper(player: MakeBilibiliGreatThanEverBeforeHook['player'], nativeFetch: typeof fetch): MediaServePhase {
  const model = player.hosts;
  const jobs = new Set<Job>();
  /** file key -> init segment and index, insertion ordered: the oldest goes first */
  const headers = new Map<string, CachedHeader>();
  /** file key -> file size, as every host must agree on it */
  const totals = new Map<string, number>();
  /** `file key:start-end` -> until when the player's retry of a failed range goes to the browser */
  const nativeRetry = new Map<string, number>();
  let recentFailures: number[] = [];
  let offUntil = 0;
  let integrityFailed = false;

  /** hostname -> attempts in flight */
  const busy = new Map<string, number>();
  /** hostname -> when bytes last arrived from it */
  const lastDelivery = new Map<string, number>();
  /** Spreads a host's requests over the file's signatures */
  let rotation = 0;
  /** Pieces waiting for a slot, in arrival order */
  let queue: Array<[Job, Segment]> = [];
  const running = new Set<Attempt>();
  let pumping = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  // ---- Jobs

  function start(params: JobParams, sink: SyntheticXhrSink | null) {
    const { file, range } = params;
    const now = performance.now();
    const length = byteRangeLength(range);
    const buffer = new unsafeWindow.ArrayBuffer(length);
    const job: Job = {
      ...params,
      length,
      createdAt: now,
      candidates: byHost(params.candidates),
      buffer,
      bytes: new unsafeWindow.Uint8Array(buffer),
      segments: [],
      sink,
      contentType: '',
      state: 'running',
      committed: false,
      total: totals.get(file.key) ?? null,
      covered: 0,
      lastProgressAt: now
    };
    jobs.add(job);
    if (sink) {
      sink.signal.addEventListener('abort', () => {
        if (job.state === 'running') {
          stop(job, false);
        }
      }, { once: true });
    }

    // No more pieces than the hosts that may carry one alone can take
    const typical = model.typicalSpeed(file);
    const owners = ownersOf(hostsOf(job, Math.min(length, MiB), now));
    const count = pieceCount(length, typical.rate, typical.ttfb, owners?.size ?? 1);
    for (let i = 0; i < count; i++) {
      job.segments.push(segment(range.start + Math.floor(length * i / count), range.start + Math.floor(length * (i + 1) / count) - 1));
    }
    for (let i = 0; i < count; i++) {
      enqueue(job, job.segments[i]);
    }
    if (count === 1) {
      race(job);
    } else if (job.segments[count - 1].attempts.size > 0) {
      // One piece is raced on a host never measured, if any: that measures it, at no risk to the
      // request (`choose`)
      const seg = job.segments[count - 1];
      if (eligible(hostsOf(job, 0, now), seg, null).some(option => !option.estimate.measured)) {
        duplicate(job, seg, true);
      }
    }
    return job;
  }

  /** Every piece on a few hosts at once: a slow first byte is covered from the start */
  function race(job: Job) {
    for (let i = 0, len = job.segments.length; i < len; i++) {
      for (let j = 1; j < RACE_WIDTH[job.cls]; j++) {
        duplicate(job, job.segments[i], true);
      }
    }
  }

  function stop(job: Job, done: boolean) {
    job.state = done ? 'done' : 'failed';
    jobs.delete(job);
    queue = queue.filter(unit => unit[0] !== job);
    for (const att of running) {
      // Not those already past their end: they finish on their own
      if (att.job === job && att.pos <= att.seg.end) {
        abortAttempt(att, MediaOutcome.Canceled);
      }
    }
  }

  function complete(job: Job) {
    stop(job, true);
    if (process.env.DEBUG) {
      const ms = Math.max(1, performance.now() - job.createdAt);
      const pieces = job.segments.length;
      debugNote(`${job.file.kind} ${job.range.start}-${job.range.end} (${ibytes(job.length)}) in ${Math.round(ms)} ms at ${prettyBandwidth(job.length * 8000 / ms)} (stream ${prettyBandwidth(job.file.bandwidth)}), ${pieces} piece${pieces === 1 ? '' : 's'}`);
    }
    if (job.sink) {
      const { served, range } = job;
      job.sink.done(served.start === range.start && served.end === range.end ? job.buffer : job.buffer.slice(served.start - range.start, served.end - range.start + 1));
    }
    const header = headers.get(job.file.key);
    if (header?.bytes === null && job.range.start === header.range.start && job.range.end === header.range.end) {
      header.bytes = new Uint8Array(job.buffer);
      header.total = job.total;
      header.contentType = job.contentType;
    }
  }

  /** The XHR fails, and the player's retry of the range goes to the browser */
  function giveUp(job: Job, reason: string) {
    const now = performance.now();
    stop(job, false);
    if (!job.sink) {
      // A warm-up: its entry stays empty, and requests fetch the normal way
      return;
    }
    recentFailures = recentFailures.filter(at => now - at < 60 * 1000);
    recentFailures.push(now);
    if (recentFailures.length >= FAILURES_TO_TURN_OFF) {
      offUntil = now + 30 * 1000;
      recentFailures = [];
      logger.warn(`[thread-ripper] ${FAILURES_TO_TURN_OFF} failures within a minute, leaving media requests to the browser for 30 seconds`);
    }
    nativeRetry.set(`${job.file.key}:${job.served.start}-${job.served.end}`, now + NATIVE_RETRY_MS);
    logger.error(`[thread-ripper] failed: ${reason}`, { kind: job.file.kind, range: job.range });
    job.sink.error();
  }

  // ---- Attempts: one ranged fetch from one host

  async function fetchRange(att: Attempt): Promise<MediaOutcome> {
    const { job } = att;
    // Synchronously from `launch`: the piece's remaining range
    const start = att.pos;
    const end = att.seg.end;
    let response: Response;
    try {
      response = await nativeFetch(att.candidate.href, {
        method: 'GET',
        // The only author header: Range is CORS-safelisted, no preflight
        headers: { Range: `bytes=${start}-${end}` },
        mode: 'cors',
        // What the page's XHR uses (withCredentials = false), so connections are shared with it
        credentials: 'same-origin',
        // Like the page's XHR. `no-store` would add `Cache-Control: no-cache` and `Pragma: no-cache`,
        // which upos hosts ignore but Akamai may honour by going upstream
        cache: 'default',
        // Like the page's XHR. A redirect is not necessarily a P2P CDN: Akamai may send to an edge,
        // an extension may clean the URL (AdGuard's 307). One landing on a P2P CDN is refused
        redirect: 'follow',
        referrerPolicy: 'strict-origin-when-cross-origin',
        priority: job.cls === RELAXED ? 'auto' : 'high',
        signal: att.controller.signal
      });
    } catch (e) {
      return classifyError(e, att.abortReason, att.bytes, false, performance.now() - att.startedAt);
    }

    const contentRange = parseContentRange(response.headers.get('content-range'));
    const outcome = classifyResponse(response, contentRange, { start, end, total: job.total });
    if (contentRange === null || outcome !== MediaOutcome.Ok || !response.body) {
      response.body?.cancel().catch(noop);
      return outcome === MediaOutcome.Ok ? MediaOutcome.Truncated : outcome;
    }
    att.headersAt = performance.now();
    commit(job, response, contentRange.total);

    const reader = response.body.getReader();
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- stream reading
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const now = performance.now();
        if (att.firstByteAt === 0) {
          att.firstByteAt = now;
          att.firstChunkBytes = value.byteLength;
        } else if (att.gaps.length < 256) {
          att.gaps.push(now - att.lastByteAt);
        }
        att.lastByteAt = now;
        lastDelivery.set(att.hostname, now);
        att.bytes += value.byteLength;
        att.meter.push([now, att.bytes]);
        if (att.meter.length > 32) {
          att.meter.splice(0, att.meter.length - 32);
        }

        const written = onChunk(att, value);
        if (written === 'mismatch') {
          reader.cancel().catch(noop);
          return MediaOutcome.Integrity;
        }
        // Past the piece's end (its tail went elsewhere, or the job is over), or all asked for is here
        if (written === 'overrun' || att.pos > att.seg.end) {
          att.abortReason ??= MediaOutcome.Canceled;
          reader.cancel().catch(noop);
          return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Canceled;
        }
      }
    } catch (e) {
      return classifyError(e, att.abortReason, att.bytes, true, performance.now() - att.startedAt);
    } finally {
      reader.releaseLock();
    }
    return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Truncated;
  }

  /** The first validated response: its headers, for the whole range, go to the page */
  function commit(job: Job, response: Response, total: number | null) {
    if (total !== null && job.total === null) {
      job.total = total;
      totals.set(job.file.key, total);
    }
    if (job.committed || job.state !== 'running') {
      return;
    }
    job.committed = true;
    job.contentType = response.headers.get('content-type') ?? '';
    if (!job.sink) {
      return;
    }
    const responseHeaders: Array<[string, string]> = [];
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'content-range') {
        responseHeaders.push([name, value]);
      }
    });
    responseHeaders.push(['content-length', String(byteRangeLength(job.served))]);
    if (job.total !== null) {
      responseHeaders.push(['content-range', `bytes ${job.served.start}-${job.served.end}/${job.total}`]);
    }
    job.sink.headersReceived(206, responseHeaders, response.statusText);
  }

  /**
   * Take a chunk an attempt received. Every attempt starts at or below its piece's frontier and the
   * frontier only moves forward, so a piece always holds a contiguous run: bytes below the frontier
   * were written by another attempt and are compared instead, bytes above it are written.
   *
   * - `overrun`: the attempt is past its piece's end (the piece is done or shrunk), stop it
   * - `mismatch`: two responses disagree about the file's content
   */
  function onChunk(att: Attempt, chunk: Uint8Array): 'ok' | 'overrun' | 'mismatch' {
    const { job, seg, pos } = att;
    const now = performance.now();
    model.noteBytes(now);
    const usable = job.state === 'running' ? Math.min(chunk.byteLength, seg.end + 1 - pos) : 0;
    if (usable <= 0) {
      return 'overrun';
    }
    const base = job.range.start;
    const duplicateEnd = Math.min(pos + usable, seg.frontier);
    for (let offset = pos; offset < duplicateEnd; offset++) {
      if (job.bytes[offset - base] !== chunk[offset - pos]) {
        return 'mismatch';
      }
    }
    if (pos + usable > seg.frontier) {
      const fresh = chunk.subarray(seg.frontier - pos, usable);
      job.bytes.set(fresh, seg.frontier - base);
      job.covered += fresh.byteLength;
      seg.frontier = pos + usable;
      seg.tried.clear();
      job.lastProgressAt = now;
    }
    att.pos = pos + usable;

    if (seg.frontier > seg.end) {
      // The race is over for this piece
      for (const other of seg.attempts) {
        if (other !== att) {
          abortAttempt(other, MediaOutcome.Canceled);
        }
      }
    }
    if (job.segments.every(piece => piece.frontier > piece.end)) {
      complete(job);
    } else if (job.sink) {
      const served = byteRangeLength(job.served);
      job.sink.progress(Math.min(job.covered, served), served);
    }
    return usable < chunk.byteLength ? 'overrun' : 'ok';
  }

  function onAttemptEnd(att: Attempt, outcome: MediaOutcome) {
    const { job, seg } = att;
    if (outcome === MediaOutcome.Integrity) {
      integrityFailed = true;
      logger.error('[thread-ripper] two CDN hosts sent different bytes for the same range, leaving media requests to the browser from now on', { url: att.candidate.href });
      if (job.state === 'running') {
        giveUp(job, 'integrity');
      }
      return;
    }
    if (job.state !== 'running' || seg.frontier > seg.end || seg.queued) {
      return;
    }
    if (process.env.DEBUG && outcome !== MediaOutcome.Canceled) {
      debugNote(`${job.file.kind} ${job.range.start}-${job.range.end}: ${att.role} ${outcome} on ${att.hostname} after ${Math.round(performance.now() - att.startedAt)} ms, try ${seg.tries + 1}`);
    }
    if (seg.attempts.size > 0) {
      // A racer is still on the piece. It covers a lost race, but not a failed primary: left to a
      // racer on a worse host, the piece would crawl. A fresh primary joins, settling keeps the one ahead
      if (att.role === 'primary' && isRetryable(outcome) && ++seg.tries < MAX_TRIES) {
        enqueue(job, seg);
      }
      return;
    }
    if (outcome !== MediaOutcome.Canceled && !isRetryable(outcome)) {
      giveUp(job, outcome);
      return;
    }
    // Canceled by us (a race settled, a tail split off) is no failure of the piece
    if (outcome !== MediaOutcome.Canceled) {
      seg.tries++;
    }
    if (seg.tries >= MAX_TRIES) {
      giveUp(job, `a piece failed ${seg.tries} times, last: ${outcome}`);
      return;
    }
    enqueue(job, seg);
  }

  /** What the attempt's end says about its host, into the host model */
  function learn(att: Attempt, outcome: MediaOutcome) {
    const { hostname, job } = att;
    const now = performance.now();
    // A slow first byte or a stall on a host that delivered just now is that request's, not the host's
    model.recordOutcome(hostname, job.file, outcome, now, now - (lastDelivery.get(hostname) ?? -Infinity) < ALIVE_MS);

    const received = att.bytes - att.firstChunkBytes;
    const delivered = outcome === MediaOutcome.Ok || outcome === MediaOutcome.Canceled;
    const rate = delivered && received >= MIN_SAMPLE && att.lastByteAt > att.firstByteAt ? received / (att.lastByteAt - att.firstByteAt) : null;
    // No validated response yet: what it waited is a lower bound of its first byte. A racer
    // canceled before it waited as long as requests usually take says nothing
    const waited = now - att.startedAt;
    let ttfb = att.headersAt === 0 ? null : att.headersAt - att.startedAt;
    if (ttfb === null && outcome === MediaOutcome.Canceled && waited > model.typicalSpeed(job.file).ttfb) {
      ttfb = waited;
    }
    model.recordSpeed(hostname, job.file, { ttfb, rate, partial: outcome !== MediaOutcome.Ok || att.bytes < FULL_SAMPLE, gap: att.gaps.length === 0 ? null : p90(att.gaps) });
  }

  // ---- Scheduling

  function enqueue(job: Job, seg: Segment) {
    if (!seg.queued) {
      seg.queued = true;
      queue.push([job, seg]);
      tickTimer ??= setInterval(tick, TICK_MS);
      pump();
    }
  }

  /** Start what waits, in order, as slots and hosts allow */
  function pump() {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      const blocked = new Set<Segment>();
      for (;;) {
        const next = queue.findIndex(unit => !blocked.has(unit[1]));
        if (next === -1 || !hasSlot(queue[next][0])) {
          break;
        }
        const [job, seg] = queue[next];
        let target: HostOption | null = null;
        if (job.state === 'running' && seg.frontier <= seg.end) {
          target = pickHost(job, seg, null);
          if (target === null) {
            blocked.add(seg);
            continue;
          }
        }
        queue.splice(next, 1);
        seg.queued = false;
        if (target !== null) {
          launch(job, seg, 'primary', target);
        }
      }
    } finally {
      pumping = false;
    }
  }

  /** Within `GLOBAL_CAP`, leaving room for what is urgent */
  function hasSlot(job: Job) {
    return running.size < (job.cls === RELAXED ? GLOBAL_CAP - URGENT_RESERVE : GLOBAL_CAP);
  }

  /**
   * Race a piece on a host not already on it, if one has room: over HTTP/2 one hung connection
   * hangs every request to its host. To `explore`, a host never measured first; else (a rescue)
   * the fastest measured one first
   */
  function duplicate(job: Job, seg: Segment, explore: boolean) {
    const target = seg.extra < MAX_EXTRA && hasSlot(job) ? pickHost(job, seg, explore ? 'explore' : 'fastest') : null;
    if (target !== null) {
      seg.extra++;
      launch(job, seg, 'dup', target);
    }
    return target !== null;
  }

  function launch(job: Job, seg: Segment, role: Attempt['role'], { hostname, candidate, estimate }: HostOption) {
    const att: Attempt = {
      job,
      seg,
      hostname,
      candidate,
      role,
      controller: new AbortController(),
      abortReason: null,
      // A few times what the host usually takes
      ttfbSoft: clamp(2 * estimate.ttfb, 250, 1200),
      stallSoft: estimate.gap === null ? 600 : clamp(4 * estimate.gap, 300, 1000),
      startedAt: performance.now(),
      headersAt: 0,
      firstByteAt: 0,
      firstChunkBytes: 0,
      lastByteAt: 0,
      bytes: 0,
      pos: seg.frontier,
      meter: [],
      gaps: [],
      probe: !estimate.measured
    };
    rotation++;
    busy.set(hostname, (busy.get(hostname) ?? 0) + 1);
    // Work resumes after idle: silence from every host means the network is down only from here on
    if (running.size === 0) {
      model.noteBytes(att.startedAt);
    }
    running.add(att);
    seg.attempts.add(att);
    seg.tried.add(hostname);
    tickTimer ??= setInterval(tick, TICK_MS);

    void (async () => {
      let outcome: MediaOutcome;
      try {
        outcome = await fetchRange(att);
      } catch (e) {
        logger.error('[thread-ripper] attempt crashed', e);
        outcome = MediaOutcome.Network;
      }
      busy.set(hostname, busy.get(hostname)! - 1);
      running.delete(att);
      seg.attempts.delete(att);
      learn(att, outcome);
      try {
        onAttemptEnd(att, outcome);
      } finally {
        pump();
      }
    })();
  }

  function abortAttempt(att: Attempt, reason: AbortReason) {
    if (att.abortReason === null) {
      att.abortReason = reason;
      att.controller.abort();
    }
  }

  /** Every `TICK_MS` while there is work */
  function tick() {
    const now = performance.now();
    for (const att of running) {
      // A slow first byte is never given up on: an edge without the file is pulling it from
      // upstream, and another one would start over. Its racer takes over once that one delivers
      // (`settleRace`)
      if (att.abortReason !== null || att.firstByteAt === 0) {
        continue;
      }
      // Gone silent after bytes flowed, and so has its host: one silent while the host delivers to
      // its other requests only waits its turn on their shared connection, and its racer takes
      // over (`settleRace`). Only when something else can carry its bytes, else the piece would
      // only go to whatever racer is on it, there because it was the worse choice
      const { job, seg } = att;
      const silence = 2 * att.stallSoft * URGENCY_FACTOR[job.cls];
      if (
        now - att.lastByteAt > silence && now - (lastDelivery.get(att.hostname) ?? -Infinity) > silence
        && (seg.attempts.size > 1 || hasAlternative(job, seg, now) || now - att.startedAt > JOB_STALL_MS)
      ) {
        abortAttempt(att, MediaOutcome.Stall);
      }
    }

    try {
      for (const job of jobs) {
        tickJob(job, now);
      }
      if (queue.length === 0 && running.size < GLOBAL_CAP) {
        offload(now);
      }
    } catch (e) {
      logger.error('[thread-ripper] tick failed', e);
    }
    // Hosts cool down and slots free up: what waits may go now
    pump();

    if (tickTimer !== null && running.size === 0 && queue.length === 0 && jobs.size === 0) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function tickJob(job: Job, now: number) {
    if (job.committed && now - job.lastProgressAt > JOB_STALL_MS) {
      giveUp(job, 'no progress');
      return;
    }

    for (let i = 0, len = job.segments.length; i < len; i++) {
      const seg = job.segments[i];
      if (seg.frontier > seg.end) {
        continue;
      }
      if (seg.attempts.size > 1) {
        settleRace(seg);
        // Every request on it still waits for a first byte: one more host races it
        let newest: Attempt | null = null;
        let waiting = true;
        for (const att of seg.attempts) {
          waiting &&= att.firstByteAt === 0 && att.abortReason === null;
          if (newest === null || att.startedAt > newest.startedAt) {
            newest = att;
          }
        }
        if (waiting && newest !== null && job.cls !== RELAXED && isStuck(newest, now)) {
          rescue(newest, now);
        }
        continue;
      }
      const att = seg.attempts.values().next().value;
      // No first byte yet, or it stopped: another host may do better at once
      if (att?.abortReason === null && job.cls !== RELAXED && isStuck(att, now)) {
        rescue(att, now);
      }
    }
  }

  /** No first byte, or silent after bytes flowed, past its soft threshold */
  function isStuck(att: Attempt, now: number) {
    const factor = URGENCY_FACTOR[att.job.cls];
    return att.firstByteAt === 0
      ? now - att.startedAt >= att.ttfbSoft * factor
      : now - att.lastByteAt >= att.stallSoft * factor;
  }

  /** A racer on another host for a stuck request's piece */
  function rescue(att: Attempt, now: number) {
    const { job, seg } = att;
    if (duplicate(job, seg, false) && process.env.DEBUG) {
      debugNote(`${job.file.kind} ${job.range.start}-${job.range.end}: racer for a request on ${att.hostname} ${att.firstByteAt === 0 ? 'without a first byte' : 'gone silent'} after ${Math.round(now - att.startedAt)} ms`);
    }
  }

  /**
   * A race is for the first byte. Once both racers are receiving, the one behind only competes
   * with the leader for the same line and bytes: it goes, whatever the speeds. One still without
   * a first byte goes once the leader has `LAGGARD_BYTES` received since it started: the racer
   * rescuing a leader gone silent stays
   */
  function settleRace(seg: Segment) {
    let leader: Attempt | null = null;
    for (const att of seg.attempts) {
      if (leader === null || att.pos > leader.pos) {
        leader = att;
      }
    }
    for (const att of seg.attempts) {
      if (att !== leader && (!att.probe || att.bytes >= PROBE_BYTES) && (att.firstByteAt === 0 ? leader!.bytes >= LAGGARD_BYTES && leader!.lastByteAt > att.startedAt : att.pos < leader!.pos)) {
        abortAttempt(att, MediaOutcome.Canceled);
      }
    }
  }

  /**
   * Free slots and nothing waiting: the piece expected to finish last holds its whole request, so
   * its tail goes to the fastest measured host not on it, cut so that both finish together
   */
  function offload(now: number) {
    let slowest: Attempt | null = null;
    let slowestMs = 0;
    for (const att of running) {
      const { job, seg } = att;
      if (job.state !== 'running' || seg.attempts.size !== 1 || att.abortReason !== null || att.firstByteAt === 0 || seg.frontier > seg.end) {
        continue;
      }
      const rate = recentRate(att, now);
      const ms = (seg.end - seg.frontier + 1) / rate;
      if (rate > 0 && (slowest === null || ms > slowestMs)) {
        slowest = att;
        slowestMs = ms;
      }
    }
    if (slowest === null) {
      return;
    }
    const { job, seg } = slowest;
    const target = seg.end - seg.frontier + 1 >= 2 * STEAL_MIN && hasSlot(job) ? pickHost(job, seg, 'fastest') : null;
    const at = target && splitPoint(seg, recentRate(slowest, now), target.estimate);
    if (target && at !== null) {
      const tail = segment(at, seg.end);
      seg.end = at - 1;
      job.segments.push(tail);
      launch(job, tail, 'primary', target);
    }
  }

  // ---- Hosts

  /**
   * Where a piece goes. A primary (`racer` null) only to a host that may carry it alone
   * (`ownersOf`), relaxed work anywhere, to explore; a racer, or a tail, anywhere it is not running
   * already (`choose`). Hosts not tried since the piece last made progress first
   */
  function pickHost(job: Job, seg: Segment, racer: 'explore' | 'fastest' | null): HostOption | null {
    const bytes = seg.end - seg.frontier + 1;
    const dup = racer !== null;
    const hosts = hostsOf(job, bytes, performance.now());
    const owners = dup || job.cls === RELAXED ? null : ownersOf(hosts);
    const all = eligible(hosts, dup ? seg : null, owners);
    const untried = all.filter(option => !seg.tried.has(option.hostname));
    const options = untried.length === 0 ? all : untried;
    if (options.length === 0) {
      return null;
    }
    const explore = racer === null ? job.cls === RELAXED : racer === 'explore';
    const chosen = choose(options, explore, dup || bytes < SMALL_PIECE || job.segments.length === 1);
    if (seg.tried.has(chosen.hostname)) {
      // Every usable host was tried: a new round starts with this one
      seg.tried.clear();
    }
    return chosen;
  }

  function hasAlternative(job: Job, seg: Segment, now: number) {
    return eligible(hostsOf(job, seg.end - seg.frontier + 1, now), seg, null).length > 0;
  }

  /** Every host of the job not cooling down, with a signature it may use, busy or not, and what a piece of `bytes` would get from it */
  function hostsOf(job: Job, bytes: number, now: number): HostOption[] {
    const nowSec = Date.now() / 1000;
    const loads = hostLoads(now);
    const hosts: HostOption[] = [];
    for (const [hostname, listed] of job.candidates) {
      const candidate = model.isCoolingDown(hostname, now) ? null : pickCandidate(listed, job.file, now, nowSec);
      if (candidate !== null) {
        hosts.push({ hostname, candidate, estimate: withLoad(model.estimate(hostname, job.file, bytes), loads.get(hostname), bytes), active: busy.get(hostname) ?? 0 });
      }
    }
    return hosts;
  }

  /** hostname -> [its requests receiving, the bytes per ms they get together] */
  function hostLoads(now: number) {
    const loads = new Map<string, [receiving: number, rate: number]>();
    for (const att of running) {
      if (att.firstByteAt !== 0 && att.abortReason === null) {
        const load = loads.get(att.hostname) ?? [0, 0];
        load[0]++;
        load[1] += recentRate(att, now);
        loads.set(att.hostname, load);
      }
    }
    return loads;
  }

  /** For one host: one of the file's signatures it may use, in turn */
  function pickCandidate(listed: readonly MediaCandidate[], file: MediaFile, now: number, nowSec: number) {
    const usable = listed.filter(candidate => player.isCandidateUsable(candidate, file, now, nowSec));
    return usable.length > 0 ? usable[rotation % usable.length] : null;
  }

  // ---- Warm-up: the init segment and index of what the player may switch to, ahead of it

  /** Every representation of the file's video of its kind, and for video of its codec (`codecs` from the playinfo) */
  function warmUp(file: MediaFile) {
    const now = performance.now();
    const nowSec = Date.now() / 1000;
    const files = player.filesOf(file.videoKey);
    for (let i = 0, len = files.length; i < len; i++) {
      const other = files[i];
      if (
        other.kind !== file.kind || other.segmentBase === null || headers.has(other.key)
        || (other.kind === 'video' && codecFamily(other) !== codecFamily(file))
      ) {
        continue;
      }
      const candidates = player.candidates(other);
      // Nothing usable right now: a request for it fetches the normal way
      if (!candidates.some(candidate => player.isCandidateUsable(candidate, other, now, nowSec))) {
        continue;
      }
      const range: ByteRange = { start: 0, end: other.segmentBase.index.end };
      addHeader(other.key, range);
      start({ file: other, range, served: range, cls: RELAXED, candidates }, null);
    }
  }

  /** An empty entry, filled by the job fetching exactly `range` */
  function addHeader(key: string, range: ByteRange) {
    headers.set(key, { range, bytes: null, total: null, contentType: '' });
    if (headers.size > MAX_HEADERS) {
      headers.delete(headers.keys().next().value!);
    }
  }

  /** A request inside the init and index fetched ahead: served from them, as a copy */
  function serveHeader(header: CachedHeader, bytes: Uint8Array, file: MediaFile, range: ByteRange, sink: SyntheticXhrSink) {
    if (process.env.DEBUG) {
      debugNote(`${file.kind} ${range.start}-${range.end}: served from the warm-up`);
    }
    const length = byteRangeLength(range);
    const body = new unsafeWindow.ArrayBuffer(length);
    new unsafeWindow.Uint8Array(body).set(bytes.subarray(range.start - header.range.start, range.end - header.range.start + 1));
    const responseHeaders: Array<[string, string]> = [
      ['content-type', header.contentType || `${file.kind}/mp4`],
      ['content-length', String(length)]
    ];
    if (header.total !== null) {
      responseHeaders.push(['content-range', `bytes ${range.start}-${range.end}/${header.total}`]);
    }
    sink.headersReceived(206, responseHeaders, '');
    sink.done(body);
  }

  return {
    type: 'serve',
    name: 'thread-ripper',
    serve({ ctx, range, file, candidates, requested }): XhrResponder | null {
      const now = performance.now();
      // Left to the browser. The requested URL is the last resort: not acceptable, the browser keeps it
      let reason: string | null = null;
      if (integrityFailed || now < offUntil) {
        reason = 'off after failures';
      } else if (range === null) {
        reason = 'not a single byte range';
      } else if (file === null) {
        reason = 'no playinfo lists the file';
      } else if (requested === null) {
        reason = 'the requested URL is not acceptable';
      } else if (byteRangeLength(range) > MAX_SERVED_LENGTH) {
        reason = 'range too long';
      } else if ((nativeRetry.get(`${file.key}:${range.start}-${range.end}`) ?? 0) > now) {
        reason = 'it failed just now';
      }
      if (reason !== null || range === null || file === null || requested === null) {
        if (process.env.DEBUG) {
          debugNote(`left to the browser, ${reason}: ${ctx.url}`);
        }
        return null;
      }

      // The initialization segment and the index come first: nothing plays without them
      const whole = file.segmentBase !== null && range.end <= file.segmentBase.index.end ? { start: 0, end: file.segmentBase.index.end } : null;
      const header = headers.get(file.key);
      const bytes = header?.bytes ?? null;
      if (header !== undefined && bytes !== null && range.start >= header.range.start && range.end <= header.range.end) {
        return sink => serveHeader(header, bytes, file, range, sink);
      }
      // The first request for the init segment or the index fetches both, and the other is served from the copy
      const fetched = header === undefined && whole !== null ? whole : range;
      if (fetched !== range) {
        addHeader(file.key, fetched);
      }
      // The player plays this video: what it may switch to is fetched ahead of it
      warmUp(file);
      return sink => start({ file, range: fetched, served: range, cls: whole === null ? URGENT : CRITICAL, candidates }, sink);
    }
  };
}

/**
 * How many pieces a range is split into. A range whose transfer takes less than two round trips
 * is not worth splitting; otherwise each piece keeps its request busy for a good part of a second,
 * with no more than `PIECES_PER_HOST` per host that may carry one
 */
function pieceCount(length: number, rate: number, ttfb: number, hosts: number): number {
  if (length < clamp(2 * rate * ttfb, 128 * KiB, MiB)) {
    return 1;
  }
  const pieceSize = clamp(rate * clamp(4 * ttfb, 600, 1500), MIN_PIECE, MAX_PIECE);
  return clamp(Math.ceil(length / pieceSize), 1, Math.min(MAX_PIECES, hosts * PIECES_PER_HOST));
}

function segment(start: number, end: number): Segment {
  return { end, frontier: start, attempts: new Set(), tries: 0, tried: new Set(), extra: 0, queued: false };
}

/** An attempt's speed over the last half second, or since its first byte when the history is short */
function recentRate(att: Attempt, now: number): number {
  const { meter } = att;
  if (meter.length === 0) {
    return 0;
  }
  const [lastTime, lastBytes] = meter.at(-1)!;
  for (let i = 0, len = meter.length; i < len; i++) {
    const [time, bytes] = meter[i];
    if (now - time <= 500 && lastTime - time >= 100) {
      return (lastBytes - bytes) / Math.max(1, now - time);
    }
  }
  return att.firstByteAt === 0 || now <= att.firstByteAt ? 0 : (att.bytes - att.firstChunkBytes) / (now - att.firstByteAt);
}

/**
 * Where to split a piece so both halves finish together: the running attempt (rate `r`) keeps
 * `[frontier, m)`, the new host takes `[m, end]`. `null` when either half would be too small
 */
function splitPoint(seg: Segment, r: number, { ttfb, rate }: HostEstimate): number | null {
  if (r <= 0) {
    return null;
  }
  const remaining = seg.end + 1 - seg.frontier;
  const m = seg.frontier + Math.ceil(r * (ttfb + remaining / rate) / (1 + r / rate));
  // The running attempt must still have work while the new one waits for its first byte
  return seg.end + 1 - m < STEAL_MIN || m - seg.frontier < Math.max(STEAL_MIN, r * ttfb) ? null : m;
}

/**
 * What one more request to a host would get: no more than its requests get now. They share one
 * HTTP/2 connection, so on a host whose connection is the limit they slow each other down
 */
function withLoad(estimate: HostEstimate, load: [receiving: number, rate: number] | undefined, bytes: number): HostEstimate {
  const rate = load === undefined || load[1] <= 0 ? estimate.rate : Math.min(estimate.rate, load[1] / load[0]);
  return rate === estimate.rate ? estimate : { ...estimate, rate, eta: estimate.ttfb + bytes / rate };
}

/** Of `hosts`, those with room for one more piece, of `only` if given, not those on `avoid` if given */
function eligible(hosts: HostOption[], avoid: Segment | null, only: ReadonlySet<string> | null) {
  const taken = new Set<string>();
  if (avoid !== null) {
    for (const att of avoid.attempts) {
      taken.add(att.hostname);
    }
  }
  return hosts.filter(option => option.active < HOST_CAP && !taken.has(option.hostname) && (only === null || only.has(option.hostname)));
}

/**
 * Of `hosts`, those a piece may go to on its own, busy or not: the measured ones expected to finish
 * it within `ETA_BAND` of the best. `null` when none is measured: any host may take it
 */
function ownersOf(hosts: HostOption[]): Set<string> | null {
  const measured = hosts.filter(option => option.estimate.measured);
  const best = Math.min(...measured.map(option => option.estimate.eta));
  const owners = new Set<string>();
  for (let i = 0, len = measured.length; i < len; i++) {
    if (measured[i].estimate.eta <= best * ETA_BAND) {
      owners.add(measured[i].hostname);
    }
  }
  return owners.size > 0 ? owners : null;
}

/**
 * Among the hosts that may carry a piece. A host never measured is unknown: its speed depends on
 * whether its edge has the file and on the path to it, so it is never ranked against measured
 * ones. Before anything is measured, or to `explore`, such a host first (the addresses Bilibili
 * listed, then the least busy); else, for a `small` piece, the measured host expected to finish
 * first, otherwise the least busy
 */
function choose(options: HostOption[], explore: boolean, small: boolean): HostOption {
  const untested = options.filter(option => !option.estimate.measured);
  if (untested.length > 0 && (explore || untested.length === options.length)) {
    return leastBusy(preferred(untested));
  }
  const measured = options.filter(option => option.estimate.measured);
  return small ? fastest(measured) : leastBusy(measured);
}

/**
 * Among hosts nothing is measured on yet: the addresses Bilibili issued for this file first (when
 * only the assigned hosts are good, the moved signatures are 13 ways to wait), then the signatures
 * moved onto other hosts, last the rest. Mirror and bcache hosts are peers at every step
 */
function preferred(options: HostOption[]): HostOption[] {
  const listed = options.filter(option => option.candidate.tier <= CandidateTier.ListedBcache);
  if (listed.length > 0) {
    return listed;
  }
  const moved = options.filter(option => option.candidate.tier <= CandidateTier.Bcache);
  return moved.length > 0 ? moved : options;
}

function leastBusy(options: HostOption[]): HostOption {
  return options.reduce((best, option) => (option.active < best.active || (option.active === best.active && option.estimate.eta < best.estimate.eta) ? option : best));
}

function fastest(options: HostOption[]): HostOption {
  return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best));
}

/** `avc1`, `hev1` (`hvc1` alike), `av01`... */
function codecFamily(file: MediaFile) {
  return file.codecs.startsWith('hvc1') ? 'hev1' : file.codecs.slice(0, 4);
}

function byHost(candidates: readonly MediaCandidate[]) {
  const grouped = new Map<string, MediaCandidate[]>();
  for (let i = 0, len = candidates.length; i < len; i++) {
    const list = grouped.get(candidates[i].hostname);
    if (list) {
      list.push(candidates[i]);
    } else {
      grouped.set(candidates[i].hostname, [candidates[i]]);
    }
  }
  return grouped;
}

/** Debug builds: what thread-ripper does, in the console */
function debugNote(text: string) {
  if (process.env.DEBUG) {
    logger.debug(`[thread-ripper] ${text}`);
  }
}
