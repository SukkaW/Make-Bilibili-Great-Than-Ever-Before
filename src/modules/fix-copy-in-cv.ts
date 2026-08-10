import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';

declare global {
  interface Window {
    original?: {
      reprint: string
    }
  }
}

const fixCopyInCV: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'fix-copy-in-cv',
  description: '修复文章复制功能',
  onCV() {
    if ('original' in unsafeWindow) {
      defineReadonlyProperty(unsafeWindow.original, 'reprint', '1');
    }

    const holder = document.querySelector('.article-holder');
    if (holder) {
      holder.classList.remove('unable-reprint');
      holder.addEventListener('copy', e => e.stopImmediatePropagation(), { capture: true });
    }
  }
};

export default fixCopyInCV;
