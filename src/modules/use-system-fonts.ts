// 去除鸿蒙字体，强制使用系统默认字体
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { tagged as css } from 'foxts/tagged';

const useSystemFonts: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'use-system-fonts',
  description: '去除鸿蒙字体，强制使用系统默认字体',
  any({ addStyle }) {
    document.querySelectorAll('link[href*="/jinkela/long/font/"]').forEach(x => x.remove());
    addStyle(css`html, body { font-family: system-ui !important; }`);
  }
};

export default useSystemFonts;
