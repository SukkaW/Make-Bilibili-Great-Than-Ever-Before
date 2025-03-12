import { noop } from 'foxts/noop';
import { logger } from './logger';
import defuseSpyware from './modules/defuse-spyware';
import enhanceLive from './modules/enhance-live';
import fixCopyInCV from './modules/fix-copy-in-cv';
import noAd from './modules/no-ad';
import noP2P from './modules/no-p2p';
import noWebRTC from './modules/no-webtrc';
import optimizeHomepage from './modules/optimize-homepage';
import optimizeStory from './modules/optimize-story';
import playerVideoFit from './modules/player-video-fit';
import removeBlackBackdropFilter from './modules/remove-black-backdrop-filter';
import removeUselessUrlParams from './modules/remove-useless-url-params';
import useSystemFonts from './modules/use-system-fonts';
import type { FetchArgs, OnXhrOpenHook, XHRDetail, XHROpenArgs } from './types';
import type { MakeBilibiliGreatThanEverBeforeHook, MakeBilibiliGreatThanEverBeforeModule, OnBeforeFetchHook } from './types';
import { onDOMContentLoaded } from './utils/on-load-event';
import disableAV1 from './modules/disable-av1';
import defuseStorage from './modules/defuse-storage';

; ((unsafeWindow) => {
  const modules: MakeBilibiliGreatThanEverBeforeModule[] = [
    defuseStorage,
    defuseSpyware,
    disableAV1,
    enhanceLive,
    fixCopyInCV,
    noAd,
    noP2P,
    noWebRTC,
    optimizeHomepage,
    optimizeStory,
    playerVideoFit,
    removeBlackBackdropFilter,
    removeUselessUrlParams,
    useSystemFonts
  ];

  const styles: string[] = [];
  const onBeforeFetchHooks = new Set<OnBeforeFetchHook>();
  const onResponseHooks = new Set<(response: Response, finalFetchArgs: FetchArgs, $fetch: typeof fetch) => Response | Promise<Response>>();
  const onXhrOpenHooks = new Set<OnXhrOpenHook>();
  const onAfterXhrOpenHooks = new Set<(xhr: XMLHttpRequest) => void>();
  const onXhrResponseHooks = new Set<(method: string, url: string | URL, response: unknown, xhr: XMLHttpRequest) => unknown>();

  const fnWs = new WeakSet();
  function onlyCallOnce(fn: () => void) {
    if (fnWs.has(fn)) {
      return;
    }
    fnWs.add(fn);
    fn();
  }

  const hook: MakeBilibiliGreatThanEverBeforeHook = {
    addStyle(style: string) {
      styles.push(style);
    },
    onBeforeFetch(cb) {
      onBeforeFetchHooks.add(cb);
    },
    onResponse(cb) {
      onResponseHooks.add(cb);
    },
    onXhrOpen(cb) {
      onXhrOpenHooks.add(cb);
    },
    onAfterXhrOpen(cb) {
      onAfterXhrOpenHooks.add(cb);
    },
    onXhrResponse(cb) {
      onXhrResponseHooks.add(cb);
    },
    onlyCallOnce
  };

  const hostname = unsafeWindow.location.hostname;
  const pathname = unsafeWindow.location.pathname;

  const storage: { [id: string]: { enabled: boolean, description: string } } = GM_getValue("plugins", {});
  console.log(storage)
  for (const module of modules) {
    if (storage[module.name] && storage[module.name].enabled === false) {
      logger.debug(`[${module.name}] skipped`)
      continue
    } else {
      storage[module.name] = {
        enabled: true,
        description: module.description
      }
      logger.debug(`[${module.name}] loaded`)
    }
    if (module.any) {
      logger.log(`[${module.name}] "any" ${unsafeWindow.location.href}`);
      module.any(hook);
    }
    switch (hostname) {
      case 'www.bilibili.com': {
        if (pathname.startsWith('/read/cv')) {
          if (module.onCV) {
            logger.log(`[${module.name}] "onCV" ${unsafeWindow.location.href}`);
            module.onCV(hook);
          }
        } else if (pathname.startsWith('/video/')) {
          if (module.onVideo) {
            logger.log(`[${module.name}] "onVideo" ${unsafeWindow.location.href}`);
            module.onVideo(hook);
          }
          if (module.onVideoOrBangumi) {
            logger.log(`[${module.name}] "onVideoOrBangumi" ${unsafeWindow.location.href}`);
            module.onVideoOrBangumi(hook);
          }
        } else if (pathname.startsWith('/bangumi/play/')) {
          if (module.onVideo) {
            logger.log(`[${module.name}] "onVideo" ${unsafeWindow.location.href}`);
            module.onVideo(hook);
          }
          if (module.onBangumi) {
            logger.log(`[${module.name}] "onBangumi" ${unsafeWindow.location.href}`);
            module.onBangumi(hook);
          }
          if (module.onVideoOrBangumi) {
            logger.log(`[${module.name}] "onVideoOrBangumi" ${unsafeWindow.location.href}`);
            module.onVideoOrBangumi(hook);
          }
        }
        break;
      }
      case 'live.bilibili.com': {
        if (module.onLive) {
          logger.log(`[${module.name}] "onLive" ${unsafeWindow.location.href}`);
          module.onLive(hook);
        }
        break;
      }
      case 't.bilibili.com': {
        if (module.onStory) {
          logger.log(`[${module.name}] "onStory" ${unsafeWindow.location.href}`);
          module.onStory(hook);
        }
        break;
      }
      // no default
    }
  }

  // Add Style
  onDOMContentLoaded(() => {
    const head = document.head || document.getElementsByTagName('head')[0];
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.textContent = styles.join('\n');
    head.appendChild(style);
  });

  // Override fetch
  (($fetch) => {
    unsafeWindow.fetch = async function (...$fetchArgs) {
      let abortFetch = false;
      let fetchArgs: typeof $fetchArgs | null | Response = $fetchArgs;
      let mockResponse: Response | null = null;
      for (const obBeforeFetch of onBeforeFetchHooks) {
        try {
          fetchArgs = obBeforeFetch($fetchArgs);
          if (fetchArgs === null) {
            abortFetch = true;
            break;
          } else if ('body' in fetchArgs) {
            abortFetch = true;
            mockResponse = fetchArgs;
            break;
          }
        } catch (e) {
          logger.error('Failed to replace fetcherArgs', e, { fetchArgs: $fetchArgs });
        }
      }

      if (abortFetch) {
        logger.log('Fetch aborted', { fetchArgs: $fetchArgs, mockResponse });

        return mockResponse ?? new Response();
      }

      let response = await Reflect.apply($fetch, this, $fetchArgs);
      for (const onResponse of onResponseHooks) {
        // eslint-disable-next-line no-await-in-loop -- hook
        response = await onResponse(response, $fetchArgs, $fetch);
      }
      return response;
    };
  })(unsafeWindow.fetch);

  const xhrInstances = new WeakMap<XMLHttpRequest, XHRDetail>();

  const XHRBefore = unsafeWindow.XMLHttpRequest.prototype;

  unsafeWindow.XMLHttpRequest = class extends unsafeWindow.XMLHttpRequest {
    open(...$args: XHROpenArgs) {
      const method = $args[0];
      const url = $args[1];
      const xhrDetails: XHRDetail = { method, url, response: null, lastResponseLength: null };

      let xhrArgs: XHROpenArgs | null = $args;

      for (const onXhrOpen of onXhrOpenHooks) {
        try {
          if (xhrArgs === null) {
            break;
          }
          xhrArgs = onXhrOpen(xhrArgs, this);
        } catch (e) {
          logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e);
        }
      }

      if (xhrArgs === null) {
        logger.log('XHR aborted', { $args });
        this.send = noop;
        this.setRequestHeader = noop;
        return;
      }

      xhrInstances.set(this, xhrDetails);

      super.open(...(xhrArgs as Parameters<XMLHttpRequest['open']>));

      for (const onAfterXhrOpen of onAfterXhrOpenHooks) {
        try {
          onAfterXhrOpen(this);
        } catch (e) {
          logger.error('Failed to call onAfterXhrOpen', e);
        }
      }
    }

    get response() {
      const originalResponse = super.response;
      if (!xhrInstances.has(this)) {
        return originalResponse;
      }

      const xhrDetails: XHRDetail = xhrInstances.get(this)!;

      const responseLength = typeof originalResponse === 'string'
        ? originalResponse.length
        : null;

      if (xhrDetails.lastResponseLength !== responseLength) {
        xhrDetails.response = null;
        xhrDetails.lastResponseLength = responseLength;
      }
      if (xhrDetails.response !== null) {
        return xhrDetails.response;
      }

      let finalResponse = originalResponse;
      for (const onXhrResponse of onXhrResponseHooks) {
        try {
          finalResponse = onXhrResponse(xhrDetails.method, xhrDetails.url, finalResponse, this);
        } catch (e) {
          logger.error('Failed to call onXhrResponse', e);
        }
      }

      xhrDetails.response = finalResponse;

      return finalResponse;
    }

    get responseText() {
      const response = this.response;
      return typeof response === 'string'
        ? response
        : super.responseText;
    }
  };

  unsafeWindow.XMLHttpRequest.prototype.open.toString = function () {
    return XHRBefore.open.toString();
  };
  unsafeWindow.XMLHttpRequest.prototype.send.toString = function () {
    return XHRBefore.send.toString();
  };
  // unsafeWindow.XMLHttpRequest.prototype.getResponseHeader.toString = function () {
  //   return XHRBefore.getResponseHeader.toString();
  // };
  // unsafeWindow.XMLHttpRequest.prototype.getAllResponseHeaders.toString = function () {
  //   return XHRBefore.getAllResponseHeaders.toString();
  // };
  setTimeout(GM_setValue("plugins", storage), 0);
})(unsafeWindow);
