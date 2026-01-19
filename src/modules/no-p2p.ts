import { noop } from 'foxts/noop';
import { createRetrieKeywordFilter } from 'foxts/retrie';
import { logger } from '../logger';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';

const rBackupCdn = /(?:up|cn-)[\w-]+\.bilivideo\.com/g;
const isP2PCDN = createRetrieKeywordFilter([
  'upos-sz-302',
  '.mcdn.bilivideo',
  '.szbdyd.com',
  '.nexusedgeio.com',
  '.ahdohpiechei.com' // 七牛云 PCDN
]);

let prevLocationHref = '';
let prevCdnDomains: string[] = [];
function getCDNDomain() {
  if (prevLocationHref !== unsafeWindow.location.href || prevCdnDomains.length === 0) {
    try {
      const matched = Array.from(new Set(Array.from(document.head.innerHTML.matchAll(rBackupCdn), match => match[0]))).filter(domain => !isP2PCDN(domain));

      if (matched.length > 0) {
        prevLocationHref = unsafeWindow.location.href;
        prevCdnDomains = matched;

        logger.info('Get CDN domains from <head />', { matched });
      } else {
        logger.warn('Failed to get CDN domains from document.head.innerHTML, fallback to default CDN domain');
        prevLocationHref = unsafeWindow.location.href;
        prevCdnDomains = ['upos-sz-mirrorcoso1.bilivideo.com'];
        return 'upos-sz-mirrorcoso1.bilivideo.com';
      }
    } catch (e) {
      logger.error('Failed to get CDN domains from document.head.innerHTML, fallback to default CDN domain', e);
      prevLocationHref = unsafeWindow.location.href;
      prevCdnDomains = ['upos-sz-mirrorcoso1.bilivideo.com'];
      return 'upos-sz-mirrorcoso1.bilivideo.com';
    }
  }

  return prevCdnDomains.length === 1
    ? prevCdnDomains[0]
    : prevCdnDomains[Math.floor(Math.random() * prevCdnDomains.length)];
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

    // Patch new Native Player
    (function (HTMLMediaElementPrototypeSrcDescriptor) {
      Object.defineProperty(unsafeWindow.HTMLMediaElement.prototype, 'src', {
        ...HTMLMediaElementPrototypeSrcDescriptor,
        set(value: string) {
          if (typeof value !== 'string') {
            value = String(value);
          }
          try {
            const result = replaceP2P(value, getCDNDomain, 'HTMLMediaElement.prototype.src');
            value = typeof result === 'string' ? result : result.href;
          } catch (e) {
            logger.error('Failed to handle HTMLMediaElement.prototype.src setter', e, { value });
          }

          HTMLMediaElementPrototypeSrcDescriptor?.set?.call(this, value);
        }
      });
    }(Object.getOwnPropertyDescriptor(unsafeWindow.HTMLMediaElement.prototype, 'src')));

    onXhrOpen((xhrOpenArgs) => {
      try {
        xhrOpenArgs[1] = replaceP2P(
          xhrOpenArgs[1],
          getCDNDomain,
          'XMLHttpRequest.prototype.open'
        );
      } catch (e) {
        logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e, { xhrUrl: xhrOpenArgs[1] });
      }

      return xhrOpenArgs;
    });

    onXhrResponse((_method, url, response, _xhr) => {
      if (typeof response === 'string' && url.toString().includes('api.bilibili.com/x/player/wbi/playurl')) {
        try {
          const json: object = JSON.parse(response);

          const cdnDomains = new Set<string>();

          function addCDNFromUrl(url: unknown) {
            if (typeof url === 'string' && !isP2PCDN(url)) {
              try {
                cdnDomains.add(new URL(url).hostname);
              } catch {}
            }
          }
          function extractCDNFromVideoOrAudio(data: unknown) {
            if (Array.isArray(data)) {
              for (const videoOrAudio of data) {
                if ('baseUrl' in videoOrAudio && typeof videoOrAudio.baseUrl === 'string') {
                  addCDNFromUrl(videoOrAudio.baseUrl);
                } else if ('base_url' in videoOrAudio && typeof videoOrAudio.base_url === 'string') {
                  addCDNFromUrl(videoOrAudio.base_url);
                }

                if ('backupUrl' in videoOrAudio && Array.isArray(videoOrAudio.backupUrl)) {
                  videoOrAudio.backupUrl.forEach(addCDNFromUrl);
                } else if ('backup_url' in videoOrAudio && Array.isArray(videoOrAudio.backup_url)) {
                  videoOrAudio.backup_url.forEach(addCDNFromUrl);
                }
              }
            }
          }

          if (
            'data' in json && typeof json.data === 'object' && json.data
            && 'dash' in json.data && typeof json.data.dash === 'object' && json.data.dash
          ) {
            if ('video' in json.data.dash) {
              extractCDNFromVideoOrAudio(json.data.dash.video);
            }
            if ('audio' in json.data.dash) {
              extractCDNFromVideoOrAudio(json.data.dash.audio);
            }
          }

          logger.info('Get CDN domains from Bilibili API', { json, cdnDomains });

          if (cdnDomains.size > 0) {
            prevLocationHref = unsafeWindow.location.href;
            prevCdnDomains = Array.from(cdnDomains);
          }
        } catch { };
      }

      return response;
    });

    onBeforeFetch((fetchArgs: [RequestInfo | URL, RequestInit?]) => {
      let input = fetchArgs[0];
      if (typeof input === 'string' || 'href' in input) {
        input = replaceP2P(input, getCDNDomain, 'fetch');
      } else if ('url' in input) {
        input = new Request(replaceP2P(input.url, getCDNDomain, 'fetch'), input);
      } else {
        const _: never = input;
        // input = replaceP2P(String(input), cdnDomain);
      }

      fetchArgs[0] = input;

      return fetchArgs;
    });
  }
};

export default noP2P;

function replaceP2P(url: string | URL, cdnDomainGetter: () => string, meta = ''): string | URL {
  try {
    if (typeof url === 'string') {
      // early bailout for better performance
      if (!isP2PCDN(url)) {
        return url;
      }

      if (url.startsWith('//')) {
        url = unsafeWindow.location.protocol + url;
      }
      url = new URL(url, unsafeWindow.location.href);
    }
    const hostname = url.hostname;
    if (hostname.endsWith('.szbdyd.com')) {
      const xy_usource = url.searchParams.get('xy_usource');
      if (xy_usource) {
        url.hostname = xy_usource;
        url.port = '443';
        logger.info(`P2P replaced: ${hostname} -> ${xy_usource}`, { meta });
      }
    } else {
      const cdn = cdnDomainGetter();
      url.protocol = 'https:';
      url.hostname = cdn;
      url.port = '443';
      logger.info(`P2P replaced: ${hostname} -> ${cdn}`, { meta });
    }

    return url;
  } catch (e) {
    logger.error(`Failed to replace P2P for URL (${url}):`, e);
    return url;
  }
}
