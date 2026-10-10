import { logger } from '../../logger';
import type { MakeBilibiliGreatThanEverBeforeHook } from '../../types';
import { getUrlFromRequest } from '../../utils/get-url-from-request';
import { onDOMContentLoaded } from '../../utils/on-load-event';
import { isObject } from '../../utils/is-object';
import type { ReadonlyURL } from '../../utils/readonly-url';

declare global {
  interface Window {
    __playinfo__?: unknown
  }
}

const playurlApiRegex = /\/\/api\.bilibili\.com\/(?:x\/player\/(?:wbi\/)?playurl|pgc\/player\/web\/(?:v2\/)?playurl|pugv\/player\/web\/playurl)(?:[#/?]|$)/;

export function isPlayurlApi(url: string | ReadonlyURL): boolean {
  return playurlApiRegex.test(url.toString());
}

/**
 * Catch every playinfo the page receives: the one embedded in the page (`window.__playinfo__`),
 * and every playurl API response over XHR or fetch.
 */
export function initPlayinfoCapture(
  { onXhrResponse, onResponse }: Pick<MakeBilibiliGreatThanEverBeforeHook, 'onXhrResponse' | 'onResponse'>,
  ingest: (json: object, meta: string) => void
) {
  let current: unknown = unsafeWindow.__playinfo__;
  let lastIngested: unknown = null;

  const ingestEmbedded = (value: unknown, meta: string) => {
    if (value !== lastIngested && isObject(value)) {
      lastIngested = value;
      ingest(value, meta);
    }
  };

  ingestEmbedded(current, 'unsafeWindow.__playinfo__');

  // The page assigns `window.__playinfo__` in an inline script, before the player loads:
  // trap the assignment instead of polling for it
  try {
    Object.defineProperty(unsafeWindow, '__playinfo__', {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(value: unknown) {
        current = value;
        ingestEmbedded(value, 'unsafeWindow.__playinfo__ (setter)');
      }
    });
  } catch (e) {
    logger.warn('Failed to trap unsafeWindow.__playinfo__', e);
  }

  // In case the page (re)defines the property instead of assigning it
  onDOMContentLoaded(() => {
    ingestEmbedded(unsafeWindow.__playinfo__, 'unsafeWindow.__playinfo__ (DOMContentLoaded)');
  });

  onXhrResponse((_method, url, response) => {
    if (!isPlayurlApi(url)) {
      return response;
    }
    if (typeof response === 'string') {
      try {
        const json: unknown = JSON.parse(response);
        if (isObject(json)) {
          ingest(json, 'playurl XHR API');
        }
      } catch (e) {
        logger.error('Failed to parse playinfo XHR API JSON', e, { response });
      }
    } else if (isObject(response)) {
      // responseType: 'json'
      ingest(response, 'playurl XHR API (json)');
    }
    return response;
  });

  onResponse((response, fetchArgs) => {
    const url = response.url || getUrlFromRequest(fetchArgs[0]);
    if (url && isPlayurlApi(url)) {
      response
        .clone()
        .json()
        .then((json: unknown) => {
          if (isObject(json)) {
            ingest(json, 'playurl fetch API');
          }
        })
        .catch((e: unknown) => logger.error('Failed to parse playinfo fetch API JSON', e, { url }));
    }
    return response;
  });
}
