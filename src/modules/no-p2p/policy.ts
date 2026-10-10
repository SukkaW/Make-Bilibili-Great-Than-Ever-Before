/**
 * IMPORTANT NOTICE for those who want to implement similar functionality:
 *
 * "Make Bilibili Great Than Ever Before" does not have control of the Bilibili web player, we can
 * only hijack the HTTP request fired by the Bilibili web player and replace the URL on the fly,
 * thus we must implement such complex logic.
 *
 * If you are implementing a third-party Bilibili player or Bilibili video downloader, you already
 * have all the control. You can just choose one best URL from the full CDN information and then
 * move on.
 */

import { CandidateTier } from '../../core/player/candidates';
import type { MediaCandidate } from '../../core/player/candidates';
import { classifyCdnUrl } from '../../core/player/cdn-classify';

const PROXY_TF = 'proxy-tf-all-ws.bilivideo.com';

/**
 * The no-p2p policy: no P2P / PCDN host. What such a host serves with an upgcxcode signature is
 * already a candidate on every upgcxcode host; the rest is pointed back at its source host
 * (szbdyd's `xy_usource`) or fetched through Bilibili's proxy (mcdn `/v1/resource`).
 */
export function noP2PPolicy(candidates: readonly MediaCandidate[]): MediaCandidate[] {
  const acceptable: MediaCandidate[] = [];
  for (let i = 0, len = candidates.length; i < len; i++) {
    const candidate = candidates[i];
    if (!candidate.p2p) {
      acceptable.push(candidate);
      continue;
    }

    const url = new URL(candidate.href);
    switch (classifyCdnUrl(url)) {
      // szbdyd.com appears to be deprecated, but we still handle it just in case
      case 'szbdyd': {
        const source = url.searchParams.get('xy_usource');
        if (source) {
          url.protocol = 'https:';
          url.hostname = source;
          url.port = '';
          acceptable.push({ ...candidate, href: url.href, hostname: url.hostname, key: url.pathname + url.search, tier: CandidateTier.Source, p2p: false });
        }
        break;
      }
      // Pure IP / mcdn.bilivideo.* with its own path: only the proxy can reach it for us
      case 'mcdn-tf': {
        const proxy = new URL(`https://${PROXY_TF}`);
        proxy.searchParams.set('url', candidate.href);
        acceptable.push({ ...candidate, href: proxy.href, hostname: PROXY_TF, key: proxy.pathname + proxy.search, tier: CandidateTier.Proxy, p2p: false });
        break;
      }
      // mcdn upgcxcode (os=mcdn, *.mcdn.bilivideo.*): its signature is on every upgcxcode host already
      default:
        break;
    }
  }
  return acceptable;
}
