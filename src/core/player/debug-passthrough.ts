/**
 * Debug builds only: answer media range XHRs through the synthetic XHR path with a plain native
 * fetch of the same range, to prove the XHR emulation without changing what is downloaded.
 */

import { logger } from '../../logger';
import type { SyntheticXhrSink } from '../../types';
import type { MediaServePhase } from '.';
import { byteRangeLength } from './range';
import type { ByteRange } from './range';

export function createDebugPassthroughPhase(nativeFetch: typeof fetch): MediaServePhase {
  return {
    type: 'serve',
    name: 'debug-passthrough',
    serve({ ctx, range }) {
      if (range === null) {
        return null;
      }
      logger.debug('[debug-passthrough] serving', ctx.url, range);
      return (sink) => {
        passthrough(nativeFetch, ctx.url, range, sink);
      };
    }
  };
}

async function passthrough(nativeFetch: typeof fetch, url: string, range: ByteRange, sink: SyntheticXhrSink) {
  let committed = false;
  try {
    const response = await nativeFetch(url, {
      headers: { Range: `bytes=${range.start}-${range.end}` },
      mode: 'cors',
      credentials: 'same-origin',
      // Like the page's XHR: no `no-cache` request headers
      cache: 'default',
      referrerPolicy: 'strict-origin-when-cross-origin',
      signal: sink.signal
    });
    if (response.status !== 206 || !response.body) {
      void response.body?.cancel();
      if (!sink.fallbackToNative()) {
        sink.error();
      }
      return;
    }

    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    sink.headersReceived(response.status, headers, response.statusText);
    committed = true;

    const total = byteRangeLength(range);
    const buffer = new unsafeWindow.ArrayBuffer(total);
    const bytes = new unsafeWindow.Uint8Array(buffer);
    const reader = response.body.getReader();
    let offset = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- read the stream in order
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (offset + value.byteLength > total) {
        throw new RangeError('Response body is longer than the requested range');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
      sink.progress(offset, total);
    }
    if (offset !== total) {
      throw new RangeError(`Response body is shorter than the requested range: ${offset}/${total}`);
    }
    sink.done(buffer);
  } catch (e) {
    if (sink.signal.aborted) {
      return;
    }
    logger.error('[debug-passthrough] failed', e, { url, range });
    if (committed || !sink.fallbackToNative()) {
      sink.error();
    }
  }
}
