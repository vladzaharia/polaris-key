// Own-property reads, shared by `config.ts` and `headers.ts`. Internal: no subpath exports it.
//
// A plain object literal (or a JSON-parsed one) inherits `Object.prototype`, so `obj[key]` for a
// key named `constructor`, `toString` or `__proto__` finds a function instead of nothing. The
// catalog allows such keys (`^[A-Za-z0-9._:-]{1,64}$`), so every lookup reads own properties.
//
// `Object.prototype.hasOwnProperty.call` and not `Object.hasOwn`: this module ships in
// `@polaris-key/react`'s browser bundle, and `Object.hasOwn` is missing before Safari 15.4
// (`tools/runtime-floor.test.ts`).

const hasOwnProperty = Object.prototype.hasOwnProperty;

/** True when `obj` holds `key` itself, never through its prototype. */
export function hasOwn(obj: object, key: string): boolean {
  return hasOwnProperty.call(obj, key);
}
