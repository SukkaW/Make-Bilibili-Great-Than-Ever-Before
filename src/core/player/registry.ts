import flru from 'flru';
import { FIFO } from 'foxts/fifo';
import { logger } from '../../logger';
import { classifyCdnUrl, isAkamaiHost, signatureDeadlineOf, signatureFamilyOf } from './cdn-classify';
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
  /** Quality id for video, audio id for audio */
  readonly id: number,
  readonly codecs: string,
  readonly mimeType: string,
  /** Bits per second */
  readonly bandwidth: number,
  readonly segmentBase: { readonly init: ByteRange, readonly index: ByteRange } | null,
  /** Every signed address Bilibili listed for this file (baseUrl + backupUrl) */
  readonly addresses: readonly MediaAddress[]
}

export interface MediaFileMatch {
  /** As listed by the newest playinfo: the freshest signed addresses, whichever one was requested */
  readonly file: MediaFile,
  /** The signed address itself is listed. Otherwise only its path matched, maybe with a newer signature */
  readonly exact: boolean
}

/** All upgcxcode hosts are interchangeable, so we collect them here. Only the registry adds to it */
export interface MediaHostCatalog {
  /** Upos mirrors: interchangeable for any upos-signed address */
  readonly mirror: ReadonlySet<string>,
  /** Bilibili's own PoPs: interchangeable as well */
  readonly bcache: ReadonlySet<string>,
  /** Only valid with Akamai's own signatures */
  readonly akamai: ReadonlySet<string>
}

export interface MediaRegistry {
  readonly hosts: MediaHostCatalog,
  /** Changes whenever a playinfo is ingested or a host added to the catalog */
  readonly version: number,
  /** @returns `null` if the JSON is not a DASH playinfo */
  ingestPlayinfo(this: void, json: object, meta: string): MediaFile[] | null,
  findFile(this: void, address: MediaAddress): MediaFileMatch | null,
  /** Collect the host of a CDN URL seen outside of playinfo */
  noteHost(this: void, address: MediaAddress): void,
  /** Also replays the files already known */
  onFileUpdated(this: void, cb: (file: MediaFile) => void): void
}

export function createMediaRegistry(): MediaRegistry {
  const mirrorHosts = new Set<string>();
  const bcacheHosts = new Set<string>();
  const akamaiHosts = new Set<string>();
  const hosts: MediaHostCatalog = { mirror: mirrorHosts, bcache: bcacheHosts, akamai: akamaiHosts };

  /** Every signed address seen (pathname + search) */
  const knownAddresses = flru<true>(1200);
  /**
   * pathname -> the file as listed by the newest playinfo. A new playinfo re-signs the same paths,
   * so the old addresses keep working until their deadline, and the new ones are fresher
   */
  const filesByPath = flru<MediaFile>(400);

  const recentFiles = new FIFO<MediaFile>();
  const listeners = new Set<(file: MediaFile) => void>();
  let fileCount = 0;
  let videoCount = 0;
  let version = 0;

  function noteHost(address: MediaAddress) {
    let catalog: Set<string> | null = null;
    if (address.class === 'mirror') {
      catalog = isAkamaiHost(address.hostname) ? akamaiHosts : mirrorHosts;
    } else if (address.class === 'bcache') {
      catalog = bcacheHosts;
    }
    if (catalog !== null && !catalog.has(address.hostname)) {
      catalog.add(address.hostname);
      version++;
    }
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

  function toMediaFile(
    kind: MediaKind,
    representation: Record<string, unknown>,
    addresses: MediaAddress[],
    key: string,
    videoKey: string
  ): MediaFile {
    const mimeType = representation.mimeType ?? representation.mime_type;

    return {
      key,
      videoKey,
      kind,
      id: Number(representation.id) || 0,
      codecs: typeof representation.codecs === 'string' ? representation.codecs : '',
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      bandwidth: Number(representation.bandwidth) || 0,
      segmentBase: segmentBaseOf(representation),
      addresses
    };
  }

  function index(file: MediaFile) {
    for (let i = 0, len = file.addresses.length; i < len; i++) {
      const address = file.addresses[i];
      knownAddresses.set(address.key, true);
      filesByPath.set(address.pathname, file);
    }

    recentFiles.enqueue(file);
    if (recentFiles.size > 200) {
      recentFiles.dequeue();
    }

    for (const cb of listeners) {
      try {
        cb(file);
      } catch (e) {
        logger.error('Failed to notify media file update', e);
      }
    }
  }

  return {
    hosts,
    get version() {
      return version;
    },
    ingestPlayinfo(json, meta) {
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
        const file = toMediaFile(kind, representation, addresses, known?.key ?? `file-${++fileCount}`, videoKey);
        files.push(file);
        index(file);
      }
      version++;

      logger.info('CDN URLs extracted', { meta });

      return files;
    },
    findFile(address) {
      const file = filesByPath.get(address.pathname);
      return file === undefined ? null : { file, exact: knownAddresses.has(address.key) };
    },
    noteHost,
    onFileUpdated(cb) {
      listeners.add(cb);
      for (const file of recentFiles) {
        try {
          cb(file);
        } catch (e) {
          logger.error('Failed to notify media file update', e);
        }
      }
    }
  };
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
