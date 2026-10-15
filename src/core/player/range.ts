/** Inclusive byte range, as used by HTTP `Range` / `Content-Range` */
export interface ByteRange {
  start: number,
  end: number
}

export interface ContentRange extends ByteRange {
  /** `null` when the server answered `bytes a-b/*` */
  total: number | null
}

export function byteRangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

const rangeHeaderRegex = /^bytes=(\d+)-(\d+)$/i;

/** A single bounded `Range: bytes=a-b` request header; anything else returns `null` */
export function parseRangeHeader(value: string): ByteRange | null {
  return toByteRange(rangeHeaderRegex.exec(value.trim()));
}

const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;

export function parseContentRange(value: string | null): ContentRange | null {
  const match = value === null ? null : contentRangeRegex.exec(value.trim());
  const range = toByteRange(match);
  if (match === null || range === null) {
    return null;
  }
  if (match[3] === '*') {
    return { ...range, total: null };
  }
  const total = Number(match[3]);
  return Number.isSafeInteger(total) && total > range.end ? { ...range, total } : null;
}

const byteRangeSpecRegex = /^(\d+)-(\d+)$/;

/** Byte ranges in Bilibili's DASH `SegmentBase`, e.g. `'0-1011'` */
export function parseByteRangeSpec(value: unknown): ByteRange | null {
  return typeof value === 'string' ? toByteRange(byteRangeSpecRegex.exec(value.trim())) : null;
}

/** The first two groups of a match as a range: `null` unless both are safe integers, in order */
function toByteRange(match: RegExpExecArray | null): ByteRange | null {
  if (match === null) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : null;
}
