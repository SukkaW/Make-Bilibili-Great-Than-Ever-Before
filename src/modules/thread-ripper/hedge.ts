/**
 * When a piece needs help, and which: a duplicate on another host, or handing its tail to one
 * (a split). A port of Bilibili Thread Ripper's `hedgeDue`, driven by the playback deadline.
 */

import { clamp } from 'foxts/clamp';
import { KiB } from './policy';
import type { Attempt, Job, Segment } from './types';

/** Scales the soft and hard thresholds: critical work is helped sooner */
export const URGENCY_FACTOR = [0.7, 0.85, 1, 2] as const;

/** Neither half of a split is smaller */
export const STEAL_MIN = 192 * KiB;

export type Help = 'none' | 'dup' | 'split';

/** Speed over the last half second, or since the first byte when the history is short */
export function recentRate(att: Attempt, now: number): number {
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

export interface HelpContext {
  now: number,
  /** What a request usually gets through (bytes per ms) */
  typicalRate: number,
  /** The best host available for this piece, if any */
  alternative: { rate: number, measured: boolean } | null,
  /** Finish this much before the deadline to be on time, ms */
  slack: number
}

/** For a piece with exactly one attempt in flight */
export function decideHelp(att: Attempt, seg: Segment, job: Job, ctx: HelpContext): Help {
  const { now } = ctx;
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
  if (eta <= job.deadline - ctx.slack) {
    return 'none';
  }
  const help: Help = remaining >= 2 * STEAL_MIN ? 'split' : 'dup';
  // Late, and clearly slower than usual
  if (eta >= job.deadline && rate < 0.5 * ctx.typicalRate && eta - now >= 500 && claim(job, 'straggler')) {
    return help;
  }
  const { alternative } = ctx;
  // A host known to be clearly faster
  if (alternative?.measured && alternative.rate > rate * 1.5) {
    return help;
  }
  // Slower than requests usually are
  if (rate < ctx.typicalRate * 0.6) {
    return help;
  }
  // On pace, but a host never measured might be faster
  if (alternative !== null && !alternative.measured) {
    return help;
  }
  // Will miss the deadline anyway: what is known about the alternative may be stale
  if (eta > job.deadline && claim(job, 'stale')) {
    return help;
  }
  return 'none';
}

/**
 * Where to split a piece so both halves finish together: the running attempt (rate `r`) keeps
 * `[frontier, m)`, a new one (first byte after `ttfb`, rate `rNew`) takes `[m, end]`.
 *
 * @returns `null` when either half would be too small to be worth it
 */
export function splitPoint(seg: Segment, r: number, ttfb: number, rNew: number): number | null {
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
export function hedgeSlack(typicalTtfb: number) {
  return clamp(2 * typicalTtfb, 500, 1500);
}

function claim(job: Job, kind: 'straggler' | 'stale') {
  if (job.rescue[kind] <= 0) {
    return false;
  }
  job.rescue[kind]--;
  return true;
}
