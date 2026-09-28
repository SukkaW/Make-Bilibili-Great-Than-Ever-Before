import { noop } from 'foxts/noop';
import type { ByteRange } from '../../core/player/range';

/** A file's initialization segment and index, fetched ahead of the player */
export interface CachedHeader {
  /** The registry's file key */
  readonly fileKey: string,
  readonly range: ByteRange,
  bytes: Uint8Array | null,
  total: number | null,
  contentType: string,
  /** Settles when the fetch is over: `true` with bytes, `false` without */
  readonly ready: Promise<boolean>
}

interface Entry {
  readonly header: CachedHeader,
  settle(this: void, ok: boolean): void
}

const MAX_ENTRIES = 64;

export type HeaderCache = ReturnType<typeof createHeaderCache>;

/** The init segment and index of every representation, per page. Served as copies */
export function createHeaderCache() {
  /** insertion ordered: the oldest goes first */
  const entries = new Map<string, Entry>();

  return {
    has(fileKey: string) {
      return entries.has(fileKey);
    },

    /** An entry being fetched: requests covered by it wait for it */
    begin(fileKey: string, range: ByteRange): CachedHeader {
      let settle: (ok: boolean) => void = noop;
      const ready = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const header: CachedHeader = { fileKey, range, bytes: null, total: null, contentType: '', ready };
      entries.set(fileKey, { header, settle });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
      return header;
    },

    fulfil(fileKey: string, bytes: Uint8Array, total: number | null, contentType: string) {
      const entry = entries.get(fileKey);
      if (entry?.header.bytes === null) {
        entry.header.bytes = bytes;
        entry.header.total = total;
        entry.header.contentType = contentType;
        entry.settle(true);
      }
    },

    fail(fileKey: string) {
      const entry = entries.get(fileKey);
      if (entry?.header.bytes === null) {
        // Nothing to serve from: the next request fetches it the normal way
        entries.delete(fileKey);
        entry.settle(false);
      }
    },

    /** The entry holding all of `range`, fetched or on its way */
    get(fileKey: string, range: ByteRange): CachedHeader | null {
      const header = entries.get(fileKey)?.header;
      if (header === undefined || range.start < header.range.start || range.end > header.range.end) {
        return null;
      }
      return header;
    }
  };
}
