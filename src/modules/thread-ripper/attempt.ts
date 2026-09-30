import { noop } from 'foxts/noop';
import { parseContentRange } from '../../core/player/range';
import { MediaOutcome } from '../../core/player/host-model';
import { classifyError, classifyResponse, hostnameOf } from './classify';
import { CRITICAL, URGENT } from './policy';
import type { Attempt } from './types';

export interface AttemptHooks {
  nativeFetch: typeof fetch,
  /** The response passed validation: the file's total size is known */
  onValidResponse(this: void, att: Attempt, response: Response, total: number | null): void,
  onChunk(this: void, att: Attempt, chunk: Uint8Array): 'ok' | 'overrun' | 'mismatch'
}

/** One ranged request to one host. Resolves with what its end says about the host */
export async function runAttempt(att: Attempt, hooks: AttemptHooks): Promise<MediaOutcome> {
  const { job } = att;

  let response: Response;
  try {
    response = await hooks.nativeFetch(att.url, {
      method: 'GET',
      // The only author header: Range is CORS-safelisted, no preflight
      headers: { Range: `bytes=${att.rangeStart}-${att.rangeEnd}` },
      mode: 'cors',
      // What the page's XHR uses (withCredentials = false), so connections are shared with it
      credentials: 'same-origin',
      // Like the page's XHR. `no-store` would add `Cache-Control: no-cache` and `Pragma: no-cache`,
      // which upos hosts ignore but Akamai may honour by going upstream
      cache: 'default',
      // Like the page's XHR. A redirect is not necessarily a P2P CDN: Akamai may send to an edge,
      // an extension may clean the URL (AdGuard's 307). One landing on a P2P CDN is refused
      // (`classifyResponse`)
      redirect: 'follow',
      referrerPolicy: 'strict-origin-when-cross-origin',
      priority: job.cls === CRITICAL || job.cls === URGENT ? 'high' : 'auto',
      signal: att.controller.signal
    });
  } catch (e) {
    return classifyError(e, att.abortReason, att.bytes, false, performance.now() - att.startedAt);
  }

  att.headersAt = performance.now();
  if (response.redirected) {
    att.redirectedTo = hostnameOf(response.url);
  }

  const contentLength = Number(response.headers.get('content-length'));
  const verdict = classifyResponse(
    response,
    parseContentRange(response.headers.get('content-range')),
    Number.isSafeInteger(contentLength) && response.headers.has('content-length') ? contentLength : null,
    { start: att.rangeStart, end: att.rangeEnd, total: job.total, addressExpired: isExpired(att.candidate.deadline) }
  );
  if (verdict.outcome !== MediaOutcome.Ok) {
    response.body?.cancel().catch(noop);
    return verdict.outcome;
  }
  if (!response.body) {
    return MediaOutcome.Truncated;
  }

  hooks.onValidResponse(att, response, verdict.total);

  const reader = response.body.getReader();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- stream reading
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const now = performance.now();
      if (att.firstByteAt === 0) {
        att.firstByteAt = now;
        att.firstChunkBytes = value.byteLength;
      } else if (att.gaps.length < 256) {
        att.gaps.push(now - att.lastByteAt);
      }
      att.lastByteAt = now;
      att.bytes += value.byteLength;
      att.meter.push([now, att.bytes]);
      if (att.meter.length > 32) {
        att.meter.splice(0, att.meter.length - 32);
      }

      const written = hooks.onChunk(att, value);
      if (written === 'mismatch') {
        reader.cancel().catch(noop);
        return MediaOutcome.Integrity;
      }
      // The segment's end moves in when its tail is handed to another attempt
      if (written === 'overrun') {
        // The rest of this range is taken care of (or the job is over)
        att.abortReason ??= MediaOutcome.Canceled;
        reader.cancel().catch(noop);
        return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Canceled;
      }
      if (att.pos > att.seg.end) {
        // All asked for is here: don't wait for the stream to close
        reader.cancel().catch(noop);
        return MediaOutcome.Ok;
      }
    }
  } catch (e) {
    return classifyError(e, att.abortReason, att.bytes, true, performance.now() - att.startedAt);
  } finally {
    reader.releaseLock();
  }

  return att.pos > att.seg.end ? MediaOutcome.Ok : MediaOutcome.Truncated;
}

function isExpired(deadline: number) {
  return deadline !== 0 && deadline * 1000 <= Date.now();
}
