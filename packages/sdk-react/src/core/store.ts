// A tiny observable store: an immutable snapshot + subscribe/emit. Adapters own one of
// these to hold their `PolarisState`; the React layer bridges it to `useSyncExternalStore`.
// Deliberately dependency-free so it works identically under both transports.

export interface Store<T> {
  /** The current snapshot (stable reference until the next `set`). */
  get(): T;
  /** Replace the snapshot (or derive it) and notify subscribers. */
  set(next: T | ((prev: T) => T)): void;
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe(cb: (value: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (resolved === value) return; // identity-equal: skip the notify churn.
      value = resolved;
      for (const cb of subs) cb(value);
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}
