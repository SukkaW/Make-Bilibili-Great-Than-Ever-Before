import type { PlayerInterceptor } from './core/player';

export interface MakeBilibiliGreatThanEverBeforeModule {
  name: string,
  description: string,
  /** Initial state of the module's GM menu toggle until the user changes it. Defaults to `true`. */
  defaultEnabled?: boolean,
  any?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onVideo?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onLive?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onCV?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onStory?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onBangumi?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void,
  onVideoOrBangumi?: (hook: MakeBilibiliGreatThanEverBeforeHook) => void
}

export type XHROpenArgs =
  | [
    method: string,
    url: string | URL,
    async: boolean,
    username?: string | null | undefined,
    password?: string | null | undefined
  ]
  | [
    method: string,
    url: string | URL
  ];

/**
 * If `null` is returned, the fetch will be nullified.
 * If a `Response` is returned, the fetch will be mocaked with the response.
 */
export type FetchArgs = [requestInfo: RequestInfo | URL, requestInit?: RequestInit];
export type OnBeforeFetchHook = (fetchArgs: FetchArgs) => FetchArgs | null | Response;
/**
 * If `null` is returned, the XMLHttpRequest will be nullified.
 */
export type OnXhrOpenHook = (xhrOpenArgs: XHROpenArgs, xhr: XMLHttpRequest) => XHROpenArgs | null;

export interface XhrSendContext {
  readonly xhr: XMLHttpRequest,
  /** Upper-cased request method */
  readonly method: string,
  /** Absolute request URL after all `onXhrOpen` hooks */
  readonly url: string,
  /** The URL originally passed to `open()` */
  readonly originalUrl: string | URL,
  readonly async: boolean,
  /** `open()` received a username or password */
  readonly hasUrlCredentials: boolean,
  /** Request headers set by the page, names lower-cased, in call order */
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>,
  readonly body: Document | XMLHttpRequestBodyInit | null | undefined,
  readonly responseType: XMLHttpRequestResponseType,
  readonly withCredentials: boolean,
  readonly timeout: number
}

/**
 * Drives a synthetic XHR response. The XHR emulation follows the XHR spec: every call here turns
 * into the matching readyState changes and events.
 */
export interface SyntheticXhrSink {
  /** Aborted when the page calls `abort()`, re-opens the XHR, or its `timeout` elapses. */
  readonly signal: AbortSignal,
  /**
   * Commit point: the response exists from now on, `fallbackToNative()` is no longer possible.
   *
   * @param statusText `''` over HTTP/2, which has no reason phrase
   */
  headersReceived(this: void, status: number, headers: ReadonlyArray<readonly [name: string, value: string]>, statusText?: string): void,
  progress(this: void, loaded: number, total: number): void,
  done(this: void, body: ArrayBuffer): void,
  error(this: void): void,
  /**
   * Hand the request back to the browser (native `send()`). Only possible before `headersReceived()`.
   *
   * @returns `false` if it is too late to fall back
   */
  fallbackToNative(this: void): boolean
}

export type XhrResponder = (sink: SyntheticXhrSink) => void;
/**
 * Return a responder to answer the request with a synthetic response, or `null` to let the
 * browser send it. Only `responseType === 'arraybuffer'` requests can be answered.
 */
export type OnXhrSendHook = (ctx: XhrSendContext) => XhrResponder | null;

export interface MakeBilibiliGreatThanEverBeforeHook {
  addStyle(this: void, css: string): void,
  onBeforeFetch(this: void, cb: OnBeforeFetchHook): void,
  onResponse(this: void, cb: (response: Response, fetchArgs: FetchArgs, $fetch: typeof fetch) => Promise<Response> | Response): void,
  onXhrOpen(this: void, cb: OnXhrOpenHook): void,
  onAfterXhrOpen(this: void, cb: (xhr: XMLHttpRequest) => void): void,
  onXhrResponse(this: void, cb: (method: string, url: string | URL, response: unknown, xhr: XMLHttpRequest) => unknown): void,
  onXhrSend(this: void, cb: OnXhrSendHook): void,
  onlyCallOnce(this: void, fn: () => void): void,
  /** The page's original `fetch`, bypassing every `onBeforeFetch` / `onResponse` hook */
  readonly nativeFetch: typeof fetch,
  /** The player request interceptor: media modules register their phases here */
  readonly player: PlayerInterceptor
};
