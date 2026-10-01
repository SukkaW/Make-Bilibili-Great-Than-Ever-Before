import { falseFn, noop } from 'foxts/noop';
import { split0th } from 'foxts/split-nth';
import { wait } from 'foxts/wait';
import { p50 } from 'fast-percentile';
import { logger } from '../../logger';
import type { MediaServePhase, MediaXhrRequest, PlayerInterceptor } from '../../core/player';
import type { ByteRange } from '../../core/player/range';
import { byteRangeLength } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import type { XhrResponder } from '../../types';
import { runAttempt } from './attempt';
import { MediaOutcome, MIN_RATE_SAMPLE_BYTES } from '../../core/player/host-model';
import { isRetryable } from './classify';
import { createHeaderCache } from './header-cache';
import type { CachedHeader } from './header-cache';
import { STEAL_MIN, URGENCY_FACTOR, decideHelp, hedgeSlack, recentRate, splitPoint } from './hedge';
import { createHostPool } from './host-pool';
import {
  COMMIT_TIMEOUT_MS, CRITICAL, HEDGE_HEADROOM, JOB_STALL_MS, KiB, MAX_SERVED_LENGTH, MAX_TRIES_PER_SEGMENT,
  MiB, RATE_WINDOW_MS, RELAXED, URGENT, planPieceCount
} from './policy';
import { createJob, deliveredRate, isJobComplete, isSegmentComplete, planSegments, splitSegment, writeChunk } from './range-job';
import { createScheduler } from './scheduler';
import { defaultCandidate } from '../../core/player/candidates';
import type { MediaCandidate } from '../../core/player/candidates';
import type { SyntheticXhrSink } from '../../utils/xhr-override';
import type { Attempt, Job, Segment } from './types';
import { warmupFiles } from './warmup';

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
  warmup: boolean,
  /** The player's own XHR timeout, `0` for none: the clock for handing a request back before commit */
  timeout: number,
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
export function createThreadRipper(interceptor: PlayerInterceptor, nativeFetch: typeof fetch): MediaServePhase {
  const model = interceptor.hosts;
  const pool = createHostPool(model);
  const headers = createHeaderCache();
  const jobs = new Set<Job>();
  /** file key -> its warm-up job, while it runs */
  const warmups = new Map<string, Job>();
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
    hasWork: () => jobs.size > 0,
    onLaunch: process.env.DEBUG
      ? (att) => {
        // Only what follows a failure: every launch would flood the startup trace
        if (att.seg.tries > 0 || att.role === 'final') {
          debugNote(att.job.file, `#${att.job.id} piece ${att.seg.index} ${att.role} -> ${att.host.hostname} (${att.rangeStart}-${att.rangeEnd}, ${att.seg.attempts.size} on it)`);
        }
      }
      : noop
  });

  /** Debug builds: what thread-ripper does, in the console and in the video's startup trace (`metrics.ts`) */
  function debugNote(file: MediaFile | null, text: string) {
    if (process.env.DEBUG) {
      logger.debug(`[thread-ripper] ${text}`);
      interceptor.metrics?.note(file, `thread-ripper: ${text}`);
    }
  }

  /** Leave a media XHR to the browser, saying why in debug builds */
  function declined(reason: string, request: MediaXhrRequest): null {
    if (process.env.DEBUG) {
      debugNote(request.match?.file ?? null, `left to the browser: ${reason} (${request.ctx.url})`);
    }
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
    if (warmups.get(job.file.key) === job) {
      warmups.delete(job.file.key);
    }
    scheduler.cancelJob(job);
    if (process.env.DEBUG) {
      const summary = summarize(job, result);
      history.push(summary);
      if (history.length > 50) {
        history.splice(0, history.length - 50);
      }
      interceptor.metrics?.recordJob(job.file, {
        result,
        warmup: job.warmup,
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
      debugNote(job.file, `#${job.id} ${job.warmup ? 'warm-up ' : ''}${job.kind} ${Math.round(job.length / KiB)} KiB in ${summary.ms} ms (${summary.rateKiBps} KiB/s), ${summary.pieces} pieces via ${summary.hosts.join(', ')}${summary.retries ? `, ${summary.retries} retries` : ''}${summary.duplicates ? `, ${summary.duplicates} duplicates` : ''}`);
    }
    if (job.sink === null) {
      headers.fulfil(job.file.key, new Uint8Array(job.buffer), job.total, job.contentType);
    } else {
      job.sink.done(job.buffer);
    }
  }

  /** Before commit: the browser sends the request itself, nothing is lost */
  function fallback(job: Job, reason: string) {
    stop(job, 'fallback');
    if (job.sink === null) {
      // Nobody waits for a warm-up: requests covered by it fetch by themselves
      headers.fail(job.file.key);
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
    if (job.sink === null) {
      headers.fail(job.file.key);
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
      job.contentType = response.headers.get('content-type') ?? '';
      if (job.sink === null) {
        return;
      }
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
      job.sink?.progress(job.covered, job.length);
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
        scheduler.enqueue(job, seg);
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
  }

  /**
   * Split a piece so both halves finish together, or add a duplicate. A duplicate for a piece that
   * is `stuck` (no first byte, or no new byte, past its soft threshold) is a rescue and always goes;
   * one for a piece merely expected to go faster elsewhere is speculation, and `mayDuplicate` decides
   */
  function help(job: Job, seg: Segment, att: Attempt, kind: 'dup' | 'split', now: number, stuck = false) {
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
    if (seg.extra < MAX_EXTRA && (stuck || mayDuplicate(job, now))) {
      job.lastDuplicate = { at: now, rate: deliveredRate(job, now) };
      scheduler.enqueue(job, seg, 'dup');
      return true;
    }
    return false;
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
        // Never hand back while a host is left to try, except to leave the browser the other half of
        // the player's own timeout
        if (now - job.createdAt > (job.timeout > 0 ? job.timeout / 2 : COMMIT_TIMEOUT_MS)) {
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
          if (process.env.DEBUG) {
            debugNote(job.file, `#${job.id}: no progress for ${JOB_STALL_MS} ms, unfinished pieces go to the player's own URL`);
          }
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
          const factor = URGENCY_FACTOR[job.cls];
          const stuck = att.firstByteAt === 0
            ? now - att.startedAt >= att.timeouts.ttfbSoft * factor
            : now - att.lastByteAt >= att.timeouts.stallSoft * factor;
          help(job, seg, att, decision, now, stuck);
        }
      }
    }

    if (idle) {
      endgame(now);
    }
  }

  /**
   * Race an unsplit request on a few hosts at once: 3 when critical, 2 when urgent. A slow first
   * byte is covered from the start, the losers go as soon as it is decided (`settleRace`), and with
   * nothing measured yet, racing is also how hosts get measured.
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

    setUrgency(job);

    // No more pieces than the hosts worth a primary can carry
    const pieces = planPieceCount(job.length, model.typicalRate(job.file, now), model.typicalTtfb(job.file, now), pool.primaryHostCount(job, Math.min(job.length, MiB)));
    planSegments(job, pieces);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      scheduler.enqueue(job, job.segments[i]);
    }

    if (pieces === 1) {
      const seg = job.segments[0];
      const width = raceWidth(job);
      for (let i = 1; i < width; i++) {
        scheduler.enqueue(job, seg, 'dup');
      }
    }
    if (process.env.DEBUG) {
      debugNote(job.file, `#${job.id} ${job.warmup ? 'warm-up ' : ''}${job.kind} ${Math.round(job.length / KiB)} KiB started: ${pieces} piece(s); ${scheduler.running.size} requests running, ${scheduler.queued()} queued`);
    }
  }

  /** A request inside the init/index fetched ahead: served from it, as a copy */
  /** The player asks for what a warm-up is still fetching: it becomes critical, and is raced */
  function promote(fileKey: string) {
    const job = warmups.get(fileKey);
    if (job?.state !== 'running' || job.cls === CRITICAL) {
      return;
    }
    job.cls = CRITICAL;
    job.deadline = performance.now();
    const width = raceWidth(job);
    for (let i = 0, len = job.segments.length; i < len; i++) {
      for (let j = 1; j < width; j++) {
        scheduler.enqueue(job, job.segments[i], 'dup');
      }
    }
  }

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

  /** Every playable representation's init segment and index, into the header cache */
  function warmUp(_json: object, files: readonly MediaFile[]) {
    const now = performance.now();
    const items = warmupFiles(files);
    for (let i = 0, len = items.length; i < len; i++) {
      const file = items[i];
      if (headers.has(file.key)) {
        continue;
      }
      const candidates = interceptor.candidates(file);
      // Its own last resort, as the browser would pick it
      const requested = defaultCandidate(candidates, model, file, now);
      if (requested === null) {
        continue;
      }
      const range: ByteRange = { start: 0, end: file.segmentBase!.index.end };
      headers.begin(file.key, range);
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

  interceptor.onPlayinfo(warmUp);

  if (process.env.DEBUG) {
    Object.defineProperty(unsafeWindow, '__MBGTEB_THREAD_RIPPER__', {
      configurable: true,
      enumerable: false,
      value: {
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
      // A suspected outage is no reason to decline: it may be a quiet moment
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
