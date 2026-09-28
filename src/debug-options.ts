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

/** Shown in the GM menu after the modules, in this order */
export const debugOptions: readonly DebugOption[] = [mediaXhrMode];
