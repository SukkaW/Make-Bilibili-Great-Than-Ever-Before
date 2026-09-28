/**
 * Sane presets: nothing here is user-facing.
 *
 * Rates are in bytes per millisecond, durations in milliseconds.
 */

import { clamp } from 'foxts/clamp';

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** Attempts in flight across all jobs */
export const GLOBAL_CAP = 32;
/** Slots only critical / urgent work may take */
export const URGENT_RESERVE = 2;
/** Per host: HTTP/2 multiplexes on one connection, the CDN throttles per request */
export const HOST_CAP_H2 = 6;
/** Until a host has proven itself */
export const HOST_CAP_H2_WARMUP = 4;
/**
 * Over HTTP/1.1 every request needs its own connection and Chrome opens at most 6 per host, shared
 * with the player's own requests: anything beyond waits inside the browser, and that wait would be
 * mistaken for a slow first byte
 */
export const HOST_CAP_H1 = 4;
/** Primaries only go to the best hosts */
export const TOP_HOSTS = 6;

export const MAX_PIECES = 16;
export const MIN_PIECE = 192 * KiB;
export const MAX_PIECE = 4 * MiB;
export const MAX_SERVED_LENGTH = 64 * MiB;
export const MAX_TRIES_PER_SEGMENT = 6;

export const TTFB_HARD_MS = 2400;
export const STALL_HARD_MS = 1200;
export const HTTP1_TIMEOUT_FACTOR = 1.5;
/** No validated 206 from any host by then: give the request back to the browser */
export const COMMIT_TIMEOUT_MS = clamp(2 * TTFB_HARD_MS, 2000, 5000);
/** Committed, but no byte arrived for this long */
export const JOB_STALL_MS = 8000;
export const TICK_MS = 50;

/** Urgency classes, most urgent first */
export const CRITICAL = 0;
export const URGENT = 1;
export const NORMAL = 2;
export const RELAXED = 3;
export type UrgencyClass = typeof CRITICAL | typeof URGENT | typeof NORMAL | typeof RELAXED;

/**
 * How many pieces a range is split into. A range whose transfer takes less than two round trips
 * is not worth splitting; otherwise each piece should keep its request busy for a good part of
 * a second.
 */
export function planPieceCount(length: number, rate: number, ttfb: number, usableHosts: number): number {
  if (length < clamp(2 * rate * ttfb, 128 * KiB, MiB)) {
    return 1;
  }
  const targetMs = clamp(4 * ttfb, 600, 1500);
  const pieceSize = clamp(rate * targetMs, MIN_PIECE, MAX_PIECE);
  const cap = Math.max(1, Math.min(MAX_PIECES, usableHosts * HOST_CAP_H2_WARMUP));
  return clamp(Math.ceil(length / pieceSize), 1, cap);
}

/** Split `[start, end]` into `count` contiguous pieces of (almost) equal length */
export function splitEvenly(start: number, end: number, count: number): Array<[start: number, end: number]> {
  const length = end - start + 1;
  const base = Math.floor(length / count);
  const remainder = length % count;
  const pieces: Array<[number, number]> = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    const size = base + (i < remainder ? 1 : 0);
    pieces.push([cursor, cursor + size - 1]);
    cursor += size;
  }
  return pieces;
}
