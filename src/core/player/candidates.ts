/**
 * Every URL a media request could be fetched from, and which one the browser should fetch.
 *
 * A signed upgcxcode address is valid on any upgcxcode host (a Bilibili CDN host serving
 * `/upgcxcode/` paths, P2P / PCDN ones aside): the host is not part of the signature. So the
 * candidates of a request are the URL it asked for and every address the playinfo lists for its
 * file, as they are, plus each of those signatures on every upgcxcode host (the file's own, every
 * host seen in any playinfo, the seeds).
 *
 * Policy phases (no-p2p) then decide which candidates are acceptable, dropping and converting
 * some. The browser fetches one of what is left natively, and a serve phase (thread-ripper) races
 * them all.
 */

import { addArrayElementsToSet } from 'foxts/add-array-elements-to-set';
import { pickOne } from 'foxts/pick-random';
import { isAkamaiHost, isMirrorHost, isP2PCDNDomain } from './cdn-classify';
import type { SignatureFamily } from './cdn-classify';
import type { HostModel } from './host-model';
import type { MediaAddress, MediaFile, MediaHostCatalog } from './registry';

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
  P2P = 6,
  /**
   * A signature on a host not known to accept it: upos ones on Akamai refuse with 403 (verified),
   * Akamai ones elsewhere are unverified. Kept, tried last, and the refusal is learned
   */
  Foreign = 7
}

/** One URL a media request could go to */
export interface MediaCandidate {
  readonly href: string,
  readonly hostname: string,
  /** pathname + search: the signed address, whatever the host */
  readonly key: string,
  /** Which hosts can verify the signature */
  readonly family: SignatureFamily,
  /** When the signature expires, unix seconds, `0` if unknown */
  readonly deadline: number,
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
 * learned: Akamai included, although it is known to refuse upos signatures. Never a P2P / PCDN
 * host (`isP2PCDNDomain`).
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
  'cn-hk-eq-01-03.bilivideo.com',
  'upos-hz-mirrorakam.akamaized.net'
];

/**
 * The URL a request asked for (`null` for none) and every address listed for its file (`null`
 * when the registry does not know it), as they are, plus every upgcxcode signature among them on
 * every upgcxcode host.
 */
export function mediaCandidates(requested: MediaAddress | null, file: MediaFile | null, catalog: MediaHostCatalog): MediaCandidate[] {
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

  const upgcxcodeHosts = upgcxcodeHostsOf(file, catalog);
  /** Signatures already on every upgcxcode host: the requested one is usually listed as well */
  const moved = new Set<string>();
  for (let i = 0, len = sources.length; i < len; i++) {
    const source = sources[i];
    add(asListed(source, catalog));

    const { key, family, deadline } = source;
    if (source.pathname.includes('/upgcxcode/') && !moved.has(key)) {
      moved.add(key);
      for (let j = 0, count = upgcxcodeHosts.length; j < count; j++) {
        const hostname = upgcxcodeHosts[j];
        add({
          href: `https://${hostname}${key}`,
          hostname,
          key,
          family,
          deadline,
          tier: tierOnHost(hostname, family),
          p2p: false
        });
      }
    }
  }
  return candidates;
}

/** Not banned, not about to expire, and this host neither refuses its signature nor lacks the file */
export function isCandidateUsable(candidate: MediaCandidate, model: HostModel, file: MediaFile | null, now: number, nowSec: number) {
  return !model.isAddressBanned(candidate.key)
    && (candidate.deadline === 0 || (candidate.deadline - nowSec) * 1000 > DEADLINE_MARGIN_MS)
    && !model.isFamilyRefused(candidate.hostname, candidate.family, now)
    && (file === null || !model.isExcluded(candidate.hostname, file, now));
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
export function defaultCandidate(candidates: readonly MediaCandidate[], model: HostModel, file: MediaFile | null, now: number): MediaCandidate | null {
  const usable = Array.from(usableByHost(candidates, model, file, now).values());
  const available = usable.filter(candidate => !model.isCoolingDown(candidate.hostname, now));
  const options = available.length > 0 ? available : usable;
  let best: CandidateTier | null = null;
  for (let i = 0, len = options.length; i < len; i++) {
    if (best === null || options[i].tier < best) {
      best = options[i].tier;
    }
  }
  return best === null ? null : pickOne(options.filter(candidate => candidate.tier === best));
}

/** For every host, its most preferred usable candidate */
function usableByHost(candidates: readonly MediaCandidate[], model: HostModel, file: MediaFile | null, now: number): Map<string, MediaCandidate> {
  const nowSec = Date.now() / 1000;
  const byHost = new Map<string, MediaCandidate>();
  for (let i = 0, len = candidates.length; i < len; i++) {
    const candidate = candidates[i];
    if (isCandidateUsable(candidate, model, file, now, nowSec)) {
      const current = byHost.get(candidate.hostname);
      if (current === undefined || isPreferred(candidate, current, model)) {
        byHost.set(candidate.hostname, candidate);
      }
    }
  }
  return byHost;
}

/** For one host: the signature it served last, else one of a family it accepts, else the freshest */
function isPreferred(candidate: MediaCandidate, current: MediaCandidate, model: HostModel) {
  const proven = model.provenAddress(candidate.hostname);
  if ((candidate.key === proven) !== (current.key === proven)) {
    return candidate.key === proven;
  }
  const accepted = model.acceptsFamily(candidate.hostname, candidate.family);
  if (accepted !== model.acceptsFamily(current.hostname, current.family)) {
    return accepted;
  }
  if (candidate.tier !== current.tier) {
    return candidate.tier < current.tier;
  }
  return candidate.deadline > current.deadline;
}

/** The file's own upgcxcode hosts first (Bilibili picked them for this viewer), then the others */
function upgcxcodeHostsOf(file: MediaFile | null, catalog: MediaHostCatalog) {
  const names = new Set<string>();
  if (file !== null) {
    for (let i = 0, len = file.addresses.length; i < len; i++) {
      const address = file.addresses[i];
      if (address.class === 'mirror' || address.class === 'bcache') {
        names.add(address.hostname);
      }
    }
  }
  for (const hostname of catalog.mirror) names.add(hostname);
  for (const hostname of catalog.bcache) names.add(hostname);
  for (const hostname of catalog.akamai) names.add(hostname);
  addArrayElementsToSet(names, SEED_HOSTS);
  // The catalog only holds mirror / bcache hosts already: this keeps it that way
  return Array.from(names).filter(hostname => !isP2PCDNDomain(hostname));
}

/** A signature moved onto an upgcxcode host (never a P2P one) */
function tierOnHost(hostname: string, family: SignatureFamily) {
  if ((family === 'akam') !== isAkamaiHost(hostname)) {
    return CandidateTier.Foreign;
  }
  // The path is an upgcxcode one wherever it is moved: only the host tells mirror from PoP
  return isMirrorHost(hostname) ? CandidateTier.Mirror : CandidateTier.Bcache;
}

/** An address as it was given: non-P2P ones over HTTPS, P2P ones untouched (their own ports) */
function asListed(source: MediaAddress, catalog: MediaHostCatalog): MediaCandidate {
  const { hostname, key, family, deadline } = source;
  const p2p = isP2PCDNDomain(hostname) || source.class === 'mcdn-upgcxcode' || source.class === 'mcdn-tf' || source.class === 'szbdyd';
  if (p2p) {
    return { href: source.href, hostname, key, family, deadline, tier: CandidateTier.P2P, p2p };
  }
  let tier: CandidateTier;
  if (PROXY_HOST_RE.test(hostname)) {
    tier = CandidateTier.Proxy;
  } else if (source.class === 'bcache' || catalog.bcache.has(hostname)) {
    tier = CandidateTier.ListedBcache;
  } else {
    tier = CandidateTier.ListedMirror;
  }
  return { href: `https://${hostname}${key}`, hostname, key, family, deadline, tier, p2p };
}
