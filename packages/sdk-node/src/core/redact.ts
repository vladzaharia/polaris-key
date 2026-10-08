// Keep a credential out of default printing. A device-code prompt carries its poll credential,
// an activation or registration result the device token, and a minted token a live credential
// for someone else's API; a host that logs any of them (`console.log(result)`,
// `JSON.stringify(minted)`) must not leak it.
//
// The fields stay ordinary, readable properties — the public shape does not change — and two
// NON-enumerable hooks replace them with a marker when the object is printed: `toJSON` for
// `JSON.stringify`, and Node's `util.inspect.custom` for `console.log` and `util.inspect`.

/** What a redacted field prints as. */
export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Make `obj` print (`console.log`, `util.inspect`, `JSON.stringify`) as `view()` rather than
 *  as its own fields, and return the same object. For an object holding a credential it must
 *  never show, such as the client's token custody. */
export function printAs<T extends object>(obj: T, view: () => unknown): T {
  Object.defineProperties(obj, {
    toJSON: { value: view, enumerable: false, configurable: true },
    [INSPECT]: {
      value: (
        _depth: number,
        options: unknown,
        inspect: (v: unknown, o: unknown) => string,
      ) => inspect(view(), options),
      enumerable: false,
      configurable: true,
    },
  });
  return obj;
}

/** Attach the redacting hooks to `obj` for `keys` and return the same object. A key whose value
 *  is null or absent prints as it is: there is nothing to hide. */
export function redactOnPrint<T extends object>(
  obj: T,
  keys: readonly (keyof T & string)[],
): T {
  return printAs(obj, () => {
    const out = { ...obj } as Record<string, unknown>;
    for (const k of keys)
      if (out[k] !== undefined && out[k] !== null) out[k] = REDACTED;
    return out;
  });
}
