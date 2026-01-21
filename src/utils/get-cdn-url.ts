import { pickOne } from 'foxts/pick-random';
import { createRetrieKeywordFilter } from 'foxts/retrie';
import { logger } from '../logger';
import { lazyValue } from 'foxts/lazy-value';

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
    bacache_urls?: Set<string>,
    mcdn_upgcxcode_urls?: Set<string>,
    xyusourceUrls?: Set<string>,
    mcdn_tf_urls?: Set<string>
  }

  // All upgcxcode hosts are interchangeable, so we collect them here
  const mirror_type_upgcxcode_hosts = new Set<string>();
  const bcache_type_upgcxcode_hosts = new Set<string>();

  const cdnDatas = new Map<string, CdnUrlData>();

  return {
    saveAndParsePlayerInfo(json: object, meta: string, shouldOverwrite = false) {
      if (cdnDatas.size > 0) {
        if (!shouldOverwrite) {
          logger.debug('CDN URLs already extracted, skip parsing again.', { meta });
          return;
        }

        logger.debug('Overwritten existing CDN URLs, re-parse playinfo.', { meta });
        cdnDatas.clear();
      }

      if (
        (!('data' in json)) || typeof json.data !== 'object' || json.data === null
        || (!('dash' in json.data)) || typeof json.data.dash !== 'object' || json.data.dash === null
      ) {
        logger.warn('Invalid Bilibili Playinfo data', { json });
        return;
      }

      if ('video' in json.data.dash && Array.isArray(json.data.dash.video)) {
        extractCDNFromVideoOrAudio(json.data.dash.video);
      }
      if ('audio' in json.data.dash && Array.isArray(json.data.dash.audio)) {
        extractCDNFromVideoOrAudio(json.data.dash.audio);
      }

      logger.info('CDN URLs extracted', { meta, cdnDatas });
    },
    getReplacementCdnUrl(url: string | URL, meta: string): string {
      if (cdnDatas.size === 0) {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        return basicP2PReplacement(urlObj, meta);
      }

      if (cdnDatas.has(url.toString())) {
        return cdnDatas.get(url.toString())!.getReplacementUrl(url);
      }

      logger.error('No matching CDN URL Group found!', { meta, url });
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
      let last = '';
      const mirror_urls = new Set<string>();
      const bcache_urls = new Set<string>();

      const mcdn_tf_urls = new Set<string>();
      const mcdn_upgcxcode_urls = new Set<string>();
      const xyusourceUrls = new Set<string>();

      for (const urlStr of knownUrls) {
        last = urlStr;

        try {
          if (mirrorRegex.test(urlStr)) {
            if (urlStr.includes('/upgcxcode/')) {
              const url = new URL(urlStr);

              // Now we konw this url is both upgcxcode type url and mirror type url
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

                mirror_urls.add(url.href);
              } else {
                // Now we know this url is mirror type url, upgcxcode url, and p2p cdn url
                url.protocol = 'https:';
                url.port = '443';

                // since we will replace its hostname anyway, the original hostname
                // does not matter, we use a fixed dummy hostname here, and better
                // reduce duplicates in the Set<string>.
                url.hostname = MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED;

                mcdn_upgcxcode_urls.add(urlStr);
              }
            }

            continue;
          }

          if (mCdnTfRegex.test(urlStr)) {
            // This is mcdn type url, a.k.a. pure IP cdn url or mcdn.bilivideo.*
            mcdn_tf_urls.add(urlStr);
            continue;
          }

          if (urlStr.includes('/upgcxcode/')) {
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

              mcdn_upgcxcode_urls.add(urlStr);
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

          // szbdyd.com appears to be deprecated, but we still handle it just in case
          if (urlStr.includes('szbdyd.com')) {
            const url = new URL(urlStr);

            url.protocol = 'https:';

            // szbdyd hostname can be replaced with the value of xy_usource query param
            // and if xy_usource is missing, we can replace to upgcxcode host
            url.hostname = url.searchParams.get('xy_usource') ?? MCDN_UPGCXCODE_URL_HOSTNAME_TO_BE_REPLACED;
            url.port = '443';

            xyusourceUrls.add(url.href);
            continue;
          }

          logger.error(`Unrecognized CDN URL pattern: ${urlStr}`);
        } catch {
          // fallthru
        }
      }

      let replacementType: string;
      let getReplacementUrl: (url: string | URL) => string;

      switch (true) {
        // We always prefer mirror type urls when possible, so as long as we have some,
        // we always pick one from them
        case (mirror_urls.size > 0): {
          replacementType = 'mirror';

          const mirrorUrlsArray = Array.from(mirror_urls);
          if (mirrorUrlsArray.length === 1) {
            getReplacementUrl = () => mirrorUrlsArray[0];
            break;
          }
          getReplacementUrl = () => pickOne(mirrorUrlsArray);
          break;
        }
        // bacache urls are not as good as mirror urls, but still better than p2p cdn,
        // we pick one from them when no mirror urls are available
        case (bcache_urls.size > 0): {
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
        case (xyusourceUrls.size > 0): {
          replacementType = 'szbdyd.com -> xy_usource or upgcxcode host replacement';

          const xyusourceUrlsArray = Array.from(xyusourceUrls);

          getReplacementUrl = () => {
            const picked = pickOne(xyusourceUrlsArray);
            const url = new URL(picked);

            // If the URL do not have xy_usource, we need to replace with upgcxcode host
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
          replacementType = 'none';

          logger.warn('Failed to get replacement CDN URL', { last });
          getReplacementUrl = (url: string | URL) => url.toString();
          break;
        }
      }

      knownUrls.forEach((url) => {
        cdnDatas.set(url, {
          replacementType,
          getReplacementUrl,
          // Optional meta
          mirror_urls,
          bacache_urls: bcache_urls,
          mcdn_upgcxcode_urls,
          xyusourceUrls,
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
    logger.warn('PlayInfo not collected yet! Opt-in basic P2P replacement', { meta, url: url.href });

    const urlStr = url.href;

    if (urlStr.includes('/upgcxcode/')) {
      // Even if we have not collected any CDN info yet, we can still try our best to avoid P2P CDNs
      if (mirrorRegex.test(urlStr)) {
        // Now we konw this url is both upgcxcode type url and mirror type url
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
