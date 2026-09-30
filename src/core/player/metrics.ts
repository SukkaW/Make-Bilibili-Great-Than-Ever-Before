/**
 * Debug builds only: how playback really goes, to compare real sessions with thread-ripper on and
 * off (or anything else the phases change).
 *
 * One session per video (the registry's `videoKey`). Startup, rebuffering and seeks come from the
 * player's `<video>` events. Every media XHR the player sends, whoever answers it, gives its
 * duration, first byte, bytes and quality. Thread-ripper adds its jobs: how they ended and how many
 * bytes it fetched from the CDN to deliver them.
 *
 * Sessions are kept in GM storage across page loads, labelled with the phases that were on, so
 * `__MBGTEB_METRICS__.compare()` in the console puts configurations side by side.
 */

import { p50, p } from 'fast-percentile';
import { logger } from '../../logger';
import { registerDebugCommand } from '../../utils/debug-menu';
import type { ByteRange } from './range';
import { byteRangeLength } from './range';
import type { MediaFile } from './registry';

const STORAGE_KEY = 'mbgtbe:debug:metrics-sessions';
/** Set by the build (see `rollup.config.ts`) */
const BUILD_ID = process.env.BUILD_ID ?? 'dev';
/** Oldest dropped first */
const MAX_SESSIONS = 300;
/** Less playback than this says nothing about rebuffering: not saved */
const MIN_PLAYED_S = 10;
/** A `timeupdate` jump larger than this is a seek, not playback */
const MAX_PLAY_STEP_S = 2;
const SAVE_INTERVAL_MS = 30 * 1000;
/** Where the player's `<video>` is (`bwp-video` for its own HEVC decoder) */
const PLAYER_VIDEO_SELECTOR = '#bilibili-player video, #bilibili-player bwp-video, .bpx-player-container video, .bpx-player-container bwp-video';
/** How long after the player's first request for a video its startup trace runs */
const TRACE_MS = 20 * 1000;
/** How long a stall, or the player asking again for a range it was given, reopens the trace */
const EVENT_TRACE_MS = 10 * 1000;
/** Most events in a startup trace */
const MAX_TRACE = 300;
/** Saved sessions that keep their startup trace: the latest ones */
const TRACED_SESSIONS = 20;
/** `<video>` events worth a line in the startup trace */
const TRACED_VIDEO_EVENTS = ['loadstart', 'canplay', 'playing', 'waiting', 'seeking', 'seeked'];
/** Videos kept per page: a long SPA session sees many */
const MAX_PAGE_SESSIONS = 16;
/** `/video/BV1xx/` and `/video/BV1xx` are the same video */
const TRAILING_SLASHES_RE = /\/+$/;
const FIND_VIDEO_INTERVAL_MS = 1000;
const KiB = 1024;
const MiB = 1024 * KiB;

const p90 = p(90);

/** How a serve phase's job ended, as far as the metrics care */
export interface JobRecord {
  readonly result: 'done' | 'fallback' | 'failed' | 'canceled',
  /** Fetched ahead of the player, not asked for by it */
  readonly warmup: boolean,
  /** What the job delivered (the requested range) */
  readonly bytes: number,
  /** Everything received from the CDN for it: duplicates, overlaps and cut-off attempts included */
  readonly fetchedBytes: number,
  readonly pieces: number,
  readonly duplicates: number,
  readonly retries: number,
  readonly hosts: number
}

/** One request a serve phase sent to a CDN host on its own */
export interface AttemptRecord {
  readonly hostname: string,
  readonly bytes: number,
  /** `null` without a response */
  readonly ttfbMs: number | null,
  /** Bytes per second after the first chunk, `null` for too few bytes to tell */
  readonly rateKiBps: number | null,
  /** How it ended: a `MediaOutcome` */
  readonly outcome: string,
  /** The host a redirect led to, if one did: an extension's (AdGuard's 307) stays on the same host */
  readonly redirectedTo: string | null
}

export interface PlaybackMetrics {
  /**
   * A media XHR the player sent
   *
   * @param hostname where the XHR goes
   * @param served a serve phase answers it
   */
  watchRequest(this: void, xhr: XMLHttpRequest, file: MediaFile, range: ByteRange, hostname: string, served: boolean): void,
  recordJob(this: void, file: MediaFile, job: JobRecord): void,
  recordAttempt(this: void, file: MediaFile, attempt: AttemptRecord): void,
  /** An event for the startup trace of `file`'s video, or of the video playing */
  note(this: void, file: MediaFile | null, text: string): void,
  /** Which arm of an A/B test `file`'s video is in: part of its configuration */
  setArm(this: void, file: MediaFile, arm: string): void
}

/** One saved session, and one row of the comparison */
export interface SessionSummary {
  readonly id: string,
  /** The build that recorded it: sessions of an older build are dropped, a new build starts over */
  readonly build: string,
  /** `location.pathname` when the session started */
  readonly page: string,
  /** ISO date */
  readonly startedAt: string,
  /** The phases that were on, e.g. `no-p2p+thread-ripper` */
  readonly config: string,
  readonly playedS: number,
  /**
   * From the player's first media request until the video can play (`canplay`). Not until
   * `playing`: the player calls `play()` only once it has data, and not at all without autoplay
   */
  readonly startupMs: number | null,
  readonly stalls: number,
  readonly stallMs: number,
  /** Stalled time / (played + stalled time) */
  readonly rebufferRatio: number,
  readonly seeks: number,
  /** Player requests for a range it had been given in full already: data it threw away, not the network's doing */
  readonly repeats: number,
  readonly seekP50Ms: number | null,
  readonly seekMaxMs: number | null,
  readonly video: RequestStats,
  readonly audio: RequestStats,
  readonly header: RequestStats,
  /** Media XHRs that failed (error, timeout, not the requested range) */
  readonly errors: number,
  /** Share of the player's media XHRs a serve phase answered */
  readonly servedShare: number,
  /** Mean bandwidth of the video segments requested, kbps: which quality the player could afford */
  readonly videoKbps: number | null,
  /** Video segment requests per quality id */
  readonly qualities: Record<string, number>,
  readonly jobs: Record<JobRecord['result'], number>,
  /** Bytes fetched from the CDN / bytes the player got, over its own requests (1 when native) */
  readonly overhead: number | null,
  readonly deliveredMiB: number,
  /** Share of the media bytes that came from the host the player's XHRs were opened with */
  readonly playerHostShare: number | null,
  /** Every host that delivered media, most bytes first */
  readonly hosts: HostSummary[],
  /**
   * What happened, `+<ms since the session began> <event>`, until `TRACE_MS` after the player's
   * first request (why a start was slow), and `EVENT_TRACE_MS` after a stall or the first repeat.
   * Only the latest `TRACED_SESSIONS` saved sessions keep it
   */
  readonly trace?: readonly string[]
}

/** One CDN host in one session: the player's own requests when native, a serve phase's otherwise */
interface HostSummary {
  readonly host: string,
  /** The host the player's XHRs were opened with */
  readonly player: boolean,
  readonly requests: number,
  readonly MiB: number,
  readonly ttfbP50Ms: number | null,
  readonly p50KiBps: number | null,
  /** Requests that failed, by how: a `MediaOutcome`, or for a native one `network`, `timeout`, the HTTP status or `length` */
  readonly failed: Record<string, number>,
  /** Serve phase requests redirected, by the host they landed on */
  readonly redirects: Record<string, number>
}

interface RequestStats {
  readonly n: number,
  readonly p50Ms: number | null,
  readonly p90Ms: number | null,
  readonly firstByteP50Ms: number | null,
  /** Median of each request's bytes / duration */
  readonly p50KiBps: number | null
}

interface RequestRecord {
  readonly hostname: string,
  readonly kind: 'video' | 'audio' | 'header',
  readonly quality: number,
  readonly bandwidth: number,
  readonly bytes: number,
  readonly ms: number,
  readonly firstByteMs: number | null,
  readonly served: boolean,
  readonly ok: boolean,
  /** Why it failed: `network`, `timeout`, the HTTP status, or `length` for a short body */
  readonly failure: string | null
}

interface Session {
  readonly id: string,
  /** `performance.now()` when the session began: its trace counts from here */
  readonly createdAt: number,
  /** The arm of an A/B test, see `setArm` */
  arm: string | null,
  readonly trace: string[],
  readonly videoKey: string,
  /** Where the video plays: set again once it can play, it may have been prefetched on another page */
  page: string,
  readonly startedAt: number,
  readonly config: string,
  /** `performance.now()` of the player's first media request in this session */
  firstRequestAt: number | null,
  /** `performance.now()` the trace runs until, once the player's first request came */
  traceUntil: number,
  startupMs: number | null,
  /** It was playing before its start was seen (the element was found late): startup is unknown */
  startMissed: boolean,
  stalls: number,
  stallMs: number,
  /** A stall in progress since then */
  stallAt: number | null,
  readonly seekMs: number[],
  /** A seek in progress since then */
  seekAt: number | null,
  playedS: number,
  /** Last `currentTime` seen playing, `null` right after a seek */
  lastTime: number | null,
  readonly requests: RequestRecord[],
  /** `<file key>:<range>` of every request the player got in full */
  readonly delivered: Set<string>,
  repeats: number,
  readonly jobs: JobRecord[],
  readonly attempts: AttemptRecord[]
}

/**
 * @param configOf the phases that are on, as the label sessions are compared by
 */
export function createPlaybackMetrics(configOf: () => string): PlaybackMetrics {
  /** Every video seen on this page, by `videoKey`: warm-up work may come before the player asks */
  const sessions = new Map<string, Session>();
  /** The video playing: the one the player's requests were last for */
  let current: Session | null = null;
  let badge: HTMLElement | null = null;
  let video: HTMLMediaElement | null = null;
  /**
   * The player's element last took a new source: Bilibili prefetches the next video before the
   * viewer goes to it, so startup counts from whichever is later, this or the first request
   */
  let loadStartAt = 0;
  let detach: (() => void) | null = null;

  /**
   * The session of `file`'s video. Only the player's own requests (`play`) make it the current one,
   * which the `<video>` events go to: a warm-up of a playinfo fetched ahead (the next video) must
   * not take them from the video playing
   */
  function sessionFor(file: MediaFile, play: boolean): Session {
    let session = sessions.get(file.videoKey);
    if (session === undefined) {
      session = createSession(file);
      sessions.set(file.videoKey, session);
      if (sessions.size > MAX_PAGE_SESSIONS) {
        for (const [videoKey, candidate] of sessions) {
          if (candidate !== current) {
            sessions.delete(videoKey);
            break;
          }
        }
      }
    }
    if (play && current !== session) {
      if (current !== null) {
        save(current);
      }
      current = session;
      showConfig();
    }
    return session;
  }

  /** Debug builds: whether the video playing gets thread-ripper, in a corner of the page */
  function showConfig() {
    const session = current;
    if (session === null) {
      return;
    }
    if (badge === null) {
      // Not parsed yet: the next call (every second, `findVideo`) shows it
      const body = unsafeWindow.document.querySelector('body');
      if (body === null) {
        return;
      }
      badge = unsafeWindow.document.createElement('div');
      badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:2px 6px;font:12px/1.5 monospace;color:#fff;background:rgba(0,0,0,.65);border-radius:4px;pointer-events:none';
      body.append(badge);
    }
    const on = session.config.includes('thread-ripper') && session.arm !== 'A/B: off';
    const text = `MBGTEB debug: thread-ripper ${on ? 'ON' : 'OFF'}${session.arm === null ? '' : ' (A/B)'}`;
    if (badge.textContent !== text) {
      badge.textContent = text;
    }
  }

  function createSession(file: MediaFile): Session {
    return {
      id: `${Date.now().toString(36)}-${file.videoKey}`,
      createdAt: performance.now(),
      arm: null,
      trace: [],
      videoKey: file.videoKey,
      page: unsafeWindow.location.pathname,
      startedAt: Date.now(),
      config: configOf() || 'none',
      firstRequestAt: null,
      traceUntil: -Infinity,
      startupMs: null,
      startMissed: false,
      stalls: 0,
      stallMs: 0,
      stallAt: null,
      seekMs: [],
      seekAt: null,
      playedS: 0,
      lastTime: null,
      requests: [],
      delivered: new Set(),
      repeats: 0,
      jobs: [],
      attempts: []
    };
  }

  function trace(session: Session, text: string) {
    const now = performance.now();
    if (session.trace.length < MAX_TRACE && (session.firstRequestAt === null || now <= session.traceUntil)) {
      session.trace.push(`+${Math.round(now - session.createdAt)} ${text}`);
    }
  }

  function started(session: Session, now: number) {
    if (session.startupMs !== null || session.startMissed || session.firstRequestAt === null) {
      return;
    }
    session.page = unsafeWindow.location.pathname;
    // Played already: this is a later `playing` (after a pause, a stall), not the start
    if (session.playedS > 0) {
      session.startMissed = true;
      return;
    }
    session.startupMs = now - Math.max(session.firstRequestAt, loadStartAt);
  }

  function endStall(session: Session, now: number) {
    if (session.stallAt !== null) {
      session.stalls++;
      session.stallMs += now - session.stallAt;
      session.stallAt = null;
    }
  }

  /** The player's `<video>`: it may be replaced, by an episode switch for one */
  function attach(element: HTMLMediaElement) {
    detach?.();
    video = element;
    // Found only once it plays: its start went by unseen
    if (current !== null && current.startupMs === null && !element.paused && element.readyState >= 3) {
      current.startMissed = true;
    }
    const on = (type: string, listener: () => void) => {
      element.addEventListener(type, listener);
      return () => element.removeEventListener(type, listener);
    };
    const offs = [
      on('loadstart', () => {
        loadStartAt = performance.now();
      }),
      on('canplay', () => {
        if (current !== null) started(current, performance.now());
      }),
      on('playing', () => {
        const session = current;
        if (session === null) return;
        const now = performance.now();
        started(session, now);
        endStall(session, now);
      }),
      on('waiting', () => {
        const session = current;
        // Waiting for a seek is the seek's time, and before playing started is startup
        if (session?.startupMs != null && !element.seeking && !element.paused && session.stallAt === null) {
          const now = performance.now();
          session.stallAt = now;
          session.traceUntil = Math.max(session.traceUntil, now + EVENT_TRACE_MS);
          trace(session, `stall ${describePlayback(element)}`);
        }
      }),
      on('pause', () => {
        if (current !== null) endStall(current, performance.now());
      }),
      on('seeking', () => {
        const session = current;
        if (session === null) return;
        // A seek out of a stall ends it: from now on it is the seek's time
        endStall(session, performance.now());
        session.seekAt ??= performance.now();
        session.lastTime = null;
      }),
      on('seeked', () => {
        const session = current;
        if (session?.seekAt != null) {
          session.seekMs.push(performance.now() - session.seekAt);
          session.seekAt = null;
        }
      }),
      on('timeupdate', () => {
        const session = current;
        if (session === null || element.seeking) return;
        const time = element.currentTime;
        if (session.lastTime !== null && time > session.lastTime && time - session.lastTime <= MAX_PLAY_STEP_S) {
          session.playedS += time - session.lastTime;
        }
        session.lastTime = time;
      }),
      ...TRACED_VIDEO_EVENTS.map(type => on(type, () => {
        if (current !== null) trace(current, `<video> ${type} at ${element.currentTime.toFixed(1)} s`);
      }))
    ];
    detach = () => {
      for (let i = 0, len = offs.length; i < len; i++) offs[i]();
    };
  }

  function findVideo() {
    showConfig();
    const element = findPlayerVideo();
    if (element !== null && element !== video) {
      attach(element);
    }
  }

  function save(session: Session) {
    const summary = summarize(session, performance.now());
    if (summary.playedS < MIN_PLAYED_S) {
      return;
    }
    try {
      const sessions = loadSessions().filter(saved => saved.id !== summary.id);
      sessions.push(summary);
      const kept = sessions.slice(-MAX_SESSIONS);
      // Traces are the bulk of it: the older sessions drop theirs
      const trimmed = kept.map((saved, i) => (i < kept.length - TRACED_SESSIONS ? { ...saved, trace: undefined } : saved));
      GM.setValue(STORAGE_KEY, JSON.stringify(trimmed)).catch((e: unknown) => {
        logger.error('[metrics] failed to save the session', e);
      });
    } catch (e) {
      logger.error('[metrics] failed to save the session', e);
    }
  }

  const saveCurrent = () => {
    if (current !== null) save(current);
  };

  // For the page's lifetime: never cleared
  // eslint-disable-next-line sukka/prefer-timer-id -- see above
  setInterval(findVideo, FIND_VIDEO_INTERVAL_MS);
  // eslint-disable-next-line sukka/prefer-timer-id -- see above
  setInterval(saveCurrent, SAVE_INTERVAL_MS);
  unsafeWindow.addEventListener('pagehide', saveCurrent);
  unsafeWindow.document.addEventListener('visibilitychange', () => {
    if (unsafeWindow.document.visibilityState === 'hidden') saveCurrent();
  });

  /** Every saved session and this one, oldest first */
  function allSessions() {
    const session = current;
    const saved = loadSessions();
    return session === null ? saved : [...saved.filter(summary => summary.id !== session.id), summarize(session, performance.now())];
  }

  function compare() {
    return compareSessions(allSessions());
  }

  /** A JSON file of every session, to share */
  function download() {
    const blob = new unsafeWindow.Blob([JSON.stringify(allSessions(), null, 1)], { type: 'application/json' });
    const url = unsafeWindow.URL.createObjectURL(blob);
    const link = unsafeWindow.document.createElement('a');
    link.href = url;
    link.download = `mbgtbe-metrics-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
    link.click();
    // Once the download has surely started
    // eslint-disable-next-line sukka/prefer-timer-id -- never cleared
    setTimeout(() => unsafeWindow.URL.revokeObjectURL(url), 60 * 1000);
  }

  function report() {
    if (current !== null) {
      const s = summarize(current, performance.now());
      logger.group(`[metrics] this video: ${s.page} (${s.config})`);
      logger.table([{
        'played s': s.playedS,
        'startup ms': s.startupMs,
        stalls: s.stalls,
        'stall ms': s.stallMs,
        'rebuffer %': Math.round(s.rebufferRatio * 10000) / 100,
        seeks: s.seeks,
        'seek p50 ms': s.seekP50Ms,
        'seek max ms': s.seekMaxMs,
        repeats: s.repeats,
        errors: s.errors,
        'served share': s.servedShare,
        'video kbps': s.videoKbps,
        overhead: s.overhead,
        'delivered MiB': s.deliveredMiB
      }]);
      logger.table({ video: s.video, audio: s.audio, header: s.header });
      logger.info('video segments per quality', s.qualities, 'thread-ripper jobs', s.jobs, 'bytes from the player\'s host', s.playerHostShare);
      logger.table(s.hosts);
      logger.groupCollapsed('[metrics] trace');
      logger.log((s.trace ?? []).join('\n'));
      logger.groupEnd();
      logger.groupEnd();
    }
    logger.group('[metrics] every saved session (and this one), by configuration');
    logger.table(compare());
    logger.groupEnd();
  }

  registerDebugCommand('print playback metrics to the console', report);
  registerDebugCommand('download playback metrics (JSON)', download);

  Object.defineProperty(unsafeWindow, '__MBGTEB_METRICS__', {
    configurable: true,
    enumerable: false,
    value: {
      /** This video so far */
      current: () => current && summarize(current, performance.now()),
      /** Every saved session, oldest first */
      sessions: loadSessions,
      /** Saved sessions (and this one) aggregated per configuration */
      compare,
      /** This video and the comparison, printed as tables */
      report,
      /** For sharing, every session (this one included) as JSON: `copy(__MBGTEB_METRICS__.export())` */
      export: () => JSON.stringify(allSessions()),
      download,
      clear: () => GM.setValue(STORAGE_KEY, '[]')
    }
  });

  return {
    watchRequest(xhr, file, range, hostname, served) {
      const session = sessionFor(file, true);
      const startedAt = performance.now();
      if (session.firstRequestAt === null) {
        session.firstRequestAt = startedAt;
        session.traceUntil = startedAt + TRACE_MS;
      }
      findVideo();
      const key = `${file.key}:${range.start}-${range.end}`;
      if (session.delivered.has(key)) {
        if (session.repeats === 0) {
          session.traceUntil = Math.max(session.traceUntil, startedAt + EVENT_TRACE_MS);
        }
        session.repeats++;
        trace(session, `repeat #${session.repeats}: ${file.kind} ${range.start}-${range.end} was delivered already${video === null ? '' : `; <video> ${describePlayback(video)}`}`);
      }

      const segmentBase = file.segmentBase;
      const kind = segmentBase !== null && range.end <= segmentBase.index.end ? 'header' : file.kind;
      const length = byteRangeLength(range);
      const what = `player ${kind} ${range.start}-${range.end}`;
      trace(session, `${what} (${Math.round(length / KiB)} KiB) sent to ${hostname}, ${served ? 'thread-ripper' : 'native'}`);
      let firstByteAt: number | null = null;
      let ended: 'abort' | 'network' | 'timeout' | null = null;
      const onReadyStateChange = () => {
        if (firstByteAt === null && xhr.readyState >= 2) {
          firstByteAt = performance.now();
        }
      };
      const onAbort = () => {
        ended = 'abort';
      };
      const onError = () => {
        ended = 'network';
      };
      const onTimeout = () => {
        ended = 'timeout';
      };
      const onLoadEnd = () => {
        xhr.removeEventListener('readystatechange', onReadyStateChange);
        xhr.removeEventListener('abort', onAbort);
        xhr.removeEventListener('error', onError);
        xhr.removeEventListener('timeout', onTimeout);
        xhr.removeEventListener('loadend', onLoadEnd);
        // Aborted by the player (a seek, a quality switch): says nothing about how it went
        if (ended === 'abort') {
          trace(session, `${what} aborted by the player after ${Math.round(performance.now() - startedAt)} ms`);
          return;
        }
        const response: unknown = xhr.response;
        const bytes = typeof response === 'object' && response !== null && 'byteLength' in response ? Number(response.byteLength) : 0;
        const { status } = xhr;
        const ok = ended === null && (status === 206 || status === 200) && bytes === length;
        let failure: string | null = null;
        if (!ok) {
          if (ended !== null) {
            failure = ended;
          } else if (status === 206 || status === 200) {
            failure = 'length';
          } else {
            failure = String(status);
          }
        }
        if (ok) {
          session.delivered.add(key);
        }
        session.requests.push({
          hostname,
          kind,
          quality: file.id,
          bandwidth: file.bandwidth,
          bytes,
          ms: performance.now() - startedAt,
          firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
          served,
          ok,
          failure
        });
        const firstByte = firstByteAt === null ? '' : `, first byte ${Math.round(firstByteAt - startedAt)} ms`;
        trace(session, `${what} ${ok ? 'done' : `failed (${failure})`} in ${Math.round(performance.now() - startedAt)} ms${firstByte}`);
      };
      xhr.addEventListener('readystatechange', onReadyStateChange);
      xhr.addEventListener('abort', onAbort);
      xhr.addEventListener('error', onError);
      xhr.addEventListener('timeout', onTimeout);
      xhr.addEventListener('loadend', onLoadEnd);
    },
    recordJob(file, job) {
      sessionFor(file, false).jobs.push(job);
    },
    recordAttempt(file, attempt) {
      sessionFor(file, false).attempts.push(attempt);
    },
    note(file, text) {
      const session = file === null ? current : sessionFor(file, false);
      if (session !== null) trace(session, text);
    },
    setArm(file, arm) {
      const session = sessionFor(file, false);
      session.arm = arm;
      trace(session, arm);
      if (session === current) showConfig();
    }
  };
}

/** This build's saved sessions: saving drops the older builds' ones */
function loadSessions(): SessionSummary[] {
  try {
    const parsed: unknown = JSON.parse(GM_getValue<string>(STORAGE_KEY, '[]'));
    return Array.isArray(parsed) ? (parsed as SessionSummary[]).filter(session => session.build === BUILD_ID) : [];
  } catch {
    return [];
  }
}

function summarize(session: Session, now: number): SessionSummary {
  const stallMs = session.stallMs + (session.stallAt === null ? 0 : now - session.stallAt);
  const playedMs = session.playedS * 1000;
  const ok = session.requests.filter(request => request.ok);
  const videos = ok.filter(request => request.kind === 'video');
  const qualities: Record<string, number> = {};
  let kbps = 0;
  for (let i = 0, len = videos.length; i < len; i++) {
    increment(qualities, String(videos[i].quality));
    kbps += videos[i].bandwidth / 1000;
  }
  const jobs: Record<JobRecord['result'], number> = { done: 0, fallback: 0, failed: 0, canceled: 0 };
  let fetched = 0;
  let delivered = 0;
  for (let i = 0, len = session.jobs.length; i < len; i++) {
    const job = session.jobs[i];
    if (!job.warmup) {
      jobs[job.result]++;
    }
    fetched += job.fetchedBytes;
  }
  let servedBytes = 0;
  for (let i = 0, len = ok.length; i < len; i++) {
    delivered += ok[i].bytes;
    if (ok[i].served) servedBytes += ok[i].bytes;
  }
  const seeks = session.seekMs;
  const hosts = hostSummaries(session);
  let hostBytes = 0;
  let playerBytes = 0;
  for (let i = 0, len = hosts.length; i < len; i++) {
    hostBytes += hosts[i].MiB;
    if (hosts[i].player) playerBytes += hosts[i].MiB;
  }
  return {
    id: session.id,
    build: BUILD_ID,
    page: session.page,
    startedAt: new Date(session.startedAt).toISOString(),
    config: session.arm === null ? session.config : `${session.config} (${session.arm})`,
    playedS: round(session.playedS, 1),
    startupMs: session.startupMs === null ? null : Math.round(session.startupMs),
    stalls: session.stalls + (session.stallAt === null ? 0 : 1),
    stallMs: Math.round(stallMs),
    rebufferRatio: round(stallMs / Math.max(1, playedMs + stallMs), 4),
    seeks: seeks.length,
    repeats: session.repeats,
    seekP50Ms: seeks.length === 0 ? null : Math.round(p50(seeks)),
    seekMaxMs: seeks.length === 0 ? null : Math.round(Math.max(...seeks)),
    video: requestStats(videos),
    audio: requestStats(ok.filter(request => request.kind === 'audio')),
    header: requestStats(ok.filter(request => request.kind === 'header')),
    errors: session.requests.length - ok.length,
    servedShare: round(session.requests.filter(request => request.served).length / Math.max(1, session.requests.length), 2),
    videoKbps: videos.length === 0 ? null : Math.round(kbps / videos.length),
    qualities,
    jobs,
    // Warm-up fetches count too: they are what serving the player cost, beyond what it got natively
    overhead: delivered === 0 ? null : round((delivered - servedBytes + fetched) / delivered, 2),
    deliveredMiB: round(delivered / MiB, 1),
    playerHostShare: hostBytes === 0 ? null : round(playerBytes / hostBytes, 2),
    hosts,
    trace: session.trace.slice()
  };
}

/** Native requests by the host they went to, a serve phase's by the hosts its attempts went to */
function hostSummaries(session: Session): HostSummary[] {
  /** The hosts the player's own XHRs went to: a warm-up's first host is not one of them */
  const playerHosts = new Set<string>();
  for (let i = 0, len = session.requests.length; i < len; i++) {
    playerHosts.add(session.requests[i].hostname);
  }
  const byHost = new Map<string, { requests: number, bytes: number, ttfbs: number[], rates: number[], failed: Record<string, number>, redirects: Record<string, number> }>();
  const entry = (hostname: string) => {
    let stats = byHost.get(hostname);
    if (stats === undefined) {
      stats = { requests: 0, bytes: 0, ttfbs: [], rates: [], failed: {}, redirects: {} };
      byHost.set(hostname, stats);
    }
    return stats;
  };
  for (let i = 0, len = session.requests.length; i < len; i++) {
    const request = session.requests[i];
    if (request.served) continue;
    const stats = entry(request.hostname);
    stats.requests++;
    stats.bytes += request.bytes;
    if (request.failure !== null) increment(stats.failed, request.failure);
    if (request.firstByteMs !== null) {
      stats.ttfbs.push(request.firstByteMs);
      const transferMs = request.ms - request.firstByteMs;
      if (request.bytes >= 48 * KiB && transferMs > 0) stats.rates.push(request.bytes / KiB / transferMs * 1000);
    }
  }
  for (let i = 0, len = session.attempts.length; i < len; i++) {
    const attempt = session.attempts[i];
    const stats = entry(attempt.hostname);
    stats.requests++;
    stats.bytes += attempt.bytes;
    // Not failures: finished, or canceled by the serve phase itself
    if (attempt.outcome !== 'ok' && attempt.outcome !== 'canceled') {
      increment(stats.failed, attempt.outcome);
    }
    if (attempt.redirectedTo !== null) increment(stats.redirects, attempt.redirectedTo || '(invalid)');
    if (attempt.ttfbMs !== null) stats.ttfbs.push(attempt.ttfbMs);
    if (attempt.rateKiBps !== null) stats.rates.push(attempt.rateKiBps);
  }
  return Array.from(byHost, ([host, stats]) => ({
    host,
    player: playerHosts.has(host),
    requests: stats.requests,
    MiB: round(stats.bytes / MiB, 2),
    ttfbP50Ms: stats.ttfbs.length === 0 ? null : Math.round(p50(stats.ttfbs)),
    p50KiBps: stats.rates.length === 0 ? null : Math.round(p50(stats.rates)),
    failed: stats.failed,
    redirects: stats.redirects
  })).sort((a, b) => b.MiB - a.MiB);
}

function requestStats(requests: readonly RequestRecord[]): RequestStats {
  if (requests.length === 0) {
    return { n: 0, p50Ms: null, p90Ms: null, firstByteP50Ms: null, p50KiBps: null };
  }
  const ms = requests.map(request => request.ms);
  const firstBytes = requests.flatMap(request => (request.firstByteMs === null ? [] : [request.firstByteMs]));
  return {
    n: requests.length,
    p50Ms: Math.round(p50(ms)),
    p90Ms: Math.round(p90(ms)),
    firstByteP50Ms: firstBytes.length === 0 ? null : Math.round(p50(firstBytes)),
    p50KiBps: Math.round(p50(requests.map(request => request.bytes / KiB / Math.max(1, request.ms) * 1000)))
  };
}

/**
 * Per configuration: sums where a ratio over all playback is fairer than a mean of sessions. Only
 * the first view of each video: a replay finds the CDN edges it used warm, whichever configuration
 * plays it
 */
function compareSessions(sessions: readonly SessionSummary[]) {
  const byConfig = new Map<string, SessionSummary[]>();
  const replays = new Map<string, number>();
  const seen = new Set<string>();
  // ISO dates sort as strings
  const ordered = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? -1 : (a.startedAt > b.startedAt ? 1 : 0)));
  for (let i = 0, len = ordered.length; i < len; i++) {
    const session = ordered[i];
    const page = session.page.replace(TRAILING_SLASHES_RE, '');
    if (seen.has(page)) {
      replays.set(session.config, (replays.get(session.config) ?? 0) + 1);
      continue;
    }
    seen.add(page);
    const list = byConfig.get(session.config);
    if (list === undefined) {
      byConfig.set(session.config, [session]);
    } else {
      list.push(session);
    }
  }
  const rows: Record<string, Record<string, number | string | null>> = {};
  for (const [config, list] of byConfig) {
    let played = 0;
    let stall = 0;
    let stalls = 0;
    let kbps = 0;
    let kbpsCount = 0;
    let errors = 0;
    let delivered = 0;
    let overheadBytes = 0;
    const startups: number[] = [];
    const seeks: number[] = [];
    const videoMs: number[] = [];
    const videoKiBps: number[] = [];
    for (let i = 0, len = list.length; i < len; i++) {
      const s = list[i];
      played += s.playedS;
      stall += s.stallMs;
      stalls += s.stalls;
      errors += s.errors;
      delivered += s.deliveredMiB;
      overheadBytes += (s.overhead ?? 1) * s.deliveredMiB;
      if (s.videoKbps !== null) {
        kbps += s.videoKbps * s.video.n;
        kbpsCount += s.video.n;
      }
      if (s.startupMs !== null) startups.push(s.startupMs);
      if (s.seekP50Ms !== null) seeks.push(s.seekP50Ms);
      if (s.video.p50Ms !== null) videoMs.push(s.video.p50Ms);
      if (s.video.p50KiBps !== null) videoKiBps.push(s.video.p50KiBps);
    }
    rows[config] = {
      sessions: list.length,
      'replays left out': replays.get(config) ?? 0,
      'played min': round(played / 60, 1),
      'rebuffer %': round(stall / Math.max(1, played * 1000 + stall) * 100, 2),
      'stalls / 10 min': round(stalls / Math.max(1, played) * 600, 2),
      'startup p50 ms': startups.length === 0 ? null : Math.round(p50(startups)),
      'seek p50 ms': seeks.length === 0 ? null : Math.round(p50(seeks)),
      'video req p50 ms': videoMs.length === 0 ? null : Math.round(p50(videoMs)),
      'video req p50 KiB/s': videoKiBps.length === 0 ? null : Math.round(p50(videoKiBps)),
      'video kbps': kbpsCount === 0 ? null : Math.round(kbps / kbpsCount),
      overhead: delivered === 0 ? null : round(overheadBytes / delivered, 2),
      'errors / 10 min': round(errors / Math.max(1, played) * 600, 2)
    };
  }
  return rows;
}

/** Where playback is and what is buffered around it: `at 12.3 s, buffered 0.0-80.5 s` */
function describePlayback(element: HTMLMediaElement) {
  const { buffered } = element;
  const ranges: string[] = [];
  for (let i = 0, len = buffered.length; i < len; i++) {
    ranges.push(`${buffered.start(i).toFixed(1)}-${buffered.end(i).toFixed(1)} s`);
  }
  return `at ${element.currentTime.toFixed(1)} s, buffered ${ranges.length === 0 ? 'nothing' : ranges.join(', ')}`;
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (Object.hasOwn(counts, key) ? counts[key] : 0) + 1;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The player's element with media loaded, else the first one there is. Look it up again and
 * again: the player may replace it (an episode switch, `<video>` -> `<bwp-video>`)
 */
function findPlayerVideo(): HTMLMediaElement | null {
  const elements = document.querySelectorAll(PLAYER_VIDEO_SELECTOR);
  let first: HTMLMediaElement | null = null;
  for (let i = 0, len = elements.length; i < len; i++) {
    const element = elements[i];
    if (isVideoLike(element)) {
      if (element.readyState > 0) {
        return element;
      }
      first ??= element;
    }
  }
  return first;
}

function isVideoLike(element: Element | null): element is HTMLMediaElement {
  return element !== null && 'currentTime' in element && 'buffered' in element;
}
