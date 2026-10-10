import flru from 'flru';
import { logger } from '../../logger';
import { classifyCdnUrl, signatureDeadlineOf, signatureFamilyOf } from './cdn-classify';
import type { CdnUrlClass, SignatureFamily } from './cdn-classify';
import { parseByteRangeSpec } from './range';
import type { ByteRange } from './range';
import { isObject } from '../../utils/is-object';
import type { ReadonlyURL } from '../../utils/readonly-url';

export type MediaKind = 'video' | 'audio';

/** A CDN URL, parsed once */
export interface MediaAddress {
  /** Normalised by `URL` */
  readonly href: string,
  readonly hostname: string,
  readonly pathname: string,
  /** pathname + search: the signed address, whatever the host */
  readonly key: string,
  readonly class: CdnUrlClass,
  readonly family: SignatureFamily,
  /** Unix seconds, `0` if unknown */
  readonly deadline: number
}

export interface MediaFile {
  /**
   * The file itself, whatever URL format it is requested through (upgcxcode, `/v1/resource`, ...)
   * and whichever playinfo listed it: a later playinfo sharing any of its paths keeps the key
   */
  readonly key: string,
  /** The video it belongs to: every representation listed by one playinfo shares it */
  readonly videoKey: string,
  readonly kind: MediaKind,
  readonly codecs: string,
  readonly mimeType: string,
  /** Bits per second */
  readonly bandwidth: number,
  readonly segmentBase: { readonly init: ByteRange, readonly index: ByteRange } | null,
  /** Every signed address Bilibili listed for this file (baseUrl + backupUrl) */
  readonly addresses: readonly MediaAddress[]
}

/** Every upgcxcode host (upos mirror, Bilibili PoP, Akamai) seen in any playinfo or request */
export const upgcxcodeHosts = new Set<string>();

/**
 * pathname -> the file as listed by the newest playinfo. A new playinfo re-signs the same paths,
 * so the old addresses keep working until their deadline, and the new ones are fresher
 */
const filesByPath = flru<MediaFile>(400);
let fileCount = 0;
let videoCount = 0;

/** Collect the host of a CDN URL */
export function noteHost(address: MediaAddress) {
  if (address.class === 'mirror' || address.class === 'bcache') {
    upgcxcodeHosts.add(address.hostname);
  }
}

/** @returns `null` if the JSON is not a DASH playinfo */
export function ingestPlayinfo(json: object, meta: string): MediaFile[] | null {
  const dash = extractDash(json as Record<string, unknown>);
  if (!dash) {
    logger.warn('Invalid Bilibili Playinfo data', { json });
    return null;
  }

  const listed: Array<{ kind: MediaKind, representation: Record<string, unknown>, addresses: MediaAddress[], known: MediaFile | null }> = [];
  let videoKey: string | null = null;
  const representations = representationsOf(dash);
  for (let i = 0, len = representations.length; i < len; i++) {
    const [kind, representation] = representations[i];
    const addresses = readAddresses(representation);
    if (addresses.length > 0) {
      const known = knownFileOf(addresses);
      // Files seen before: the same video again (re-signed addresses, another quality)
      videoKey ??= known?.videoKey ?? null;
      listed.push({ kind, representation, addresses, known });
    }
  }
  videoKey ??= `video-${++videoCount}`;

  const files: MediaFile[] = [];
  for (let i = 0, len = listed.length; i < len; i++) {
    const { kind, representation, addresses, known } = listed[i];
    const mimeType = representation.mimeType ?? representation.mime_type;
    const file: MediaFile = {
      key: known?.key ?? `file-${++fileCount}`,
      videoKey,
      kind,
      codecs: typeof representation.codecs === 'string' ? representation.codecs : '',
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      bandwidth: Number(representation.bandwidth) || 0,
      segmentBase: segmentBaseOf(representation),
      addresses
    };
    files.push(file);
    for (let j = 0, count = addresses.length; j < count; j++) {
      filesByPath.set(addresses[j].pathname, file);
    }
  }

  logger.info('CDN URLs extracted', { meta });

  return files;
}

/** As listed by the newest playinfo: the freshest signed addresses, whichever one was requested */
export function findFile(address: MediaAddress): MediaFile | null {
  return filesByPath.get(address.pathname) ?? null;
}

/** Read everything the interceptor needs from a CDN URL, once */
export function toMediaAddress(url: ReadonlyURL): MediaAddress {
  return {
    href: url.href,
    hostname: url.hostname,
    pathname: url.pathname,
    key: url.pathname + url.search,
    class: classifyCdnUrl(url),
    family: signatureFamilyOf(url),
    deadline: signatureDeadlineOf(url)
  };
}

function extractDash(json: Record<string, unknown>): Record<string, unknown> | null {
  // normal video player, and pugv (cheese)
  if (isObject(json.data) && isObject(json.data.dash)) {
    return json.data.dash;
  }
  if (isObject(json.result)) {
    // bangumi video player
    if (isObject(json.result.video_info) && isObject(json.result.video_info.dash)) {
      return json.result.video_info.dash;
    }
    // bangumi video player, older playurl API
    if (isObject(json.result.dash)) {
      return json.result.dash;
    }
  }
  return null;
}

function representationsOf(dash: Record<string, unknown>) {
  const representations: Array<[MediaKind, Record<string, unknown>]> = [];
  const add = (kind: MediaKind, list: unknown) => {
    if (Array.isArray(list)) {
      for (let i = 0, len = list.length; i < len; i++) {
        const item: unknown = list[i];
        if (isObject(item)) {
          representations.push([kind, item]);
        }
      }
    } else if (isObject(list)) {
      representations.push([kind, list]);
    }
  };

  add('video', dash.video);
  add('audio', dash.audio);
  // Dolby Atmos: an array
  if (isObject(dash.dolby)) {
    add('audio', dash.dolby.audio);
  }
  // Hi-Res: a single representation
  if (isObject(dash.flac)) {
    add('audio', dash.flac.audio);
  }
  return representations;
}

function knownUrlsOf(representation: Record<string, unknown>) {
  const knownUrls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      knownUrls.add(value);
    } else if (Array.isArray(value)) {
      for (let i = 0, len = value.length; i < len; i++) {
        const item: unknown = value[i];
        if (typeof item === 'string') {
          knownUrls.add(item);
        }
      }
    }
  };
  add(representation.baseUrl);
  add(representation.base_url);
  add(representation.backupUrl);
  add(representation.backup_url);
  return knownUrls;
}

function segmentBaseOf(representation: Record<string, unknown>): MediaFile['segmentBase'] {
  const segmentBase = isObject(representation.SegmentBase)
    ? representation.SegmentBase
    : (isObject(representation.segment_base) ? representation.segment_base : null);
  if (!segmentBase) {
    return null;
  }
  const init = parseByteRangeSpec(segmentBase.Initialization ?? segmentBase.initialization);
  const index = parseByteRangeSpec(segmentBase.indexRange ?? segmentBase.index_range);
  return init && index ? { init, index } : null;
}

/** Every address listed for a representation */
function readAddresses(representation: Record<string, unknown>) {
  const addresses: MediaAddress[] = [];
  for (const urlStr of knownUrlsOf(representation)) {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      logger.debug('Failed to process CDN URL, skipping.', { url: urlStr });
      continue;
    }

    const address = toMediaAddress(url);
    if (address.class === 'unknown') {
      logger.error(`Unrecognized CDN URL pattern: ${urlStr}`);
    }
    noteHost(address);
    addresses.push(address);
  }
  return addresses;
}

/** The file an earlier playinfo listed under any of these addresses' paths */
function knownFileOf(addresses: readonly MediaAddress[]) {
  for (let i = 0, len = addresses.length; i < len; i++) {
    const file = filesByPath.get(addresses[i].pathname);
    if (file !== undefined) {
      return file;
    }
  }
  return null;
}
