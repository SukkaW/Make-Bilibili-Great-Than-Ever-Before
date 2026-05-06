import { logger } from '../logger';
import type { MakeBilibiliGreatThanEverBeforeHook, MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';

const forceEnable4K: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'force-enable-4k',
  description: '强制启用 4K 播放 / 解锁 HDR / Dolby Atmos',
  onVideo: hook,
  onBangumi: hook,
  onLive: hook
};

export default forceEnable4K;

const OUR_KEYS = new Set([
  'bilibili_player_force_DolbyAtmos&8K&HDR',
  'bilibili_player_force_hdr',
  'bilibili_player_force_8k'
]);

function hook({ onlyCallOnce }: MakeBilibiliGreatThanEverBeforeHook) {
  const keysToDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key != null && key.startsWith('bilibili_player_force_') && !OUR_KEYS.has(key)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    localStorage.removeItem(key);
  }

  if (localStorage.getItem('bilibili_player_force_DolbyAtmos&8K&HDR') !== '1') {
    localStorage.setItem('bilibili_player_force_DolbyAtmos&8K&HDR', '1');
  }
  if (localStorage.getItem('bilibili_player_force_hdr') !== '1') {
    localStorage.setItem('bilibili_player_force_hdr', '1');
  }
  if (localStorage.getItem('bilibili_player_force_8k') !== '1') {
    localStorage.setItem('bilibili_player_force_8k', '1');
  }

  ((sessionStorageGetItem) => {
    sessionStorage.getItem = function (key) {
      // 部分視頻解碼錯誤後會強制全局回退，禁用所有HEVC內容
      // 此hook禁用對應邏輯
      if (key === 'enableHEVCError') {
        return null;
      }
      return Reflect.apply(sessionStorageGetItem, this, [key]);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- cache origin method
  })(sessionStorage.getItem);

  onlyCallOnce(overrideUA);
  onlyCallOnce(modifyTouchPointer);
}

function overrideUA() {
  // Bilibili use User-Agent to determine if the 4K should be avaliable, we simply overrides UA
  defineReadonlyProperty(unsafeWindow.navigator, 'userAgent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15');
  defineReadonlyProperty(unsafeWindow.navigator, 'platform', 'MacIntel');
}

function modifyTouchPointer() {
  const pointerType = detectPointerType();
  if (pointerType.isMouseDevice && !pointerType.isTouchDevice) {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 0,
      configurable: true
    });
    logger.info('Mouse detected, set maxTouchPoints to 0');
  } else {
    logger.info(`Retain maxTouchPoints (${navigator.maxTouchPoints}) because: ${pointerType.isTouchDevice ? 'touch device detected' : 'no mouse device detected'}`);
  }
}

function detectPointerType() {
  try {
    const hasFinePointer = unsafeWindow.matchMedia('(pointer: fine)').matches;
    const hasCoarsePointer = unsafeWindow.matchMedia('(pointer: coarse)').matches;
    const anyHover = unsafeWindow.matchMedia('(any-hover: hover)').matches;
    const supportsTouch = ('ontouchstart' in unsafeWindow) || unsafeWindow.navigator.maxTouchPoints > 0;
    return {
      isMouseDevice: hasFinePointer && anyHover,
      isTouchDevice: hasCoarsePointer && supportsTouch
    };
  } catch {
    return { isMouseDevice: true, isTouchDevice: false };
  }
}
