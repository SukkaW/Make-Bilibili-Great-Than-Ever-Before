/**
 * The player request interceptor: owns every interception point of the player's media requests.
 *
 * Feature modules are phases of the interceptor, always run in this order:
 *
 * 1. capture (always): playinfo -> registry
 * 2. candidates (core): every URL a media request could go to, see `candidates.ts`
 * 3. policy (`no-p2p`): which candidates are acceptable, dropping and converting some. Never
 *    picks one
 * 4. select (core, once a policy phase is registered): the URL the browser fetches natively (XHR
 *    open / fetch / HTMLMediaElement.src): the requested one if it is acceptable, else any
 *    acceptable one. Which is fastest is the serve phase's business
 * 5. serve (`thread-ripper`): take over the download of a media XHR, splitting the range into
 *    pieces raced and hedged across every acceptable candidate and reassembling them into one
 *    synthetic response, or decline: the browser then fetches the selected URL
 * 6. observe (always): how the browser's own media requests went -> host model; segment index
 *
 * Without a policy phase every candidate is acceptable and the browser's URL is left alone.
 *
 * With no phase registered, the interceptor only reads: it never alters a request.
 *
 * Not a module: the bootstrap (`src/index.ts`) creates it before any module runs, whatever is
 * enabled, and modules reach it as `hook.player`.
 */

import flru from 'flru';
import { FIFO } from 'foxts/fifo';
import { never } from 'foxts/guard';
import { logger } from '../../logger';
import type { ReadonlyURL } from '../../utils/readonly-url';
import type { MakeBilibiliGreatThanEverBeforeHook, XhrResponder, XhrSendContext } from '../../types';
import { isKnownNonVideoUrl } from './cdn-classify';
import { defaultCandidate, findCandidate, isCandidateUsable, mediaCandidates } from './candidates';
import type { MediaCandidate } from './candidates';
import { createDebugPassthroughPhase } from './debug-passthrough';
import { getDebugOption } from '../../utils/debug-menu';
import { mediaXhrMode } from '../../debug-options';
import { createHostModel } from './host-model';
import type { HostModel } from './host-model';
import { observeNativeMediaXhr, stopWatching, watchForSidx } from './observer';
import { createPlaybackClock } from './playback-clock';
import type { PlaybackClock } from './playback-clock';
import { initPlayinfoCapture } from './playinfo';
import { parseRangeHeader } from './range';
import type { ByteRange } from './range';
import { createMediaRegistry, toMediaAddress } from './registry';
import type { MediaAddress, MediaFile, MediaFileMatch, MediaRegistry } from './registry';
import { createSidxStore } from './sidx';
import type { SidxStore } from './sidx';

/** Which interception point a media request came through: its name, for the logs */
export enum MediaRequestVia {
  Xhr = 'XMLHttpRequest.prototype.open',
  Fetch = 'fetch',
  MediaSrc = 'HTMLMediaElement.prototype.src'
}

export interface MediaPolicyPhase {
  readonly type: 'policy',
  readonly name: string,
  /** Which candidates media requests may use: drop some, convert some. Never picks one */
  filter(this: void, candidates: readonly MediaCandidate[]): MediaCandidate[]
}

/** A media XHR that could be answered with a synthetic response */
export interface MediaXhrRequest {
  readonly ctx: XhrSendContext,
  /** The URL the XHR was opened with */
  readonly address: MediaAddress,
  /** The request's single bounded `Range`, `null` if it has none */
  readonly range: ByteRange | null,
  readonly match: MediaFileMatch | null,
  /** Every acceptable URL of the file */
  readonly candidates: readonly MediaCandidate[],
  /** The URL the XHR was opened with (the selected one), if acceptable */
  readonly requested: MediaCandidate | null
}

export interface MediaServePhase {
  readonly type: 'serve',
  readonly name: string,
  /**
   * @returns a responder to take over the download, or `null` to leave the request to the next
   * phase or the browser, which fetches the selected URL
   */
  serve(this: void, request: MediaXhrRequest): XhrResponder | null
}

export type PlayerInterceptorPhase = MediaPolicyPhase | MediaServePhase;

export interface PlayerInterceptor {
  readonly registry: MediaRegistry,
  /** Everything learned about every CDN host, by every phase and the observer */
  readonly hosts: HostModel,
  /** Segment timelines by file key */
  readonly sidx: SidxStore,
  readonly clock: PlaybackClock,
  /** Every acceptable URL of a file, for requests of its own (the warm-up) */
  candidates(this: void, file: MediaFile): readonly MediaCandidate[],
  registerPhase(this: void, phase: PlayerInterceptorPhase): void,
  /** Also replays the last few playinfos */
  onPlayinfo(this: void, cb: (playinfo: object, files: MediaFile[]) => void): void
}

/** What the interceptor knows of a media URL: read once, shared by every request for it */
interface MediaUrlInfo {
  /** `registry.version` when it was read: stale once the registry changes */
  readonly version: number,
  readonly address: MediaAddress,
  readonly match: MediaFileMatch | null,
  /** Every acceptable URL of its file, computed on first need */
  candidates: readonly MediaCandidate[] | null
}

/** The generic hooks the interceptor builds upon */
export type PlayerInterceptorHooks = Pick<
  MakeBilibiliGreatThanEverBeforeHook,
  'onXhrOpen' | 'onBeforeFetch' | 'onXhrSend' | 'onXhrResponse' | 'onResponse' | 'nativeFetch'
>;

export function createPlayerInterceptor(hook: PlayerInterceptorHooks): PlayerInterceptor {
  const registry = createMediaRegistry();
  const hosts = createHostModel();
  const sidx = createSidxStore();
  const clock = createPlaybackClock();

  const policyPhases: MediaPolicyPhase[] = [];
  const servePhases: MediaServePhase[] = [];

  /**
   * By href, as the page gave it: the player asks for every segment of a file with the same URL,
   * and each XHR goes through both open and send
   */
  const urlInfos = flru<MediaUrlInfo>(64);

  const recentPlayinfos = new FIFO<[playinfo: object, files: MediaFile[]]>();
  const playinfoListeners = new Set<(playinfo: object, files: MediaFile[]) => void>();

  // 1. capture
  initPlayinfoCapture(hook, (json, meta) => {
    const files = registry.ingestPlayinfo(json, meta);
    if (!files) {
      return;
    }
    recentPlayinfos.enqueue([json, files]);
    if (recentPlayinfos.size > 3) {
      recentPlayinfos.dequeue();
    }
    for (const cb of playinfoListeners) {
      try {
        cb(json, files);
      } catch (e) {
        logger.error('Failed to notify playinfo', e);
      }
    }
  });

  /** @throws on an invalid URL */
  function infoOf(href: string): MediaUrlInfo {
    const cached = urlInfos.get(href);
    if (cached?.version === registry.version) {
      return cached;
    }
    const address = toMediaAddress(new URL(href));
    const match = registry.findFile(address);
    if (match === null) {
      // Hosts seen outside any playinfo are candidates for other requests too
      registry.noteHost(address);
    }
    const info: MediaUrlInfo = { version: registry.version, address, match, candidates: null };
    urlInfos.set(href, info);
    return info;
  }

  // 2. candidates, 3. policy
  function acceptable(requested: MediaAddress | null, file: MediaFile | null) {
    let candidates = mediaCandidates(requested, file, registry.hosts);
    for (let i = 0, len = policyPhases.length; i < len; i++) {
      candidates = policyPhases[i].filter(candidates);
    }
    return candidates;
  }

  function candidatesOf(info: MediaUrlInfo): readonly MediaCandidate[] {
    info.candidates ??= acceptable(info.address, info.match?.file ?? null);
    return info.candidates;
  }

  /**
   * 4. select
   *
   * @returns the URL the browser should fetch instead, `null` to leave the request as it is
   */
  function route(url: string | ReadonlyURL, via: MediaRequestVia): string | null {
    const href = typeof url === 'string' ? (url.startsWith('//') ? 'https:' + url : url) : url.href;
    const info = infoOf(href);
    const { address, match } = info;
    // Neither a CDN URL nor a listed one: not a media request, left alone
    if (match === null && address.class === 'unknown') {
      return null;
    }

    const candidates = candidatesOf(info);
    const file = match?.file ?? null;
    const now = performance.now();
    const requested = findCandidate(candidates, address);
    // The player's own URL, unless it is known not to work right now; failing that, still better
    // than one that is not acceptable
    const keep = requested !== null
      && isCandidateUsable(requested, hosts, file, now, Date.now() / 1000)
      && !hosts.isCoolingDown(requested.hostname, now);
    const chosen = keep ? requested : (defaultCandidate(candidates, hosts, file, now) ?? requested);
    if (chosen === null) {
      logger.warn('[player-interceptor] no acceptable URL for a media request, left as is', { via, url: href });
      return null;
    }
    return chosen.href === href ? null : chosen.href;
  }

  let routeHooksInstalled = false;
  function installRouteHooks() {
    if (routeHooksInstalled) {
      return;
    }
    routeHooksInstalled = true;

    hook.onXhrOpen((xhrOpenArgs) => {
      const xhrUrl = xhrOpenArgs[1];
      if (isKnownNonVideoUrl(xhrUrl)) {
        return xhrOpenArgs;
      }

      try {
        xhrOpenArgs[1] = route(xhrUrl, MediaRequestVia.Xhr) ?? xhrUrl;
      } catch (e) {
        logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e, { xhrUrl });
      }

      return xhrOpenArgs;
    });

    hook.onBeforeFetch((fetchArgs) => {
      const input = fetchArgs[0];
      if (typeof input === 'string' || 'href' in input) { // string | URL
        if (!isKnownNonVideoUrl(input)) {
          fetchArgs[0] = route(input, MediaRequestVia.Fetch) ?? input;
        }
      } else if ('url' in input) { // Request
        if (!isKnownNonVideoUrl(input.url)) {
          const routed = route(input.url, MediaRequestVia.Fetch);
          if (routed !== null) {
            fetchArgs[0] = new Request(routed, input);
          }
        }
      } else {
        never(input, 'fetchArgs[0]');
      }

      return fetchArgs;
    });

    // Patch new Native Player
    (function (HTMLMediaElementPrototypeSrcDescriptor) {
      Object.defineProperty(unsafeWindow.HTMLMediaElement.prototype, 'src', {
        ...HTMLMediaElementPrototypeSrcDescriptor,
        set(value: string) {
          if (typeof value !== 'string') {
            // eslint-disable-next-line sukka/unicorn/no-useless-coercion -- fuck typescript-eslint about never
            value = String(value);
          }

          if (!value.startsWith('blob:') && !value.startsWith('data:')) {
            // we don't care about blob urls
            // they will use another way to fetch the real url and turn it into blob url anyway
            // we can intercept that fetch/XHR instead
            try {
              value = route(value, MediaRequestVia.MediaSrc) ?? value;
            } catch (e) {
              logger.error('Failed to handle HTMLMediaElement.prototype.src setter', e, { value });
            }
          }

          HTMLMediaElementPrototypeSrcDescriptor?.set?.call(this, value);
        }
      });
    })(Object.getOwnPropertyDescriptor(unsafeWindow.HTMLMediaElement.prototype, 'src'));
  }

  // 6. observe: a re-opened XHR drops the request it was sending, without an event to say so
  hook.onXhrOpen((xhrOpenArgs, xhr) => {
    stopWatching(xhr);
    return xhrOpenArgs;
  });

  // 5. serve, 6. observe
  hook.onXhrSend((ctx) => {
    const request = toMediaXhrRequest(ctx, infoOf, servePhases.length > 0 ? candidatesOf : null);
    if (!request) {
      return null;
    }

    let responder: XhrResponder | null = null;
    for (let i = 0, len = servePhases.length; i < len; i++) {
      try {
        responder = servePhases[i].serve(request);
        if (responder) {
          break;
        }
      } catch (e) {
        logger.error(`[player-interceptor] serve phase "${servePhases[i].name}" failed`, e, { url: ctx.url });
      }
    }

    const { match, range, address } = request;
    if (match !== null && range !== null) {
      try {
        if (responder) {
          // A serve phase reports its own requests; only the segment index is left to catch
          watchForSidx(ctx.xhr, sidx, match.file, range);
        } else {
          observeNativeMediaXhr(ctx.xhr, address, match.file, range, hosts, sidx);
        }
      } catch (e) {
        logger.error('[player-interceptor] failed to observe media XHR', e, { url: ctx.url });
      }
    }
    return responder;
  });

  const interceptor: PlayerInterceptor = {
    registry,
    hosts,
    sidx,
    clock,
    candidates: file => acceptable(null, file),
    registerPhase(phase) {
      if (phase.type === 'policy') {
        policyPhases.push(phase);
        urlInfos.clear(false);
        installRouteHooks();
      } else {
        servePhases.push(phase);
      }
      logger.info(`[player-interceptor] ${phase.type} phase "${phase.name}" registered`);
    },
    onPlayinfo(cb) {
      playinfoListeners.add(cb);
      for (const [playinfo, files] of recentPlayinfos) {
        try {
          cb(playinfo, files);
        } catch (e) {
          logger.error('Failed to notify playinfo', e);
        }
      }
    }
  };

  if (process.env.DEBUG && getDebugOption(mediaXhrMode) === 'passthrough') {
    interceptor.registerPhase(createDebugPassthroughPhase(hook.nativeFetch));
  }

  if (process.env.DEBUG) {
    Object.defineProperty(unsafeWindow, '__MBGTEB_PLAYER_INTERCEPTOR__', {
      configurable: true,
      enumerable: false,
      value: {
        registry,
        hosts: () => hosts.snapshot(performance.now()),
        file(url: string) {
          const match = registry.findFile(toMediaAddress(new URL(url, unsafeWindow.location.href)));
          return match && { file: match.file, hosts: hosts.fileSnapshot(match.file, performance.now()), sidx: sidx.get(match.file.key) };
        },
        page: (kind: 'video' | 'audio' = 'video') => hosts.pageSnapshot(kind, performance.now()),
        playback: () => clock.state(),
        phases: () => [...policyPhases, ...servePhases].map(({ type, name }) => ({ type, name })),
        playinfos: () => Array.from(recentPlayinfos)
      }
    });
  }

  return interceptor;
}

/**
 * Only plain GETs of media files can be answered: no body, no credentials, and at most a single
 * bounded `Range` (plus `Accept`) as request headers.
 */
function toMediaXhrRequest(
  ctx: XhrSendContext,
  infoOf: (href: string) => MediaUrlInfo,
  candidatesOf: ((info: MediaUrlInfo) => readonly MediaCandidate[]) | null
): MediaXhrRequest | null {
  if (
    ctx.method !== 'GET'
    || !ctx.async
    || ctx.responseType !== 'arraybuffer'
    || ctx.body != null
    // Right now all CDN requests do not include cookies
    // But future CDN requests might include cookies, keep in mind
    || ctx.hasUrlCredentials
    || ctx.withCredentials
  ) {
    return null;
  }

  // Absolute and normalised already
  const { url } = ctx;
  if ((!url.startsWith('https:') && !url.startsWith('http:')) || isKnownNonVideoUrl(url)) {
    return null;
  }

  let range: ByteRange | null = null;
  for (let i = 0, len = ctx.headers.length; i < len; i++) {
    const [name, value] = ctx.headers[i];
    if (name === 'range') {
      if (range !== null) {
        return null;
      }
      range = parseRangeHeader(value);
      if (range === null) {
        return null;
      }
    } else if (name !== 'accept') {
      return null;
    }
  }

  let info: MediaUrlInfo;
  try {
    info = infoOf(url);
  } catch {
    return null;
  }
  // Only a serve phase needs them, and only for a file it knows
  const candidates = candidatesOf === null || info.match === null ? [] : candidatesOf(info);
  return { ctx, address: info.address, range, match: info.match, candidates, requested: findCandidate(candidates, info.address) };
}
