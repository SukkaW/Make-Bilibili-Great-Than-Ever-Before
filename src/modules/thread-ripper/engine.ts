import { falseFn, noop } from 'foxts/noop';
import { split0th } from 'foxts/split-nth';
import { wait } from 'foxts/wait';
import { p50 } from 'fast-percentile';
import { logger } from '../../logger';
import type { MediaServePhase, MediaXhrRequest, PlayerInterceptor } from '../../core/player';
import type { ByteRange } from '../../core/player/range';
import { byteRangeLength, parseContentRange } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import type { SyntheticXhrSink, XhrResponder } from '../../types';
import { runAttempt } from './attempt';
import { MediaOutcome, MIN_RATE_SAMPLE_BYTES } from '../../core/player/host-model';
import { isRetryable } from './classify';
import { createHeaderCache } from './header-cache';
import type { CachedHeader } from './header-cache';
import { STEAL_MIN, decideHelp, hedgeSlack, recentRate, splitPoint } from './hedge';
import { createHostPool } from './host-pool';
import {
  COMMIT_TIMEOUT_MS, CRITICAL, JOB_STALL_MS, KiB, MAX_SERVED_LENGTH, MAX_TRIES_PER_SEGMENT, MiB,
  RELAXED, URGENT, planPieceCount
} from './policy';
import { createJob, isJobComplete, isSegmentComplete, planSegments, splitSegment, writeChunk } from './range-job';
import { createScheduler } from './scheduler';
import { defaultCandidate } from '../../core/player/candidates';
import type { MediaCandidate } from '../../core/player/candidates';
import type { Attempt, Job, Segment } from './types';
import { planWarmup } from './warmup';

export type ThreadRipperMode = 'serve' | 'shadow';

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

interface JobParams {
  file: MediaFile,
  pathname: string,
  range: ByteRange,
  header: boolean,
  warmup: 'current' | 'other' | null,
  /** Every acceptable URL of the file */
  candidates: readonly MediaCandidate[],
  requested: MediaCandidate
}

interface JobSummary {
  id: number,
  kind: string,
  bytes: number,
  pieces: number,
  ms: number,
  rateKiBps: number,
  hosts: string[],
  retries: number,
  duplicates: number,
  result: 'done' | 'fallback' | 'failed' | 'canceled'
}

/**
 * The serve phase: a media range the player asks for is split into pieces, fetched from many
 * interchangeable CDN hosts at once, checked, and put together as the XHR's response.
 */
/**
 * @param ab debug builds: each video gets thread-ripper or not on a coin flip (`threadRipperAb`)
 */
export function createThreadRipper(interceptor: PlayerInterceptor, nativeFetch: typeof fetch, mode: ThreadRipperMode, ab = false): MediaServePhase {
  const model = interceptor.hosts;
  const pool = createHostPool(model);
  const headers = createHeaderCache();
  const jobs = new Set<Job>();
  /** file key -> file size, as every host must agree on it */
  const totals = new Map<string, number>();
  const nativeRetry = new Map<string, number>();
  const nativeOnly = new Map<string, number>();
  const postCommitFailures = new Map<string, number>();
  let recentFailures: number[] = [];
  let offUntil = 0;
  let integrityFailed = false;
  const history: JobSummary[] = [];

  const scheduler = createScheduler(pool, model, {
    run: att => runAttempt(att, { nativeFetch, onValidResponse, onChunk }),
    onAttemptEnd,
    onTick,
    hasWork: () => jobs.size > 0
  });

  /** Debug A/B: whether each video (`videoKey`) gets thread-ripper, a coin flip at first sight */
  const arms = new Map<string, boolean>();

  function isOn(file: MediaFile) {
    if (!ab) {
      return true;
    }
    let on = arms.get(file.videoKey);
    if (on === undefined) {
      on = Math.random() < 0.5;
      arms.set(file.videoKey, on);
      interceptor.metrics?.setArm(file, on ? 'A/B: on' : 'A/B: off');
    }
    return on;
  }

  /** Debug builds: what thread-ripper does, in the console and in the video's startup trace (`metrics.ts`) */
  function debugNote(file: MediaFile | null, text: string) {
    if (process.env.DEBUG) {
      logger.debug(`[thread-ripper] ${text}`);
      interceptor.metrics?.note(file, `thread-ripper: ${text}`);
    }
  }

  /** Leave a media XHR to the browser, saying why in debug builds */
  function declined(reason: string, request: MediaXhrRequest): null {
    debugNote(request.match?.file ?? null, `left to the browser: ${reason} (${request.ctx.url})`);
    return null;
  }

  function summarize(job: Job, result: JobSummary['result']): JobSummary {
    const ms = Math.round(performance.now() - job.createdAt);
    let retries = 0;
    let duplicates = 0;
    for (let i = 0, len = job.segments.length; i < len; i++) {
      retries += job.segments[i].tries;
      duplicates += job.segments[i].extra;
    }
    return {
      id: job.id,
      kind: job.kind,
      bytes: job.length,
      pieces: job.segments.length,
      ms,
      rateKiBps: Math.round(job.covered / KiB / Math.max(ms, 1) * 1000),
      hosts: Array.from(job.hostsUsed),
      retries,
      duplicates,
      result
    };
  }

  function stop(job: Job, result: JobSummary['result']) {
    job.state = result === 'done' ? 'done' : 'failed';
    jobs.delete(job);
    scheduler.cancelJob(job);
    if (process.env.DEBUG) {
      const summary = summarize(job, result);
      history.push(summary);
      if (history.length > 50) {
        history.splice(0, history.length - 50);
      }
      interceptor.metrics?.recordJob(job.file, {
        result,
        warmup: job.warmup !== null,
        bytes: job.length,
        fetchedBytes: job.fetched,
        pieces: summary.pieces,
        duplicates: summary.duplicates,
        retries: summary.retries,
        hosts: summary.hosts.length
      });
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

  function complete(job: Job) {
    if (job.state !== 'running') {
      return;
    }
    stop(job, 'done');
    if (process.env.DEBUG) {
      const summary = history.at(-1)!;
      debugNote(job.file, `#${job.id} ${job.warmup === null ? '' : 'warm-up '}${job.kind} ${Math.round(job.length / KiB)} KiB in ${summary.ms} ms (${summary.rateKiBps} KiB/s), ${summary.pieces} pieces via ${summary.hosts.join(', ')}${summary.retries ? `, ${summary.retries} retries` : ''}${summary.duplicates ? `, ${summary.duplicates} duplicates` : ''}`);
    }
    job.sink.done(job.buffer);
  }

  /** Before commit: the browser sends the request itself, nothing is lost */
  function fallback(job: Job, reason: string) {
    stop(job, 'fallback');
    if (job.warmup !== null) {
      // Nobody waits for a warm-up: requests covered by it fetch by themselves
      job.sink.error();
      return;
    }
    recordFailure();
    logger.warn(`[thread-ripper] #${job.id} handed back to the browser: ${reason}`, { pathname: job.pathname, range: job.range });
    interceptor.metrics?.note(job.file, `thread-ripper: #${job.id} handed back to the browser: ${reason}`);
    if (!job.sink.fallbackToNative()) {
      job.sink.error();
    }
  }

  /** After commit: the XHR fails, and the player's retry goes to the browser */
  function fail(job: Job, reason: string) {
    const now = performance.now();
    stop(job, 'failed');
    if (job.warmup !== null) {
      job.sink.error();
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

  function onValidResponse(att: Attempt, response: Response, total: number | null) {
    const { job } = att;
    if (job.state !== 'running') {
      return;
    }
    if (total !== null && job.total === null) {
      job.total = total;
      totals.set(job.file.key, total);
    }
    if (!job.committed) {
      job.committed = true;
      /** What a native response would expose, for the whole range */
      const headers: Array<[string, string]> = [];
      response.headers.forEach((value, name) => {
        if (name !== 'content-length' && name !== 'content-range') {
          headers.push([name, value]);
        }
      });
      headers.push(['content-length', String(job.length)]);
      if (job.total !== null) {
        headers.push(['content-range', `bytes ${job.range.start}-${job.range.end}/${job.total}`]);
      }
      job.sink.headersReceived(206, headers, response.statusText);
    }
  }

  function onChunk(att: Attempt, chunk: Uint8Array) {
    const { job } = att;
    const now = performance.now();
    model.noteBytes(now);
    const { result } = writeChunk(job, att, chunk);
    job.fetched += chunk.byteLength;
    if (result !== 'mismatch' && job.state === 'running') {
      job.hostsUsed.add(att.host.hostname);
      job.sink.progress(job.covered, job.length);
      if (isSegmentComplete(att.seg)) {
        // The race is over for this piece
        for (const other of att.seg.attempts) {
          if (other !== att) {
            scheduler.abortAttempt(other, MediaOutcome.Canceled);
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
      interceptor.metrics?.recordAttempt(job.file, {
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
    if (isSegmentComplete(seg) || seg.attempts.size > 0 || seg.queued) {
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
    }
    if (seg.tries < MAX_TRIES_PER_SEGMENT) {
      scheduler.enqueue(job, seg);
      return;
    }
    if (!job.committed) {
      fallback(job, `piece ${seg.index} failed ${seg.tries} times, last: ${outcome}`);
      return;
    }
    // Last resort: exactly what the player asked for
    seg.final = true;
    scheduler.enqueue(job, seg, 'final', { hostname: job.requested.hostname, candidate: job.requested });
  }

  /**
   * How urgent the job is, for its whole life: the initialization segment and index first (nothing
   * plays without them), then what the player asked for, last the warm-up of qualities it may
   * never ask for
   */
  function setUrgency(job: Job) {
    if (job.warmup === 'other') {
      job.cls = RELAXED;
      job.deadline = job.createdAt + 5000;
    } else if (job.header) {
      job.cls = CRITICAL;
      job.deadline = job.createdAt;
    } else {
      job.cls = URGENT;
      job.deadline = job.createdAt + 1500;
    }
  }

  /** Split a piece so both halves finish together, or add a duplicate */
  function help(job: Job, seg: Segment, att: Attempt, kind: 'dup' | 'split', now: number) {
    const alternative = pool.bestAlternative(job, seg);
    if (alternative === null) {
      return false;
    }
    if (kind === 'split') {
      const at = splitPoint(seg, recentRate(att, now), alternative.ttfb, alternative.rate);
      if (at !== null) {
        scheduler.enqueue(job, splitSegment(job, seg, at));
        return true;
      }
    }
    if (seg.extra < MAX_EXTRA) {
      scheduler.enqueue(job, seg, 'dup');
      return true;
    }
    return false;
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
        scheduler.abortAttempt(att, MediaOutcome.Canceled);
      }
    }
  }

  /** Free slots and nothing queued: take the slowest piece's tail, or race it */
  function endgame(now: number) {
    let target: { att: Attempt, remainingMs: number } | null = null;
    const etas: number[] = [];
    for (const att of scheduler.running) {
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
    if (target === null || scheduler.hasQueuedDuplicate(target.att.seg)) {
      return;
    }
    const { att, remainingMs } = target;
    const { job, seg } = att;
    const remaining = seg.end - seg.frontier + 1;
    if (remaining >= 2 * STEAL_MIN) {
      // Taking a tail wastes nothing
      help(job, seg, att, 'split', now);
      return;
    }
    const medianEta = p50(etas);
    const slack = hedgeSlack(model.typicalTtfb(job.file, now));
    if (remainingMs > Math.max(300, 1.3 * medianEta) || now + remainingMs > job.deadline - slack) {
      help(job, seg, att, 'dup', now);
    }
  }

  function onTick(now: number, idle: boolean) {
    for (const job of jobs) {
      if (job.state !== 'running') {
        continue;
      }

      if (!job.committed) {
        if (now - job.createdAt > COMMIT_TIMEOUT_MS) {
          fallback(job, 'no CDN host answered in time');
          continue;
        }
      } else if (now - job.lastProgressAt > JOB_STALL_MS) {
        let forced = false;
        for (let i = 0, len = job.segments.length; i < len; i++) {
          const seg = job.segments[i];
          if (!isSegmentComplete(seg) && !seg.final) {
            seg.final = true;
            forced = true;
            for (const att of seg.attempts) {
              scheduler.abortAttempt(att, MediaOutcome.Stall);
            }
            scheduler.enqueue(job, seg, 'final', { hostname: job.requested.hostname, candidate: job.requested });
          }
        }
        if (forced) {
          job.lastProgressAt = now;
        } else {
          fail(job, 'no progress');
        }
        continue;
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
        if (att?.abortReason !== null || scheduler.hasQueuedDuplicate(seg) || seg.extra >= MAX_EXTRA) {
          continue;
        }
        const alternative = pool.bestAlternative(job, seg);
        const decision = decideHelp(att, seg, job, {
          now,
          typicalRate,
          alternative: alternative === null ? null : { rate: alternative.rate, measured: alternative.measured },
          slack
        });
        if (decision !== 'none') {
          help(job, seg, att, decision, now);
        }
      }
    }

    if (idle) {
      endgame(now);
    }
  }

  /**
   * Race a request on a few hosts at once: 3 when critical, 2 when urgent. A slow first byte is
   * covered from the start, the losers go as soon as it is decided (`settleRace`), and with nothing
   * measured yet, racing is also how hosts get measured.
   */
  function raceWidth(job: Job) {
    let width = 1;
    if (job.cls === CRITICAL) {
      width = 3;
    } else if (job.cls === URGENT) {
      width = 2;
    }
    return Math.min(width, pool.usableHostCount(job));
  }

  function start(params: JobParams, sink: SyntheticXhrSink) {
    const now = performance.now();
    const job = createJob({ ...params, cls: URGENT, total: totals.get(params.file.key) ?? null, sink });
    jobs.add(job);
    sink.signal.addEventListener('abort', () => {
      if (job.state === 'running') {
        stop(job, 'canceled');
      }
    }, { once: true });

    setUrgency(job);

    // No more pieces than the hosts worth a primary can carry
    const pieces = planPieceCount(job.length, model.typicalRate(job.file, now), model.typicalTtfb(job.file, now), pool.primaryHostCount(job, Math.min(job.length, MiB)));
    planSegments(job, pieces);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      scheduler.enqueue(job, job.segments[i]);
    }

    // Until a host is measured on this file, every piece is raced: on its own it may only go to the
    // player's host (see `ownersOf`), a faster one takes over by winning the race
    if (pieces === 1 || (job.warmup === null && pool.measuredHostCount(job) === 0)) {
      const width = raceWidth(job);
      for (let i = 0, len = job.segments.length; i < len; i++) {
        for (let j = 1; j < width; j++) {
          scheduler.enqueue(job, job.segments[i], 'dup');
        }
      }
    }
    debugNote(job.file, `#${job.id} ${job.warmup === null ? '' : 'warm-up '}${job.kind} ${Math.round(job.length / KiB)} KiB started: ${pieces} piece(s); ${scheduler.running.size} requests running, ${scheduler.queued()} queued`);
  }

  /** A request inside the init/index fetched ahead: served from it, as a copy */
  async function serveHeader(header: CachedHeader, params: JobParams, sink: SyntheticXhrSink) {
    const waitedFrom = performance.now();
    // `ready` resolves true exactly when the bytes are there
    const ok = header.bytes !== null || await Promise.race([header.ready, wait(WARMUP_WAIT_MS).then(falseFn)]);
    if (sink.signal.aborted) {
      return;
    }
    if (!ok) {
      debugNote(params.file, `${params.file.kind} ${params.range.start}-${params.range.end}: the warm-up's copy did not come in ${Math.round(performance.now() - waitedFrom)} ms, fetched on its own`);
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
    debugNote(params.file, `${params.file.kind} ${range.start}-${range.end} served from the warm-up, after waiting ${Math.round(performance.now() - waitedFrom)} ms`);
    sink.headersReceived(206, responseHeaders, '');
    sink.done(body);
  }

  function warmUp(json: object, files: readonly MediaFile[]) {
    if (files.length > 0 && !isOn(files[0])) {
      return;
    }
    const items = planWarmup(json, files);
    const now = performance.now();
    for (let i = 0, len = items.length; i < len; i++) {
      const { file, current } = items[i];
      if (headers.has(file.key) || file.segmentBase === null) {
        continue;
      }
      const candidates = interceptor.candidates(file);
      // Its own last resort, as the browser would pick it
      const requested = defaultCandidate(candidates, model, file, now);
      if (requested === null) {
        continue;
      }

      const range: ByteRange = { start: 0, end: file.segmentBase.index.end };
      const header = headers.begin(file.key, range);
      let total: number | null = null;
      start({
        file,
        // The key is pathname + search
        pathname: split0th(requested.key, '?'),
        range,
        header: true,
        warmup: current ? 'current' : 'other',
        candidates,
        requested
      }, {
        signal: new AbortController().signal,
        headersReceived(_status, responseHeaders) {
          for (let k = 0, count = responseHeaders.length; k < count; k++) {
            const [name, value] = responseHeaders[k];
            if (name === 'content-type') {
              header.contentType = value;
            } else if (name === 'content-range') {
              total = parseContentRange(value)?.total ?? null;
            }
          }
        },
        progress: noop,
        done(body) {
          headers.fulfil(file.key, new Uint8Array(body), total, header.contentType);
        },
        error() {
          headers.fail(file.key);
        },
        fallbackToNative: () => false
      });
    }
  }

  if (mode === 'serve') {
    interceptor.onPlayinfo(warmUp);
  }

  /** Debug builds only: download in parallel with the browser and compare */
  function shadow(request: MediaXhrRequest, params: JobParams) {
    const { xhr } = request.ctx;
    const controller = new AbortController();
    const startedAt = performance.now();
    let engineBody: ArrayBuffer | null = null;
    let engineMs = 0;
    let nativeBody: ArrayBuffer | null = null;
    let nativeMs = 0;

    const compare = () => {
      if (engineBody === null || nativeBody === null) {
        return;
      }
      const a = new Uint8Array(engineBody);
      const b = new Uint8Array(nativeBody);
      let identical = a.byteLength === b.byteLength;
      for (let i = 0, len = a.byteLength; identical && i < len; i++) {
        identical = a[i] === b[i];
      }
      logger[identical ? 'info' : 'error'](`[thread-ripper] shadow ${params.file.kind} ${Math.round(a.byteLength / KiB)} KiB: ${identical ? 'identical' : 'MISMATCH'}, browser ${Math.round(nativeMs)} ms, thread-ripper ${Math.round(engineMs)} ms`);
    };

    xhr.addEventListener('load', () => {
      const response: unknown = xhr.response;
      if (typeof response === 'object' && response !== null && 'byteLength' in response) {
        nativeBody = response as ArrayBuffer;
        nativeMs = performance.now() - startedAt;
        compare();
      }
    }, { once: true });
    const cancel = () => controller.abort();
    xhr.addEventListener('abort', cancel, { once: true });
    xhr.addEventListener('error', cancel, { once: true });
    xhr.addEventListener('timeout', cancel, { once: true });

    start(params, {
      signal: controller.signal,
      headersReceived: noop,
      progress: noop,
      done(body) {
        engineBody = body;
        engineMs = performance.now() - startedAt;
        compare();
      },
      error() {
        logger.warn('[thread-ripper] shadow download failed', { pathname: params.pathname, range: params.range });
      },
      fallbackToNative: () => false
    });
  }

  if (process.env.DEBUG) {
    Object.defineProperty(unsafeWindow, '__MBGTEB_THREAD_RIPPER__', {
      configurable: true,
      enumerable: false,
      value: {
        mode,
        hosts: () => model.snapshot(performance.now()),
        slots: () => pool.snapshot(),
        jobs: () => Array.from(jobs, job => summarize(job, 'done')),
        history: () => history.slice(),
        running: () => scheduler.running.size,
        queued: () => scheduler.queued()
      }
    });
  }

  return {
    type: 'serve',
    name: 'thread-ripper',
    serve(request): XhrResponder | null {
      const now = performance.now();
      // A suspected outage (`model.isOutage()`) is no reason to decline: it may be a quiet moment
      // at startup, and if the network is really down, the jobs fail and the player retries anyway
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
      // The A/B coin said no for this video: nothing worth a line
      if (!isOn(match.file)) {
        return null;
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
        warmup: null,
        candidates,
        requested
      };

      if (mode === 'shadow') {
        shadow(request, params);
        return null;
      }
      const header = headers.get(match.file.key, range);
      if (header !== null) {
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

function firstOfSet<T>(set: Set<T>): T | null {
  const { value, done } = set.values().next();
  return done ? null : value;
}
