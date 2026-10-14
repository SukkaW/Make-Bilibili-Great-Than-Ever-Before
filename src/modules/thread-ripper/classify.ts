import { isAbortErrorLike } from 'foxts/abort-error';
import { isP2PCDNDomain } from '../../core/player/cdn-classify';
import { MediaOutcome } from '../../core/player/host-model';
import type { ContentRange } from '../../core/player/range';

export type AbortReason = MediaOutcome.Canceled | MediaOutcome.Stall;

/** `Ok` only for a 206 whose `Content-Range` is the range asked for, of the file size known so far */
export function classifyResponse(
  response: Pick<Response, 'status' | 'redirected' | 'url'>,
  contentRange: ContentRange | null,
  expected: { start: number, end: number, total: number | null }
): MediaOutcome {
  if (response.redirected && isP2PCDNDomain(hostnameOf(response.url))) {
    return MediaOutcome.Redirect;
  }

  const { status } = response;
  if (status === 206) {
    // Without it, which bytes came back is unknown: every tested host exposes it
    if (contentRange === null) {
      return MediaOutcome.Unverifiable;
    }
    if (contentRange.start !== expected.start) {
      return MediaOutcome.BadRange;
    }
    if (contentRange.end !== expected.end) {
      return contentRange.end < expected.end && contentRange.total !== null && contentRange.end === contentRange.total - 1
        ? MediaOutcome.EofClamp
        : MediaOutcome.BadRange;
    }
    if (expected.total !== null && contentRange.total !== null && contentRange.total !== expected.total) {
      return MediaOutcome.StaleObject;
    }
    return MediaOutcome.Ok;
  }

  if (status === 200) return MediaOutcome.NoRange;
  if (status === 401 || status === 403) return MediaOutcome.Refused;
  if (status === 404 || status === 410) return MediaOutcome.Missing;
  if (status === 416) return MediaOutcome.EofClamp;
  if (status === 412 || status === 429 || status === 503) return MediaOutcome.Throttled;
  return MediaOutcome.ServerError;
}

/** A failed fetch() or body read */
export function classifyError(error: unknown, abortReason: AbortReason | null, receivedBytes: number, headersReceived: boolean, elapsedMs: number): MediaOutcome {
  if (abortReason !== null) {
    return abortReason;
  }
  if (isAbortErrorLike(error)) {
    return MediaOutcome.Canceled;
  }
  if (headersReceived) {
    return receivedBytes > 0 ? MediaOutcome.Reset : MediaOutcome.Truncated;
  }
  return elapsedMs < 150 ? MediaOutcome.ConnectFail : MediaOutcome.Network;
}

/** Outcomes after which the same bytes are worth asking for again elsewhere */
export function isRetryable(outcome: MediaOutcome): boolean {
  return outcome !== MediaOutcome.Ok && outcome !== MediaOutcome.Canceled && outcome !== MediaOutcome.Integrity && outcome !== MediaOutcome.EofClamp;
}

/** `''` for an invalid URL */
export function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
