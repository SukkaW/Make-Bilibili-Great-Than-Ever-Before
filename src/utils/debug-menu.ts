const KEY_PREFIX = 'mbgtbe:debug:';

/** A setting that only exists in debug builds, switched from the GM menu like a module */
export interface DebugOption<T extends string = string> {
  name: string,
  description: string,
  /** The first value is the default, and the only one release builds ever see */
  values: readonly [T, ...T[]]
}

export function getDebugOption<T extends string>(option: DebugOption<T>): T {
  if (!process.env.DEBUG) {
    return option.values[0];
  }
  const value = GM_getValue<string>(KEY_PREFIX + option.name, option.values[0]);
  return (option.values as readonly string[]).includes(value) ? value as T : option.values[0];
}

/** Debug builds only: one GM menu command per option, each click moves on to the next value */
export function initDebugMenu(options: readonly DebugOption[]) {
  if (!process.env.DEBUG) {
    return;
  }

  for (let i = 0, len = options.length; i < len; i++) {
    const option = options[i];

    GM.registerMenuCommand(`[DEBUG] ${option.description}: ${getDebugOption(option)}`, async () => {
      const values = option.values;
      const next = values[(values.indexOf(getDebugOption(option)) + 1) % values.length];
      await GM.setValue(KEY_PREFIX + option.name, next);
      try {
        unsafeWindow.location.reload();
      } catch {
        // swallow
      }
    });
  }
}
