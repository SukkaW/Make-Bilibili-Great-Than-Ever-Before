import type { ByteRange } from '../../core/player/range';
import { byteRangeLength } from '../../core/player/range';
import type { MediaFile } from '../../core/player/registry';
import type { UrgencyClass } from './policy';
import { RATE_WINDOW_MS, splitEvenly } from './policy';
import type { MediaCandidate } from '../../core/player/candidates';
import type { SyntheticXhrSink } from '../../utils/xhr-override';
import type { Attempt, Job, Segment } from './types';

let jobSequence = 0;

export function createJob(params: {
  file: MediaFile,
  pathname: string,
  range: ByteRange,
  header: boolean,
  warmup: boolean,
  cls: UrgencyClass,
  timeout: number,
  candidates: readonly MediaCandidate[],
  requested: MediaCandidate,
  total: number | null,
  sink: SyntheticXhrSink | null
}): Job {
  const length = byteRangeLength(params.range);
  // Handed to the page as the XHR response: allocate it in the page's realm
  const buffer = new unsafeWindow.ArrayBuffer(length);
  const now = performance.now();
  return {
    id: ++jobSequence,
    file: params.file,
    pathname: params.pathname,
    kind: params.file.kind,
    range: params.range,
    length,
    header: params.header,
    warmup: params.warmup,
    cls: params.cls,
    deadline: now,
    createdAt: now,
    timeout: params.timeout,
    rescue: { straggler: 1, stale: 1 },
    candidates: byHost(params.candidates),
    requested: params.requested,
    buffer,
    bytes: new unsafeWindow.Uint8Array(buffer),
    segments: [],
    sink: params.sink,
    contentType: '',
    state: 'running',
    committed: false,
    total: params.total,
    covered: 0,
    fetched: 0,
    lastProgressAt: now,
    // Bits per second to bytes per millisecond
    requiredRate: params.file.bandwidth / 8000,
    meter: [[now, 0]],
    lastDuplicate: null,
    saturated: false,
    hostsUsed: new Set()
  };
}

export function planSegments(job: Job, count: number) {
  const pieces = splitEvenly(job.range.start, job.range.end, count);
  for (let i = 0, len = pieces.length; i < len; i++) {
    job.segments.push({
      index: i,
      start: pieces[i][0],
      end: pieces[i][1],
      frontier: pieces[i][0],
      attempts: new Set(),
      tries: 0,
      tried: new Set(),
      final: false,
      queued: false,
      extra: 0
    });
  }
  /** One rescue per four pieces, at least one, at most four */
  const rescues = Math.min(4, Math.max(1, Math.ceil(job.segments.length / 4)));
  job.rescue.straggler = rescues;
  job.rescue.stale = rescues;
}

/**
 * Hand the tail of a segment to another attempt: the running one keeps `[frontier, splitAt)`,
 * a new segment takes `[splitAt, end]`.
 */
export function splitSegment(job: Job, seg: Segment, splitAt: number): Segment {
  const tail: Segment = {
    index: job.segments.length,
    start: splitAt,
    end: seg.end,
    frontier: splitAt,
    attempts: new Set(),
    tries: 0,
    tried: new Set(),
    final: false,
    queued: false,
    extra: 0
  };
  seg.end = splitAt - 1;
  job.segments.push(tail);
  return tail;
}

/** Bytes written for the job over the last `RATE_WINDOW_MS`, per ms: what the job delivers now */
export function deliveredRate(job: Job, now: number) {
  const { meter } = job;
  let base = meter[0];
  for (let i = 1, len = meter.length; i < len; i++) {
    if (meter[i][0] > now - RATE_WINDOW_MS) {
      break;
    }
    base = meter[i];
  }
  return (job.covered - base[1]) / Math.max(1, now - base[0]);
}

export function isSegmentComplete(seg: Segment) {
  return seg.frontier > seg.end;
}

export function isJobComplete(job: Job) {
  for (let i = 0, len = job.segments.length; i < len; i++) {
    if (!isSegmentComplete(job.segments[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Take a chunk an attempt received. Every attempt starts at or below its segment's frontier and
 * the frontier only moves forward, so what a segment holds is always the contiguous
 * `[start, frontier)`: bytes below the frontier were already written by another attempt and are
 * compared instead, bytes above it are written.
 *
 * - `ok`: keep reading
 * - `overrun`: the attempt is past its segment's end (the segment is done or shrunk), stop it
 * - `mismatch`: two responses disagree about the file's content
 *
 * `waste` counts the bytes that did not add anything: compared duplicates and overshoot.
 */
export function writeChunk(job: Job, att: Attempt, chunk: Uint8Array): { result: 'ok' | 'overrun' | 'mismatch', waste: number } {
  if (job.state !== 'running') {
    return { result: 'overrun', waste: chunk.byteLength };
  }
  const seg = att.seg;
  const pos = att.pos;
  const usable = Math.min(chunk.byteLength, seg.end + 1 - pos);
  if (usable <= 0) {
    return { result: 'overrun', waste: chunk.byteLength };
  }

  const base = job.range.start;
  const duplicateEnd = Math.min(pos + usable, seg.frontier);
  for (let offset = pos; offset < duplicateEnd; offset++) {
    if (job.bytes[offset - base] !== chunk[offset - pos]) {
      return { result: 'mismatch', waste: chunk.byteLength };
    }
  }
  let waste = Math.max(0, duplicateEnd - pos) + (chunk.byteLength - usable);

  if (pos + usable > seg.frontier) {
    const fresh = chunk.subarray(seg.frontier - pos, usable);
    job.bytes.set(fresh, seg.frontier - base);
    job.covered += fresh.byteLength;
    seg.frontier = pos + usable;
    const now = performance.now();
    job.lastProgressAt = now;
    seg.tried.clear();
    // One sample at or before the window's start stays, see `deliveredRate`
    const { meter } = job;
    meter.push([now, job.covered]);
    let stale = 0;
    while (stale < meter.length - 1 && meter[stale + 1][0] <= now - RATE_WINDOW_MS) {
      stale++;
    }
    if (stale > 0) {
      meter.splice(0, stale);
    }
  } else {
    waste = chunk.byteLength;
  }

  att.pos = pos + usable;
  return { result: usable < chunk.byteLength ? 'overrun' : 'ok', waste };
}

function byHost(candidates: readonly MediaCandidate[]) {
  const grouped = new Map<string, MediaCandidate[]>();
  for (let i = 0, len = candidates.length; i < len; i++) {
    const candidate = candidates[i];
    const list = grouped.get(candidate.hostname);
    if (list) {
      list.push(candidate);
    } else {
      grouped.set(candidate.hostname, [candidate]);
    }
  }
  return grouped;
}
