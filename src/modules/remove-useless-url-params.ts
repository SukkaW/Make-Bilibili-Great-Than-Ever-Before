import { logger } from '../logger';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';

const uselessUrlParams = [
  'buvid',
  'is_story_h5',
  'launch_id',
  'live_from',
  'mid',
  'session_id',
  'timestamp',
  'up_id',
  'vd_source',
  'trackid',
  /^share/,
  /^spm/
];

const removeUselessUrlParams: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'remove-useless-url-params',
  description: '清理 URL 中的无用参数',
  any() {
    unsafeWindow.history.replaceState(undefined, '', removeTracking(location.href));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with Reflect.apply
    const pushState = unsafeWindow.history.pushState;
    unsafeWindow.history.pushState = function (state, unused, url) {
      return Reflect.apply(pushState, this, [state, unused, removeTracking(url)]);
    };

    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with Reflect.apply
    const replaceState = unsafeWindow.history.replaceState;
    unsafeWindow.history.replaceState = function (state, unused, url) {
      return Reflect.apply(replaceState, this, [state, unused, removeTracking(url)]);
    };
  }
};

export default removeUselessUrlParams;

function removeTracking(url: string | URL | null | undefined) {
  if (!url) return url;
  try {
    if (typeof url === 'string') url = new URL(url, unsafeWindow.location.href);
    if (!url.search) return url;

    const keys = Array.from(url.searchParams.keys());
    for (const key of keys) {
      for (const item of uselessUrlParams) {
        if (typeof item === 'string') {
          if (item === key) url.searchParams.delete(key);
        } else if ('test' in item && item.test(key)) {
          url.searchParams.delete(key);
        };
      };
    }
    return url.href;
  } catch (e) {
    logger.error('Failed to remove useless urlParams', e);
    return url;
  }
}
