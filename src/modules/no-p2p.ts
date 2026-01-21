import { noop } from 'foxts/noop';
import { logger } from '../logger';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';
import { getCDNUtil } from '../utils/get-cdn-url';
import { never } from 'foxts/guard';
import { createRetrieKeywordFilter } from 'foxts/retrie';
import { onDOMContentLoaded } from '../utils/on-load-event';

const knownNonVideoPattern = createRetrieKeywordFilter([
  'bilibili.com',
  'hdslb.com',
  'bvc.bilivideo.com'
]);
function isKnownNonVideoUrl(url: string | URL): boolean {
  const urlStr = url.toString();
  return knownNonVideoPattern(urlStr);
}

const noP2P: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'no-p2p',
  description: '防止叔叔用 P2P CDN 省下纸钱',
  any({ onXhrOpen, onBeforeFetch, onXhrResponse }) {
    class MockPCDNLoader { }

    class MockBPP2PSDK {
      on = noop;
    }

    class MockSeederSDK { }

    defineReadonlyProperty(unsafeWindow, 'PCDNLoader', MockPCDNLoader);
    defineReadonlyProperty(unsafeWindow, 'BPP2PSDK', MockBPP2PSDK);
    defineReadonlyProperty(unsafeWindow, 'SeederSDK', MockSeederSDK);

    if ('__playinfo__' in unsafeWindow && typeof unsafeWindow.__playinfo__ === 'object' && unsafeWindow.__playinfo__) {
      getCDNUtil().saveAndParsePlayerInfo(unsafeWindow.__playinfo__, 'unsafeWindow.__playinfo__', false);
    } else {
      logger.debug('No unsafeWindow.__playinfo__ found on script load, wait for DOMContentLoaded and check again.');
      onDOMContentLoaded(() => {
        if ('__playinfo__' in unsafeWindow && typeof unsafeWindow.__playinfo__ === 'object' && unsafeWindow.__playinfo__) {
          getCDNUtil().saveAndParsePlayerInfo(unsafeWindow.__playinfo__, 'unsafeWindow.__playinfo__ (DOMContentLoaded)', false);
        }
      });
    }

    onXhrResponse((_method, url, response, _xhr) => {
      if (url.toString().includes('api.bilibili.com/x/player/wbi/playurl') && typeof response === 'string') {
        try {
          getCDNUtil().saveAndParsePlayerInfo(JSON.parse(response), 'playurl XHR API', true);
        } catch (e) {
          logger.error('Failed to parse playinfo XHR API JSON', e, { response });
        }
      }

      return response;
    });

    // Patch new Native Player
    (function (HTMLMediaElementPrototypeSrcDescriptor) {
      Object.defineProperty(unsafeWindow.HTMLMediaElement.prototype, 'src', {
        ...HTMLMediaElementPrototypeSrcDescriptor,
        set(value: string) {
          if (typeof value !== 'string') {
            value = String(value);
          }

          if (!value.startsWith('blob:')) {
            // we don't care about blob urls
            // they will use another way to fetch the real url and turn it into blob url anyway
            // we can intercept that fetch/XHR instead
            try {
              value = getCDNUtil().getReplacementCdnUrl(value, 'HTMLMediaElement.prototype.src');
            } catch (e) {
              logger.error('Failed to handle HTMLMediaElement.prototype.src setter', e, { value });
            }
          }

          HTMLMediaElementPrototypeSrcDescriptor?.set?.call(this, value);
        }
      });
    }(Object.getOwnPropertyDescriptor(unsafeWindow.HTMLMediaElement.prototype, 'src')));

    onXhrOpen((xhrOpenArgs) => {
      const xhrUrl = xhrOpenArgs[1];
      if (isKnownNonVideoUrl(xhrUrl)) {
        return xhrOpenArgs;
      }

      try {
        xhrOpenArgs[1] = getCDNUtil().getReplacementCdnUrl(xhrUrl, 'XMLHttpRequest.prototype.open');
      } catch (e) {
        logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e, { xhrUrl });
      }

      return xhrOpenArgs;
    });

    onBeforeFetch((fetchArgs: [RequestInfo | URL, RequestInit?]) => {
      let input = fetchArgs[0];
      if (typeof input === 'string' || 'href' in input) { // string | URL
        if (!isKnownNonVideoUrl(input)) {
          input = getCDNUtil().getReplacementCdnUrl(input, 'fetch');
          fetchArgs[0] = input;
        }
      } else if ('url' in input) { // Request
        if (!isKnownNonVideoUrl(input.url)) {
          input = new Request(getCDNUtil().getReplacementCdnUrl(input.url, 'fetch'), input);
          fetchArgs[0] = input;
        }
      } else {
        never(input, 'fetchArgs[0]');
      }

      return fetchArgs;
    });
  }
};

export default noP2P;
