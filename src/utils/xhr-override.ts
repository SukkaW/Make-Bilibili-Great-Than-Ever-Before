import { noop } from 'foxts/noop';
import { logger } from '../logger';
import type { OnXhrOpenHook, OnXhrSendHook, XhrResponder, XhrSendContext, XHROpenArgs } from '../types';
import { disguiseAsNative } from './fake-native-function';

/** Filled by the bootstrap's `hook.onXhr*` */
export const xhrHooks = {
  open: new Set<OnXhrOpenHook>(),
  afterOpen: new Set<(xhr: XMLHttpRequest) => void>(),
  response: new Set<(method: string, url: string | URL, response: unknown, xhr: XMLHttpRequest) => unknown>(),
  send: new Set<OnXhrSendHook>()
};

const enum ReadyState {
  UNSENT = 0,
  OPENED = 1,
  HEADERS_RECEIVED = 2,
  LOADING = 3,
  DONE = 4
}

/* eslint-disable @typescript-eslint/unbound-method -- only called with Reflect.apply */
const NativeXMLHttpRequest = unsafeWindow.XMLHttpRequest;
const nativeSend = NativeXMLHttpRequest.prototype.send;
/**
 * Captured before any page script runs: the page may wrap these later (monitoring SDKs do), and our
 * own events and listeners should neither go through its wrappers nor show up in them
 */
const {
  dispatchEvent: nativeDispatchEvent,
  addEventListener: nativeAddEventListener,
  removeEventListener: nativeRemoveEventListener
} = unsafeWindow.EventTarget.prototype;
/* eslint-enable @typescript-eslint/unbound-method */

interface XhrState {
  method: string,
  originalUrl: string | URL,
  url: string,
  async: boolean,
  hasUrlCredentials: boolean,
  headers: Array<readonly [name: string, value: string]>,
  /** Native send() was called, the browser owns this request */
  nativeSent: boolean,
  /** The request we answer instead of the browser, if any */
  fake: SyntheticXhrSink | null,
  /** What the onXhrResponse hooks made of the response, cached */
  response: unknown,
  /** Length of the (text) response the cache was made from: a longer one invalidates it */
  lastResponseLength: number | null
}

const states = new WeakMap<XMLHttpRequest, XhrState>();
/** An `onXhrOpen` hook returned `null`: send() and setRequestHeader() do nothing until the next open() */
const blocked = new WeakSet<XMLHttpRequest>();

/**
 * A request answered by its responder instead of the browser, following the XHR spec: the
 * responder drives it (it is the responder's sink), and the XHR's getters read from it.
 *
 * Every event dispatch runs the page's handlers synchronously, and a handler may abort or re-open
 * the XHR: once `ended`, nothing more is fired for this request.
 */
export class SyntheticXhrSink {
  readyState = ReadyState.OPENED;
  status = 0;
  statusText = '';
  /** Lower-cased names: each one once, as `Headers` iteration gives them */
  headers = new Map<string, string>();
  body: ArrayBuffer | null = null;
  /** No more events: finished, failed, aborted, handed back or re-opened */
  ended = false;
  /** Headers received: from here on the request can no longer fall back to native */
  private committed = false;
  private lastProgressAt = -Infinity;
  private readonly sentAt = performance.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controller = new AbortController();
  /** Aborted when the page calls `abort()`, re-opens the XHR, or its `timeout` elapses */
  readonly signal = this.controller.signal;

  constructor(
    private readonly xhr: XMLHttpRequest,
    private readonly state: XhrState,
    private readonly requestBody: XhrSendContext['body']
  ) {}

  /** The spec's send() flag: set while the request is in flight */
  get inFlight() {
    return !this.ended && this.readyState !== ReadyState.DONE;
  }

  start(responder: XhrResponder) {
    if (!this.emitProgress('loadstart', false, 0, 0)) return;
    const { timeout } = this.xhr;
    if (timeout > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.inFlight) this.fail('timeout', 'XMLHttpRequest timed out', 'TimeoutError');
      }, timeout);
    }
    // Apart from `loadstart`, XHR events never fire synchronously inside send()
    Promise.resolve()
      .then(() => {
        if (this.ended) return;
        try {
          responder(this);
        } catch (e) {
          logger.error('XMLHttpRequest responder failed', e, { url: this.state.url });
          if (!this.fallbackToNative()) this.error();
        }
      })
      .finally(noop);
  }

  headersReceived(status: number, headers: ReadonlyArray<readonly [name: string, value: string]>, statusText = '') {
    if (!this.inFlight || this.committed) return;
    this.committed = true;
    this.status = status;
    this.statusText = statusText;
    this.headers = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
    this.readyState = ReadyState.HEADERS_RECEIVED;
    this.emit('readystatechange');
  }

  progress(loaded: number, total: number) {
    if (!this.inFlight || !this.committed) return;
    const now = performance.now();
    // Browsers dispatch progress roughly every 50ms
    if (now - this.lastProgressAt < 50) return;
    this.lastProgressAt = now;
    this.readyState = ReadyState.LOADING;
    if (this.emit('readystatechange')) this.emitProgress('progress', true, loaded, total);
  }

  done(body: ArrayBuffer) {
    if (!this.inFlight || !this.committed) return;
    this.clearTimer();
    // A non-empty response always passes through LOADING
    if (this.readyState === ReadyState.HEADERS_RECEIVED) {
      this.readyState = ReadyState.LOADING;
      if (!this.emit('readystatechange')) return;
    }
    // Like Chrome: the final progress event already sees DONE
    const length = body.byteLength;
    this.body = body;
    this.readyState = ReadyState.DONE;
    if (
      this.emitProgress('progress', true, length, length)
      && this.emit('readystatechange')
      && this.emitProgress('load', true, length, length)
    ) {
      this.emitProgress('loadend', true, length, length);
    }
    this.ended = true;
  }

  error() {
    if (this.inFlight) this.fail('error', 'XMLHttpRequest failed', 'NetworkError');
  }

  fallbackToNative() {
    if (!this.inFlight || this.committed) return false;
    this.clearTimer();
    this.ended = true;
    this.state.fake = null;
    this.state.nativeSent = true;
    const { xhr } = this;
    // Keep the page's timeout budget: native send() restarts the clock
    if (xhr.timeout > 0) {
      xhr.timeout = Math.max(1, Math.round(xhr.timeout - (performance.now() - this.sentAt)));
    }
    // Native send() fires `loadstart` again, but the page has already seen it
    Reflect.apply(nativeAddEventListener, xhr, ['loadstart', stopImmediatePropagation, { capture: true, once: true }]);
    try {
      Reflect.apply(nativeSend, xhr, [this.requestBody]);
    } finally {
      Reflect.apply(nativeRemoveEventListener, xhr, ['loadstart', stopImmediatePropagation, { capture: true }]);
    }
    return true;
  }

  /** The page aborted it */
  abort() {
    if (this.inFlight) {
      this.fail('abort', 'The user aborted a request.', 'AbortError');
    }
    if (this.readyState === ReadyState.DONE) {
      this.readyState = ReadyState.UNSENT;
      this.status = 0;
      this.statusText = '';
      this.headers.clear();
      this.body = null;
    }
  }

  /** The XHR was re-opened: the request ends silently */
  terminate() {
    this.ended = true;
    this.clearTimer();
    this.controller.abort(new unsafeWindow.DOMException('XMLHttpRequest re-opened', 'AbortError'));
  }

  /** Abort the responder, then the spec's "request error steps" */
  private fail(type: 'error' | 'abort' | 'timeout', message: string, name: string) {
    this.controller.abort(new unsafeWindow.DOMException(message, name));
    this.clearTimer();
    this.readyState = ReadyState.DONE;
    this.status = 0;
    this.statusText = '';
    this.headers.clear();
    this.body = null;
    if (this.emit('readystatechange') && this.emitProgress(type, false, 0, 0)) {
      this.emitProgress('loadend', false, 0, 0);
    }
    this.ended = true;
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** @returns whether the request still goes on */
  private emit(type: string) {
    Reflect.apply(nativeDispatchEvent, this.xhr, [new unsafeWindow.Event(type)]);
    return !this.ended;
  }

  /** @returns whether the request still goes on */
  private emitProgress(type: string, lengthComputable: boolean, loaded: number, total: number) {
    Reflect.apply(nativeDispatchEvent, this.xhr, [new unsafeWindow.ProgressEvent(type, { lengthComputable, loaded, total })]);
    return !this.ended;
  }
}

export const PatchedXMLHttpRequest = class extends NativeXMLHttpRequest {
  open(...$args: XHROpenArgs) {
    blocked.delete(this);
    const previous = states.get(this)?.fake ?? null;

    let xhrArgs: XHROpenArgs | null = $args;
    for (const onXhrOpen of xhrHooks.open) {
      try {
        if (xhrArgs === null) {
          break;
        }
        xhrArgs = onXhrOpen(xhrArgs, this);
      } catch (e) {
        logger.error('Failed to replace P2P for XMLHttpRequest.prototype.open', e);
      }
    }

    if (xhrArgs === null) {
      logger.debug('XHR aborted', { $args });
      previous?.terminate();
      states.delete(this);
      blocked.add(this);
      return;
    }

    // Throws on a bad method or URL, leaving the request in flight alone
    super.open(...(xhrArgs as Parameters<XMLHttpRequest['open']>));
    previous?.terminate();

    const [, finalUrl, asyncArg, username, password] = xhrArgs as [string, string | URL, boolean?, (string | null)?, (string | null)?];
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(finalUrl, unsafeWindow.location.href).href;
    } catch {
      absoluteUrl = typeof finalUrl === 'string' ? finalUrl : finalUrl.href;
    }

    states.set(this, {
      method: $args[0],
      originalUrl: $args[1],
      url: absoluteUrl,
      // An omitted `async` argument means true
      async: xhrArgs.length < 3 || Boolean(asyncArg),
      hasUrlCredentials: username != null || password != null,
      headers: [],
      nativeSent: false,
      fake: null,
      response: null,
      lastResponseLength: null
    });

    // The page saw the answered request leave OPENED, so it has to see it return
    if (previous && previous.readyState !== ReadyState.OPENED) {
      Reflect.apply(nativeDispatchEvent, this, [new unsafeWindow.Event('readystatechange')]);
    }

    for (const onAfterXhrOpen of xhrHooks.afterOpen) {
      try {
        onAfterXhrOpen(this);
      } catch (e) {
        logger.error('Failed to call onAfterXhrOpen', e);
      }
    }
  }

  setRequestHeader(name: string, value: string) {
    if (blocked.has(this)) {
      return;
    }
    const state = states.get(this);
    if (state?.fake) {
      throw invalidState('Failed to execute \'setRequestHeader\' on \'XMLHttpRequest\': The object\'s state must be OPENED.');
    }
    super.setRequestHeader(name, value);
    state?.headers.push([name.toLowerCase(), value]);
  }

  send(body?: Document | XMLHttpRequestBodyInit | null) {
    if (blocked.has(this)) {
      return;
    }
    const state = states.get(this);
    if (!state) {
      return super.send(body);
    }
    if (state.fake) {
      throw invalidState('Failed to execute \'send\' on \'XMLHttpRequest\': The object\'s state must be OPENED.');
    }
    if (state.nativeSent || xhrHooks.send.size === 0) {
      state.nativeSent = true;
      return super.send(body);
    }

    const ctx: XhrSendContext = {
      xhr: this,
      method: state.method.toUpperCase(),
      url: state.url,
      originalUrl: state.originalUrl,
      async: state.async,
      hasUrlCredentials: state.hasUrlCredentials,
      headers: state.headers,
      body,
      responseType: this.responseType,
      withCredentials: this.withCredentials,
      timeout: this.timeout
    };

    let responder: XhrResponder | null = null;
    for (const onXhrSend of xhrHooks.send) {
      try {
        responder = onXhrSend(ctx);
      } catch (e) {
        logger.error('Failed to call onXhrSend', e);
        responder = null;
      }
      if (responder) {
        break;
      }
    }

    if (responder && (ctx.responseType !== 'arraybuffer' || !ctx.async)) {
      logger.error('Only async arraybuffer XMLHttpRequest can be answered by a responder', { url: ctx.url });
      responder = null;
    }

    if (!responder) {
      state.nativeSent = true;
      return super.send(body);
    }

    state.fake = new SyntheticXhrSink(this, state, body);
    state.fake.start(responder);
  }

  abort() {
    const fake = states.get(this)?.fake;
    if (fake) {
      fake.abort();
    } else {
      super.abort();
    }
  }

  get readyState(): number {
    return states.get(this)?.fake?.readyState ?? super.readyState;
  }

  get status(): number {
    return states.get(this)?.fake?.status ?? super.status;
  }

  get statusText(): string {
    return states.get(this)?.fake?.statusText ?? super.statusText;
  }

  get responseURL(): string {
    const state = states.get(this);
    if (!state?.fake) {
      return super.responseURL;
    }
    return state.fake.status === 0 ? '' : state.url;
  }

  get response() {
    const state = states.get(this);
    if (state?.fake) {
      return state.fake.readyState === ReadyState.DONE ? state.fake.body : null;
    }

    const originalResponse = super.response;
    if (!state) {
      return originalResponse;
    }

    const responseLength = typeof originalResponse === 'string'
      ? originalResponse.length
      : null;

    if (state.lastResponseLength !== responseLength) {
      state.response = null;
      state.lastResponseLength = responseLength;
    }
    if (state.response !== null) {
      return state.response;
    }

    let finalResponse = originalResponse;
    for (const onXhrResponse of xhrHooks.response) {
      try {
        finalResponse = onXhrResponse(state.method, state.originalUrl, finalResponse, this);
      } catch (e) {
        logger.error('Failed to call onXhrResponse', e);
      }
    }

    state.response = finalResponse;

    return finalResponse;
  }

  get responseText(): string {
    // An answered request is always an arraybuffer one: the native getter throws for it
    if (states.get(this)?.fake) {
      return super.responseText;
    }
    const response = this.response;
    return typeof response === 'string'
      ? response
      : super.responseText;
  }

  getResponseHeader(name: string) {
    const fake = states.get(this)?.fake;
    if (!fake) {
      return super.getResponseHeader(name);
    }
    return fake.status === 0 ? null : fake.headers.get(name.toLowerCase()) ?? null;
  }

  getAllResponseHeaders() {
    const fake = states.get(this)?.fake;
    if (!fake) {
      return super.getAllResponseHeaders();
    }
    if (fake.status === 0) {
      return '';
    }
    // Sorted by name, like the spec's "sort and combine" (names are unique already)
    return Array.from(fake.headers.keys()).sort().map(name => `${name}: ${fake.headers.get(name)}\r\n`).join('');
  }
};

// Class members are non-enumerable, native XHR members are enumerable: without this, for...in
// over an XHR skips every member we override
const patchedKeys = Object.getOwnPropertyNames(PatchedXMLHttpRequest.prototype);
for (let i = 0, len = patchedKeys.length; i < len; i++) {
  const key = patchedKeys[i];
  if (key === 'constructor') {
    continue;
  }
  Object.defineProperty(PatchedXMLHttpRequest.prototype, key, { enumerable: true });
  // Methods stringify like the native ones, for feature detection
  const value: unknown = Object.getOwnPropertyDescriptor(PatchedXMLHttpRequest.prototype, key)?.value;
  const native: unknown = Object.getOwnPropertyDescriptor(NativeXMLHttpRequest.prototype, key)?.value;
  if (typeof value === 'function' && typeof native === 'function') {
    disguiseAsNative(value, native);
  }
}
disguiseAsNative(PatchedXMLHttpRequest, NativeXMLHttpRequest);

function stopImmediatePropagation(e: Event) {
  e.stopImmediatePropagation();
}

function invalidState(message: string) {
  return new unsafeWindow.DOMException(message, 'InvalidStateError');
}
