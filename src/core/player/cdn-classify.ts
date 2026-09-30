import { createRetrieKeywordFilter } from 'foxts/retrie';
import { split0th } from 'foxts/split-nth';
import type { ReadonlyURL } from '../../utils/readonly-url';

export const mirrorRegex = /^https?:\/\/(?:upos-\w+-(?!302)\w+|(?:upos|proxy)-tf-[^/]+)\.(?:bilivideo|akamaized)\.(?:com|net)\/upgcxcode/;
/** `exp=<unix>` among the `~`-separated fields of Akamai's `hdnts` token */
const AKAMAI_TOKEN_EXPIRY_RE = /(?:^|~)exp=(\d+)/;
export const mCdnTfRegex = /^https?:\/\/(?:(?:\d{1,3}\.){3}\d{1,3}|[^/]+\.mcdn\.bilivideo\.(?:com|cn|net))(?::\d{1,5})?\/v\d\/resource/;

const knownP2pCdnDomainPattern = createRetrieKeywordFilter([
  '302ppio',
  '302kodo',
  '.mcdn.bilivideo',
  'szbdyd.com',
  '.nexusedgeio.com',
  '.ahdohpiechei.com', // 七牛云 PCDN

  'upos-sz-mirror14b.bilivideo.com' // mirror type, upgcxcode, but it has no valid SSL cert, its SSL cert is for PCDN (*.bilivideo.cn)
]);

export function isP2PCDNDomain(hostname: string): boolean {
  if (knownP2pCdnDomainPattern(hostname)) {
    return true;
  }
  // upos-sz-302ppio.bilivideo.com -> *.nexusedgeio.com
  // upos-sz-302kodo.bilivideo.com -> *.ahdohpiechei.com
  // pattern: *-*302*.*
  const subdomain = split0th(hostname, '.');
  return subdomain.includes('302');
}

/** A host `mirrorRegex` accepts: an upgcxcode path on it is a mirror URL (unless P2P, see `classifyCdnUrl`) */
export function isMirrorHost(hostname: string): boolean {
  return mirrorRegex.test(`https://${hostname}/upgcxcode/`);
}

/**
 * Akamai matches `mirrorRegex`, but it does not accept upos signatures (403): an Akamai URL is
 * only valid with its own signature, it can never be the target of a host swap.
 */
export function isAkamaiHost(hostname: string): boolean {
  return hostname.endsWith('.akamaized.net');
}

const knownNonVideoPattern = createRetrieKeywordFilter([
  'bilibili.com',
  'hdslb.com',
  'bvc.bilivideo.com',
  'bvc-drm.bilivideo.com'
]);

export function isKnownNonVideoUrl(url: string | ReadonlyURL): boolean {
  const urlStr = url.toString();
  if (knownNonVideoPattern(urlStr)) {
    return true;
  }
  if (typeof url === 'string') {
    return url.startsWith('data:') || url.startsWith('blob:');
  }
  return url.protocol === 'data:' || url.protocol === 'blob:';
}

/**
 * - `mirror`: upos mirror, upgcxcode (Akamai included, see `isAkamaiHost`)
 * - `bcache`: Bilibili's self-hosted PoP, upgcxcode (e.g. cn-sccd-cu-01-01.bilivideo.com, more
 *   details in https://rec.danmuji.org/dev/cdn-info/ )
 * - `mcdn-upgcxcode`: P2P CDN serving an upgcxcode path (`*.mcdn.bilivideo.*`, HTTP 302 P2P CDN,
 *   mirror with `os=mcdn`): the path works on any upgcxcode host
 * - `mcdn-tf`: pure IP / mcdn CDN with its own `/v1/resource` path
 * - `szbdyd`: deprecated PCDN, the real host is in `xy_usource`
 */
export type CdnUrlClass = 'mirror' | 'bcache' | 'mcdn-upgcxcode' | 'mcdn-tf' | 'szbdyd' | 'unknown';

export function classifyCdnUrl(url: ReadonlyURL): CdnUrlClass {
  const href = url.href;
  if (href.includes('/upgcxcode/')) {
    if (mirrorRegex.test(href)) {
      // It is possible for a mirror type url to also be a p2p cdn:
      //
      // upos-sz-mirrorcoso1.bilivideo.com os=mcdn
      // upos-*-302.bilivideo.com (HTTP 302 p2p cdn)
      return url.searchParams.get('os') !== 'mcdn' && !isP2PCDNDomain(url.hostname)
        ? 'mirror'
        : 'mcdn-upgcxcode';
    }
    return isP2PCDNDomain(url.hostname) ? 'mcdn-upgcxcode' : 'bcache';
  }
  if (mCdnTfRegex.test(href)) {
    return 'mcdn-tf';
  }
  if (href.includes('szbdyd.com')) {
    return 'szbdyd';
  }
  return 'unknown';
}

/**
 * Upos hosts accept any upos-signed address; Akamai only its own. Which host accepts which family
 * is learned, this only tells the families apart.
 */
export type SignatureFamily = 'upos' | 'akam';

/**
 * Akamai's addresses carry its token (`hdnts`) on top of an upos `upsig`: the token tells them
 * apart, `upsig` does not
 */
export function signatureFamilyOf(url: ReadonlyURL): SignatureFamily {
  const { searchParams } = url;
  return searchParams.has('hdnts') || (!searchParams.has('upsig') && isAkamaiHost(url.hostname)) ? 'akam' : 'upos';
}

/**
 * When the signed address expires, in unix seconds; `0` if unknown. An Akamai address expires with
 * its token (`hdnts=exp=<unix>~…`) if that comes before `deadline`: a 403 after it is an expired
 * address, not Akamai refusing the signature family
 */
export function signatureDeadlineOf(url: ReadonlyURL): number {
  const deadline = unixSeconds(url.searchParams.get('deadline'));
  const token = url.searchParams.get('hdnts');
  const tokenExpiry = token === null ? 0 : unixSeconds(AKAMAI_TOKEN_EXPIRY_RE.exec(token)?.[1] ?? null);
  if (deadline === 0 || tokenExpiry === 0) {
    return deadline || tokenExpiry;
  }
  return Math.min(deadline, tokenExpiry);
}

function unixSeconds(value: string | null) {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
}
