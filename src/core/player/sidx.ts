/**
 * The segment index of a DASH file: which byte range holds which seconds of the media.
 *
 * Bilibili serves every quality as one `.m4s` file (DASH `SegmentBase`). Near its start, at the
 * playinfo's `indexRange`, a `sidx` box lists every media segment (~5 s each) with its size and
 * duration. The player reads it, then asks for segments as plain byte ranges: the XHRs we see
 * carry `Range: bytes=a-b` and no time at all. With the index, a range maps back to when playback
 * needs it, so thread-ripper can give each job a deadline in ms (`refreshUrgency` in the engine),
 * which drives its urgency class, queue order, hedging and piece count.
 *
 * Nothing is fetched for it: the index is parsed from bytes that come anyway, the player's own
 * index request (`watchForSidx`) or thread-ripper's warm-up (`ingestSidx`).
 */

import flru from 'flru';

/** One media segment the index lists */
export interface SidxSegment {
  /** Absolute byte offsets in the file, inclusive */
  readonly start: number,
  readonly end: number,
  /** Seconds */
  readonly startTime: number,
  readonly endTime: number
}

export interface SidxIndex {
  /** Units per second of the box's own times (already converted to seconds in `segments`) */
  readonly timescale: number,
  /** In file order: contiguous bytes, contiguous times */
  readonly segments: readonly SidxSegment[]
}

/**
 * Parse the `sidx` box of a DASH `SegmentBase` index range (ISO BMFF: version 0 or 1, 32 or
 * 64-bit box sizes). References to nested `sidx` boxes are skipped, only media ones become
 * segments.
 *
 * @param absoluteStart where `bytes` starts in the file
 * @returns `null` when there is no `sidx` box or it is malformed
 */
export function parseSidx(bytes: Uint8Array, absoluteStart: number): SidxIndex | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxOffset = 0;

  while (boxOffset + 8 <= bytes.byteLength) {
    let boxSize = view.getUint32(boxOffset);
    const type = String.fromCharCode(bytes[boxOffset + 4], bytes[boxOffset + 5], bytes[boxOffset + 6], bytes[boxOffset + 7]);
    let headerSize = 8;
    if (boxSize === 1) {
      if (boxOffset + 16 > bytes.byteLength) return null;
      const large = readUint64(view, boxOffset + 8);
      if (large === null) return null;
      boxSize = large;
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = bytes.byteLength - boxOffset;
    }
    if (boxSize < headerSize || boxOffset + boxSize > bytes.byteLength) {
      return null;
    }

    if (type === 'sidx') {
      const boxEnd = boxOffset + boxSize;
      let cursor = boxOffset + headerSize;
      if (cursor + 12 > boxEnd) return null;
      const version = view.getUint8(cursor);
      // version + flags, reference_ID
      cursor += 8;
      const timescale = view.getUint32(cursor);
      cursor += 4;
      if (timescale === 0) return null;

      let earliestPresentationTime: number | null;
      let firstOffset: number | null;
      if (version === 0) {
        if (cursor + 8 > boxEnd) return null;
        earliestPresentationTime = view.getUint32(cursor);
        firstOffset = view.getUint32(cursor + 4);
        cursor += 8;
      } else {
        if (cursor + 16 > boxEnd) return null;
        earliestPresentationTime = readUint64(view, cursor);
        firstOffset = readUint64(view, cursor + 8);
        cursor += 16;
      }
      if (earliestPresentationTime === null || firstOffset === null) return null;

      // reserved
      cursor += 2;
      if (cursor + 2 > boxEnd) return null;
      const referenceCount = view.getUint16(cursor);
      cursor += 2;
      if (referenceCount === 0 || cursor + referenceCount * 12 > boxEnd) return null;

      // The first segment starts `first_offset` bytes after the end of this box
      let byteCursor = absoluteStart + boxEnd + firstOffset;
      let timeCursor = earliestPresentationTime;
      const segments: SidxSegment[] = [];
      for (let i = 0; i < referenceCount; i++) {
        const reference = view.getUint32(cursor);
        const referencedSize = reference & 0x7F_FF_FF_FF;
        const duration = view.getUint32(cursor + 4);
        cursor += 12;
        if (referencedSize === 0) return null;
        // reference_type 0: media, 1: another sidx
        if (reference >>> 31 === 0) {
          segments.push({
            start: byteCursor,
            end: byteCursor + referencedSize - 1,
            startTime: timeCursor / timescale,
            endTime: (timeCursor + duration) / timescale
          });
        }
        byteCursor += referencedSize;
        timeCursor += duration;
      }
      return segments.length > 0 ? { timescale, segments } : null;
    }
    boxOffset += boxSize;
  }
  return null;
}

/**
 * The media segment holding `offset`, `null` if outside the index. Binary search: a request's
 * start byte tells at what playback time the bytes it asks for begin.
 */
export function findSidxSegment(index: SidxIndex, offset: number): SidxSegment | null {
  const { segments } = index;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (offset < segment.start) {
      high = middle - 1;
    } else if (offset > segment.end) {
      low = middle + 1;
    } else {
      return segment;
    }
  }
  return null;
}

export type SidxStore = ReturnType<typeof createSidxStore>;

/** The indexes parsed so far, shared by every phase through the player interceptor (`player.sidx`) */
export function createSidxStore() {
  /** file key -> index */
  const indexes = flru<SidxIndex>(64);
  return {
    get(fileKey: string) {
      return indexes.get(fileKey) ?? null;
    },
    has(fileKey: string) {
      return indexes.has(fileKey);
    },
    set(fileKey: string, index: SidxIndex) {
      indexes.set(fileKey, index);
    }
  };
}

/** A big-endian uint64, `null` if it does not fit a JS number exactly */
function readUint64(view: DataView, offset: number) {
  const value = view.getUint32(offset) * (2 ** 32) + view.getUint32(offset + 4);
  return Number.isSafeInteger(value) ? value : null;
}
