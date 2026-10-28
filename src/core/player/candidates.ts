/**
 * Every URL a media request could be fetched from, and which one the browser should fetch.
 *
 * A signed upgcxcode address (a path starting with `/upgcxcode/`) is valid on any upgcxcode host (a
 * Bilibili CDN host serving `/upgcxcode/` paths; P2P / PCDN ones aside, and Akamai aside, which
 * only takes its own signed addresses): the host is not part of the signature. An MCDN address
 * wrapping one (`/v1/resource/upgcxcode/...`) is not: it is signed for its own host. So the
 * candidates of a request are the URL it asked for and every address the playinfo lists for its
 * file, as they are, plus each of those upgcxcode signatures on every upgcxcode host (the file's
 * own, every host seen in any playinfo, the seeds).
 *
 * Policy phases (no-p2p) then decide which candidates are acceptable, dropping and converting
 * some. The browser fetches one of what is left natively, and a serve phase (thread-ripper) races
 * them all.
 */

import { addArrayElementsToSet } from 'foxts/add-array-elements-to-set';
import { pickOne } from 'foxts/pick-random';
import { isAkamaiHost, isMirrorHost, isP2PCDNDomain } from './cdn-classify';
import { isCoolingDown, isExcluded } from './host-model';
import { upgcxcodeHosts } from './registry';
import type { MediaAddress, MediaFile } from './registry';

/**
 * How much a host with no measurement is preferred, lower first: what Bilibili listed for the file
 * before what is moved elsewhere (a native request has no fallback). Measurements override it
 */
export enum CandidateTier {
  /** Listed for the file (or asked for by the player) on an upos mirror */
  ListedMirror = 0,
  /** Listed on Bilibili's own PoP */
  ListedBcache = 1,
  /** A listed signature moved onto another upos mirror */
  Mirror = 2,
  /** A listed signature moved onto another PoP */
  Bcache = 3,
  /** A PCDN URL pointed back at its source host */
  Source = 4,
  /** Fetched through Bilibili's proxy */
  Proxy = 5,
  /** A P2P / PCDN host */
  P2P = 6
}

/** One URL a media request could go to: an address, and how it ranks before anything is measured */
export interface MediaCandidate extends MediaAddress {
  readonly tier: CandidateTier,
  /** Served by a P2P / PCDN host */
  readonly p2p: boolean
}

/** Bilibili's proxy hosts, which fetch a PCDN URL for us */
const PROXY_HOST_RE = /^(?:upos|proxy)-tf-/;
/** A signature must stay valid at least this long to be used */
const DEADLINE_MARGIN_MS = 60 * 1000;

/**
 * upgcxcode hosts, tried even before any playinfo lists them. Which ones work, and how fast, is
 * learned. Never a P2P / PCDN host (`isP2PCDNDomain`), never Akamai (`isAkamaiHost`).
 */
const SEED_HOSTS = [
  'upos-sz-mirrorali.bilivideo.com',
  'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirrorbos.bilivideo.com',
  'upos-sz-mirror08c.bilivideo.com',
  'upos-sz-mirrorbd.bilivideo.com',
  'upos-sz-mirrorcos.bilivideo.com',
  'upos-sz-mirrorcoso1.bilivideo.com',
  'upos-sz-mirrorcosb.bilivideo.com',
  'upos-sz-mirrorcosov.bilivideo.com',
  'upos-sz-mirroraliov.bilivideo.com',
  'upos-sz-estgoss.bilivideo.com',
  'cn-hk-eq-01-01.bilivideo.com',
  'cn-hk-eq-01-03.bilivideo.com'
];

/**
 * The URL a request asked for (`null` for none) and every address listed for its file (`null`
 * when the registry does not know it), as they are, plus every upgcxcode signature among them on
 * every upgcxcode host.
 */
export function mediaCandidates(requested: MediaAddress | null, file: MediaFile | null): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: MediaCandidate) => {
    if (!seen.has(candidate.href)) {
      seen.add(candidate.href);
      candidates.push(candidate);
    }
  };

  const listed = file === null ? [] : file.addresses;
  const sources = requested === null ? listed : [requested, ...listed];

  const upgcxcodeHosts = upgcxcodeHostsOf(file);
  /** Signatures already on every upgcxcode host: the requested one is usually listed as well */
  const moved = new Set<string>();
  for (let i = 0, len = sources.length; i < len; i++) {
    const source = sources[i];
    add(asListed(source));

    const { key } = source;
    if (source.pathname.startsWith('/upgcxcode/') && !isAkamaiHost(source.hostname) && !moved.has(key)) {
      moved.add(key);
      for (let j = 0, count = upgcxcodeHosts.length; j < count; j++) {
        const hostname = upgcxcodeHosts[j];
        // The path is an upgcxcode one wherever it is moved: only the host tells mirror from PoP
        const mirror = isMirrorHost(hostname);
        add({ ...source, href: `https://${hostname}${key}`, hostname, class: mirror ? 'mirror' : 'bcache', tier: mirror ? CandidateTier.Mirror : CandidateTier.Bcache, p2p: false });
      }
    }
  }
  return candidates;
}

/** Not about to expire, and this host does not lack the file */
export function isCandidateUsable(candidate: MediaCandidate, file: MediaFile | null, now: number, nowSec: number) {
  return (candidate.deadline === 0 || (candidate.deadline - nowSec) * 1000 > DEADLINE_MARGIN_MS)
    && (file === null || !isExcluded(candidate.hostname, file, now));
}

/** The candidate a request made for this address stands for, `null` if it is not acceptable */
export function findCandidate(candidates: readonly MediaCandidate[], address: MediaAddress): MediaCandidate | null {
  for (let i = 0, len = candidates.length; i < len; i++) {
    const candidate = candidates[i];
    if (candidate.hostname === address.hostname && candidate.key === address.key) {
      return candidate;
    }
  }
  return null;
}

/**
 * A usable candidate of the lowest tier, at random, on a host not cooling down if there is one:
 * what the browser fetches when the requested URL is not acceptable
 */
export function defaultCandidate(candidates: readonly MediaCandidate[], file: MediaFile | null, now: number): MediaCandidate | null {
  const nowSec = Date.now() / 1000;
  const usable = candidates.filter(candidate => isCandidateUsable(candidate, file, now, nowSec));
  const available = usable.filter(candidate => !isCoolingDown(candidate.hostname, now));
  const options = available.length > 0 ? available : usable;
  let best: CandidateTier | null = null;
  for (let i = 0, len = options.length; i < len; i++) {
    if (best === null || options[i].tier < best) {
      best = options[i].tier;
    }
  }
  return best === null ? null : pickOne(options.filter(candidate => candidate.tier === best));
}

/** The file's own upgcxcode hosts first (Bilibili picked them for this viewer), then the others */
function upgcxcodeHostsOf(file: MediaFile | null) {
  const names = new Set<string>();
  if (file !== null) {
    for (let i = 0, len = file.addresses.length; i < len; i++) {
      const address = file.addresses[i];
      if (address.class === 'mirror' || address.class === 'bcache') {
        names.add(address.hostname);
      }
    }
  }
  for (const hostname of upgcxcodeHosts) names.add(hostname);
  addArrayElementsToSet(names, SEED_HOSTS);
  return Array.from(names).filter(hostname => !isP2PCDNDomain(hostname) && !isAkamaiHost(hostname));
}

/** An address as it was given: non-P2P ones over HTTPS, P2P ones untouched (their own ports) */
function asListed(source: MediaAddress): MediaCandidate {
  const { hostname, class: cls } = source;
  if (cls === 'mcdn-upgcxcode' || cls === 'mcdn-tf' || cls === 'szbdyd' || isP2PCDNDomain(hostname)) {
    return { ...source, tier: CandidateTier.P2P, p2p: true };
  }
  const tier = PROXY_HOST_RE.test(hostname) ? CandidateTier.Proxy : (cls === 'bcache' ? CandidateTier.ListedBcache : CandidateTier.ListedMirror);
  return { ...source, href: `https://${hostname}${source.key}`, tier, p2p: false };
}
