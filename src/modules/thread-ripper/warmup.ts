import type { MediaFile } from '../../core/player/registry';

/**
 * The representations whose initialization segment and index are fetched as soon as the playinfo
 * arrives: every one this browser can play. Which the player takes is not guessed: the one it asks
 * for is raced then. Besides having them at hand, it opens connections to many hosts, tells how
 * fast each answers from here, and which signature families they accept.
 */
export function warmupFiles(files: readonly MediaFile[]): MediaFile[] {
  return files.filter(file => file.segmentBase !== null && isPlayable(file));
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
