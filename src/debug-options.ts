import type { DebugOption } from './utils/debug-menu';

/**
 * How media segment XHRs are answered:
 * - `default`: by thread-ripper when it is enabled, by the browser otherwise
 * - `shadow`: by the browser, while thread-ripper (needs to be enabled) downloads the same range
 *   in parallel and logs whether the bytes are identical and how long each took
 * - `passthrough`: through the synthetic XHR path, with a plain native fetch of the same range, to
 *   prove the XHR emulation
 */
export const mediaXhrMode: DebugOption<'default' | 'shadow' | 'passthrough'> = {
  name: 'media-xhr-mode',
  description: 'media XHR',
  values: ['default', 'shadow', 'passthrough']
};

/**
 * For comparing playback metrics: `random` gives each video thread-ripper (when enabled) or not on
 * a coin flip, so which videos get it is chance, not the viewer's choice or order. A badge in the
 * page's corner and the metrics tell which it got
 */
export const threadRipperAb: DebugOption<'off' | 'random'> = {
  name: 'thread-ripper-ab',
  description: 'thread-ripper A/B per video',
  values: ['off', 'random']
};

/** Shown in the GM menu after the modules, in this order */
export const debugOptions: readonly DebugOption[] = [mediaXhrMode, threadRipperAb];
