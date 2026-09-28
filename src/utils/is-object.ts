/** A non-null object: its properties are still to be checked, as with any parsed JSON */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
