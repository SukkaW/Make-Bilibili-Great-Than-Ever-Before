/**
 * What the player is doing right now: how soon it needs which bytes.
 *
 * A media XHR says nothing about when its bytes are needed. Read from the player's `<video>`,
 * the playhead turns a segment's start time (from the segment index, `sidx.ts`) into a deadline in
 * ms, and seeking / a spinner / pause into an urgency: thread-ripper's `refreshUrgency` gives each
 * job both, which drive its queue order (earliest deadline first), hedging, timeouts and duplicate
 * budget. A segment needed for a seek then goes before one the player won't play for 20 s.
 *
 * Only reads the element (properties and `waiting` / `playing` events), never touches it.
 */

/** What the player is doing right now, read from its `<video>` */
export interface PlaybackState {
  /** The player's `<video>` was found: every other field is a default otherwise */
  readonly found: boolean,
  /** Seconds, the playhead */
  readonly currentTime: number,
  /** Media seconds per wall-clock second, at least 0.25 */
  readonly playbackRate: number,
  readonly paused: boolean,
  readonly seeking: boolean,
  /** `waiting` fired more recently than `playing`: the viewer is looking at a spinner */
  readonly starving: boolean,
  /** `HTMLMediaElement.readyState`: below 3 (`HAVE_FUTURE_DATA`), playback can't go on */
  readonly readyState: number,
  /** Seconds buffered ahead of the playhead */
  readonly bufferedAhead: number
}

/** No player `<video>` (yet): the engine then gives jobs a fixed short deadline */
const NOT_FOUND: PlaybackState = {
  found: false,
  currentTime: 0,
  playbackRate: 1,
  paused: false,
  seeking: false,
  starving: false,
  readyState: 0,
  bufferedAhead: 0
};

const PLAYER_VIDEO_SELECTOR = '#bilibili-player video, #bilibili-player bwp-video, .bpx-player-container video, .bpx-player-container bwp-video';

export type PlaybackClock = ReturnType<typeof createPlaybackClock>;

export function createPlaybackClock() {
  /** `performance.now()` of the last `waiting` / `playing` event of any watched element */
  let lastWaitingAt = 0;
  let lastPlayingAt = 0;
  /** Elements whose `waiting` / `playing` are listened to already */
  const watched = new WeakSet<HTMLMediaElement>();

  function watch(element: HTMLMediaElement) {
    if (watched.has(element)) {
      return;
    }
    watched.add(element);
    element.addEventListener('waiting', () => {
      lastWaitingAt = performance.now();
    });
    element.addEventListener('playing', () => {
      lastPlayingAt = performance.now();
    });
  }

  /**
   * The player's element with media loaded, else the first one there is. Looked up on every read,
   * as the player may replace it (an episode switch, `<video>` -> `<bwp-video>`)
   */
  function findVideo(): HTMLMediaElement | null {
    const elements = document.querySelectorAll(PLAYER_VIDEO_SELECTOR);
    let first: HTMLMediaElement | null = null;
    for (let i = 0, len = elements.length; i < len; i++) {
      const element = elements[i];
      if (isVideoLike(element)) {
        watch(element);
        if (element.readyState > 0) {
          return element;
        }
        first ??= element;
      }
    }
    return first;
  }

  return {
    /** Read on demand (every engine tick while jobs run), never cached */
    state(): PlaybackState {
      const element = findVideo();
      if (element === null) {
        return NOT_FOUND;
      }
      const currentTime = element.currentTime;
      let bufferedAhead = 0;
      try {
        const { buffered } = element;
        for (let i = 0, len = buffered.length; i < len; i++) {
          if (buffered.start(i) <= currentTime + 0.25 && buffered.end(i) > currentTime) {
            bufferedAhead = buffered.end(i) - currentTime;
            break;
          }
        }
      } catch {
        // detached SourceBuffers
      }
      return {
        found: true,
        currentTime,
        playbackRate: Math.max(0.25, Math.abs(element.playbackRate) || 1),
        paused: element.paused,
        seeking: element.seeking,
        starving: lastWaitingAt > lastPlayingAt,
        readyState: element.readyState,
        bufferedAhead
      };
    }
  };
}

function isVideoLike(element: Element | null): element is HTMLMediaElement {
  return element !== null && 'currentTime' in element && 'buffered' in element;
}
