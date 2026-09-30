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
import threadRipper from './modules/thread-ripper';
import useSystemFonts from './modules/use-system-fonts';
import type { FetchArgs, OnXhrOpenHook, OnXhrSendHook, MakeBilibiliGreatThanEverBeforeHook, MakeBilibiliGreatThanEverBeforeModule, OnBeforeFetchHook } from './types';
import disableAV1 from './modules/disable-av1';
import defuseStorage from './modules/defuse-storage';
import forceEnable4K from './modules/force-enable-4k';
import { initModuleMenu } from './utils/module-menu';
import { initDebugMenu } from './utils/debug-menu';
import { debugOptions } from './debug-options';
import { createPlayerInterceptor } from './core/player';
import { createPatchedXhrClass } from './utils/xhr-override';
import { disguiseAsNative } from './utils/fake-native-function';

declare global {
  const process: {
    env: {
      NODE_ENV: 'development' | 'production',
      DEBUG?: 'true' | 'false',
      /** Debug builds only: different for every build, see `rollup.config.ts` */
      BUILD_ID?: string
    }
  };
}

((unsafeWindow) => {
  const modules: MakeBilibiliGreatThanEverBeforeModule[] = [
    defuseStorage,
    defuseSpyware,
    disableAV1,
    enhanceLive,
    fixCopyInCV,
    forceEnable4K,
    noAd,
    noP2P,
    noWebRTC,
    optimizeHomepage,
    optimizeStory,
    playerVideoFit,
    removeBlackBackdropFilter,
    removeUselessUrlParams,
    threadRipper,
    useSystemFonts
  ];

  const styles: string[] = [];
  const onBeforeFetchHooks = new Set<OnBeforeFetchHook>();
  const onResponseHooks = new Set<(response: Response, finalFetchArgs: FetchArgs, $fetch: typeof fetch) => Response | Promise<Response>>();
  const onXhrOpenHooks = new Set<OnXhrOpenHook>();
  const onAfterXhrOpenHooks = new Set<(xhr: XMLHttpRequest) => void>();
  const onXhrResponseHooks = new Set<(method: string, url: string | URL, response: unknown, xhr: XMLHttpRequest) => unknown>();
  const onXhrSendHooks = new Set<OnXhrSendHook>();

  /** Captured before fetch gets overridden below */
  const nativeFetch: typeof fetch = unsafeWindow.fetch.bind(unsafeWindow);

  const fnWs = new WeakSet();
  function onlyCallOnce(fn: () => void) {
    if (fnWs.has(fn)) {
      return;
    }
    fnWs.add(fn);
    fn();
  }

  const baseHook: Omit<MakeBilibiliGreatThanEverBeforeHook, 'player'> = {
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
    onXhrSend(cb) {
      onXhrSendHooks.add(cb);
    },
    onlyCallOnce,
    nativeFetch
  };

  /** Always on, whatever is enabled: no-p2p and thread-ripper are its phases */
  const player = createPlayerInterceptor(baseHook);
  const hook: MakeBilibiliGreatThanEverBeforeHook = { ...baseHook, player };

  const hostname = unsafeWindow.location.hostname;
  const pathname = unsafeWindow.location.pathname;

  for (let i = 0, len = modules.length; i < len; i++) {
    const mod = modules[i];

    const enabled = initModuleMenu(mod);
    if (!enabled) {
      logger.log(`[${mod.name}] disabled -- skipping`);
      continue;
    }

    if (mod.any) {
      logger.log(`[${mod.name}] "any" ${unsafeWindow.location.href}`);
      mod.any(hook);
    }
    switch (hostname) {
      case 'www.bilibili.com': {
        if (pathname.startsWith('/read/cv')) {
          if (mod.onCV) {
            logger.log(`[${mod.name}] "onCV" ${unsafeWindow.location.href}`);
            mod.onCV(hook);
          }
        } else if (pathname.startsWith('/video/')) {
          if (mod.onVideo) {
            logger.log(`[${mod.name}] "onVideo" ${unsafeWindow.location.href}`);
            mod.onVideo(hook);
          }
          if (mod.onVideoOrBangumi) {
            logger.log(`[${mod.name}] "onVideoOrBangumi" ${unsafeWindow.location.href}`);
            mod.onVideoOrBangumi(hook);
          }
        } else if (pathname.startsWith('/bangumi/play/')) {
          if (mod.onVideo) {
            logger.log(`[${mod.name}] "onVideo" ${unsafeWindow.location.href}`);
            mod.onVideo(hook);
          }
          if (mod.onBangumi) {
            logger.log(`[${mod.name}] "onBangumi" ${unsafeWindow.location.href}`);
            mod.onBangumi(hook);
          }
          if (mod.onVideoOrBangumi) {
            logger.log(`[${mod.name}] "onVideoOrBangumi" ${unsafeWindow.location.href}`);
            mod.onVideoOrBangumi(hook);
          }
        }
        break;
      }
      case 'live.bilibili.com': {
        if (mod.onLive) {
          logger.log(`[${mod.name}] "onLive" ${unsafeWindow.location.href}`);
          mod.onLive(hook);
        }
        break;
      }
      case 't.bilibili.com': {
        if (mod.onStory) {
          logger.log(`[${mod.name}] "onStory" ${unsafeWindow.location.href}`);
          mod.onStory(hook);
        }
        break;
      }
      // no default
    }
  }

  // Debug builds only, listed after the modules
  initDebugMenu(debugOptions);

  // Add Style
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(styles.join('\n'));
  document.adoptedStyleSheets.push(sheet);
  // Override fetch
  (($fetch) => {
    unsafeWindow.fetch = async function (...$fetchArgs) {
      /** Each hook gets the arguments the previous one returned */
      let fetchArgs: typeof $fetchArgs = $fetchArgs;
      let mockResponse: Response | null = null;
      let abortFetch = false;
      for (const onBeforeFetch of onBeforeFetchHooks) {
        try {
          const result = onBeforeFetch(fetchArgs);
          if (result === null) {
            abortFetch = true;
            break;
          }
          if ('body' in result) {
            abortFetch = true;
            mockResponse = result;
            break;
          }
          fetchArgs = result;
        } catch (e) {
          logger.error('Failed to replace fetcherArgs', e, { fetchArgs });
        }
      }

      if (abortFetch) {
        logger.debug('Fetch aborted', { fetchArgs: $fetchArgs, mockResponse });

        return mockResponse ?? new Response();
      }

      let response = await Reflect.apply($fetch, this, fetchArgs);
      for (const onResponse of onResponseHooks) {
        // eslint-disable-next-line no-await-in-loop -- hook
        response = await onResponse(response, fetchArgs, $fetch);
      }
      return response;
    };
    // Polyfills and feature detection test fetch for `[native code]` (e.g. Sentry's `isNativeFetch`)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- only stringified
    disguiseAsNative(unsafeWindow.fetch, $fetch);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- cache original method
  })(unsafeWindow.fetch);

  unsafeWindow.XMLHttpRequest = createPatchedXhrClass(
    unsafeWindow.XMLHttpRequest,
    {
      open: onXhrOpenHooks,
      afterOpen: onAfterXhrOpenHooks,
      response: onXhrResponseHooks,
      send: onXhrSendHooks
    }
  );
})(unsafeWindow);
