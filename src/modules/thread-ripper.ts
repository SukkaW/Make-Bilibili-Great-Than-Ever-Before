import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { createThreadRipper } from './thread-ripper/engine';

const threadRipper: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'thread-ripper',
  description: '多 CDN 分片并发并行下载视频，可能浪费一部分带宽和流量',
  defaultEnabled: false,
  any({ player, nativeFetch }) {
    // Live streams are not DASH segments
    if (unsafeWindow.location.hostname === 'live.bilibili.com') {
      return;
    }

    player.registerPhase(createThreadRipper(player, nativeFetch));
  }
};

export default threadRipper;
