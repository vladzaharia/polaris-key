// Keep a credential out of default printing. A device-code prompt carries its poll credential
// and a minted token carries a live credential for someone else's API; a host that logs either
// object (`console.log(prompt)`, `JSON.stringify(minted)`) must not leak it.
//
// The fields stay ordinary, readable properties — the public shape does not change — and two
// NON-enumerable hooks replace them with a marker when the object is printed: `toJSON` for
// `JSON.stringify`, and Node's `util.inspect.custom` for `console.log` and `util.inspect`.

/** What a redacted field prints as. */
export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Attach the redacting hooks to `obj` for `keys` and return the same object. */
export function redactOnPrint<T extends object>(
  obj: T,
  keys: readonly (keyof T & string)[],
): T {
  const printable = (): Record<string, unknown> => {
    const out = { ...obj } as Record<string, unknown>;
    for (const k of keys) if (k in out) out[k] = REDACTED;
    return out;
  };
  Object.defineProperties(obj, {
    toJSON: { value: printable, enumerable: false },
    [INSPECT]: {
      value: (
        _depth: number,
        options: unknown,
        inspect: (v: unknown, o: unknown) => string,
      ) => inspect(printable(), options),
      enumerable: false,
    },
  });
  return obj;
}
