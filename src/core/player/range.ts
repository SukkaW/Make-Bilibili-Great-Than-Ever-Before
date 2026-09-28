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
  const match = rangeHeaderRegex.exec(value.trim());
  return match ? toByteRange(match[1], match[2]) : null;
}

const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;

export function parseContentRange(value: string | null): ContentRange | null {
  if (value === null) {
    return null;
  }
  const match = contentRangeRegex.exec(value.trim());
  if (!match) {
    return null;
  }
  const range = toByteRange(match[1], match[2]);
  if (!range) {
    return null;
  }
  if (match[3] === '*') {
    return { ...range, total: null };
  }
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total <= range.end) {
    return null;
  }
  return { ...range, total };
}

const byteRangeSpecRegex = /^(\d+)-(\d+)$/;

/** Byte ranges in Bilibili's DASH `SegmentBase`, e.g. `'0-1011'` */
export function parseByteRangeSpec(value: unknown): ByteRange | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = byteRangeSpecRegex.exec(value.trim());
  return match ? toByteRange(match[1], match[2]) : null;
}

function toByteRange(startStr: string, endStr: string): ByteRange | null {
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return null;
  }
  return { start, end };
}
