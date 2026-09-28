import { falseFn, noop } from 'foxts/noop';
import { split0th } from 'foxts/split-nth';
import { wait } from 'foxts/wait';
import { p50 } from 'fast-percentile';
import { logger } from '../../logger';
import type { MediaServePhase, MediaXhrRequest, PlayerInterceptor } from '../../core/player';
import { ingestSidx } from '../../core/player/observer';
import type { ByteRange } from '../../core/player/range';
import { byteRangeLength, parseContentRange } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import { findSidxSegment } from '../../core/player/sidx';
import type { SyntheticXhrSink, XhrResponder } from '../../types';
import { runAttempt } from './attempt';
import { createBudget } from './budget';
import { MediaOutcome } from '../../core/player/host-model';
import { isRetryable } from './classify';
import { createHeaderCache } from './header-cache';
import type { CachedHeader } from './header-cache';
import { STEAL_MIN, decideHelp, hedgeSlack, recentRate, splitPoint } from './hedge';
import { createHostPool } from './host-pool';
import {
  COMMIT_TIMEOUT_MS, CRITICAL, JOB_STALL_MS, KiB, MAX_SERVED_LENGTH, MAX_TRIES_PER_SEGMENT,
  NORMAL, RELAXED, URGENT, planPieceCount
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
export function createThreadRipper(interceptor: PlayerInterceptor, nativeFetch: typeof fetch, mode: ThreadRipperMode): MediaServePhase {
  const model = interceptor.hosts;
  const pool = createHostPool(model);
  const budget = createBudget();
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
      history.push(summarize(job, result));
      if (history.length > 50) {
        history.splice(0, history.length - 50);
      }
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
      logger.debug(`[thread-ripper] #${job.id} ${job.kind} ${Math.round(job.length / KiB)} KiB in ${summary.ms} ms (${summary.rateKiBps} KiB/s), ${summary.pieces} pieces via ${summary.hosts.join(', ')}${summary.retries ? `, ${summary.retries} retries` : ''}${summary.duplicates ? `, ${summary.duplicates} duplicates` : ''}`);
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
    const { result, waste } = writeChunk(job, att, chunk);
    budget.received(chunk.byteLength, now);
    budget.waste(waste, now);
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

  /** When playback needs the job's bytes, and how urgent that is */
  function refreshUrgency(job: Job, now: number) {
    if (job.warmup === 'other') {
      job.cls = RELAXED;
      job.deadline = job.createdAt + 5000;
      return;
    }
    if (job.header) {
      job.cls = CRITICAL;
      job.deadline = job.createdAt;
      return;
    }
    const playback = interceptor.clock.state();
    if (!playback.found) {
      job.cls = URGENT;
      job.deadline = job.createdAt + 1500;
      return;
    }
    const index = interceptor.sidx.get(job.file.key);
    const segment = index === null ? null : findSidxSegment(index, job.range.start);
    job.deadline = segment === null
      ? now + Math.min(playback.bufferedAhead, 10) * 1000 / playback.playbackRate
      : now + (segment.startTime - playback.currentTime) * 1000 / playback.playbackRate - 300;

    if (playback.seeking || playback.readyState < 3 || playback.starving) {
      job.cls = CRITICAL;
    } else if (playback.paused) {
      job.cls = RELAXED;
    } else {
      job.cls = job.deadline - now < 1500 ? URGENT : NORMAL;
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
    if (seg.extra < MAX_EXTRA && budget.allowDup(job.cls, seg.end - seg.frontier + 1, now)) {
      scheduler.enqueue(job, seg, 'dup');
      return true;
    }
    return false;
  }

  /** A racer far behind the leader only compares bytes: let it go */
  function settleRace(seg: Segment, now: number) {
    let leader: Attempt | null = null;
    for (const att of seg.attempts) {
      if (leader === null || att.pos > leader.pos) {
        leader = att;
      }
    }
    if (leader === null) {
      return;
    }
    const leaderRate = recentRate(leader, now);
    for (const att of seg.attempts) {
      if (att === leader || att.abortReason !== null) {
        continue;
      }
      const lagging = att.firstByteAt === 0
        ? leader.bytes >= LAGGARD_BYTES
        : leader.pos - att.pos >= LAGGARD_BYTES && leaderRate >= 1.2 * recentRate(att, now);
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
      refreshUrgency(job, now);

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
          settleRace(seg, now);
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
   * Race an unsplit request on a few hosts at once, when it is urgent and the link has room.
   * With nothing measured yet, racing is also how hosts get measured.
   */
  function raceWidth(job: Job, now: number) {
    const headroom = budget.headroom(now);
    let width = 1;
    if (job.cls === CRITICAL) {
      width = headroom >= 3 ? 3 : 2;
    } else if (job.cls === URGENT && headroom >= 2) {
      width = 2;
    }
    if (headroom >= 2 && pool.measuredHostCount(job) < 3) {
      width = Math.max(width, 2);
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

    // The player's own requests: the warm-up covers every quality, not the one playing
    if (job.kind === 'video' && job.warmup === null) {
      budget.setBitrate(job.file.bandwidth);
    }
    refreshUrgency(job, now);

    const pieces = planPieceCount(job.length, model.typicalRate(job.file, now), model.typicalTtfb(job.file, now), pool.usableHostCount(job));
    planSegments(job, pieces);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      scheduler.enqueue(job, job.segments[i]);
    }

    if (pieces === 1) {
      const seg = job.segments[0];
      const width = raceWidth(job, now);
      for (let i = 1; i < width && budget.allowDup(job.cls, job.length, now); i++) {
        scheduler.enqueue(job, seg, 'dup');
      }
    }
  }

  /** A request inside the init/index fetched ahead: served from it, as a copy */
  async function serveHeader(header: CachedHeader, params: JobParams, sink: SyntheticXhrSink) {
    // `ready` resolves true exactly when the bytes are there
    const ok = header.bytes !== null || await Promise.race([header.ready, wait(WARMUP_WAIT_MS).then(falseFn)]);
    if (sink.signal.aborted) {
      return;
    }
    if (!ok) {
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
    logger.debug(`[thread-ripper] ${params.file.kind} ${range.start}-${range.end} served from the warm-up`);
    sink.headersReceived(206, responseHeaders, '');
    sink.done(body);
  }

  function warmUp(json: object, files: readonly MediaFile[]) {
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
          ingestSidx(interceptor.sidx, file, range, body);
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
        budget: () => budget.snapshot(performance.now()),
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
      // No host can help while the viewer's network is down: the player retries on its own
      if (integrityFailed || now < offUntil || model.isOutage()) {
        return null;
      }
      const { range, match, address, candidates, requested } = request;
      // The URL the player asked for is the last resort: not acceptable, the browser keeps it
      if (range === null || match === null || requested === null) {
        return null;
      }
      if (byteRangeLength(range) > MAX_SERVED_LENGTH) {
        return null;
      }
      const { pathname } = address;
      if (
        (nativeOnly.get(pathname) ?? 0) > now
        || (nativeRetry.get(`${pathname}:${range.start}-${range.end}`) ?? 0) > now
      ) {
        return null;
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
