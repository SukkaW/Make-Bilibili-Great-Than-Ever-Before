import { logger } from '../../logger';
import type { HostModel } from '../../core/player/host-model';
import { MediaOutcome } from '../../core/player/host-model';
import { URGENCY_FACTOR } from './hedge';
import type { HostPool } from './host-pool';
import { GLOBAL_CAP, JOB_STALL_MS, TICK_MS, URGENT, URGENT_RESERVE } from './policy';
import { isSegmentComplete } from './range-job';
import type { MediaCandidate } from '../../core/player/candidates';
import type { Attempt, AttemptRole, HostState, Job, Segment } from './types';

interface Unit {
  readonly job: Job,
  readonly seg: Segment,
  readonly role: AttemptRole,
  readonly seq: number,
  /** Bypass host selection: the player's own URL as the last resort */
  readonly forced: { hostname: string, candidate: MediaCandidate } | null
}

export interface SchedulerHooks {
  run(this: void, att: Attempt): Promise<MediaOutcome>,
  onAttemptEnd(this: void, att: Attempt, outcome: MediaOutcome): void,
  /** Every tick while there is work: urgency, hedging, the endgame */
  onTick(this: void, now: number, idle: boolean): void,
  hasWork(this: void): boolean
}

let attemptSequence = 0;

export type Scheduler = ReturnType<typeof createScheduler>;

/**
 * Earliest deadline first, within caps: at most `GLOBAL_CAP` attempts in flight, a few of them
 * reserved for urgent work, and per host whatever its cap allows.
 */
export function createScheduler(pool: HostPool, model: HostModel, hooks: SchedulerHooks) {
  let queue: Unit[] = [];
  const queuedDuplicates = new Set<Segment>();
  const running = new Set<Attempt>();
  let unitSequence = 0;
  let pumping = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const remaining = (unit: Unit) => unit.seg.end - unit.seg.frontier + 1;

  function before(a: Unit, b: Unit) {
    return a.job.cls - b.job.cls
      || a.job.deadline - b.job.deadline
      || remaining(a) - remaining(b)
      || a.seq - b.seq;
  }

  function ensureTick() {
    if (tickTimer === null) {
      tickTimer = setInterval(tick, TICK_MS);
    }
  }

  function abortAttempt(att: Attempt, reason: NonNullable<Attempt['abortReason']>) {
    if (att.abortReason === null) {
      att.abortReason = reason;
      att.controller.abort();
    }
  }

  /** A hard timeout only kills an attempt when something else can take over */
  function canGiveUp(att: Attempt, now: number) {
    return att.seg.attempts.size > 1
      || pool.bestAlternative(att.job, att.seg) !== null
      || now - att.startedAt > JOB_STALL_MS;
  }

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
      hooks.onTick(now, running.size < GLOBAL_CAP && queue.length === 0);
    } catch (e) {
      logger.error('[thread-ripper] tick failed', e);
    }

    if (tickTimer !== null && running.size === 0 && queue.length === 0 && !hooks.hasWork()) {
      clearInterval(tickTimer);
      tickTimer = null;
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
    ensureTick();

    void runAndFinish(att);
  }

  async function runAndFinish(att: Attempt) {
    let outcome: MediaOutcome;
    try {
      outcome = await hooks.run(att);
    } catch (e) {
      logger.error('[thread-ripper] attempt crashed', e);
      outcome = MediaOutcome.Network;
    }
    finish(att, outcome);
  }

  function finish(att: Attempt, outcome: MediaOutcome) {
    att.host.active--;
    running.delete(att);
    att.seg.attempts.delete(att);
    pool.apply(att, outcome);
    try {
      hooks.onAttemptEnd(att, outcome);
    } finally {
      pump();
    }
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
          ? { host: pool.getHost(unit.forced.hostname), candidate: unit.forced.candidate }
          : pool.pick(unit.job, unit.seg, unit.role);
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

  return {
    running,

    /** Queue work on a segment. One primary and one duplicate per segment wait at most */
    enqueue(job: Job, seg: Segment, role: AttemptRole = 'primary', forced: Unit['forced'] = null) {
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
      ensureTick();
      pump();
    },

    /** Stop everything a job has queued or in flight, except attempts already past their end */
    cancelJob(job: Job) {
      const removed = queue.filter(unit => unit.job === job);
      for (let i = 0, len = removed.length; i < len; i++) {
        dequeue(removed[i]);
      }
      for (const att of running) {
        if (att.job === job && att.pos <= att.seg.end) {
          abortAttempt(att, MediaOutcome.Canceled);
        }
      }
    },

    abortAttempt,

    pump,

    hasQueuedDuplicate(seg: Segment) {
      return queuedDuplicates.has(seg);
    },

    queued() {
      return queue.length;
    }
  };
}
