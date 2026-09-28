import { p } from 'fast-percentile';
import type { HostEstimate, HostModel } from '../../core/player/host-model';
import { isCandidateUsable } from '../../core/player/candidates';
import type { CandidateTier, MediaCandidate } from '../../core/player/candidates';
import { MediaOutcome, MIN_RATE_SAMPLE_BYTES } from '../../core/player/host-model';
import {
  CRITICAL, HOST_CAP_H1, HOST_CAP_H2, HOST_CAP_H2_WARMUP,
  NORMAL, RELAXED, TOP_HOSTS, KiB
} from './policy';
import type { Attempt, AttemptRole, HostState, Job, Segment } from './types';

/** The gaps between an attempt's chunks are reported as their 90th percentile */
const p90 = p(90);

/** A piece this small is about latency, not throughput: pick by expected finish time */
const SMALL_UNIT = 256 * KiB;
/** Speed samples of transfers cut short count less */
const PARTIAL_SAMPLE_BYTES = 16 * KiB;

/** A host that could take a piece, with the URL it would get and what it is expected to do */
interface HostOption {
  host: HostState,
  candidate: MediaCandidate,
  estimate: HostEstimate
}

export type HostPool = ReturnType<typeof createHostPool>;

/**
 * The engine's own view of the hosts: how many requests each may carry right now. Everything
 * known about them (speed, reliability) lives in the shared host model.
 */
export function createHostPool(model: HostModel) {
  const slots = new Map<string, HostState>();
  let rotation = 0;

  function getHost(hostname: string): HostState {
    let host = slots.get(hostname);
    if (host === undefined) {
      const http1 = model.isHttp1(hostname);
      host = {
        hostname,
        http1,
        active: 0,
        cap: http1 ? HOST_CAP_H1 : HOST_CAP_H2_WARMUP,
        successes: 0,
        // Never: `performance.now()` starts near 0, where `0` would read as "just now"
        lastThrottleAt: -Infinity,
        credit: 0
      };
      slots.set(hostname, host);
    }
    return host;
  }

  /**
   * For one host: the signature it served last, else one of a family it accepts, spread over
   * the file's signatures
   */
  function pickCandidate(hostname: string, job: Job, now: number, nowSec: number): MediaCandidate | null {
    const proven = model.provenAddress(hostname);
    const listed = job.candidates.get(hostname) ?? [];
    const usable: MediaCandidate[] = [];
    for (let i = 0, len = listed.length; i < len; i++) {
      const candidate = listed[i];
      if (isCandidateUsable(candidate, model, job.file, now, nowSec)) {
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

  /** Hosts that could take a request for this segment right now */
  function eligible(job: Job, seg: Segment, role: AttemptRole, now: number): HostOption[] {
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
          host.active >= host.cap
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

  /** Whether any of the job's URLs on this host could be used now: no side effect, unlike `pickCandidate` */
  function hasUsableCandidate(hostname: string, job: Job, now: number, nowSec: number) {
    const listed = job.candidates.get(hostname) ?? [];
    for (let i = 0, len = listed.length; i < len; i++) {
      if (isCandidateUsable(listed[i], model, job.file, now, nowSec)) {
        return true;
      }
    }
    return false;
  }

  return {
    getHost,

    pick(job: Job, seg: Segment, role: AttemptRole): { host: HostState, candidate: MediaCandidate } | null {
      const now = performance.now();
      const options = eligible(job, seg, role, now);
      if (options.length === 0) {
        return null;
      }
      const chosen = role === 'dup'
        ? chooseDuplicate(options, job)
        : choosePrimary(options, job, seg.end - seg.frontier + 1);
      if (seg.tried.has(chosen.host.hostname)) {
        // Every usable host was tried: a new round starts with this one
        seg.tried.clear();
      }
      return { host: chosen.host, candidate: chosen.candidate };
    },

    /** The best host a duplicate or a split of this segment would go to */
    bestAlternative(job: Job, seg: Segment): HostEstimate | null {
      const options = eligible(job, seg, 'dup', performance.now());
      if (options.length === 0) {
        return null;
      }
      return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best)).estimate;
    },

    /** Hosts that could serve the job now: not cooling down, with a URL it would accept */
    usableHostCount(job: Job) {
      const now = performance.now();
      const nowSec = Date.now() / 1000;
      let count = 0;
      for (const hostname of job.candidates.keys()) {
        if (!model.isCoolingDown(hostname, now) && hasUsableCandidate(hostname, job, now, nowSec)) {
          count++;
        }
      }
      return count;
    },

    measuredHostCount(job: Job) {
      const now = performance.now();
      const names = Array.from(job.candidates.keys());
      let count = 0;
      for (let i = 0, len = names.length; i < len; i++) {
        if (model.estimate(names[i], job.file, 1, now).measured) {
          count++;
        }
      }
      return count;
    },

    /** Caps here, knowledge into the host model */
    apply(att: Attempt, outcome: MediaOutcome) {
      const { host, candidate, job } = att;
      const now = performance.now();

      model.recordOutcome(host.hostname, job.file, candidate, outcome, now);

      if (outcome === MediaOutcome.Ok) {
        host.successes++;
        const maxCap = host.http1 ? HOST_CAP_H1 : HOST_CAP_H2;
        if (host.cap < maxCap && host.successes >= 3 && now - host.lastThrottleAt > 10 * 1000) {
          host.cap++;
        }
      } else if (outcome === MediaOutcome.Throttled || outcome === MediaOutcome.Overloaded) {
        host.cap = Math.max(1, host.cap >> 1);
        host.lastThrottleAt = now;
      }

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
    },

    snapshot() {
      return Array.from(slots.values(), host => ({
        hostname: host.hostname,
        active: host.active,
        cap: host.cap,
        successes: host.successes
      }));
    }
  };
}

/**
 * Primaries go to measured hosts only: the top ones by speed, none below a twelfth of the best
 * (a sixth when critical), shared out by smooth weighted round-robin. A small piece goes to
 * the host expected to finish it first. Unmeasured hosts are explored by duplicates (and
 * relaxed work), and only carry primaries while nothing is measured at all.
 */
function choosePrimary(options: HostOption[], job: Job, bytes: number): HostOption {
  const measured = options.filter(option => option.estimate.measured);
  const explore = measured.length < options.length && job.cls === RELAXED;
  if (explore || measured.length === 0) {
    // The tier ranks what is not measured: the least busy of the best tier
    const unmeasured = options.filter(option => !option.estimate.measured);
    return bestTier(unmeasured.length > 0 ? unmeasured : options).reduce((best, option) => (option.host.active < best.host.active ? option : best));
  }

  let top = 0;
  for (let i = 0, len = measured.length; i < len; i++) {
    top = Math.max(top, measured[i].estimate.rate);
  }
  const floor = top / (job.cls === CRITICAL ? 6 : 12);
  const pool = measured
    .filter(c => c.estimate.rate >= floor)
    .sort((a, b) => b.estimate.rate - a.estimate.rate)
    .slice(0, TOP_HOSTS);

  if (bytes < SMALL_UNIT) {
    return pool.reduce((best, c) => (c.estimate.eta < best.estimate.eta ? c : best));
  }

  let total = 0;
  let best = pool[0];
  for (let i = 0, len = pool.length; i < len; i++) {
    const c = pool[i];
    const weight = Math.max(c.estimate.rate, top * 0.05);
    c.host.credit += weight;
    total += weight;
    if (c.host.credit > best.host.credit) {
      best = c;
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
    return bestTier(unmeasured).reduce((best, option) => (option.estimate.ttfb < best.estimate.ttfb ? option : best));
  }
  return options.reduce((best, option) => (option.estimate.eta < best.estimate.eta ? option : best));
}

/** The options whose URL has the lowest tier */
function bestTier(options: HostOption[]): HostOption[] {
  let best: CandidateTier | null = null;
  for (let i = 0, len = options.length; i < len; i++) {
    if (best === null || options[i].candidate.tier < best) {
      best = options[i].candidate.tier;
    }
  }
  return options.filter(option => option.candidate.tier === best);
}
