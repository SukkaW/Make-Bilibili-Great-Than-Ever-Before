import type { MediaCandidate } from '../../core/player/candidates';
import type { HostTimeouts } from '../../core/player/host-model';
import type { ByteRange } from '../../core/player/range';
import type { MediaFile, MediaKind } from '../../core/player/registry';
import type { SyntheticXhrSink } from '../../types';
import type { AbortReason } from './classify';
import type { UrgencyClass } from './policy';

/** A host's slots: what is known about it lives in the shared host model */
export interface HostState {
  readonly hostname: string,
  /** Lower cap: one connection per request, and Chrome opens at most 6 per host */
  readonly http1: boolean,
  /** Attempts in flight on this host */
  active: number,
  /** Max attempts in flight: AIMD, +1 per success after the first 3, halved on 412 / 429 / 503 */
  cap: number,
  /** Successful attempts, the cap only grows after the first few */
  successes: number,
  /** The cap does not grow within 10 s of a throttle */
  lastThrottleAt: number,
  /** Smooth weighted round-robin credit */
  credit: number
}

/** Why an attempt was started */
export type AttemptRole = 'primary' | 'dup' | 'final';

/** One piece of a job's range: fetched by one attempt at a time, plus hedges */
export interface Segment {
  /** Position in the job, for logs */
  readonly index: number,
  readonly start: number,
  /** Inclusive. Moves in when its tail is split off to another attempt */
  end: number,
  /** Everything in `[start, frontier)` is written. Only ever moves forward */
  frontier: number,
  /** In flight: one, or more while hedging */
  readonly attempts: Set<Attempt>,
  /** Failed attempts: after `MAX_TRIES_PER_SEGMENT`, the job falls back or fails */
  tries: number,
  /** Hosts tried since the segment last made progress */
  readonly tried: Set<string>,
  /** Last resort: the player's own URL */
  final: boolean,
  /** Waiting in the scheduler's queue */
  queued: boolean,
  /** Duplicates started for it */
  extra: number
}

/** One fetch() of (part of) a segment from one host. Times are performance.now() ms, `0` = not yet */
export interface Attempt {
  readonly id: number,
  readonly job: Job,
  readonly seg: Segment,
  readonly host: HostState,
  readonly candidate: MediaCandidate,
  /** `candidate.href` */
  readonly url: string,
  readonly role: AttemptRole,
  /** The requested range, inclusive: from the segment's frontier when started */
  readonly rangeStart: number,
  readonly rangeEnd: number,
  readonly controller: AbortController,
  /** Set when we abort it ourselves: tells a race lost or a timeout from a network error */
  abortReason: AbortReason | null,
  /** No request to this host for a while: this one pays for the TLS handshake */
  readonly cold: boolean,
  /** Unscaled: the job's urgency scales them when checked */
  readonly timeouts: HostTimeouts,
  readonly startedAt: number,
  /** Response headers arrived */
  headersAt: number,
  /** Where a redirect led, if one did */
  redirectedTo: string | null,
  firstByteAt: number,
  /** Size of the first chunk: left out of speed measurements, it arrives with the first byte */
  firstChunkBytes: number,
  lastByteAt: number,
  /** Received so far, including bytes other attempts already wrote */
  bytes: number,
  /** Absolute offset of the next byte this attempt receives */
  pos: number,
  /** Recent (time, cumulative bytes) samples, to measure its current speed */
  readonly meter: Array<[time: number, bytes: number]>,
  /** Gaps between chunks, for the host's stall threshold */
  readonly gaps: number[]
}

/** One XHR range the player asked for, answered by many attempts across hosts */
export interface Job {
  readonly id: number,
  readonly file: MediaFile,
  readonly pathname: string,
  readonly kind: MediaKind,
  /** What the player asked for */
  readonly range: ByteRange,
  /** Bytes in `range` */
  readonly length: number,
  /** The initialization segment or the index: nothing plays without them */
  readonly header: boolean,
  /** Fetched ahead of the player: `current` is what it will ask for first */
  readonly warmup: 'current' | 'other' | null,
  /** Set when the job starts, see `setUrgency` in the engine */
  cls: UrgencyClass,
  /** When its bytes are wanted (performance.now() time): past its start by how urgent it is */
  deadline: number,
  readonly createdAt: number,
  /** Rescue budget: help for pieces that miss their deadline although on pace */
  readonly rescue: { straggler: number, stale: number },
  /** Every acceptable URL of the file, by host */
  readonly candidates: ReadonlyMap<string, readonly MediaCandidate[]>,
  /** The URL the player asked for (the warm-up's own pick for its jobs): the last resort */
  readonly requested: MediaCandidate,
  /** Page-realm memory: it is handed to the page as the XHR response */
  readonly buffer: ArrayBuffer,
  /** View of `buffer` */
  readonly bytes: Uint8Array,
  /** The pieces `range` is split into, in order */
  readonly segments: Segment[],
  /** The synthetic XHR response this job drives */
  readonly sink: SyntheticXhrSink,
  state: 'running' | 'done' | 'failed',
  /** Headers were handed to the page: falling back to a native request is no longer possible */
  committed: boolean,
  /** The whole file's size, from the first valid Content-Range */
  total: number | null,
  /** Distinct bytes written so far: the XHR progress */
  covered: number,
  /** Every byte received for it: duplicates, overlaps and cut-off attempts included */
  fetched: number,
  /** Last time new bytes were written: stuck too long, unfinished pieces go to the player's own URL */
  lastProgressAt: number,
  /** Distinct hosts that delivered bytes, for the debug log */
  readonly hostsUsed: Set<string>
}
