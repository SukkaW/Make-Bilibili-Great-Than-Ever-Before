import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { createThreadRipper } from './thread-ripper/engine';
import type { ThreadRipperMode } from './thread-ripper/engine';
import { getDebugOption } from '../utils/debug-menu';
import { mediaXhrMode, threadRipperAb } from '../debug-options';

const threadRipper: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'thread-ripper',
  description: '多 CDN 分片并发并行下载视频，可能浪费一部分带宽和流量',
  defaultEnabled: false,
  any({ player, nativeFetch }) {
    // Live streams are not DASH segments
    if (unsafeWindow.location.hostname === 'live.bilibili.com') {
      return;
    }

    const mode: ThreadRipperMode = process.env.DEBUG && getDebugOption(mediaXhrMode) === 'shadow' ? 'shadow' : 'serve';
    const ab = process.env.DEBUG ? getDebugOption(threadRipperAb) === 'random' : false;

    player.registerPhase(createThreadRipper(player, nativeFetch, mode, ab));
  }
};

export default threadRipper;
