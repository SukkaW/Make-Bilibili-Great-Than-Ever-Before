import type { MediaFile } from '../../core/player/registry';
import { isObject } from '../../utils/is-object';

export interface WarmupItem {
  readonly file: MediaFile,
  /** What the player will most likely ask for first */
  readonly current: boolean
}

/**
 * Every representation's initialization segment and index, right when the playinfo arrives.
 * Besides having them at hand when the player asks, it opens a connection to many hosts, tells
 * how fast each answers from here, and which signature families they accept.
 */
export function planWarmup(json: object, files: readonly MediaFile[]): WarmupItem[] {
  const quality = qualityOf(json);
  const items: WarmupItem[] = [];
  let bestAudio: MediaFile | null = null;

  for (let i = 0, len = files.length; i < len; i++) {
    const file = files[i];
    if (file.segmentBase === null || !isPlayable(file)) {
      continue;
    }
    if (file.kind === 'audio' && file.codecs.startsWith('mp4a') && (bestAudio === null || file.bandwidth > bestAudio.bandwidth)) {
      bestAudio = file;
    }
    items.push({ file, current: file.kind === 'video' && file.id === quality });
  }

  return items.map(item => (item.file === bestAudio ? { ...item, current: true } : item));
}

/** The quality the playinfo was issued for: the player starts with it */
function qualityOf(json: object): number {
  const root = json as Record<string, unknown>;
  let body: unknown = null;
  if (isObject(root.data)) {
    body = root.data;
  } else if (isObject(root.result)) {
    body = isObject(root.result.video_info) ? root.result.video_info : root.result;
  }
  return isObject(body) ? Number(body.quality) || 0 : 0;
}

/** Skip what this browser won't play: `disable-av1` makes AV1 one of them */
function isPlayable(file: MediaFile) {
  if (!('MediaSource' in unsafeWindow) || !file.mimeType) {
    return true;
  }
  try {
    return unsafeWindow.MediaSource.isTypeSupported(file.codecs ? `${file.mimeType}; codecs="${file.codecs}"` : file.mimeType);
  } catch {
    return true;
  }
}
