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
 * 6. observe (always): how the browser's own media requests went -> host model
 *
 * Without a policy phase every candidate is acceptable and the browser's URL is left alone.
 *
 * With no phase registered, the interceptor only reads: it never alters a request.
 *
 * Not a module: the bootstrap (`src/index.ts`) starts it before any module runs, whatever is
 * enabled. Modules reach it through `hook.player`.
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
import * as hosts from './host-model';
import { createPlaybackMetrics } from './metrics';
import { observeNativeMediaXhr, stopWatching } from './observer';
import { initPlayinfoCapture } from './playinfo';
import { parseRangeHeader } from './range';
import type { ByteRange } from './range';
import { findFile, ingestPlayinfo, noteHost, registryVersion, toMediaAddress } from './registry';
import type { MediaAddress, MediaFile, MediaFileMatch } from './registry';

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
  /** @returns a responder to take over the download, or `null` to leave it to the browser */
  serve(this: void, request: MediaXhrRequest): XhrResponder | null
}

/** What the interceptor knows of a media URL: read once, shared by every request for it */
interface MediaUrlInfo {
  /** `registryVersion` when it was read: stale once the registry changes */
  readonly version: number,
  readonly address: MediaAddress,
  readonly match: MediaFileMatch | null,
  /** Every acceptable URL of its file, computed on first need */
  candidates: readonly MediaCandidate[] | null
}

/** no-p2p, once registered */
let policy: MediaPolicyPhase | null = null;
/** thread-ripper, once registered */
let server: MediaServePhase | null = null;
/** Debug builds only: playback and request metrics, compared across sessions */
const metrics = process.env.DEBUG
  ? createPlaybackMetrics(() => [policy?.name, server?.name].filter(Boolean).join('+'))
  : null;
/** The bootstrap's hooks: the route hooks are installed with them once a policy registers */
let bootstrapHook: MakeBilibiliGreatThanEverBeforeHook | null = null;

/**
 * By href, as the page gave it: the player asks for every segment of a file with the same URL,
 * and each XHR goes through both open and send
 */
const urlInfos = flru<MediaUrlInfo>(64);
const recentPlayinfos = new FIFO<[playinfo: object, files: MediaFile[]]>();
const playinfoListeners = new Set<(playinfo: object, files: MediaFile[]) => void>();

/** What media modules get as `hook.player` */
export const player = {
  /** Everything learned about every CDN host, by every phase and the observer */
  hosts,
  /** Debug builds only: playback and request metrics, compared across sessions */
  metrics,
  /** Every acceptable URL of a file, for requests of its own (the warm-up) */
  candidates: acceptableCandidates,
  registerPhase,
  onPlayinfo
};

/** Started once by the bootstrap, before any module runs */
export function initPlayerInterceptor(hook: MakeBilibiliGreatThanEverBeforeHook) {
  bootstrapHook = hook;

  // 1. capture
  initPlayinfoCapture(hook, (json, meta) => {
    const files = ingestPlayinfo(json, meta);
    if (!files) {
      return;
    }
    if (files.length > 0) {
      metrics?.note(files[0], `playinfo (${meta}): ${files.length} files`);
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

  // 6. observe: a re-opened XHR drops the request it was sending, without an event to say so
  hook.onXhrOpen((xhrOpenArgs, xhr) => {
    stopWatching(xhr);
    return xhrOpenArgs;
  });

  // 5. serve, 6. observe
  hook.onXhrSend((ctx) => {
    const request = toMediaXhrRequest(ctx);
    if (!request) {
      return null;
    }

    let responder: XhrResponder | null = null;
    if (server !== null) {
      try {
        responder = server.serve(request);
      } catch (e) {
        logger.error(`[player-interceptor] serve phase "${server.name}" failed`, e, { url: ctx.url });
      }
    }

    const { match, range, address } = request;
    if (match !== null && range !== null) {
      try {
        metrics?.watchRequest(ctx.xhr, match.file, range, address.hostname, responder !== null);
        // A serve phase reports its own requests
        if (!responder) {
          observeNativeMediaXhr(ctx.xhr, address, match.file);
        }
      } catch (e) {
        logger.error('[player-interceptor] failed to observe media XHR', e, { url: ctx.url });
      }
    }
    return responder;
  });

  if (process.env.DEBUG) {
    Object.defineProperty(unsafeWindow, '__MBGTEB_PLAYER_INTERCEPTOR__', {
      configurable: true,
      enumerable: false,
      value: {
        hosts: () => hosts.snapshot(performance.now()),
        file(url: string) {
          const match = findFile(toMediaAddress(new URL(url, unsafeWindow.location.href)));
          return match && { file: match.file, hosts: hosts.fileSnapshot(match.file, performance.now()) };
        },
        page: (kind: 'video' | 'audio' = 'video') => hosts.pageSnapshot(kind, performance.now()),
        phases: () => [policy?.name, server?.name].filter(Boolean),
        playinfos: () => Array.from(recentPlayinfos)
      }
    });
  }
}

/** @throws on an invalid URL */
function infoOf(href: string): MediaUrlInfo {
  const cached = urlInfos.get(href);
  if (cached?.version === registryVersion()) {
    return cached;
  }
  const address = toMediaAddress(new URL(href));
  const match = findFile(address);
  if (match === null) {
    // Hosts seen outside any playinfo are candidates for other requests too
    noteHost(address);
  }
  const info: MediaUrlInfo = { version: registryVersion(), address, match, candidates: null };
  urlInfos.set(href, info);
  return info;
}

function candidatesOf(info: MediaUrlInfo): readonly MediaCandidate[] {
  info.candidates ??= acceptableCandidates(info.match?.file ?? null, info.address);
  return info.candidates;
}

/**
 * 4. select
 *
 * @param via which interception point the request came through, for the logs
 * @returns the URL the browser should fetch instead, `null` to leave the request as it is
 */
function route(url: string | ReadonlyURL, via: string): string | null {
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
    && isCandidateUsable(requested, file, now, Date.now() / 1000)
    && !hosts.isCoolingDown(requested.hostname, now);
  const chosen = keep ? requested : (defaultCandidate(candidates, file, now) ?? requested);
  if (chosen === null) {
    logger.warn('[player-interceptor] no acceptable URL for a media request, left as is', { via, url: href });
    return null;
  }
  return chosen.href === href ? null : chosen.href;
}

let routeHooksInstalled = false;
function installRouteHooks(hook: MakeBilibiliGreatThanEverBeforeHook) {
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
      xhrOpenArgs[1] = route(xhrUrl, 'XMLHttpRequest.prototype.open') ?? xhrUrl;
    } catch (e) {
      logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e, { xhrUrl });
    }

    return xhrOpenArgs;
  });

  hook.onBeforeFetch((fetchArgs) => {
    const input = fetchArgs[0];
    if (typeof input === 'string' || 'href' in input) { // string | URL
      if (!isKnownNonVideoUrl(input)) {
        fetchArgs[0] = route(input, 'fetch') ?? input;
      }
    } else if ('url' in input) { // Request
      if (!isKnownNonVideoUrl(input.url)) {
        const routed = route(input.url, 'fetch');
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
            value = route(value, 'HTMLMediaElement.prototype.src') ?? value;
          } catch (e) {
            logger.error('Failed to handle HTMLMediaElement.prototype.src setter', e, { value });
          }
        }

        HTMLMediaElementPrototypeSrcDescriptor?.set?.call(this, value);
      }
    });
  })(Object.getOwnPropertyDescriptor(unsafeWindow.HTMLMediaElement.prototype, 'src'));
}

/**
 * Only plain GETs of media files can be answered: no body, no credentials, and at most a single
 * bounded `Range` (plus `Accept`) as request headers.
 */
function toMediaXhrRequest(ctx: XhrSendContext): MediaXhrRequest | null {
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
  const candidates = server === null || info.match === null ? [] : candidatesOf(info);
  return { ctx, address: info.address, range, match: info.match, candidates, requested: findCandidate(candidates, info.address) };
}

function registerPhase(phase: MediaPolicyPhase | MediaServePhase) {
  if (phase.type === 'policy') {
    policy = phase;
    urlInfos.clear(false);
    installRouteHooks(bootstrapHook!);
  } else {
    server = phase;
  }
  logger.info(`[player-interceptor] ${phase.type} phase "${phase.name}" registered`);
}

/** Also replays the last few playinfos */
function onPlayinfo(cb: (playinfo: object, files: MediaFile[]) => void) {
  playinfoListeners.add(cb);
  for (const [playinfo, files] of recentPlayinfos) {
    try {
      cb(playinfo, files);
    } catch (e) {
      logger.error('Failed to notify playinfo', e);
    }
  }
}

/** 2. candidates, 3. policy: every acceptable URL of a file, for a request or for its own (the warm-up) */
function acceptableCandidates(file: MediaFile | null, requested: MediaAddress | null = null) {
  const candidates = mediaCandidates(requested, file);
  return policy === null ? candidates : policy.filter(candidates);
}
