import { isAbortErrorLike } from 'foxts/abort-error';
import { MediaOutcome } from '../../core/player/host-model';
import type { ContentRange } from '../../core/player/range';

export type AbortReason = MediaOutcome.Canceled | MediaOutcome.TtfbTimeout | MediaOutcome.Stall;

export interface ResponseVerdict {
  outcome: MediaOutcome,
  /** The file's total size, when the response is valid */
  total: number | null
}

export function classifyResponse(
  response: Pick<Response, 'type' | 'status'>,
  contentRange: ContentRange | null,
  contentLength: number | null,
  expected: { start: number, end: number, total: number | null, addressExpired: boolean }
): ResponseVerdict {
  const invalid = (outcome: MediaOutcome): ResponseVerdict => ({ outcome, total: null });

  if (response.type === 'opaqueredirect') {
    return invalid(MediaOutcome.Redirect);
  }

  const { status } = response;
  if (status === 206) {
    if (contentRange === null) {
      // Only good enough if we know the file and the length fits
      return expected.total !== null && contentLength === expected.end - expected.start + 1
        ? { outcome: MediaOutcome.Ok, total: expected.total }
        : invalid(MediaOutcome.Unverifiable);
    }
    if (contentRange.start !== expected.start) {
      return invalid(MediaOutcome.BadRange);
    }
    if (contentRange.end !== expected.end) {
      return invalid(
        contentRange.end < expected.end && contentRange.total !== null && contentRange.end === contentRange.total - 1
          ? MediaOutcome.EofClamp
          : MediaOutcome.BadRange
      );
    }
    if (expected.total !== null && contentRange.total !== null && contentRange.total !== expected.total) {
      return invalid(MediaOutcome.StaleObject);
    }
    return { outcome: MediaOutcome.Ok, total: contentRange.total ?? expected.total };
  }

  if (status === 200) return invalid(MediaOutcome.NoRange);
  if (status === 401 || status === 403) return invalid(expected.addressExpired ? MediaOutcome.Expired : MediaOutcome.Refused);
  if (status === 404 || status === 410) return invalid(MediaOutcome.Missing);
  if (status === 416) return invalid(MediaOutcome.EofClamp);
  if (status === 412 || status === 429) return invalid(MediaOutcome.Throttled);
  if (status === 503) return invalid(MediaOutcome.Overloaded);
  return invalid(MediaOutcome.ServerError);
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
