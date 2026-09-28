import { clamp } from 'foxts/clamp';
import { CRITICAL } from './policy';
import type { UrgencyClass } from './policy';

/** Until measured, assume this much to spare: 100 Mbps */
const PRIOR_CAPACITY = 100 * 1000 * 1000 / 8;
const MIN_CAPACITY = 1000 * 1000;
const CAPACITY_WINDOW_S = 30;
const WASTE_WINDOW_MS = 10 * 1000;

export type Budget = ReturnType<typeof createBudget>;

/**
 * How much bandwidth duplicates may burn: what the link has to spare beyond the video's bitrate.
 * With 100 Mbps, a 25 Mbps 4K video can afford racing freely, an 8K one is rationed.
 */
export function createBudget() {
  /** bytes received per whole second */
  const seconds = new Map<number, number>();
  let wasted: Array<[time: number, bytes: number]> = [];
  /** Bytes per second of the video being played */
  let bitrate = 0;

  function capacity(now: number) {
    const current = Math.floor(now / 1000);
    let busy = 0;
    let peak = 0;
    for (const [second, bytes] of seconds) {
      if (current - second > CAPACITY_WINDOW_S) {
        seconds.delete(second);
      } else if (second !== current && bytes > 0) {
        busy++;
        peak = Math.max(peak, bytes);
      }
    }
    return busy < 3 ? PRIOR_CAPACITY : Math.max(MIN_CAPACITY, peak);
  }

  function wasteInWindow(now: number) {
    wasted = wasted.filter(([at]) => now - at < WASTE_WINDOW_MS);
    let total = 0;
    for (let i = 0, len = wasted.length; i < len; i++) {
      total += wasted[i][1];
    }
    return total;
  }

  /** Waste allowed, in bytes per second */
  function dupBudget(now: number) {
    const b = bitrate > 0 ? bitrate : 1000 * 1000 / 8;
    const mbps = b * 8 / 1000 / 1000;
    const k = mbps <= 8 ? 4 : (mbps >= 25 ? 2 : 4 - 2 * (mbps - 8) / 17);
    return Math.max(0, Math.min(k * b, capacity(now) - 1.25 * b));
  }

  function headroom(now: number) {
    return bitrate > 0 ? capacity(now) / bitrate : 4;
  }

  return {
    received(bytes: number, now: number) {
      const second = Math.floor(now / 1000);
      seconds.set(second, (seconds.get(second) ?? 0) + bytes);
    },
    waste(bytes: number, now: number) {
      if (bytes > 0) {
        wasted.push([now, bytes]);
      }
    },
    /** The bitrate of what is playing, from the file's own `bandwidth` (bits per second) */
    setBitrate(bitsPerSecond: number) {
      if (bitsPerSecond > 0) {
        bitrate = bitsPerSecond / 8;
      }
    },
    /** Link capacity over the video's bitrate */
    headroom,
    /** May a duplicate of about `bytes` start now? Critical work may overdraw twice */
    allowDup(cls: UrgencyClass, bytes: number, now: number) {
      const allowance = dupBudget(now) * WASTE_WINDOW_MS / 1000;
      const waste = wasteInWindow(now);
      return cls === CRITICAL ? waste < 2 * allowance : waste + bytes <= allowance;
    },
    snapshot(now: number) {
      return {
        capacityMbps: Math.round(capacity(now) * 8 / 1000 / 100) / 10,
        bitrateMbps: Math.round(bitrate * 8 / 1000 / 100) / 10,
        dupBudgetMbps: Math.round(dupBudget(now) * 8 / 1000 / 100) / 10,
        waste10sKiB: Math.round(wasteInWindow(now) / 1024),
        headroom: Math.round(clamp(headroom(now), 0, 100) * 10) / 10
      };
    }
  };
}
