// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- any function
export function createFakeNativeFunction<T extends Function>(cb: T): T {
  const fnName = cb.name || '';

  const toStringFn = () => `function ${fnName}() { [native code] }`;

  Object.defineProperties(cb, {
    toString: {
      value: toStringFn,
      writable: true,
      configurable: false,
      enumerable: false
    },
    toLocaleString: {
      value: toStringFn,
      writable: true,
      configurable: false,
      enumerable: false
    }
  });

  return cb;
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- only called with Reflect.apply
const nativeFunctionToString = unsafeWindow.Function.prototype.toString;

/**
 * Just enough for polyfills and feature detection: `patched.toString()` (and `String(patched)`)
 * returns `native`'s source in the browser's own format, e.g. `function fetch() { [native code] }`,
 * and `patched.name` is `native.name`. `Function.prototype.toString` itself is left alone.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- any function
export function disguiseAsNative(patched: Function, native: Function) {
  const source: string = Reflect.apply(nativeFunctionToString, native, []);

  Object.defineProperties(patched, {
    name: { value: native.name, configurable: true },
    toString: {
      // A page subclass inherits a class's static members: it keeps its own source
      value(this: unknown) {
        return this === patched ? source : Reflect.apply(nativeFunctionToString, this, []);
      },
      writable: true,
      configurable: true,
      enumerable: false
    }
  });
}
