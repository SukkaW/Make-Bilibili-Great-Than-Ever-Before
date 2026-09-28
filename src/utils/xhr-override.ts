import { logger } from '../logger';
import type { OnXhrOpenHook, OnXhrSendHook, SyntheticXhrSink, XhrResponder, XhrSendContext, XHROpenArgs } from '../types';
import { disguiseAsNative } from './fake-native-function';

type XhrResponseHook = (method: string, url: string | URL, response: unknown, xhr: XMLHttpRequest) => unknown;

export interface XhrHooks {
  open: Set<OnXhrOpenHook>,
  afterOpen: Set<(xhr: XMLHttpRequest) => void>,
  response: Set<XhrResponseHook>,
  send: Set<OnXhrSendHook>
}

interface SyntheticState {
  readyState: ReadyState,
  /** The XHR spec's send() flag: set while a request is in flight */
  sendFlag: boolean,
  /** Headers received: from here on the request can no longer fall back to native */
  committed: boolean,
  /** The responder is running synchronously inside send() */
  inSend: boolean,
  status: number,
  statusText: string,
  headers: Array<readonly [name: string, value: string]>,
  body: ArrayBuffer | null,
  lastProgressAt: number,
  sentAt: number,
  timer: ReturnType<typeof setTimeout> | null,
  controller: AbortController
}

interface XhrState {
  method: string,
  originalUrl: string | URL,
  url: string,
  async: boolean,
  hasUrlCredentials: boolean,
  headers: Array<readonly [name: string, value: string]>,
  /** Native send() was called, the browser owns this request */
  nativeSent: boolean,
  synthetic: SyntheticState | null,
  /** What the onXhrResponse hooks made of the response, cached */
  response: unknown,
  /** Length of the (text) response the cache was made from: a longer one invalidates it */
  lastResponseLength: number | null
}

const enum ReadyState {
  UNSENT = 0,
  OPENED = 1,
  HEADERS_RECEIVED = 2,
  LOADING = 3,
  DONE = 4
}

/* eslint-disable @typescript-eslint/unbound-method -- only called with Reflect.apply */
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

export function createPatchedXhrClass(Base: typeof XMLHttpRequest, hooks: XhrHooks): typeof XMLHttpRequest {
  const states = new WeakMap<XMLHttpRequest, XhrState>();
  /** An `onXhrOpen` hook returned `null`: send() and setRequestHeader() do nothing until the next open() */
  const blocked = new WeakSet<XMLHttpRequest>();

  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with Reflect.apply
  const nativeSend = Base.prototype.send;

  function getSynthetic(xhr: XMLHttpRequest) {
    return states.get(xhr)?.synthetic ?? null;
  }

  function startSynthetic(xhr: XMLHttpRequest, state: XhrState, responder: XhrResponder, body: XhrSendContext['body']) {
    const s: SyntheticState = {
      readyState: ReadyState.OPENED,
      sendFlag: true,
      committed: false,
      inSend: true,
      status: 0,
      statusText: '',
      headers: [],
      body: null,
      lastProgressAt: -Infinity,
      sentAt: performance.now(),
      timer: null,
      controller: new AbortController()
    };
    state.synthetic = s;

    /** Event handlers may re-open or abort the XHR at any point: check after every dispatch */
    const isCurrent = () => states.get(xhr) === state && state.synthetic === s;

    fireProgress(xhr, 'loadstart', false, 0, 0);
    if (!isCurrent() || !s.sendFlag) return;

    const timeout = xhr.timeout;
    if (timeout > 0) {
      s.timer = setTimeout(() => {
        s.timer = null;
        if (!isCurrent() || !s.sendFlag) return;
        s.controller.abort(new unsafeWindow.DOMException('XMLHttpRequest timed out', 'TimeoutError'));
        requestError(xhr, s, isCurrent, 'timeout');
      }, timeout);
    }

    /** Apart from `loadstart`, XHR events never fire synchronously inside send() */
    const later = (fn: () => void) => {
      if (s.inSend) {
        setTimeout(fn, 0);
      } else {
        fn();
      }
    };

    const sink: SyntheticXhrSink = {
      signal: s.controller.signal,
      headersReceived(status, headers, statusText = '') {
        later(() => {
          if (!isCurrent() || !s.sendFlag || s.committed) return;
          s.committed = true;
          s.status = status;
          s.statusText = statusText;
          s.headers = headers.map(([name, value]) => [name.toLowerCase(), value] as const);
          s.readyState = ReadyState.HEADERS_RECEIVED;
          fire(xhr, 'readystatechange');
        });
      },
      progress(loaded, total) {
        later(() => {
          if (!isCurrent() || !s.sendFlag || !s.committed) return;
          const now = performance.now();
          // Browsers dispatch progress roughly every 50ms
          if (now - s.lastProgressAt < 50) return;
          s.lastProgressAt = now;

          s.readyState = ReadyState.LOADING;
          fire(xhr, 'readystatechange');
          if (!isCurrent()) return;
          fireProgress(xhr, 'progress', true, loaded, total);
        });
      },
      done(responseBody) {
        later(() => {
          if (!isCurrent() || !s.sendFlag || !s.committed) return;
          clearTimer(s);
          const length = responseBody.byteLength;

          // A non-empty response always passes through LOADING
          if (s.readyState === ReadyState.HEADERS_RECEIVED) {
            s.readyState = ReadyState.LOADING;
            fire(xhr, 'readystatechange');
            if (!isCurrent()) return;
          }

          // Like Chrome: the final progress event already sees DONE
          s.body = responseBody;
          s.readyState = ReadyState.DONE;
          s.sendFlag = false;
          fireProgress(xhr, 'progress', true, length, length);
          if (!isCurrent()) return;
          fire(xhr, 'readystatechange');
          if (!isCurrent()) return;
          fireProgress(xhr, 'load', true, length, length);
          if (!isCurrent()) return;
          fireProgress(xhr, 'loadend', true, length, length);
        });
      },
      error() {
        later(() => {
          if (!isCurrent() || !s.sendFlag) return;
          s.controller.abort(new unsafeWindow.DOMException('XMLHttpRequest failed', 'NetworkError'));
          requestError(xhr, s, isCurrent, 'error');
        });
      },
      fallbackToNative() {
        if (!isCurrent() || !s.sendFlag || s.committed) {
          return false;
        }
        clearTimer(s);
        state.synthetic = null;
        state.nativeSent = true;

        // Keep the page's timeout budget: native send() restarts the clock
        if (xhr.timeout > 0) {
          xhr.timeout = Math.max(1, Math.round(xhr.timeout - (performance.now() - s.sentAt)));
        }

        // Native send() fires `loadstart` again, but the page has already seen it
        Reflect.apply(nativeAddEventListener, xhr, ['loadstart', stopImmediatePropagation, { capture: true, once: true }]);
        try {
          Reflect.apply(nativeSend, xhr, [body]);
        } finally {
          Reflect.apply(nativeRemoveEventListener, xhr, ['loadstart', stopImmediatePropagation, { capture: true }]);
        }
        return true;
      }
    };

    try {
      responder(sink);
    } catch (e) {
      logger.error('XMLHttpRequest responder failed', e, { url: state.url });
      if (!sink.fallbackToNative()) {
        sink.error();
      }
    } finally {
      s.inSend = false;
    }
  }

  const PatchedXMLHttpRequest = class extends Base {
    open(...$args: XHROpenArgs) {
      blocked.delete(this);

      const previous = states.get(this);
      const previousSynthetic = previous?.synthetic ?? null;
      /** open() terminates the request in flight, silently, but only once it can no longer throw */
      const terminatePrevious = () => {
        if (previous && previousSynthetic) {
          previous.synthetic = null;
          clearTimer(previousSynthetic);
          previousSynthetic.sendFlag = false;
          previousSynthetic.controller.abort(new unsafeWindow.DOMException('XMLHttpRequest re-opened', 'AbortError'));
        }
      };

      let xhrArgs: XHROpenArgs | null = $args;

      for (const onXhrOpen of hooks.open) {
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
        terminatePrevious();
        states.delete(this);
        blocked.add(this);
        return;
      }

      // Throws on a bad method or URL, leaving the request in flight alone
      super.open(...(xhrArgs as Parameters<XMLHttpRequest['open']>));
      terminatePrevious();

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
        synthetic: null,
        response: null,
        lastResponseLength: null
      });

      // The page saw the synthetic request leave OPENED, so it has to see it return
      if (previousSynthetic && previousSynthetic.readyState !== ReadyState.OPENED) {
        fire(this, 'readystatechange');
      }

      for (const onAfterXhrOpen of hooks.afterOpen) {
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
      if (state?.synthetic) {
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
      if (state.synthetic) {
        throw invalidState('Failed to execute \'send\' on \'XMLHttpRequest\': The object\'s state must be OPENED.');
      }
      if (state.nativeSent || hooks.send.size === 0) {
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
      for (const onXhrSend of hooks.send) {
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

      startSynthetic(this, state, responder, body);
    }

    abort() {
      const state = states.get(this);
      const s = state?.synthetic;
      if (!state || !s) {
        return super.abort();
      }

      const isCurrent = () => states.get(this) === state && state.synthetic === s;
      s.controller.abort(new unsafeWindow.DOMException('The user aborted a request.', 'AbortError'));

      // The send() flag is set exactly in the "opened with send() flag set", "headers received"
      // and "loading" states
      if (s.sendFlag) {
        requestError(this, s, isCurrent, 'abort');
      }
      if (isCurrent() && s.readyState === ReadyState.DONE) {
        s.readyState = ReadyState.UNSENT;
        s.status = 0;
        s.statusText = '';
        s.headers = [];
        s.body = null;
      }
    }

    get readyState(): number {
      const s = getSynthetic(this);
      return s ? s.readyState : super.readyState;
    }

    get status(): number {
      const s = getSynthetic(this);
      return s ? s.status : super.status;
    }

    get statusText(): string {
      const s = getSynthetic(this);
      return s ? s.statusText : super.statusText;
    }

    get responseURL(): string {
      const state = states.get(this);
      const s = state?.synthetic;
      if (!state || !s) {
        return super.responseURL;
      }
      return s.status === 0 ? '' : state.url;
    }

    get response() {
      const state = states.get(this);
      if (state?.synthetic) {
        return state.synthetic.readyState === ReadyState.DONE ? state.synthetic.body : null;
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
      for (const onXhrResponse of hooks.response) {
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
      if (getSynthetic(this)) {
        throw invalidState('Failed to read the \'responseText\' property from \'XMLHttpRequest\': The value is only accessible if the object\'s \'responseType\' is \'\' or \'text\' (was \'arraybuffer\').');
      }
      const response = this.response;
      return typeof response === 'string'
        ? response
        : super.responseText;
    }

    get responseXML(): Document | null {
      if (getSynthetic(this)) {
        throw invalidState('Failed to read the \'responseXML\' property from \'XMLHttpRequest\': The value is only accessible if the object\'s \'responseType\' is \'\' or \'document\' (was \'arraybuffer\').');
      }
      return super.responseXML;
    }

    getResponseHeader(name: string) {
      const s = getSynthetic(this);
      if (!s) {
        return super.getResponseHeader(name);
      }
      if (s.status === 0) {
        return null;
      }
      const lowerName = name.toLowerCase();
      const values: string[] = [];
      for (let i = 0, len = s.headers.length; i < len; i++) {
        if (s.headers[i][0] === lowerName) {
          values.push(s.headers[i][1]);
        }
      }
      return values.length > 0 ? values.join(', ') : null;
    }

    getAllResponseHeaders() {
      const s = getSynthetic(this);
      if (!s) {
        return super.getAllResponseHeaders();
      }
      if (s.status === 0) {
        return '';
      }
      // The spec's "sort and combine"
      const combined = new Map<string, string>();
      for (let i = 0, len = s.headers.length; i < len; i++) {
        const [name, value] = s.headers[i];
        const existing = combined.get(name);
        combined.set(name, existing === undefined ? value : existing + ', ' + value);
      }
      const names = Array.from(combined.keys()).sort();
      let result = '';
      for (let i = 0, len = names.length; i < len; i++) {
        result += names[i] + ': ' + combined.get(names[i]) + '\r\n';
      }
      return result;
    }
  };

  // Class members are non-enumerable, native XHR members are enumerable: without this, for...in
  // over an XHR skips every member we override
  const keys = Object.getOwnPropertyNames(PatchedXMLHttpRequest.prototype);
  for (let i = 0, len = keys.length; i < len; i++) {
    const key = keys[i];
    if (key === 'constructor') {
      continue;
    }
    Object.defineProperty(PatchedXMLHttpRequest.prototype, key, { enumerable: true });

    // Methods stringify like the native ones, for feature detection
    const value: unknown = Object.getOwnPropertyDescriptor(PatchedXMLHttpRequest.prototype, key)?.value;
    const native: unknown = Object.getOwnPropertyDescriptor(Base.prototype, key)?.value;
    if (typeof value === 'function' && typeof native === 'function') {
      disguiseAsNative(value, native);
    }
  }
  disguiseAsNative(PatchedXMLHttpRequest, Base);

  return PatchedXMLHttpRequest;
}

function stopImmediatePropagation(e: Event) {
  e.stopImmediatePropagation();
}

function clearTimer(s: SyntheticState) {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

function invalidState(message: string) {
  return new unsafeWindow.DOMException(message, 'InvalidStateError');
}

function fire(xhr: XMLHttpRequest, type: string) {
  Reflect.apply(nativeDispatchEvent, xhr, [new unsafeWindow.Event(type)]);
}

function fireProgress(xhr: XMLHttpRequest, type: string, lengthComputable: boolean, loaded: number, total: number) {
  Reflect.apply(nativeDispatchEvent, xhr, [new unsafeWindow.ProgressEvent(type, { lengthComputable, loaded, total })]);
}

/** The XHR spec's "request error steps" */
function requestError(xhr: XMLHttpRequest, s: SyntheticState, isCurrent: () => boolean, type: 'error' | 'abort' | 'timeout') {
  clearTimer(s);
  s.readyState = ReadyState.DONE;
  s.sendFlag = false;
  s.status = 0;
  s.statusText = '';
  s.headers = [];
  s.body = null;

  fire(xhr, 'readystatechange');
  if (!isCurrent()) return;
  fireProgress(xhr, type, false, 0, 0);
  if (!isCurrent()) return;
  fireProgress(xhr, 'loadend', false, 0, 0);
}
