/**
 * The player request interceptor: owns every interception point of the player's media requests.
 *
 * - capture (always): every playinfo goes to the registry
 * - policy (`no-p2p`): which candidate URLs media requests may use (see `candidates.ts`). Once one
 *   is registered, the browser's own media requests (XHR open, fetch, media src) go to the
 *   requested URL if it is acceptable, else to an acceptable one
 * - serve (`thread-ripper`): take over the download of a media XHR, or leave it to the browser
 *
 * With no phase registered, the interceptor only reads. Not a module: the bootstrap starts it before
 * any module runs, and modules reach it through `hook.player`.
 */

import { FIFO } from 'foxts/fifo';
import { never } from 'foxts/guard';
import { logger } from '../../logger';
import type { ReadonlyURL } from '../../utils/readonly-url';
import type { MakeBilibiliGreatThanEverBeforeHook, XhrResponder, XhrSendContext } from '../../types';
import { isKnownNonVideoUrl } from './cdn-classify';
import { defaultCandidate, findCandidate, isCandidateUsable, mediaCandidates } from './candidates';
import type { MediaCandidate } from './candidates';
import * as hosts from './host-model';
import { initPlayinfoCapture } from './playinfo';
import { parseRangeHeader } from './range';
import type { ByteRange } from './range';
import { findFile, ingestPlayinfo, noteHost, toMediaAddress } from './registry';
import type { MediaAddress, MediaFile } from './registry';

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
  /** `null` if no playinfo listed it */
  readonly file: MediaFile | null,
  /** Every acceptable URL of the file */
  readonly candidates: readonly MediaCandidate[],
  /** The URL the XHR was opened with, if acceptable */
  readonly requested: MediaCandidate | null
}

export interface MediaServePhase {
  readonly type: 'serve',
  readonly name: string,
  /** @returns a responder to take over the download, or `null` to leave it to the browser */
  serve(this: void, request: MediaXhrRequest): XhrResponder | null
}

type PlayinfoListener = (playinfo: object, files: MediaFile[]) => void;

/** no-p2p, once registered */
let policy: MediaPolicyPhase | null = null;
/** thread-ripper, once registered */
let server: MediaServePhase | null = null;
/** The bootstrap's hooks: the route hooks are installed with them once a policy registers */
let bootstrapHook: MakeBilibiliGreatThanEverBeforeHook | null = null;
let routeHooksInstalled = false;
/** The last few, replayed to a late listener */
const recentPlayinfos = new FIFO<[playinfo: object, files: MediaFile[]]>();
const playinfoListeners = new Set<PlayinfoListener>();

/** What media modules get as `hook.player` */
export const player = {
  /** Everything learned about every CDN host */
  hosts,
  /** Every acceptable URL of a file, for requests of its own (the warm-up) */
  candidates: acceptableCandidates,
  registerPhase,
  onPlayinfo
};

/** Started once by the bootstrap, before any module runs */
export function initPlayerInterceptor(hook: MakeBilibiliGreatThanEverBeforeHook) {
  bootstrapHook = hook;

  initPlayinfoCapture(hook, (json, meta) => {
    const files = ingestPlayinfo(json, meta);
    if (!files) {
      return;
    }
    recentPlayinfos.enqueue([json, files]);
    if (recentPlayinfos.size > 3) {
      recentPlayinfos.dequeue();
    }
    for (const cb of playinfoListeners) {
      notify(cb, json, files);
    }
  });

  hook.onXhrSend((ctx) => {
    if (server === null) {
      return null;
    }
    const request = toMediaXhrRequest(ctx);
    try {
      return request && server.serve(request);
    } catch (e) {
      logger.error(`[player-interceptor] serve phase "${server.name}" failed`, e, { url: ctx.url });
      return null;
    }
  });
}

function registerPhase(phase: MediaPolicyPhase | MediaServePhase) {
  if (phase.type === 'policy') {
    policy = phase;
    installRouteHooks(bootstrapHook!);
  } else {
    server = phase;
  }
  logger.info(`[player-interceptor] ${phase.type} phase "${phase.name}" registered`);
}

/** Also replays the last few playinfos */
function onPlayinfo(cb: PlayinfoListener) {
  playinfoListeners.add(cb);
  for (const [playinfo, files] of recentPlayinfos) {
    notify(cb, playinfo, files);
  }
}

/** Every acceptable URL of a file, for a request (`requested`) or for its own */
function acceptableCandidates(file: MediaFile | null, requested: MediaAddress | null = null) {
  const candidates = mediaCandidates(requested, file);
  return policy === null ? candidates : policy.filter(candidates);
}

function notify(cb: PlayinfoListener, playinfo: object, files: MediaFile[]) {
  try {
    cb(playinfo, files);
  } catch (e) {
    logger.error('Failed to notify playinfo', e);
  }
}

/**
 * @throws on an invalid URL
 * @returns the URL the browser should fetch instead, `null` to leave the request as it is
 */
function route(url: string | ReadonlyURL, via: string): string | null {
  const href = typeof url === 'string' ? (url.startsWith('//') ? 'https:' + url : url) : url.href;
  const address = toMediaAddress(new URL(href));
  const file = findFile(address);
  if (file === null) {
    // Neither a CDN URL nor a listed one: not a media request, left alone
    if (address.class === 'unknown') {
      return null;
    }
    // Hosts seen outside any playinfo are candidates for other requests too
    noteHost(address);
  }

  const candidates = acceptableCandidates(file, address);
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

  let address: MediaAddress;
  try {
    address = toMediaAddress(new URL(url));
  } catch {
    return null;
  }
  const file = findFile(address);
  const candidates = file === null ? [] : acceptableCandidates(file, address);
  return { ctx, address, range, file, candidates, requested: findCandidate(candidates, address) };
}
