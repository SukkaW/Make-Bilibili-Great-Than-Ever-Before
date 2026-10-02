import { clamp } from 'foxts/clamp';
import { falseFn, noop } from 'foxts/noop';
import { split0th } from 'foxts/split-nth';
import { wait } from 'foxts/wait';
import { p, p50 } from 'fast-percentile';
import { logger } from '../../logger';
import type { MediaServePhase, MediaXhrRequest } from '../../core/player';
import { CandidateTier, defaultCandidate, isCandidateUsable } from '../../core/player/candidates';
import type { MediaCandidate } from '../../core/player/candidates';
import { MediaOutcome, MIN_RATE_SAMPLE_BYTES } from '../../core/player/host-model';
import type { HostEstimate } from '../../core/player/host-model';
import type { ByteRange } from '../../core/player/range';
import { byteRangeLength, parseContentRange } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import type { MakeBilibiliGreatThanEverBeforeHook, XhrResponder } from '../../types';
import type { SyntheticXhrSink } from '../../utils/xhr-override';
import { classifyError, classifyResponse, hostnameOf, isRetryable } from './classify';
import {
  COMMIT_TIMEOUT_MS, CRITICAL, GLOBAL_CAP, HEDGE_HEADROOM, HOST_CAP, JOB_STALL_MS, KiB, MAX_SERVED_LENGTH,
  MAX_TRIES_PER_SEGMENT, MiB, NORMAL, RATE_WINDOW_MS, RELAXED, TICK_MS, TOP_HOSTS, URGENT, URGENT_RESERVE,
  planPieceCount
} from './policy';
import { createJob, deliveredRate, isJobComplete, isSegmentComplete, planSegments, splitSegment, writeChunk } from './range-job';
import type { Attempt, AttemptRole, HostState, Job, Segment } from './types';

/** After a failed job, the player's retry of the same range goes to the browser */
const NATIVE_RETRY_MS = 30 * 1000;
/** A file that failed twice after commit goes to the browser for a while */
const NATIVE_ONLY_MS = 2 * 60 * 1000;
/** Too many failures in a row: stop serving for a while */
const ENGINE_OFF_MS = 30 * 1000;
const FAILURE_WINDOW_MS = 60 * 1000;
const FAILURES_TO_TURN_OFF = 3;
/** Duplicates started per segment at most */
const MAX_EXTRA = 2;
/** A racer this far behind the leader is only comparing bytes */
const LAGGARD_BYTES = 64 * KiB;
/** A request waits this long for a warm-up still on its way, then fetches by itself */
const WARMUP_WAIT_MS = 1500;
/** Init segments and indexes kept, the oldest dropped first */
const MAX_HEADERS = 64;
/** A piece this small is about latency, not throughput: pick by expected finish time */
const SMALL_UNIT = 256 * KiB;
/**
 * A primary goes only to a host expected to finish its piece within this factor of the best one:
 * a slower host would only make the job wait for its piece. Real sessions of a viewer whose own
 * host was the fastest got slower when pieces went to hosts up to 12x slower. Beating a per-request
 * throttle takes more requests, not more hosts: several go to the same good host
 */
const ETA_BAND = 1.25;
/** Speed samples of transfers cut short count less */
const PARTIAL_SAMPLE_BYTES = 16 * KiB;
/** Scales the soft and hard thresholds: critical work is helped sooner */
const URGENCY_FACTOR = [0.7, 0.85, 1, 2] as const;
/** Neither half of a split is smaller */
const STEAL_MIN = 192 * KiB;

/** The gaps between an attempt's chunks are reported as their 90th percentile */
const p90 = p(90);

interface JobParams {
  file: MediaFile,
  pathname: string,
  range: ByteRange,
  header: boolean,
  warmup: boolean,
  /** The player's own XHR timeout, `0` for none: the clock for handing a request back before commit */
  timeout: number,
  /** Every acceptable URL of the file */
  candidates: readonly MediaCandidate[],
  requested: MediaCandidate
}

/** Work waiting for a slot */
interface Unit {
  readonly job: Job,
  readonly seg: Segment,
  readonly role: AttemptRole,
  readonly seq: number,
  /** Bypass host selection: the player's own URL as the last resort */
  readonly forced: { hostname: string, candidate: MediaCandidate } | null
}

/** A host that could take a piece, with the URL it would get and what it is expected to do */
interface HostOption {
  host: HostState,
  candidate: MediaCandidate,
  estimate: HostEstimate
}

/** A file's initialization segment and index, fetched ahead of the player */
interface CachedHeader {
  readonly range: ByteRange,
  bytes: Uint8Array | null,
  total: number | null,
  contentType: string,
  /** Settles when the fetch is over: `true` with bytes, `false` without */
  readonly ready: Promise<boolean>,
  settle(this: void, ok: boolean): void
}

let attemptSequence = 0;

/**
 * The serve phase: a media range the player asks for is split into pieces, fetched from many
 * interchangeable CDN hosts at once, checked, and put together as the XHR's response.
 */
export function createThreadRipper(player: MakeBilibiliGreatThanEverBeforeHook['player'], nativeFetch: typeof fetch): MediaServePhase {
  const model = player.hosts;
  const jobs = new Set<Job>();
  /** file key -> its warm-up job, while it runs */
  const warmups = new Map<string, Job>();
  /** file key -> init segment and index, insertion ordered: the oldest goes first */
  const headers = new Map<string, CachedHeader>();
  /** file key -> file size, as every host must agree on it */
  const totals = new Map<string, number>();
  const nativeRetry = new Map<string, number>();
  const nativeOnly = new Map<string, number>();
  const postCommitFailures = new Map<string, number>();
  let recentFailures: number[] = [];
  let offUntil = 0;
  let integrityFailed = false;

  /** Every host's slots: what is known about it lives in the shared host model */
  const slots = new Map<string, HostState>();
  let rotation = 0;

  /** Earliest deadline first, within `GLOBAL_CAP`, a few slots reserved for urgent work */
  let queue: Unit[] = [];
  const queuedDuplicates = new Set<Segment>();
  const running = new Set<Attempt>();
  let unitSequence = 0;
  let pumping = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  // ---- Jobs: start, finish, fail

  /** Debug builds: what thread-ripper does, in the console and in the video's startup trace (`metrics.ts`) */
  function debugNote(file: MediaFile | null, text: string) {
    if (process.env.DEBUG) {
      logger.debug(`[thread-ripper] ${text}`);
      player.metrics?.note(file, `thread-ripper: ${text}`);
    }
  }

  /** Leave a media XHR to the browser, saying why in debug builds */
  function declined(reason: string, request: MediaXhrRequest): null {
    if (process.env.DEBUG) {
      debugNote(request.match?.file ?? null, `left to the browser: ${reason} (${request.ctx.url})`);
    }
    return null;
  }

  function start(params: JobParams, sink: SyntheticXhrSink | null) {
    const now = performance.now();
    const job = createJob({ ...params, cls: URGENT, total: totals.get(params.file.key) ?? null, sink });
    jobs.add(job);
    if (job.warmup) {
      warmups.set(job.file.key, job);
    }
    sink?.signal.addEventListener('abort', () => {
      if (job.state === 'running') {
        stop(job, 'canceled');
      }
    }, { once: true });

    // How urgent the job is, for its whole life: the init segment and index first (nothing plays
    // without them), then what the player asked for, last the warm-up of what it may never ask for
    if (job.warmup) {
      job.cls = RELAXED;
      job.deadline = job.createdAt + 5000;
    } else if (job.header) {
      job.cls = CRITICAL;
      job.deadline = job.createdAt;
    } else {
      job.cls = URGENT;
      job.deadline = job.createdAt + 1500;
    }

    // No more pieces than the hosts worth a primary can carry
    const pieces = planPieceCount(
      job.length,
      model.typicalRate(job.file, now),
      model.typicalTtfb(job.file, now),
      ownersOf(job, Math.min(job.length, MiB), now)?.size ?? usableHostCount(job)
    );
    planSegments(job, pieces);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      enqueue(job, job.segments[i]);
    }
    if (pieces === 1) {
      raceAll(job);
    }
    if (process.env.DEBUG) {
      debugNote(job.file, `#${job.id} ${job.warmup ? 'warm-up ' : ''}${job.kind} ${Math.round(job.length / KiB)} KiB started: ${pieces} piece(s); ${running.size} requests running, ${queue.length} queued`);
    }
  }

  /**
   * Race every piece on a few hosts at once: 3 when critical, 2 when urgent. A slow first byte is
   * covered from the start, the losers go as soon as it is decided (`settleRace`), and with nothing
   * measured yet, racing is also how hosts get measured
   */
  function raceAll(job: Job) {
    let width = 1;
    if (job.cls === CRITICAL) {
      width = 3;
    } else if (job.cls === URGENT) {
      width = 2;
    }
    width = Math.min(width, usableHostCount(job));
    for (let i = 0, len = job.segments.length; i < len; i++) {
      for (let j = 1; j < width; j++) {
        enqueue(job, job.segments[i], 'dup');
      }
    }
  }

  function stop(job: Job, result: 'done' | 'fallback' | 'failed' | 'canceled') {
    job.state = result === 'done' ? 'done' : 'failed';
    jobs.delete(job);
    if (warmups.get(job.file.key) === job) {
      warmups.delete(job.file.key);
    }
    // Stop everything the job has queued or in flight, except attempts already past their end
    const removed = queue.filter(unit => unit.job === job);
    for (let i = 0, len = removed.length; i < len; i++) {
      dequeue(removed[i]);
    }
    for (const att of running) {
      if (att.job === job && att.pos <= att.seg.end) {
        abortAttempt(att, MediaOutcome.Canceled);
      }
    }
    if (process.env.DEBUG) {
      let retries = 0;
      let duplicates = 0;
      for (let i = 0, len = job.segments.length; i < len; i++) {
        retries += job.segments[i].tries;
        duplicates += job.segments[i].extra;
      }
      player.metrics?.recordJob(job.file, {
        result,
        warmup: job.warmup,
        bytes: job.length,
        fetchedBytes: job.fetched,
        pieces: job.segments.length,
        duplicates,
        retries,
        hosts: job.hostsUsed.size
      });
      if (result === 'done') {
        const ms = Math.round(performance.now() - job.createdAt);
        debugNote(job.file, `#${job.id} ${job.warmup ? 'warm-up ' : ''}${job.kind} ${Math.round(job.length / KiB)} KiB in ${ms} ms (${Math.round(job.covered / KiB / Math.max(ms, 1) * 1000)} KiB/s), ${job.segments.length} pieces via ${Array.from(job.hostsUsed).join(', ')}${retries ? `, ${retries} retries` : ''}${duplicates ? `, ${duplicates} duplicates` : ''}`);
      }
    }
  }

  function complete(job: Job) {
    if (job.state !== 'running') {
      return;
    }
    stop(job, 'done');
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

  /** A warm-up failed: nothing to serve from, the next request fetches it the normal way */
  function dropHeader(fileKey: string) {
    const header = headers.get(fileKey);
    if (header?.bytes === null) {
      headers.delete(fileKey);
      header.settle(false);
    }
  }

  function recordFailure() {
    const now = performance.now();
    recentFailures = recentFailures.filter(at => now - at < FAILURE_WINDOW_MS);
    recentFailures.push(now);
    if (recentFailures.length >= FAILURES_TO_TURN_OFF) {
      offUntil = now + ENGINE_OFF_MS;
      recentFailures = [];
      logger.warn(`[thread-ripper] ${FAILURES_TO_TURN_OFF} failures within a minute, leaving media requests to the browser for 30 seconds`);
    }
  }

  /** Before commit: the browser sends the request itself, nothing is lost */
  function fallback(job: Job, reason: string) {
    stop(job, 'fallback');
    if (!job.sink) {
      dropHeader(job.file.key);
      return;
    }
    recordFailure();
    logger.warn(`[thread-ripper] #${job.id} handed back to the browser: ${reason}`, { pathname: job.pathname, range: job.range });
    player.metrics?.note(job.file, `thread-ripper: #${job.id} handed back to the browser: ${reason}`);
    if (!job.sink.fallbackToNative()) {
      job.sink.error();
    }
  }

  /** After commit: the XHR fails, and the player's retry goes to the browser */
  function fail(job: Job, reason: string) {
    const now = performance.now();
    stop(job, 'failed');
    if (!job.sink) {
      dropHeader(job.file.key);
      return;
    }
    recordFailure();
    nativeRetry.set(`${job.pathname}:${job.range.start}-${job.range.end}`, now + NATIVE_RETRY_MS);
    const failures = (postCommitFailures.get(job.pathname) ?? 0) + 1;
    postCommitFailures.set(job.pathname, failures);
    if (failures >= 2) {
      nativeOnly.set(job.pathname, now + NATIVE_ONLY_MS);
    }
    logger.error(`[thread-ripper] #${job.id} failed: ${reason}`, { pathname: job.pathname, range: job.range });
    job.sink.error();
  }

  // ---- Attempts: one ranged fetch from one host

  async function fetchRange(att: Attempt): Promise<MediaOutcome> {
    const { job } = att;
    let response: Response;
    try {
      response = await nativeFetch(att.url, {
        method: 'GET',
        // The only author header: Range is CORS-safelisted, no preflight
        headers: { Range: `bytes=${att.rangeStart}-${att.rangeEnd}` },
        mode: 'cors',
        // What the page's XHR uses (withCredentials = false), so connections are shared with it
        credentials: 'same-origin',
        // Like the page's XHR. `no-store` would add `Cache-Control: no-cache` and `Pragma: no-cache`,
        // which upos hosts ignore but Akamai may honour by going upstream
        cache: 'default',
        // Like the page's XHR. A redirect is not necessarily a P2P CDN: Akamai may send to an edge,
        // an extension may clean the URL (AdGuard's 307). One landing on a P2P CDN is refused
        // (`classifyResponse`)
        redirect: 'follow',
        referrerPolicy: 'strict-origin-when-cross-origin',
        priority: job.cls === CRITICAL || job.cls === URGENT ? 'high' : 'auto',
        signal: att.controller.signal
      });
    } catch (e) {
      return classifyError(e, att.abortReason, att.bytes, false, performance.now() - att.startedAt);
    }

    att.headersAt = performance.now();
    if (response.redirected) {
      att.redirectedTo = hostnameOf(response.url);
    }
    const contentLength = Number(response.headers.get('content-length'));
    const verdict = classifyResponse(
      response,
      parseContentRange(response.headers.get('content-range')),
      Number.isSafeInteger(contentLength) && response.headers.has('content-length') ? contentLength : null,
      { start: att.rangeStart, end: att.rangeEnd, total: job.total, addressExpired: att.candidate.deadline !== 0 && att.candidate.deadline * 1000 <= Date.now() }
    );
    if (verdict.outcome !== MediaOutcome.Ok) {
      response.body?.cancel().catch(noop);
      return verdict.outcome;
    }
    if (!response.body) {
      return MediaOutcome.Truncated;
    }
    onValidResponse(att, response, verdict.total);

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
        // The segment's end moves in when its tail is handed to another attempt
        if (written === 'overrun') {
          // The rest of this range is taken care of (or the job is over)
          att.abortReason ??= MediaOutcome.Canceled;
          reader.cancel().catch(noop);
          return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Canceled;
        }
        if (att.pos > att.seg.end) {
          // All asked for is here: don't wait for the stream to close
          reader.cancel().catch(noop);
          return MediaOutcome.Ok;
        }
      }
    } catch (e) {
      return classifyError(e, att.abortReason, att.bytes, true, performance.now() - att.startedAt);
    } finally {
      reader.releaseLock();
    }
    return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Truncated;
  }

  function onValidResponse(att: Attempt, response: Response, total: number | null) {
    const { job } = att;
    if (job.state !== 'running') {
      return;
    }
    if (total !== null && job.total === null) {
      job.total = total;
      totals.set(job.file.key, total);
    }
    if (job.committed) {
      return;
    }
    job.committed = true;
    job.contentType = response.headers.get('content-type') ?? '';
    if (!job.sink) {
      return;
    }
    /** What a native response would expose, for the whole range */
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
    const { job } = att;
    model.noteBytes(performance.now());
    const { result } = writeChunk(job, att, chunk);
    job.fetched += chunk.byteLength;
    if (result !== 'mismatch' && job.state === 'running') {
      job.hostsUsed.add(att.host.hostname);
      job.sink?.progress(job.covered, job.length);
      if (isSegmentComplete(att.seg)) {
        // The race is over for this piece
        for (const other of att.seg.attempts) {
          if (other !== att) {
            abortAttempt(other, MediaOutcome.Canceled);
          }
        }
        if (isJobComplete(job)) {
          complete(job);
        }
      }
    }
    return result;
  }

  function onAttemptEnd(att: Attempt, outcome: MediaOutcome) {
    const { job, seg } = att;
    if (process.env.DEBUG) {
      const received = att.bytes - att.firstChunkBytes;
      player.metrics?.recordAttempt(job.file, {
        hostname: att.host.hostname,
        bytes: att.bytes,
        ttfbMs: att.headersAt === 0 ? null : att.headersAt - att.startedAt,
        rateKiBps: received >= MIN_RATE_SAMPLE_BYTES && att.lastByteAt > att.firstByteAt ? received / KiB / (att.lastByteAt - att.firstByteAt) * 1000 : null,
        outcome,
        redirectedTo: att.redirectedTo
      });
    }

    if (outcome === MediaOutcome.Integrity) {
      integrityFailed = true;
      logger.error('[thread-ripper] two CDN hosts sent different bytes for the same range, leaving media requests to the browser from now on', { url: att.url });
      if (job.state === 'running') {
        fail(job, 'integrity');
      }
      return;
    }
    if (job.state !== 'running') {
      return;
    }
    if (isJobComplete(job)) {
      complete(job);
      return;
    }
    if (isSegmentComplete(seg) || seg.queued) {
      return;
    }
    if (seg.attempts.size > 0) {
      // A racer is still on the piece. It covers a lost race, but not a failed primary: left to a
      // racer on a worse host, the piece would crawl to the player's timeout. A fresh primary joins,
      // and settling keeps whichever is ahead
      if (att.role === 'primary' && outcome !== MediaOutcome.Canceled && isRetryable(outcome) && !seg.final) {
        seg.tries++;
        if (process.env.DEBUG) {
          debugNote(job.file, `#${job.id} piece ${seg.index} ${outcome} on ${att.host.hostname} after ${Math.round(performance.now() - att.startedAt)} ms, a racer still on it: fresh primary`);
        }
        enqueue(job, seg);
      }
      return;
    }

    if (outcome !== MediaOutcome.Canceled && !isRetryable(outcome)) {
      if (job.committed) {
        fail(job, outcome);
      } else {
        fallback(job, outcome);
      }
      return;
    }
    if (seg.final) {
      // The last resort failed as well
      fail(job, `piece ${seg.index} failed on the player's own URL too, last: ${outcome}`);
      return;
    }
    // Canceled by us (a race settled, a tail stolen) is no failure of the piece
    if (outcome !== MediaOutcome.Canceled) {
      seg.tries++;
      if (process.env.DEBUG) {
        debugNote(job.file, `#${job.id} piece ${seg.index} ${outcome} on ${att.host.hostname} after ${Math.round(performance.now() - att.startedAt)} ms (${att.bytes} bytes), try ${seg.tries}`);
      }
    }
    if (seg.tries < MAX_TRIES_PER_SEGMENT) {
      enqueue(job, seg);
      return;
    }
    if (!job.committed) {
      fallback(job, `piece ${seg.index} failed ${seg.tries} times, last: ${outcome}`);
      return;
    }
    // Last resort: exactly what the player asked for
    seg.final = true;
    enqueue(job, seg, 'final', { hostname: job.requested.hostname, candidate: job.requested });
  }

  // ---- Scheduling: queue, slots, attempts in flight

  /** Queue work on a segment. One primary and one duplicate per segment wait at most */
  function enqueue(job: Job, seg: Segment, role: AttemptRole = 'primary', forced: Unit['forced'] = null) {
    if (role === 'dup') {
      if (queuedDuplicates.has(seg)) {
        return;
      }
      queuedDuplicates.add(seg);
    } else {
      if (seg.queued) {
        return;
      }
      seg.queued = true;
    }
    queue.push({ job, seg, role, seq: ++unitSequence, forced });
    tickTimer ??= setInterval(tick, TICK_MS);
    pump();
  }

  function dequeue(unit: Unit) {
    queue = queue.filter(item => item !== unit);
    if (unit.role === 'dup') {
      queuedDuplicates.delete(unit.seg);
    } else {
      unit.seg.queued = false;
    }
  }

  function pump() {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      const blocked = new Set<Unit>();
      while (running.size < GLOBAL_CAP) {
        let best: Unit | null = null;
        for (let i = 0, len = queue.length; i < len; i++) {
          const unit = queue[i];
          if (!blocked.has(unit) && (best === null || before(unit, best) < 0)) {
            best = unit;
          }
        }
        if (best === null) {
          break;
        }
        // Leave room for what is urgent
        if (running.size >= GLOBAL_CAP - URGENT_RESERVE && best.job.cls > URGENT) {
          break;
        }
        const unit = best;
        const stale = unit.job.state !== 'running' || isSegmentComplete(unit.seg)
          // A duplicate is pointless once its segment has nothing left in flight to race
          || (unit.role === 'dup' && unit.seg.attempts.size === 0);
        if (stale) {
          dequeue(unit);
          continue;
        }
        const target = unit.forced
          ? { host: getHost(unit.forced.hostname), candidate: unit.forced.candidate }
          : pickHost(unit.job, unit.seg, unit.role);
        if (target === null) {
          blocked.add(unit);
          continue;
        }
        dequeue(unit);
        launch(unit, target.host, target.candidate);
      }
    } finally {
      pumping = false;
    }

    // Hosts cool down and slots free up: come back for what is still waiting
    if (retryTimer === null && queue.length > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        pump();
      }, 100);
    }
  }

  function launch(unit: Unit, host: HostState, candidate: MediaCandidate) {
    const { job, seg, role } = unit;
    const now = performance.now();
    const att: Attempt = {
      id: ++attemptSequence,
      job,
      seg,
      host,
      candidate,
      url: candidate.href,
      role,
      rangeStart: seg.frontier,
      rangeEnd: seg.end,
      controller: new AbortController(),
      abortReason: null,
      cold: model.isCold(host.hostname, now),
      timeouts: model.timeouts(host.hostname, job.file, now),
      startedAt: now,
      headersAt: 0,
      redirectedTo: null,
      firstByteAt: 0,
      firstChunkBytes: 0,
      lastByteAt: 0,
      bytes: 0,
      pos: seg.frontier,
      meter: [],
      gaps: []
    };
    host.active++;
    running.add(att);
    seg.attempts.add(att);
    seg.tried.add(host.hostname);
    if (role === 'dup') {
      seg.extra++;
    }
    tickTimer ??= setInterval(tick, TICK_MS);
    // Only what follows a failure: every launch would flood the startup trace
    if (process.env.DEBUG && (role === 'final' || seg.tries > 0)) {
      debugNote(job.file, `#${job.id} piece ${seg.index} ${role} -> ${host.hostname} (${att.rangeStart}-${att.rangeEnd}, ${seg.attempts.size} on it)`);
    }

    void (async () => {
      let outcome: MediaOutcome;
      try {
        outcome = await fetchRange(att);
      } catch (e) {
        logger.error('[thread-ripper] attempt crashed', e);
        outcome = MediaOutcome.Network;
      }
      host.active--;
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

  function abortAttempt(att: Attempt, reason: NonNullable<Attempt['abortReason']>) {
    if (att.abortReason === null) {
      att.abortReason = reason;
      att.controller.abort();
    }
  }

  /**
   * A hard timeout only kills an attempt when another host can take over. When none can (every
   * other host is cooling down), the request is left alone: killing it would only hand the piece to
   * whatever racer is on it, and that racer is there because it was the worse choice
   */
  function canGiveUp(att: Attempt, now: number) {
    return att.seg.attempts.size > 1
      || bestAlternative(att.job, att.seg) !== null
      || now - att.startedAt > JOB_STALL_MS;
  }

  /** Every `TICK_MS` while there is work: hard timeouts, the job clocks, hedging, the endgame */
  function tick() {
    const now = performance.now();
    for (const att of running) {
      if (att.abortReason !== null) {
        continue;
      }
      const factor = URGENCY_FACTOR[att.job.cls];
      if (att.firstByteAt === 0) {
        if (now - att.startedAt > att.timeouts.ttfbHard * factor && canGiveUp(att, now)) {
          abortAttempt(att, MediaOutcome.TtfbTimeout);
        }
      } else if (now - att.lastByteAt > att.timeouts.stallHard * factor && canGiveUp(att, now)) {
        abortAttempt(att, MediaOutcome.Stall);
      }
    }

    try {
      const idle = running.size < GLOBAL_CAP && queue.length === 0;
      for (const job of jobs) {
        if (job.state === 'running') {
          tickJob(job, now);
        }
      }
      if (idle) {
        endgame(now);
      }
    } catch (e) {
      logger.error('[thread-ripper] tick failed', e);
    }

    if (tickTimer !== null && running.size === 0 && queue.length === 0 && jobs.size === 0) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function tickJob(job: Job, now: number) {
    if (!job.committed) {
      // Never hand back while a host is left to try, except to leave the browser the other half of
      // the player's own timeout
      if (now - job.createdAt > (job.timeout > 0 ? job.timeout / 2 : COMMIT_TIMEOUT_MS)) {
        fallback(job, 'no CDN host answered in time');
        return;
      }
    } else if (now - job.lastProgressAt > JOB_STALL_MS) {
      let forced = false;
      for (let i = 0, len = job.segments.length; i < len; i++) {
        const seg = job.segments[i];
        if (!isSegmentComplete(seg) && !seg.final) {
          seg.final = true;
          forced = true;
          for (const att of seg.attempts) {
            abortAttempt(att, MediaOutcome.Stall);
          }
          enqueue(job, seg, 'final', { hostname: job.requested.hostname, candidate: job.requested });
        }
      }
      if (forced) {
        if (process.env.DEBUG) {
          debugNote(job.file, `#${job.id}: no progress for ${JOB_STALL_MS} ms, unfinished pieces go to the player's own URL`);
        }
        job.lastProgressAt = now;
      } else {
        fail(job, 'no progress');
      }
      return;
    }

    const typicalRate = model.typicalRate(job.file, now);
    const slack = hedgeSlack(model.typicalTtfb(job.file, now));
    for (let i = 0, len = job.segments.length; i < len; i++) {
      const seg = job.segments[i];
      if (isSegmentComplete(seg)) {
        continue;
      }
      if (seg.attempts.size > 1) {
        settleRace(seg);
        continue;
      }
      const att = firstOfSet(seg.attempts);
      if (att?.abortReason !== null || queuedDuplicates.has(seg) || seg.extra >= MAX_EXTRA) {
        continue;
      }
      const decision = decideHelp(att, seg, job, now, typicalRate, bestAlternative(job, seg), slack);
      if (decision !== 'none') {
        const factor = URGENCY_FACTOR[job.cls];
        const stuck = att.firstByteAt === 0
          ? now - att.startedAt >= att.timeouts.ttfbSoft * factor
          : now - att.lastByteAt >= att.timeouts.stallSoft * factor;
        help(job, seg, att, decision, now, stuck);
      }
    }
  }

  // ---- Hedging: help a piece that falls behind

  /**
   * Split a piece so both halves finish together, or add a duplicate. A duplicate for a piece that
   * is `stuck` (no first byte, or no new byte, past its soft threshold) is a rescue and always goes;
   * one for a piece merely expected to go faster elsewhere is speculation, and `mayDuplicate` decides
   */
  function help(job: Job, seg: Segment, att: Attempt, kind: 'dup' | 'split', now: number, stuck = false) {
    const alternative = bestAlternative(job, seg);
    if (alternative === null) {
      return;
    }
    if (kind === 'split') {
      const at = splitPoint(seg, recentRate(att, now), alternative.ttfb, alternative.rate);
      if (at !== null) {
        enqueue(job, splitSegment(job, seg, at));
        return;
      }
    }
    if (seg.extra < MAX_EXTRA && (stuck || mayDuplicate(job, now))) {
      job.lastDuplicate = { at: now, rate: deliveredRate(job, now) };
      enqueue(job, seg, 'dup');
    }
  }

  /**
   * A race is for the first byte. Once both racers are receiving, the one behind only competes
   * with the leader for the same line and bytes: it goes, whatever the speeds. One still without
   * a first byte goes once the leader has `LAGGARD_BYTES`. On a thin line two racers share it at
   * the same speed, so waiting for the slower one would keep both to the end
   */
  function settleRace(seg: Segment) {
    let leader: Attempt | null = null;
    for (const att of seg.attempts) {
      if (leader === null || att.pos > leader.pos) {
        leader = att;
      }
    }
    if (leader === null) {
      return;
    }
    for (const att of seg.attempts) {
      if (att === leader || att.abortReason !== null) {
        continue;
      }
      const lagging = att.firstByteAt === 0 ? leader.bytes >= LAGGARD_BYTES : att.pos < leader.pos;
      if (lagging) {
        abortAttempt(att, MediaOutcome.Canceled);
      }
    }
  }

  /** Free slots and nothing queued: take the slowest piece's tail, or race it */
  function endgame(now: number) {
    let target: { att: Attempt, remainingMs: number } | null = null;
    const etas: number[] = [];
    for (const att of running) {
      const { job, seg } = att;
      if (job.state !== 'running' || seg.attempts.size !== 1 || att.abortReason !== null || isSegmentComplete(seg)) {
        continue;
      }
      const rate = recentRate(att, now);
      const remainingMs = rate > 0 ? (seg.end - seg.frontier + 1) / rate : Infinity;
      etas.push(remainingMs);
      if (target === null || remainingMs > target.remainingMs) {
        target = { att, remainingMs };
      }
    }
    if (target === null || queuedDuplicates.has(target.att.seg)) {
      return;
    }
    const { att, remainingMs } = target;
    const { job, seg } = att;
    if (seg.end - seg.frontier + 1 >= 2 * STEAL_MIN) {
      // Taking a tail wastes nothing
      help(job, seg, att, 'split', now);
      return;
    }
    const slack = hedgeSlack(model.typicalTtfb(job.file, now));
    if (remainingMs > Math.max(300, 1.3 * p50(etas)) || now + remainingMs > job.deadline - slack) {
      help(job, seg, att, 'dup', now);
    }
  }

  // ---- Hosts: which one takes a piece

  function getHost(hostname: string): HostState {
    let host = slots.get(hostname);
    if (host === undefined) {
      host = { hostname, active: 0, credit: 0 };
      slots.set(hostname, host);
    }
    return host;
  }

  /**
   * For one host: the signature it served last, else one of a family it accepts, spread over the
   * file's signatures
   */
  function pickCandidate(hostname: string, job: Job, now: number, nowSec: number): MediaCandidate | null {
    const proven = model.provenAddress(hostname);
    const listed = job.candidates.get(hostname) ?? [];
    const usable: MediaCandidate[] = [];
    for (let i = 0, len = listed.length; i < len; i++) {
      const candidate = listed[i];
      if (isCandidateUsable(candidate, job.file, now, nowSec)) {
        if (candidate.key === proven) {
          return candidate;
        }
        usable.push(candidate);
      }
    }
    if (usable.length === 0) {
      return null;
    }
    const accepted = usable.filter(candidate => model.acceptsFamily(hostname, candidate.family));
    const list = accepted.length > 0 ? accepted : usable;
    return list[rotation++ % list.length];
  }

  /** Whether any of the job's URLs on this host could be used now: no side effect, unlike `pickCandidate` */
  function hasUsableCandidate(hostname: string, job: Job, now: number, nowSec: number) {
    const listed = job.candidates.get(hostname) ?? [];
    for (let i = 0, len = listed.length; i < len; i++) {
      if (isCandidateUsable(listed[i], job.file, now, nowSec)) {
        return true;
      }
    }
    return false;
  }

  /** Hosts that could serve the job now: not cooling down, with a URL it would accept */
  function usableHostCount(job: Job) {
    const now = performance.now();
    const nowSec = Date.now() / 1000;
    let count = 0;
    for (const hostname of job.candidates.keys()) {
      if (!model.isCoolingDown(hostname, now) && hasUsableCandidate(hostname, job, now, nowSec)) {
        count++;
      }
    }
    return count;
  }

  /** Hosts that could take a request for this segment right now, of `only` if given */
  function eligible(job: Job, seg: Segment, role: AttemptRole, now: number, only: ReadonlySet<string> | null = null): HostOption[] {
    const nowSec = Date.now() / 1000;
    const names = Array.from(job.candidates.keys());
    const busyOnSegment = new Set<string>();
    for (const att of seg.attempts) {
      busyOnSegment.add(att.host.hostname);
    }
    const bytes = seg.end - seg.frontier + 1;

    const collect = (skipTried: boolean) => {
      const options: HostOption[] = [];
      for (let i = 0, len = names.length; i < len; i++) {
        const hostname = names[i];
        const host = getHost(hostname);
        if (
          host.active >= HOST_CAP
          || (only !== null && !only.has(hostname))
          || model.isCoolingDown(hostname, now)
          || model.isExcluded(hostname, job.file, now)
          || (role === 'dup' && busyOnSegment.has(hostname))
          || (skipTried && seg.tried.has(hostname))
        ) {
          continue;
        }
        const candidate = pickCandidate(hostname, job, now, nowSec);
        if (candidate !== null) {
          options.push({ host, candidate, estimate: model.estimate(hostname, job.file, bytes, now) });
        }
      }
      return options;
    };

    const options = collect(true);
    // Every usable host was tried for this segment already: all of them again
    return options.length > 0 || seg.tried.size === 0 ? options : collect(false);
  }

  /**
   * The hosts a piece of `bytes` may go to on its own, busy or not: the measured ones expected to
   * finish it within `ETA_BAND` of the best, and the player's own until it is measured. On a slower
   * host the whole request would wait for that piece, so when these are all busy it waits for a
   * slot instead; other hosts race it, and join once measured fast. `null` when none can take it
   */
  function ownersOf(job: Job, bytes: number, now: number): Set<string> | null {
    const nowSec = Date.now() / 1000;
    const owners = new Set<string>();
    const measured: Array<[hostname: string, eta: number]> = [];
    let soonest = Infinity;
    for (const hostname of job.candidates.keys()) {
      if (model.isCoolingDown(hostname, now) || model.isExcluded(hostname, job.file, now) || !hasUsableCandidate(hostname, job, now, nowSec)) {
        continue;
      }
      const estimate = model.estimate(hostname, job.file, bytes, now);
      if (estimate.measured) {
        measured.push([hostname, estimate.eta]);
        soonest = Math.min(soonest, estimate.eta);
      } else if (hostname === job.requested.hostname) {
        owners.add(hostname);
      }
    }
    for (let i = 0, len = measured.length; i < len; i++) {
      if (measured[i][1] <= soonest * ETA_BAND) {
        owners.add(measured[i][0]);
      }
    }
    return owners.size > 0 ? owners : null;
  }

  function pickHost(job: Job, seg: Segment, role: AttemptRole): { host: HostState, candidate: MediaCandidate } | null {
    const now = performance.now();
    const bytes = seg.end - seg.frontier + 1;
    // Duplicates race anywhere, relaxed work explores
    const owners = role === 'dup' || job.cls === RELAXED ? null : ownersOf(job, bytes, now);
    const options = eligible(job, seg, role, now, owners);
    if (options.length === 0) {
      return null;
    }
    const chosen = role === 'dup' ? chooseDuplicate(options, job) : choosePrimary(options, job, bytes);
    if (seg.tried.has(chosen.host.hostname)) {
      // Every usable host was tried: a new round starts with this one
      seg.tried.clear();
    }
    return { host: chosen.host, candidate: chosen.candidate };
  }

  /** The best host a duplicate or a split of this segment would go to */
  function bestAlternative(job: Job, seg: Segment): HostEstimate | null {
    const options = eligible(job, seg, 'dup', performance.now());
    if (options.length === 0) {
      return null;
    }
    return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best)).estimate;
  }

  /** What the attempt's end says about its host, into the shared host model */
  function learn(att: Attempt, outcome: MediaOutcome) {
    const { host, candidate, job } = att;
    const now = performance.now();

    // Other requests still flowing on the host: a failure was this connection's, not the host's
    model.recordOutcome(host.hostname, job.file, candidate, outcome, now, host.active > 0);

    // What the attempt says about the host's speed, even when cut short
    const received = att.bytes - att.firstChunkBytes;
    const measuredRate = att.lastByteAt > att.firstByteAt && received > 0 ? received / (att.lastByteAt - att.firstByteAt) : null;
    let rate: number | null = null;
    let rateWeight = 1;
    if (measuredRate !== null) {
      if (outcome === MediaOutcome.Ok && att.bytes >= MIN_RATE_SAMPLE_BYTES) {
        rate = measuredRate;
      } else if (att.bytes >= PARTIAL_SAMPLE_BYTES && (outcome === MediaOutcome.Canceled || outcome === MediaOutcome.Ok)) {
        rate = measuredRate;
        rateWeight = 0.25;
      }
    }
    // An error page comes back fast, but says nothing about how fast the host serves media:
    // only a validated 206 (the attempt got to read its body) counts as a TTFB sample
    const validResponse = att.headersAt !== 0 && (outcome === MediaOutcome.Ok || outcome === MediaOutcome.Canceled || outcome === MediaOutcome.Truncated || outcome === MediaOutcome.Reset || outcome === MediaOutcome.Stall);
    // No first byte yet: what it waited is a lower bound of its TTFB. A racer canceled before it
    // waited as long as the file usually takes says nothing, it may have just started
    const waited = now - att.startedAt;
    const censored = att.headersAt === 0 && (
      outcome === MediaOutcome.TtfbTimeout
      || (outcome === MediaOutcome.Canceled && waited > model.typicalTtfb(job.file, now))
    );
    model.recordSample({
      hostname: host.hostname,
      file: job.file,
      cold: att.cold,
      ttfb: validResponse ? att.headersAt - att.startedAt : null,
      censoredTtfb: censored ? waited : undefined,
      rate,
      rateWeight,
      gap: att.gaps.length === 0 ? null : p90(att.gaps)
    }, now);
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
      headers.set(file.key, { range, bytes: null, total: null, contentType: '', ready, settle });
      if (headers.size > MAX_HEADERS) {
        headers.delete(headers.keys().next().value!);
      }
      start({
        file,
        // The key is pathname + search
        pathname: split0th(requested.key, '?'),
        range,
        header: true,
        warmup: true,
        timeout: 0,
        candidates,
        requested
      }, null);
    }
  }

  /** The player asks for what a warm-up is still fetching: it becomes critical, and is raced */
  function promote(fileKey: string) {
    const job = warmups.get(fileKey);
    if (job?.state !== 'running' || job.cls === CRITICAL) {
      return;
    }
    job.cls = CRITICAL;
    job.deadline = performance.now();
    raceAll(job);
  }

  /** A request inside the init/index fetched ahead: served from it, as a copy */
  async function serveHeader(header: CachedHeader, params: JobParams, sink: SyntheticXhrSink) {
    const waitedFrom = performance.now();
    if (header.bytes === null) {
      promote(params.file.key);
    }
    // `ready` resolves true exactly when the bytes are there
    const ok = header.bytes !== null || await Promise.race([header.ready, wait(WARMUP_WAIT_MS).then(falseFn)]);
    if (sink.signal.aborted) {
      return;
    }
    if (!ok) {
      if (process.env.DEBUG) {
        debugNote(params.file, `${params.file.kind} ${params.range.start}-${params.range.end}: the warm-up's copy did not come in ${Math.round(performance.now() - waitedFrom)} ms, fetched on its own`);
      }
      start(params, sink);
      return;
    }
    const bytes = header.bytes!;
    const { range } = params;
    const length = byteRangeLength(range);
    const body = new unsafeWindow.ArrayBuffer(length);
    new unsafeWindow.Uint8Array(body).set(bytes.subarray(range.start - header.range.start, range.end - header.range.start + 1));
    const responseHeaders: Array<[string, string]> = [
      ['content-type', header.contentType || `${params.file.kind}/mp4`],
      ['content-length', String(length)]
    ];
    if (header.total !== null) {
      responseHeaders.push(['content-range', `bytes ${range.start}-${range.end}/${header.total}`]);
    }
    if (process.env.DEBUG) {
      debugNote(params.file, `${params.file.kind} ${range.start}-${range.end} served from the warm-up, after waiting ${Math.round(performance.now() - waitedFrom)} ms`);
    }
    sink.headersReceived(206, responseHeaders, '');
    sink.done(body);
  }

  player.onPlayinfo(warmUp);

  if (process.env.DEBUG) {
    Object.defineProperty(unsafeWindow, '__MBGTEB_THREAD_RIPPER__', {
      configurable: true,
      enumerable: false,
      value: {
        hosts: () => model.snapshot(performance.now()),
        slots: () => Array.from(slots.values(), host => ({ hostname: host.hostname, active: host.active })),
        running: () => running.size,
        queued: () => queue.length
      }
    });
  }

  return {
    type: 'serve',
    name: 'thread-ripper',
    serve(request): XhrResponder | null {
      const now = performance.now();
      if (integrityFailed || now < offUntil) {
        return declined(integrityFailed ? 'off after an integrity failure' : 'off after repeated failures', request);
      }
      const { range, match, address, candidates, requested } = request;
      if (range === null) {
        return declined('not a single byte range', request);
      }
      if (match === null) {
        return declined('file unknown: no playinfo listed it (yet)', request);
      }
      // The URL the player asked for is the last resort: not acceptable, the browser keeps it
      if (requested === null) {
        return declined('the requested URL is not acceptable', request);
      }
      if (byteRangeLength(range) > MAX_SERVED_LENGTH) {
        return declined('range too long', request);
      }
      const { pathname } = address;
      if (
        (nativeOnly.get(pathname) ?? 0) > now
        || (nativeRetry.get(`${pathname}:${range.start}-${range.end}`) ?? 0) > now
      ) {
        return declined('left to the browser after a failure', request);
      }

      const segmentBase = match.file.segmentBase;
      const params: JobParams = {
        file: match.file,
        pathname,
        range,
        // The initialization segment and the index come first: nothing plays without them
        header: segmentBase !== null && range.end <= segmentBase.index.end,
        warmup: false,
        timeout: request.ctx.timeout,
        candidates,
        requested
      };

      const header = headers.get(match.file.key);
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

/** The scheduler's order: urgency, then deadline, then the smaller piece, then first come */
function before(a: Unit, b: Unit) {
  return a.job.cls - b.job.cls
    || a.job.deadline - b.job.deadline
    || (a.seg.end - a.seg.frontier) - (b.seg.end - b.seg.frontier)
    || a.seq - b.seq;
}

/**
 * Among the hosts that may take it (see `ownersOf`): relaxed work explores the unmeasured ones, a
 * small piece or a job in one piece goes to the host expected to finish it first, and otherwise
 * the fastest few share pieces by smooth weighted round-robin
 */
function choosePrimary(options: HostOption[], job: Job, bytes: number): HostOption {
  const unmeasured = options.filter(option => !option.estimate.measured);
  if (unmeasured.length === options.length || (job.cls === RELAXED && unmeasured.length > 0)) {
    return leastBusy(preferred(unmeasured));
  }
  if (bytes < SMALL_UNIT || job.segments.length === 1) {
    return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best));
  }

  const pool = options.slice().sort((a, b) => b.estimate.rate - a.estimate.rate).slice(0, TOP_HOSTS);
  const top = pool[0].estimate.rate;
  let total = 0;
  let best = pool[0];
  for (let i = 0, len = pool.length; i < len; i++) {
    const option = pool[i];
    const weight = Math.max(option.estimate.rate, top * 0.05);
    option.host.credit += weight;
    total += weight;
    if (option.host.credit > best.host.credit) {
      best = option;
    }
  }
  best.host.credit -= total;
  return best;
}

/**
 * A duplicate explores an unmeasured host when it may (the one expected to answer first: one that
 * lost races before its first byte comes last), otherwise races the fastest one
 */
function chooseDuplicate(options: HostOption[], job: Job): HostOption {
  const unmeasured = options.filter(option => !option.estimate.measured);
  if (unmeasured.length > 0 && job.cls >= NORMAL) {
    return preferred(unmeasured).reduce((best, option) => (option.estimate.ttfb < best.estimate.ttfb ? option : best));
  }
  return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best));
}

function leastBusy(options: HostOption[]): HostOption {
  return options.reduce((best, option) => (option.host.active < best.host.active ? option : best));
}

/**
 * Among hosts nothing is measured on yet: the addresses Bilibili issued for this file first (its
 * assignment for this viewer carries information: when only the assigned hosts are good, the
 * moved signatures are 13 ways to wait), then the signatures moved onto other hosts, and last the
 * last resorts (a signature on a host not known to accept it, a proxy, a P2P host). Mirror and
 * bcache hosts are peers at every step; which is faster is found out, never assumed
 */
function preferred(options: HostOption[]): HostOption[] {
  const listed = options.filter(option => option.candidate.tier <= CandidateTier.ListedBcache);
  if (listed.length > 0) {
    return listed;
  }
  const moved = options.filter(option => option.candidate.tier <= CandidateTier.Bcache);
  return moved.length > 0 ? moved : options;
}

/** Speed over the last half second, or since the first byte when the history is short */
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
  if (att.firstByteAt === 0 || now <= att.firstByteAt) {
    return 0;
  }
  return (att.bytes - att.firstChunkBytes) / (now - att.firstByteAt);
}

/**
 * Whether a piece with exactly one attempt in flight needs help, and which: a duplicate on another
 * host, or handing its tail to one (a split). `alternative` is the best host available for it
 */
function decideHelp(att: Attempt, seg: Segment, job: Job, now: number, typicalRate: number, alternative: HostEstimate | null, slack: number): 'none' | 'dup' | 'split' {
  const factor = URGENCY_FACTOR[job.cls];

  // No first byte yet, or it stopped: another host may do better at once
  if (att.firstByteAt === 0) {
    return now - att.startedAt >= att.timeouts.ttfbSoft * factor ? 'dup' : 'none';
  }
  if (now - att.lastByteAt >= att.timeouts.stallSoft * factor) {
    return 'dup';
  }
  // Too early to tell its speed
  if (now - att.firstByteAt < 250) {
    return 'none';
  }

  const rate = recentRate(att, now);
  if (rate <= 0) {
    return 'dup';
  }
  const remaining = seg.end - seg.frontier + 1;
  const eta = now + remaining / rate;

  // On time with room to spare: the bandwidth goes to work needed sooner
  if (eta <= job.deadline - slack) {
    return 'none';
  }
  const help = remaining >= 2 * STEAL_MIN ? 'split' : 'dup';
  // Late, and clearly slower than usual
  if (eta >= job.deadline && rate < 0.5 * typicalRate && eta - now >= 500 && claimRescue(job, 'straggler')) {
    return help;
  }
  // A host known to be clearly faster
  if (alternative?.measured && alternative.rate > rate * 1.5) {
    return help;
  }
  // Slower than requests usually are
  if (rate < typicalRate * 0.6) {
    return help;
  }
  // On pace, but a host never measured might be faster
  if (alternative !== null && !alternative.measured) {
    return help;
  }
  // Will miss the deadline anyway: what is known about the alternative may be stale
  if (eta > job.deadline && claimRescue(job, 'stale')) {
    return help;
  }
  return 'none';
}

function claimRescue(job: Job, kind: 'straggler' | 'stale') {
  if (job.rescue[kind] <= 0) {
    return false;
  }
  job.rescue[kind]--;
  return true;
}

/**
 * A duplicate takes bandwidth from the pieces that matter: none while the job already delivers
 * `HEDGE_HEADROOM` times what the stream needs, none for a job whose last duplicate raised nothing
 * (the line is full), and the last one gets `RATE_WINDOW_MS` to show before the next
 */
function mayDuplicate(job: Job, now: number) {
  if (job.saturated) {
    return false;
  }
  const rate = deliveredRate(job, now);
  if (rate >= HEDGE_HEADROOM * job.requiredRate) {
    return false;
  }
  const last = job.lastDuplicate;
  if (last === null) {
    return true;
  }
  if (now - last.at < RATE_WINDOW_MS) {
    return false;
  }
  if (last.rate > 0 && rate <= last.rate) {
    job.saturated = true;
    return false;
  }
  return true;
}

/**
 * Where to split a piece so both halves finish together: the running attempt (rate `r`) keeps
 * `[frontier, m)`, a new one (first byte after `ttfb`, rate `rNew`) takes `[m, end]`.
 *
 * @returns `null` when either half would be too small to be worth it
 */
function splitPoint(seg: Segment, r: number, ttfb: number, rNew: number): number | null {
  if (r <= 0 || rNew <= 0) {
    return null;
  }
  const remaining = seg.end + 1 - seg.frontier;
  const m = seg.frontier + Math.ceil(r * (ttfb + remaining / rNew) / (1 + r / rNew));
  // The running attempt must still have work while the new one waits for its first byte
  if (seg.end + 1 - m < STEAL_MIN || m - seg.frontier < Math.max(STEAL_MIN, r * ttfb)) {
    return null;
  }
  return m;
}

/** Finish this much before the deadline to count as on time */
function hedgeSlack(typicalTtfb: number) {
  return clamp(2 * typicalTtfb, 500, 1500);
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

function firstOfSet<T>(set: Set<T>): T | null {
  const { value, done } = set.values().next();
  return done ? null : value;
}
