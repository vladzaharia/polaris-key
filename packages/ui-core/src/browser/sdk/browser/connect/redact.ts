// Keep what holds a discovery key out of default printing (CC-09.2). `JSON.stringify` and a Node
// `console.log` get a short marker; the fields that matter live in closures or a WeakMap, so a
// browser console has nothing to expand either.

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Make `obj` print as `view()`; the hooks are non-enumerable. Returns the same object. */
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

/** Schedule `fn` after `ms`; returns the cancel. */
export const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

/** A queue that runs one async job at a time, in order; a failure does not stop the next. */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
