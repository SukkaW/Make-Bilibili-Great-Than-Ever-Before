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
 *   stalled gets a racer elsewhere. Once both racers receive, the one behind goes.
 * - Endgame: with slots free and nothing waiting, the slowest piece's tail is split off to an
 *   owner, or a small one raced.
 * - Failure: retried on other hosts. Then, before any headers went to the page, the browser takes
 *   the request back; after, the player's own URL is the last resort.
 * - Warm-up: every playable representation's init segment and index, fetched as soon as a
 *   playinfo lists them.
 */

import { clamp } from 'foxts/clamp';
import { falseFn, noop } from 'foxts/noop';
import { wait } from 'foxts/wait';
import { p, p50 } from 'fast-percentile';
import { ibytes, prettyBandwidth } from 'xbits';
import { logger } from '../../logger';
import type { MediaServePhase } from '../../core/player';
import { CandidateTier, defaultCandidate, isCandidateUsable } from '../../core/player/candidates';
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
/** Failed attempts per piece before the job falls back or fails */
const MAX_TRIES = 6;
/** No validated 206 from any host by then, when the player set no timeout: the browser takes over */
const COMMIT_TIMEOUT_MS = 4800;
/** Committed, but no byte arrived for this long: unfinished pieces go to the player's own URL */
const JOB_STALL_MS = 8000;
/**
 * A job delivering this many times the stream's bitrate gets no more speculative duplicates. High
 * on purpose: a saturated line shows itself when a duplicate raises nothing (`mayDuplicate`)
 */
const HEDGE_HEADROOM = 8;
/** The delivered rate is read over this long */
const RATE_WINDOW_MS = 500;
const TICK_MS = 50;
/** Duplicates per piece at most */
const MAX_EXTRA = 2;
/** A racer this far behind the leader is only comparing bytes */
const LAGGARD_BYTES = 64 * KiB;
/** A request waits this long for a warm-up still on its way, then fetches by itself */
const WARMUP_WAIT_MS = 1500;
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
/** How long after its start a job's bytes are wanted */
const DEADLINE_MS = [0, 1500, 5000] as const;
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
  queued: boolean,
  /** Last resort: the player's own URL */
  final: boolean
}

/** One fetch() of (the rest of) a piece from one host. Times are performance.now() ms, `0` = not yet */
interface Attempt {
  readonly job: Job,
  readonly seg: Segment,
  readonly hostname: string,
  readonly candidate: MediaCandidate,
  readonly role: 'primary' | 'dup' | 'final',
  readonly controller: AbortController,
  /** Set when we abort it ourselves */
  abortReason: AbortReason | null,
  /**
   * No first byte after `ttfbSoft`, or silence after bytes flowed for `stallSoft`: a racer goes on;
   * after the hard ones, the request goes. Before the job's urgency scales them
   */
  readonly ttfbSoft: number,
  readonly ttfbHard: number,
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
  readonly gaps: number[]
}

/** One range the player asked for, or a warm-up, answered by many attempts across hosts */
interface Job {
  readonly file: MediaFile,
  readonly range: ByteRange,
  readonly length: number,
  cls: typeof CRITICAL | typeof URGENT | typeof RELAXED,
  readonly createdAt: number,
  /** When its bytes are wanted: past its start by how urgent it is. Lowered when the player asks for a warm-up */
  deadline: number,
  /** Help it may get for pieces on pace but late anyway (`needsRelief`) */
  readonly rescues: { straggler: number, stale: number },
  /** The player's own XHR timeout, `0` for none */
  readonly timeout: number,
  /** Every acceptable URL of the file, by host */
  readonly candidates: ReadonlyMap<string, readonly MediaCandidate[]>,
  /** The URL the player asked for (the warm-up's own pick): the last resort */
  readonly requested: MediaCandidate,
  /** Page-realm memory: it is handed to the page as the XHR response */
  readonly buffer: ArrayBuffer,
  readonly bytes: Uint8Array,
  readonly segments: Segment[],
  /** The player's request it answers, `null` for a warm-up */
  readonly sink: SyntheticXhrSink | null,
  /** From the first valid response: the warm-up's copy is served with it */
  contentType: string,
  state: 'running' | 'done' | 'failed',
  /** Headers went to the page: the browser can no longer take the request back */
  committed: boolean,
  /** The whole file's size, from the first valid Content-Range */
  total: number | null,
  /** Distinct bytes written: the XHR progress */
  covered: number,
  lastProgressAt: number,
  /** What the stream needs, bytes per ms: the file's bitrate from the playinfo */
  readonly requiredRate: number,
  /** Recent (time, covered) samples: the delivered rate */
  readonly meter: Array<[time: number, covered: number]>,
  /** The last speculative duplicate: when, and the delivered rate then */
  lastDuplicate: { at: number, rate: number } | null,
  /** A duplicate did not raise the delivered rate: the line is full */
  saturated: boolean
}

type JobParams = Pick<Job, 'file' | 'range' | 'cls' | 'timeout' | 'requested'> & { candidates: readonly MediaCandidate[] };

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
  bytes: Uint8Array | null,
  total: number | null,
  contentType: string,
  /** Settles when the fetch is over: `true` with bytes */
  readonly ready: Promise<boolean>,
  settle(this: void, ok: boolean): void,
  /** The warm-up fetching it */
  readonly job: Job
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
  /** Pieces waiting for a slot, in arrival order: the most urgent, then the oldest job's go first */
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
      deadline: now + DEADLINE_MS[params.cls],
      rescues: { straggler: 0, stale: 0 },
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
      lastProgressAt: now,
      // Bits per second to bytes per millisecond
      requiredRate: file.bandwidth / 8000,
      meter: [[now, 0]],
      lastDuplicate: null,
      saturated: false
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
    const count = pieceCount(length, typical.rate, typical.ttfb, ownersOf(job, Math.min(length, MiB), now)?.size ?? 1);
    // One rescue of each kind per four pieces, up to four
    job.rescues.straggler = Math.min(4, Math.ceil(count / 4));
    job.rescues.stale = job.rescues.straggler;
    for (let i = 0; i < count; i++) {
      job.segments.push(segment(range.start + Math.floor(length * i / count), range.start + Math.floor(length * (i + 1) / count) - 1));
      enqueue(job, job.segments[i]);
    }
    if (count === 1) {
      race(job);
    }
    return job;
  }

  /** Every piece on a few hosts at once: a slow first byte is covered from the start */
  function race(job: Job) {
    for (let i = 0, len = job.segments.length; i < len; i++) {
      for (let j = 1; j < RACE_WIDTH[job.cls]; j++) {
        duplicate(job, job.segments[i]);
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
      job.sink.done(job.buffer);
      return;
    }
    const header = headers.get(job.file.key);
    if (header?.bytes === null) {
      header.bytes = new Uint8Array(job.buffer);
      header.total = job.total;
      header.contentType = job.contentType;
      header.settle(true);
    }
  }

  /** Before commit the browser sends the request itself; after it, the XHR fails */
  function giveUp(job: Job, reason: string) {
    const now = performance.now();
    stop(job, false);
    if (!job.sink) {
      // A warm-up: nothing to serve from, the request fetches it the normal way
      const header = headers.get(job.file.key);
      if (header?.bytes === null) {
        headers.delete(job.file.key);
        header.settle(false);
      }
      return;
    }
    recentFailures = recentFailures.filter(at => now - at < 60 * 1000);
    recentFailures.push(now);
    if (recentFailures.length >= FAILURES_TO_TURN_OFF) {
      offUntil = now + 30 * 1000;
      recentFailures = [];
      logger.warn(`[thread-ripper] ${FAILURES_TO_TURN_OFF} failures within a minute, leaving media requests to the browser for 30 seconds`);
    }
    if (!job.committed && job.sink.fallbackToNative()) {
      logger.warn(`[thread-ripper] handed back to the browser: ${reason}`, { url: job.requested.href, range: job.range });
      return;
    }
    nativeRetry.set(`${job.file.key}:${job.range.start}-${job.range.end}`, now + NATIVE_RETRY_MS);
    logger.error(`[thread-ripper] failed: ${reason}`, { url: job.requested.href, range: job.range });
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

    const verdict = classifyResponse(
      response,
      parseContentRange(response.headers.get('content-range')),
      { start, end, total: job.total, addressExpired: att.candidate.deadline !== 0 && att.candidate.deadline * 1000 <= Date.now() }
    );
    if (verdict.outcome !== MediaOutcome.Ok || !response.body) {
      response.body?.cancel().catch(noop);
      return verdict.outcome === MediaOutcome.Ok ? MediaOutcome.Truncated : verdict.outcome;
    }
    att.headersAt = performance.now();
    commit(job, response, verdict.total);

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
    responseHeaders.push(['content-length', String(job.length)]);
    if (job.total !== null) {
      responseHeaders.push(['content-range', `bytes ${job.range.start}-${job.range.end}/${job.total}`]);
    }
    job.sink.headersReceived(206, responseHeaders, response.statusText);
  }

  function onChunk(att: Attempt, chunk: Uint8Array) {
    const { job, seg } = att;
    model.noteBytes(performance.now());
    const result = writeChunk(job, att, chunk);
    if (result !== 'mismatch' && job.state === 'running') {
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
      } else {
        job.sink?.progress(job.covered, job.length);
      }
    }
    return result;
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
      if (att.role === 'primary' && isRetryable(outcome) && !seg.final && ++seg.tries < MAX_TRIES) {
        enqueue(job, seg);
      }
      return;
    }
    if (outcome !== MediaOutcome.Canceled && !isRetryable(outcome)) {
      giveUp(job, outcome);
      return;
    }
    if (seg.final) {
      giveUp(job, `the player's own URL failed as well: ${outcome}`);
      return;
    }
    // Canceled by us (a race settled, a tail split off) is no failure of the piece
    if (outcome !== MediaOutcome.Canceled) {
      seg.tries++;
    }
    if (seg.tries >= MAX_TRIES) {
      if (!job.committed) {
        giveUp(job, `a piece failed ${seg.tries} times, last: ${outcome}`);
        return;
      }
      seg.final = true;
    }
    enqueue(job, seg);
  }

  /** What the attempt's end says about its host, into the host model */
  function learn(att: Attempt, outcome: MediaOutcome) {
    const { hostname, job } = att;
    const now = performance.now();
    // A slow first byte or a stall on a host that delivered just now is that request's, not the host's
    model.recordOutcome(hostname, job.file, att.candidate, outcome, now, now - (lastDelivery.get(hostname) ?? -Infinity) < ALIVE_MS);

    const received = att.bytes - att.firstChunkBytes;
    const delivered = outcome === MediaOutcome.Ok || outcome === MediaOutcome.Canceled;
    const rate = delivered && received >= MIN_SAMPLE && att.lastByteAt > att.firstByteAt ? received / (att.lastByteAt - att.firstByteAt) : null;
    // No validated response yet: what it waited is a lower bound of its first byte. A racer
    // canceled before it waited as long as requests usually take says nothing
    const waited = now - att.startedAt;
    let ttfb = att.headersAt === 0 ? null : att.headersAt - att.startedAt;
    if (ttfb === null && (outcome === MediaOutcome.TtfbTimeout || (outcome === MediaOutcome.Canceled && waited > model.typicalSpeed(job.file).ttfb))) {
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

  /** Start what waits, most urgent first, as slots and hosts allow */
  function pump() {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      const blocked = new Set<Segment>();
      for (;;) {
        let next = -1;
        for (let i = 0, len = queue.length; i < len; i++) {
          if (!blocked.has(queue[i][1]) && (next === -1 || before(queue[i][0], queue[next][0]))) {
            next = i;
          }
        }
        if (next === -1 || !hasSlot(queue[next][0])) {
          break;
        }
        const [job, seg] = queue[next];
        let target: HostOption | null = null;
        if (job.state === 'running' && seg.frontier <= seg.end) {
          target = seg.final ? ownUrl(job) : pickHost(job, seg, false);
          if (target === null) {
            blocked.add(seg);
            continue;
          }
        }
        queue.splice(next, 1);
        seg.queued = false;
        if (target !== null) {
          launch(job, seg, seg.final ? 'final' : 'primary', target);
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
   * Race a piece, if a host has room: another one, or for a `rescue` of a stuck request the one
   * expected to finish first, its own host included (a slow first byte is one request's)
   */
  function duplicate(job: Job, seg: Segment, rescue = false) {
    const target = seg.extra < MAX_EXTRA && hasSlot(job) ? pickHost(job, seg, true, rescue) : null;
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
      ttfbHard: clamp(6 * estimate.ttfb, 1500, 3000),
      stallSoft: estimate.gap === null ? 600 : clamp(4 * estimate.gap, 300, 1000),
      startedAt: performance.now(),
      headersAt: 0,
      firstByteAt: 0,
      firstChunkBytes: 0,
      lastByteAt: 0,
      bytes: 0,
      pos: seg.frontier,
      meter: [],
      gaps: []
    };
    rotation++;
    busy.set(hostname, (busy.get(hostname) ?? 0) + 1);
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
      if (att.abortReason !== null) {
        continue;
      }
      const factor = URGENCY_FACTOR[att.job.cls];
      const silent = att.firstByteAt === 0
        ? now - att.startedAt > att.ttfbHard * factor
        : now - att.lastByteAt > 2 * att.stallSoft * factor;
      // Only when something else can carry its bytes: killing it would only hand the piece to
      // whatever racer is on it, and that racer is there because it was the worse choice
      const { job, seg } = att;
      if (silent && (seg.attempts.size > 1 || hasAlternative(job, seg, now) || now - att.startedAt > JOB_STALL_MS)) {
        abortAttempt(att, att.firstByteAt === 0 ? MediaOutcome.TtfbTimeout : MediaOutcome.Stall);
      }
    }

    try {
      for (const job of jobs) {
        tickJob(job, now);
      }
      if (queue.length === 0 && running.size < GLOBAL_CAP) {
        endgame(now);
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
    if (!job.committed) {
      // Never hand back while a host is left to try, except to leave the browser the other half
      // of the player's own timeout
      if (now - job.createdAt > (job.timeout > 0 ? job.timeout / 2 : COMMIT_TIMEOUT_MS)) {
        giveUp(job, 'no CDN host answered in time');
        return;
      }
    } else if (now - job.lastProgressAt > JOB_STALL_MS) {
      // Unfinished pieces go to the player's own URL; if they went there already, the job fails
      const stuck = job.segments.filter(seg => seg.frontier <= seg.end && !seg.final);
      if (stuck.length === 0) {
        giveUp(job, 'no progress');
        return;
      }
      for (let i = 0, len = stuck.length; i < len; i++) {
        stuck[i].final = true;
        for (const att of stuck[i].attempts) {
          abortAttempt(att, MediaOutcome.Stall);
        }
        enqueue(job, stuck[i]);
      }
      job.lastProgressAt = now;
      return;
    }

    const typical = model.typicalSpeed(job.file);
    const slack = hedgeSlack(typical.ttfb);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      const seg = job.segments[i];
      if (seg.frontier > seg.end) {
        continue;
      }
      if (seg.attempts.size > 1) {
        settleRace(seg);
        continue;
      }
      const att = seg.attempts.values().next().value;
      if (att?.abortReason !== null) {
        continue;
      }
      // No first byte yet, or it stopped: another host may do better at once
      if (att.firstByteAt === 0
        ? now - att.startedAt >= att.ttfbSoft * URGENCY_FACTOR[job.cls]
        : now - att.lastByteAt >= att.stallSoft * URGENCY_FACTOR[job.cls]) {
        duplicate(job, seg, true);
      } else {
        const relief = needsRelief(att, now, typical.rate, () => alternativeOf(job, seg), slack);
        const started = relief !== null && relieve(att, now);
        if (started && relief !== 'help') {
          job.rescues[relief]--;
        }
      }
    }
  }

  /**
   * A race is for the first byte. Once both racers are receiving, the one behind only competes
   * with the leader for the same line and bytes: it goes, whatever the speeds. One still without
   * a first byte goes once the leader has `LAGGARD_BYTES`
   */
  function settleRace(seg: Segment) {
    let leader: Attempt | null = null;
    for (const att of seg.attempts) {
      if (leader === null || att.pos > leader.pos) {
        leader = att;
      }
    }
    for (const att of seg.attempts) {
      if (att !== leader && (att.firstByteAt === 0 ? leader!.bytes >= LAGGARD_BYTES : att.pos < leader!.pos)) {
        abortAttempt(att, MediaOutcome.Canceled);
      }
    }
  }

  /** Free slots and nothing waiting: the piece with the most time left is relieved */
  function endgame(now: number) {
    let slowest: Attempt | null = null;
    let slowestMs = 0;
    const etas: number[] = [];
    for (const att of running) {
      const { job, seg } = att;
      if (job.state !== 'running' || seg.attempts.size !== 1 || att.abortReason !== null || seg.frontier > seg.end) {
        continue;
      }
      const rate = recentRate(att, now);
      const ms = rate > 0 ? (seg.end - seg.frontier + 1) / rate : Infinity;
      etas.push(ms);
      if (slowest === null || ms > slowestMs) {
        slowest = att;
        slowestMs = ms;
      }
    }
    // A piece too small to cut is raced only when well behind the others, or late
    if (
      slowest !== null && (
        slowest.seg.end - slowest.seg.frontier + 1 >= 2 * STEAL_MIN
        || slowestMs > Math.max(300, 1.3 * p50(etas))
        || now + slowestMs > slowest.job.deadline - hedgeSlack(model.typicalSpeed(slowest.job.file).ttfb)
      )
    ) {
      relieve(slowest, now);
    }
  }

  /**
   * A piece's tail goes to an owner, cut so both finish together; one that cannot be cut is raced
   *
   * @returns whether help started
   */
  function relieve(att: Attempt, now: number) {
    const { job, seg } = att;
    const target = seg.end - seg.frontier + 1 >= 2 * STEAL_MIN && hasSlot(job) ? pickHost(job, seg, false) : null;
    const at = target && splitPoint(seg, recentRate(att, now), target.estimate);
    if (target && at !== null) {
      const tail = segment(at, seg.end);
      seg.end = at - 1;
      job.segments.push(tail);
      launch(job, tail, 'primary', target);
      return true;
    }
    if (mayDuplicate(job, now) && duplicate(job, seg)) {
      job.lastDuplicate = { at: now, rate: deliveredRate(job, now) };
      return true;
    }
    return false;
  }

  // ---- Hosts

  /**
   * Where a piece goes. A primary only to a host that may carry it alone (`ownersOf`), relaxed work
   * anywhere, to explore; a duplicate anywhere it is not running already, a rescue anywhere. Hosts
   * not tried since the piece last made progress first, except for a rescue: the fastest
   */
  function pickHost(job: Job, seg: Segment, dup: boolean, rescue = false): HostOption | null {
    const bytes = seg.end - seg.frontier + 1;
    const owners = dup || job.cls === RELAXED ? null : ownersOf(job, bytes, performance.now());
    const all = eligible(job, seg, dup && !rescue, bytes, owners);
    const untried = all.filter(option => !seg.tried.has(option.hostname));
    const options = rescue || untried.length === 0 ? all : untried;
    if (options.length === 0) {
      return null;
    }
    const chosen = dup ? fastest(options) : choosePrimary(options, job, bytes);
    if (seg.tried.has(chosen.hostname)) {
      // Every usable host was tried: a new round starts with this one
      seg.tried.clear();
    }
    return chosen;
  }

  /** The host a racer of the piece would go to */
  function alternativeOf(job: Job, seg: Segment) {
    const options = eligible(job, seg, true, seg.end - seg.frontier + 1, null);
    return options.length > 0 ? fastest(options).estimate : null;
  }

  function hasAlternative(job: Job, seg: Segment, now: number) {
    return eligible(job, seg, true, seg.end - seg.frontier + 1, null, now).length > 0;
  }

  /** Hosts with room that could take the piece now, of `only` if given, not those on it when `avoidPiece` */
  function eligible(job: Job, seg: Segment, avoidPiece: boolean, bytes: number, only: ReadonlySet<string> | null, now = performance.now()) {
    const nowSec = Date.now() / 1000;
    const options: HostOption[] = [];
    for (const [hostname, listed] of job.candidates) {
      const active = busy.get(hostname) ?? 0;
      if (active >= HOST_CAP || (only !== null && !only.has(hostname)) || model.isCoolingDown(hostname, now)) {
        continue;
      }
      let onPiece = false;
      for (const att of seg.attempts) {
        onPiece ||= att.hostname === hostname;
      }
      const candidate = avoidPiece && onPiece ? null : pickCandidate(hostname, listed, job.file, now, nowSec);
      if (candidate !== null) {
        options.push({ hostname, candidate, estimate: model.estimate(hostname, job.file, bytes), active });
      }
    }
    return options;
  }

  /**
   * The hosts a piece of `bytes` may go to on its own, busy or not: the measured ones expected to
   * finish it within `ETA_BAND` of the best. `null` when none is measured: any host may take it
   */
  function ownersOf(job: Job, bytes: number, now: number): Set<string> | null {
    const nowSec = Date.now() / 1000;
    const measured: Array<[hostname: string, eta: number]> = [];
    let best = Infinity;
    for (const [hostname, listed] of job.candidates) {
      if (model.isCoolingDown(hostname, now) || pickCandidate(hostname, listed, job.file, now, nowSec) === null) {
        continue;
      }
      const estimate = model.estimate(hostname, job.file, bytes);
      if (estimate.measured) {
        measured.push([hostname, estimate.eta]);
        best = Math.min(best, estimate.eta);
      }
    }
    const owners = new Set<string>();
    for (let i = 0, len = measured.length; i < len; i++) {
      if (measured[i][1] <= best * ETA_BAND) {
        owners.add(measured[i][0]);
      }
    }
    return owners.size > 0 ? owners : null;
  }

  /** For one host: the signature it served last, else one of a family it accepts, else any, in turn */
  function pickCandidate(hostname: string, listed: readonly MediaCandidate[], file: MediaFile, now: number, nowSec: number) {
    const proven = model.provenAddress(hostname);
    const usable: MediaCandidate[] = [];
    for (let i = 0, len = listed.length; i < len; i++) {
      if (isCandidateUsable(listed[i], file, now, nowSec)) {
        if (listed[i].key === proven) {
          return listed[i];
        }
        usable.push(listed[i]);
      }
    }
    const accepted = usable.filter(candidate => model.acceptsFamily(hostname, candidate.family));
    const list = accepted.length > 0 ? accepted : usable;
    return list.length > 0 ? list[rotation % list.length] : null;
  }

  /** The player's own URL, the last resort, within its host's slots */
  function ownUrl(job: Job): HostOption | null {
    const { hostname } = job.requested;
    const active = busy.get(hostname) ?? 0;
    return active < HOST_CAP ? { hostname, candidate: job.requested, estimate: model.estimate(hostname, job.file, 0), active } : null;
  }

  // ---- Warm-up: every representation's init segment and index, ahead of the player

  function warmUp(_json: object, files: readonly MediaFile[]) {
    const now = performance.now();
    for (let i = 0, len = files.length; i < len; i++) {
      const file = files[i];
      if (file.segmentBase === null || headers.has(file.key) || !isPlayable(file)) {
        continue;
      }
      const candidates = player.candidates(file);
      // Its own last resort, as the browser would pick it
      const requested = defaultCandidate(candidates, file, now);
      if (requested === null) {
        continue;
      }
      const range: ByteRange = { start: 0, end: file.segmentBase.index.end };
      let settle: (ok: boolean) => void = noop;
      const ready = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      // Nothing ends synchronously: the entry is there before the job is over
      const job = start({ file, range, cls: RELAXED, timeout: 0, candidates, requested }, null);
      headers.set(file.key, { range, bytes: null, total: null, contentType: '', ready, settle, job });
      if (headers.size > MAX_HEADERS) {
        headers.delete(headers.keys().next().value!);
      }
    }
  }

  /** A request inside the init and index fetched ahead: served from them, as a copy */
  async function serveHeader(header: CachedHeader, params: JobParams, sink: SyntheticXhrSink) {
    const { file, range } = params;
    const waitedFrom = performance.now();
    const { job } = header;
    // The player asks for what a warm-up is still fetching: it becomes critical, and is raced
    if (job.cls !== CRITICAL && job.state === 'running') {
      job.cls = CRITICAL;
      job.deadline = waitedFrom;
      race(job);
    }
    // `ready` resolves true exactly when the bytes are there
    const ok = header.bytes !== null || await Promise.race([header.ready, wait(WARMUP_WAIT_MS).then(falseFn)]);
    if (sink.signal.aborted) {
      return;
    }
    if (process.env.DEBUG) {
      debugNote(`${file.kind} ${range.start}-${range.end}: ${ok ? 'served from the warm-up' : 'the warm-up did not come'} after ${Math.round(performance.now() - waitedFrom)} ms`);
    }
    if (!ok) {
      start(params, sink);
      return;
    }
    const length = byteRangeLength(range);
    const body = new unsafeWindow.ArrayBuffer(length);
    new unsafeWindow.Uint8Array(body).set(header.bytes!.subarray(range.start - header.range.start, range.end - header.range.start + 1));
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

  player.onPlayinfo(warmUp);

  return {
    type: 'serve',
    name: 'thread-ripper',
    serve({ ctx, range, file, candidates, requested }): XhrResponder | null {
      const now = performance.now();
      // Left to the browser: off after failures, not a single byte range, a file no playinfo listed,
      // a requested URL that is not acceptable (it is the last resort), too long, or failed just now
      if (
        integrityFailed || range === null || file === null || requested === null || now < offUntil
        || byteRangeLength(range) > MAX_SERVED_LENGTH
        || (nativeRetry.get(`${file.key}:${range.start}-${range.end}`) ?? 0) > now
      ) {
        return null;
      }

      const params: JobParams = {
        file,
        range,
        // The initialization segment and the index come first: nothing plays without them
        cls: file.segmentBase !== null && range.end <= file.segmentBase.index.end ? CRITICAL : URGENT,
        timeout: ctx.timeout,
        candidates,
        requested
      };
      const header = headers.get(file.key);
      if (header && range.start >= header.range.start && range.end <= header.range.end) {
        return (sink) => {
          serveHeader(header, params, sink).catch((e: unknown) => {
            logger.error('[thread-ripper] failed to serve from the warm-up', e);
            if (!sink.fallbackToNative()) {
              sink.error();
            }
          });
        };
      }
      return sink => start(params, sink);
    }
  };
}

/** Which job's waiting piece goes first: the more urgent, then the older */
function before(a: Job, b: Job) {
  return a.cls < b.cls || (a.cls === b.cls && a.createdAt < b.createdAt);
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
  return { end, frontier: start, attempts: new Set(), tries: 0, tried: new Set(), extra: 0, queued: false, final: false };
}

/**
 * Take a chunk an attempt received. Every attempt starts at or below its piece's frontier and the
 * frontier only moves forward, so a piece always holds a contiguous run: bytes below the frontier
 * were written by another attempt and are compared instead, bytes above it are written.
 *
 * - `overrun`: the attempt is past its piece's end (the piece is done or shrunk), stop it
 * - `mismatch`: two responses disagree about the file's content
 */
function writeChunk(job: Job, att: Attempt, chunk: Uint8Array): 'ok' | 'overrun' | 'mismatch' {
  const { seg, pos } = att;
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
    const now = performance.now();
    job.lastProgressAt = now;
    // One sample at or before the window's start stays, see `deliveredRate`
    const { meter } = job;
    meter.push([now, job.covered]);
    let stale = 0;
    while (stale < meter.length - 1 && meter[stale + 1][0] <= now - RATE_WINDOW_MS) {
      stale++;
    }
    meter.splice(0, stale);
  }
  att.pos = pos + usable;
  return usable < chunk.byteLength ? 'overrun' : 'ok';
}

/** Bytes written for the job over the last `RATE_WINDOW_MS`, per ms */
function deliveredRate(job: Job, now: number) {
  const { meter } = job;
  let base = meter[0];
  for (let i = 1, len = meter.length; i < len && meter[i][0] <= now - RATE_WINDOW_MS; i++) {
    base = meter[i];
  }
  return (job.covered - base[1]) / Math.max(1, now - base[0]);
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
 * Whether a receiving piece with one attempt needs relief: none while it finishes in time (by the
 * job's deadline less `slack`). Then, if it is slower than requests usually are, or than the host a
 * racer would go to (or that host was never measured); or, spending one of the job's rescues, if it
 * crawls (`straggler`) or will miss the deadline anyway (`stale`)
 */
function needsRelief(att: Attempt, now: number, typicalRate: number, alternativeOf: () => HostEstimate | null, slack: number): 'help' | 'straggler' | 'stale' | null {
  const { job, seg } = att;
  if (now - att.firstByteAt < 250) {
    return null;
  }
  const rate = recentRate(att, now);
  const eta = now + (seg.end - seg.frontier + 1) / rate;
  if (eta <= job.deadline - slack) {
    return null;
  }
  if (eta >= job.deadline && rate < 0.5 * typicalRate && eta - now >= 500 && job.rescues.straggler > 0) {
    return 'straggler';
  }
  if (rate < 0.6 * typicalRate) {
    return 'help';
  }
  const alternative = alternativeOf();
  if (alternative !== null && (!alternative.measured || alternative.rate > 1.5 * rate)) {
    return 'help';
  }
  return eta > job.deadline && job.rescues.stale > 0 ? 'stale' : null;
}

/** Finish this much before the deadline to count as in time */
function hedgeSlack(typicalTtfb: number) {
  return clamp(2 * typicalTtfb, 500, 1500);
}

/**
 * A speculative duplicate takes bandwidth from the pieces that matter: none while the job already
 * delivers `HEDGE_HEADROOM` times what the stream needs, none for a job whose last duplicate raised
 * nothing (the line is full), and the last one gets `RATE_WINDOW_MS` to show before the next
 */
function mayDuplicate(job: Job, now: number) {
  const rate = deliveredRate(job, now);
  const last = job.lastDuplicate;
  if (job.saturated || rate >= HEDGE_HEADROOM * job.requiredRate || (last !== null && now - last.at < RATE_WINDOW_MS)) {
    return false;
  }
  if (last !== null && last.rate > 0 && rate <= last.rate) {
    job.saturated = true;
    return false;
  }
  return true;
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
 * Among the hosts that may carry a piece: before anything is measured (and for relaxed work,
 * exploring) the least busy unmeasured one; a small piece, or a request in one piece, to the one
 * expected to finish first; otherwise the least busy
 */
function choosePrimary(options: HostOption[], job: Job, bytes: number): HostOption {
  const unmeasured = options.filter(option => !option.estimate.measured);
  if (unmeasured.length === options.length || (job.cls === RELAXED && unmeasured.length > 0)) {
    return leastBusy(preferred(unmeasured));
  }
  return bytes < SMALL_PIECE || job.segments.length === 1 ? fastest(options) : leastBusy(options);
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

/** Skip what this browser won't play: `disable-av1` makes AV1 one of them */
function isPlayable(file: MediaFile) {
  if (!('MediaSource' in unsafeWindow) || !file.mimeType) {
    return true;
  }
  try {
    return unsafeWindow.MediaSource.isTypeSupported(file.codecs ? `${file.mimeType}; codecs="${file.codecs}"` : file.mimeType);
  } catch {
    return true;
  }
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
