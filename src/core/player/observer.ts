/**
 * The observe phase, always on and read-only: native media XHRs teach the host model how fast
 * each host is.
 */

import { p } from 'fast-percentile';
import { isCold, MediaOutcome, MIN_RATE_SAMPLE_BYTES, noteBytes, recordOutcome, recordSample } from './host-model';
import type { MediaAddress, MediaFile } from './registry';

/** The gaps between a request's chunks are reported as their 90th percentile */
const p90 = p(90);

/** Listeners on XHRs, by XHR, to remove them from: `open()` ends the request they are watching */
const watching = new WeakMap<XMLHttpRequest, () => void>();

/** The XHR is re-opened: whatever request its listeners were watching is gone, without `loadend` */
export function stopWatching(xhr: XMLHttpRequest) {
  const stop = watching.get(xhr);
  if (stop !== undefined) {
    watching.delete(xhr);
    stop();
  }
}

/** Time a media XHR the browser sends itself, and report how its host did */
export function observeNativeMediaXhr(xhr: XMLHttpRequest, address: MediaAddress, file: MediaFile) {
  const { hostname } = address;
  const startedAt = performance.now();
  const cold = isCold(hostname, startedAt);

  let headersAt = 0;
  let firstAt = 0;
  let firstLoaded = 0;
  let lastAt = 0;
  let lastLoaded = 0;
  let ended: 'abort' | 'error' | 'timeout' | null = null;
  const gaps: number[] = [];

  const onReadyStateChange = () => {
    if (headersAt === 0 && xhr.readyState >= 2) {
      headersAt = performance.now();
    }
  };
  const onProgress = (event: ProgressEvent) => {
    const now = performance.now();
    noteBytes(now);
    if (firstAt === 0) {
      firstAt = now;
      firstLoaded = event.loaded;
    } else if (gaps.length < 256) {
      gaps.push(now - lastAt);
    }
    lastAt = now;
    lastLoaded = event.loaded;
  };
  const onAbort = () => {
    ended = 'abort';
  };
  const onError = () => {
    ended = 'error';
  };
  const onTimeout = () => {
    ended = 'timeout';
  };

  const onLoadEnd = () => {
    watching.delete(xhr);
    stop();

    const now = performance.now();
    let outcome: MediaOutcome;
    switch (ended) {
      case 'abort':
        outcome = MediaOutcome.Canceled;
        break;
      case 'timeout':
        outcome = headersAt === 0 ? MediaOutcome.TtfbTimeout : MediaOutcome.Stall;
        break;
      case 'error':
        outcome = headersAt === 0 ? (now - startedAt < 150 ? MediaOutcome.ConnectFail : MediaOutcome.Network) : MediaOutcome.Reset;
        break;
      default:
        outcome = outcomeOfStatus(xhr.status, address.deadline);
    }
    recordOutcome(hostname, file, address, outcome, now);

    if (headersAt !== 0 && outcome === MediaOutcome.Ok) {
      const bytes = lastLoaded - firstLoaded;
      recordSample({
        hostname,
        file,
        cold,
        ttfb: headersAt - startedAt,
        rate: bytes >= MIN_RATE_SAMPLE_BYTES && lastAt > firstAt ? bytes / (lastAt - firstAt) : null,
        gap: gaps.length === 0 ? null : p90(gaps)
      }, now);
    }
  };

  xhr.addEventListener('readystatechange', onReadyStateChange);
  xhr.addEventListener('progress', onProgress);
  xhr.addEventListener('abort', onAbort);
  xhr.addEventListener('error', onError);
  xhr.addEventListener('timeout', onTimeout);
  xhr.addEventListener('loadend', onLoadEnd);
  watching.set(xhr, stop);

  function stop() {
    xhr.removeEventListener('readystatechange', onReadyStateChange);
    xhr.removeEventListener('progress', onProgress);
    xhr.removeEventListener('abort', onAbort);
    xhr.removeEventListener('error', onError);
    xhr.removeEventListener('timeout', onTimeout);
    xhr.removeEventListener('loadend', onLoadEnd);
  }
}

function outcomeOfStatus(status: number, deadline: number): MediaOutcome {
  if (status === 206) return MediaOutcome.Ok;
  if (status === 200) return MediaOutcome.NoRange;
  if (status === 401 || status === 403) return deadline !== 0 && deadline * 1000 <= Date.now() ? MediaOutcome.Expired : MediaOutcome.Refused;
  if (status === 404 || status === 410) return MediaOutcome.Missing;
  if (status === 416) return MediaOutcome.EofClamp;
  if (status === 412 || status === 429) return MediaOutcome.Throttled;
  if (status === 503) return MediaOutcome.Overloaded;
  return MediaOutcome.ServerError;
}
