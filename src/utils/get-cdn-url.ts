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

import { pickOne } from 'foxts/pick-random';
import { createRetrieKeywordFilter } from 'foxts/retrie';
import { logger } from '../logger';
import { lazyValue } from 'foxts/lazy-value';
import flru from 'flru';

const PROXY_TF = 'proxy-tf-all-ws.bilivideo.com';
const FALLBACK_CDN_HOST = 'upos-sz-mirrorali.bilivideo.com';

const MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED = 'make-bilibili-great-than-ever-before.secret-internal-do-not-use-or-you-will-be-fired.nxdomain.skk.moe';

const mirrorRegex = /^https?:\/\/(?:upos-\w+-(?!302)\w+|(?:upos|proxy)-tf-[^/]+)\.(?:bilivideo|akamaized)\.(?:com|net)\/upgcxcode/;
const mCdnTfRegex = /^https?:\/\/(?:(?:\d{1,3}\.){3}\d{1,3}|[^/]+\.mcdn\.bilivideo\.(?:com|cn|net))(?::\d{1,5})?\/v\d\/resource/;

const knownP2pCdnDomainPattern = createRetrieKeywordFilter([
  '302ppio',
  '302kodo',
  '.mcdn.bilivideo',
  'szbdyd.com',
  '.nexusedgeio.com',
  '.ahdohpiechei.com' // 七牛云 PCDN
]);

function isP2PCDNDomain(hostname: string): boolean {
  if (knownP2pCdnDomainPattern(hostname)) {
    return true;
  }
  // upos-sz-302ppio.bilivideo.com -> *.nexusedgeio.com
  // upos-sz-302kodo.bilivideo.com -> *.ahdohpiechei.com
  // pattern: *-*302*.*
  const subdomain = hostname.split('.', 1)[0];
  return subdomain.includes('302');
}

function createCDNUtil() {
  interface CdnUrlData {
    replacementType: string,
    getReplacementUrl(incomingUrl: string | URL): string,
    // Optional meta
    mirror_urls?: Set<string>,
    bcache_urls?: Set<string>,
    mcdn_upgcxcode_urls?: Set<string>,
    szbdyd_urls?: Set<string>,
    mcdn_tf_urls?: Set<string>
  }

  // All upgcxcode hosts are interchangeable, so we collect them here
  const mirror_type_upgcxcode_hosts = new Set<string>();
  const bcache_type_upgcxcode_hosts = new Set<string>();

  const cdnDatas = flru<CdnUrlData>(200);

  return {
    saveAndParsePlayerInfo(json: object, meta: string) {
      let dash;

      if (
        'data' in json && typeof json.data === 'object' && json.data !== null
        && 'dash' in json.data && typeof json.data.dash === 'object' && json.data.dash !== null
      ) {
        // normal video player
        dash = json.data.dash;
      } else if (
        // bangumi video player
        'result' in json && typeof json.result === 'object' && json.result !== null
        && 'video_info' in json.result && typeof json.result.video_info === 'object' && json.result.video_info !== null
        && 'dash' in json.result.video_info && typeof json.result.video_info.dash === 'object' && json.result.video_info.dash !== null
      ) {
        dash = json.result.video_info.dash;
      } else {
        logger.warn('Invalid Bilibili Playinfo data', { json });
        return;
      }

      if ('video' in dash && Array.isArray(dash.video)) {
        extractCDNFromVideoOrAudio(dash.video);
      }
      if ('audio' in dash && Array.isArray(dash.audio)) {
        extractCDNFromVideoOrAudio(dash.audio);
      }

      logger.info('CDN URLs extracted', { meta });

      return cdnDatas;
    },
    getReplacementCdnUrl(url: string | URL, meta: string): string {
      let urlObj: URL;
      if (typeof url === 'string') {
        if (url.startsWith('//')) {
          urlObj = new URL('https:' + url);
        } else {
          urlObj = new URL(url);
        }
      } else {
        urlObj = url;
      }

      const key = urlObj.pathname + urlObj.search;

      const data = cdnDatas.get(key);
      if (data !== undefined) {
        return data.getReplacementUrl(url);
      }

      logger.warn('No matching CDN URL Group found! Opt-in basic P2P replacement', { meta, url: urlObj.href, key });
      return basicP2PReplacement(typeof url === 'string' ? new URL(url) : url, meta);
    }
  };

  function extractCDNFromVideoOrAudio(data: unknown[]) {
    // In the data there is an array of baseUrl/backupUrl objects
    // Each array consists of different quality levels
    // We do not care about the quality levels, just extract all URLs per group
    // Which we will be matching against later
    for (const videoOrAudio of data) {
      if (typeof videoOrAudio !== 'object' || videoOrAudio === null) {
        continue;
      }

      const knownUrls = new Set<string>();

      if ('baseUrl' in videoOrAudio && typeof videoOrAudio.baseUrl === 'string') {
        knownUrls.add(videoOrAudio.baseUrl);
      }
      if ('base_url' in videoOrAudio && typeof videoOrAudio.base_url === 'string') {
        knownUrls.add(videoOrAudio.base_url);
      }
      if ('backupUrl' in videoOrAudio && Array.isArray(videoOrAudio.backupUrl)) {
        videoOrAudio.backupUrl.forEach((url: string) => knownUrls.add(url));
      }
      if ('backup_url' in videoOrAudio && Array.isArray(videoOrAudio.backup_url)) {
        videoOrAudio.backup_url.forEach((url: string) => knownUrls.add(url));
      }

      // After collecting all known URLs, we can now process them
      const mirror_urls = new Set<string>();
      const bcache_urls = new Set<string>();

      const mcdn_tf_urls = new Set<string>();
      const mcdn_upgcxcode_urls = new Set<string>();
      const szbdyd_urls = new Set<string>();

      for (const urlStr of knownUrls) {
        try {
          if (urlStr.includes('/upgcxcode/')) {
            if (mirrorRegex.test(urlStr)) {
              const url = new URL(urlStr);

              // Now we know this url is both upgcxcode type url and mirror type url
              // Since all upgcxcode urls are interchangeable, we can collect its host
              if (
                // It is possible for a mirror type url to also be a p2p cdn:
                //
                // upos-sz-mirrorcoso1.bilivideo.com os=mcdn
                // upos-*-302.bilivideo.com (HTTP 302 p2p cdn)
                url.searchParams.get('os') !== 'mcdn'
                && !isP2PCDNDomain(url.hostname)
              ) {
                mirror_type_upgcxcode_hosts.add(url.hostname);

                // Now we know this url is mirror type url and not p2p cdn
                // let's ensure it is HTTPS and add to mirror urls
                url.protocol = 'https:';
                url.port = '443';

                mirror_urls.add(url.href);
              } else {
                // Now we know this url is mirror type url, upgcxcode url, and p2p cdn url
                url.protocol = 'https:';
                url.port = '443';

                // since we will replace its hostname anyway, the original hostname
                // does not matter, we use a fixed dummy hostname here, and better
                // reduce duplicates in the Set<string>.
                url.hostname = MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED;

                mcdn_upgcxcode_urls.add(url.href);
              }
              continue;
            }

            const url = new URL(urlStr);

            // Now we know this is upgcxcode type url, but not mirror type url:
            if (isP2PCDNDomain(url.hostname)) {
              // *.mcdn.bilivideo.* (mcdn type url p2p cdn)
              // upos-\w*-302.* (HTTP 302 p2p cdn)

              url.protocol = 'https:';
              url.port = '443';

              // since we will replace its hostname anyway, the original hostname
              // does not matter, we use a fixed dummy hostname here, and better
              // reduce duplicates in the Set<string>.
              url.hostname = MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED;

              mcdn_upgcxcode_urls.add(url.href);
            } else {
              // bcache type url (self hosted PoP):
              // cn-sccd-cu-01-01.bilivideo.com
              // (more details in https://rec.danmuji.org/dev/cdn-info/ )

              // we can collect its host for later replacement
              bcache_type_upgcxcode_hosts.add(url.hostname);

              bcache_urls.add(urlStr);
            }
            continue;
          }

          if (mCdnTfRegex.test(urlStr)) {
            // This is mcdn type url, a.k.a. pure IP cdn url or mcdn.bilivideo.*
            mcdn_tf_urls.add(urlStr);
            continue;
          }

          // szbdyd.com appears to be deprecated, but we still handle it just in case
          if (urlStr.includes('szbdyd.com')) {
            const url = new URL(urlStr);

            url.protocol = 'https:';

            // szbdyd hostname can be replaced with the value of xy_usource query param
            // and if xy_usource is missing, we can replace to upgcxcode host
            url.hostname = url.searchParams.get('xy_usource') ?? MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED;
            url.port = '443';

            szbdyd_urls.add(url.href);
            continue;
          }

          logger.error(`Unrecognized CDN URL pattern: ${urlStr}`);
        } catch {
          logger.debug('Failed to process CDN URL, skipping.', { url: urlStr });
        }
      }

      let replacementType: string;
      let getReplacementUrl: (url: string | URL) => string;

      switch (true) {
        // We always prefer mirror type urls when possible, so as long as we have some,
        // we always pick one from them
        case (mirror_urls.size > 0): {
          logger.info('Found ' + mirror_urls.size + ' mirror type CDN URLs, future replacement will be chosen from these URLs.', { mirror_urls });

          replacementType = 'mirror';

          const mirrorUrlsArray = Array.from(mirror_urls);
          if (mirrorUrlsArray.length === 1) {
            getReplacementUrl = () => mirrorUrlsArray[0];
            break;
          }
          getReplacementUrl = () => pickOne(mirrorUrlsArray);
          break;
        }
        // bcache urls are not as good as mirror urls, but still better than p2p cdn,
        // we pick one from them when no mirror urls are available
        case (bcache_urls.size > 0): {
          logger.info('Found ' + bcache_urls.size + ' bcache type CDN URLs, future replacement will be chosen from these URLs.', { bcache_urls });

          replacementType = 'bcache';

          const bcacheUrlsArray = Array.from(bcache_urls);
          if (bcacheUrlsArray.length === 1) {
            getReplacementUrl = () => bcacheUrlsArray[0];
            break;
          }
          getReplacementUrl = () => pickOne(bcacheUrlsArray);
          break;
        }
        // Next we try HTTP 302/MCDN upgcxcode urls, since we can replace their
        // hosts w/ bcache/mirror type upgcxcode hosts, it is not that bad
        case (mcdn_upgcxcode_urls.size > 0): {
          logger.info('Found ' + mcdn_upgcxcode_urls.size + ' mcdn upgcxcode type CDN URLs, future replacement will be chosen from these URLs with host replaced.', { mcdn_upgcxcode_urls });

          replacementType = 'mcdn upgcxcode -> host replacement';

          const mcdnUpgcxcodeUrlsArray = Array.from(mcdn_upgcxcode_urls);

          if (mcdnUpgcxcodeUrlsArray.length === 1) {
            getReplacementUrl = () => replaceUpgcxcodeHost(mcdnUpgcxcodeUrlsArray[0]);
            break;
          }
          getReplacementUrl = () => replaceUpgcxcodeHost(pickOne(mcdnUpgcxcodeUrlsArray));
          break;
        }
        // Next we try szbdyd.com urls with either xy_usource or upgcxcode host replacement
        case (szbdyd_urls.size > 0): {
          logger.info('Found ' + szbdyd_urls.size + ' szbdyd.com type CDN URLs, future replacement will be chosen from these URLs with xy_usource or upgcxcode host replacement.', { szbdyd_urls });

          replacementType = 'szbdyd.com -> xy_usource or upgcxcode host replacement';

          const xyusourceUrlsArray = Array.from(szbdyd_urls);

          getReplacementUrl = () => {
            const picked = pickOne(xyusourceUrlsArray);
            const url = new URL(picked);

            // If the URL does not have xy_usource, we need to replace with upgcxcode host
            if (url.hostname === MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED) {
              // need to replace with upgcxcode host
              return replaceUpgcxcodeHost(url);
            }
            return url.href;
          };
          break;
        }
        // We are left with pure IP cdn urls, or mcdn.bilivideo.* urls that are not
        // upgcxcode type, we can return proxy-wrapped mcdn tf url
        case (mcdn_tf_urls.size > 0): {
          logger.info('Found ' + mcdn_tf_urls.size + ' mcdn tf type CDN URLs, future replacement will be proxy-wrapped.', { mcdn_tf_urls });

          replacementType = 'mcdn tf -> proxy-wrapped';

          const mcdnTfUrlsArray = Array.from(mcdn_tf_urls);

          getReplacementUrl = () => {
            const proxyUrl = new URL(`https://${PROXY_TF}`);
            proxyUrl.searchParams.set('url', pickOne(mcdnTfUrlsArray));
            return proxyUrl.href;
          };
          break;
        }
        default: {
          logger.error('Failed to get replacement CDN URL', { knownUrls });

          replacementType = 'none';

          getReplacementUrl = (url: string | URL) => basicP2PReplacement(typeof url === 'string' ? new URL(url) : url, 'getReplacementCdnUrl fallback');
          break;
        }
      }

      knownUrls.forEach((url) => {
        const urlObj = new URL(url);
        const key = urlObj.pathname + urlObj.search;

        cdnDatas.set(key, {
          replacementType,
          getReplacementUrl,
          // Optional meta
          mirror_urls,
          bcache_urls,
          mcdn_upgcxcode_urls,
          szbdyd_urls,
          mcdn_tf_urls
        });
      });
    }
  }

  function replaceUpgcxcodeHost(url: string | URL): string {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    urlObj.protocol = 'https:';
    urlObj.port = '443';

    if (mirror_type_upgcxcode_hosts.size > 0) {
      const mirror_type_upgcxcode_hosts_array = Array.from(mirror_type_upgcxcode_hosts);

      urlObj.hostname = pickOne(mirror_type_upgcxcode_hosts_array);
      return urlObj.href;
    }
    if (bcache_type_upgcxcode_hosts.size > 0) {
      const bcache_type_upgcxcode_hosts_array = Array.from(bcache_type_upgcxcode_hosts);
      urlObj.hostname = pickOne(bcache_type_upgcxcode_hosts_array);
      return urlObj.href;
    }
    urlObj.hostname = FALLBACK_CDN_HOST;
    return urlObj.href;
  }

  function basicP2PReplacement(url: URL, meta: string): string {
    const urlStr = url.href;

    if (urlStr.includes('/upgcxcode/')) {
      // Even if we have not collected any CDN info yet, we can still try our best to avoid P2P CDNs
      if (mirrorRegex.test(urlStr)) {
        // Now we know this url is both upgcxcode type url and mirror type url
        // Since all upgcxcode urls are interchangeable, we can collect its host
        if (
          // It is possible for a mirror type url to also be a p2p cdn:
          //
          // upos-sz-mirrorcoso1.bilivideo.com os=mcdn
          // upos-\w*-302.* (HTTP 302 p2p cdn)
          url.searchParams.get('os') !== 'mcdn'
          && !isP2PCDNDomain(url.hostname)
        ) {
          mirror_type_upgcxcode_hosts.add(url.hostname);

          // Now we know this url is mirror type url and not p2p cdn
          // let's ensure it is HTTPS and add to mirror urls
          url.protocol = 'https:';
          url.port = '443';

          return url.href;
        }

        // Now we know this url is os=mcdn/http 302 url, let's replace its host
        return replaceUpgcxcodeHost(url);
      }

      // Now we know this is upgcxcode type url, but not mirror type url:
      if (isP2PCDNDomain(url.hostname)) {
        // *.mcdn.bilivideo.* (mcdn type url p2p cdn)
        // upos-\w*-302.* (HTTP 302 p2p cdn)
        return replaceUpgcxcodeHost(url);
      }

      // bcache type url (self hosted PoP):
      // cn-sccd-cu-01-01.bilivideo.com
      // (more details in https://rec.danmuji.org/dev/cdn-info/ )

      // we can collect its host for later replacement
      bcache_type_upgcxcode_hosts.add(url.hostname);

      return urlStr;
    }

    // szbdyd.com appears to be deprecated, but we still handle it just in case
    if (urlStr.includes('szbdyd.com')) {
      const xy_usource = url.searchParams.get('xy_usource');
      if (xy_usource) {
        url.protocol = 'https:';
        url.port = '443';
        url.hostname = xy_usource;

        return url.href;
      }

      return replaceUpgcxcodeHost(url);
    }

    if (mCdnTfRegex.test(urlStr)) {
      const proxyUrl = new URL(`https://${PROXY_TF}`);
      proxyUrl.searchParams.set('url', urlStr);
      return proxyUrl.href;
    }

    logger.error('Basic P2P replacement failed!', { meta, url: urlStr });

    return urlStr;
  }
}

type CDNUtilInstance = ReturnType<typeof createCDNUtil>;
export const getCDNUtil = lazyValue<CDNUtilInstance>(createCDNUtil);
