// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- any function
export function createFakeNativeFunction<T extends Function>(cb: T): T {
  const fnName = cb.name || '';

  const toStringFn = () => `function ${fnName}() { [native code] }`;

  Object.defineProperty(
    cb,
    'toString',
    {
      value: toStringFn,
      writable: true,
      configurable: false,
      enumerable: false
    }
  );
  Object.defineProperty(
    cb,
    'toLocaleString',
    {
      value: toStringFn,
      writable: true,
      configurable: false,
      enumerable: false
    }
  );

  return cb;
}
