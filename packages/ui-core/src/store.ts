// The framework-neutral store every stateful model sits on: a snapshot, `subscribe`, and one
// "deliver on the UI thread" hook (UI-KITS.md §5.2 "Threading"). A React kit reads it with
// `useSyncExternalStore`, the elements with a reactive controller, a Node main process sends each
// snapshot over its bridge; the SDK's callbacks may arrive on any thread or tick, and the hook
// decides where listeners run (`queueMicrotask`, `requestAnimationFrame`, an Electron IPC send).

/** Run `fn` where the host's UI may be touched. The default runs it at once. */
export type Deliver = (fn: () => void) => void;

const immediate: Deliver = (fn) => fn();

export interface Store<T> {
  /** The current snapshot. A new object whenever anything changed, the same one otherwise. */
  get(): T;
  /** Replace the snapshot, or derive it from the last one. Equal snapshots notify no one. */
  set(next: T | ((prev: T) => T)): void;
  /** Called (through `deliver`) after each change; returns the unsubscribe. */
  subscribe(listener: (snapshot: T) => void): () => void;
}

export interface StoreOptions<T> {
  /** Where listeners run (the UI-thread hook). */
  deliver?: Deliver;
  /** When two snapshots count as the same; `Object.is` by default. */
  equals?: (a: T, b: T) => boolean;
}

export function createStore<T>(
  initial: T,
  options: StoreOptions<T> = {},
): Store<T> {
  const deliver = options.deliver ?? immediate;
  const equals = options.equals ?? Object.is;
  let state = initial;
  const listeners = new Set<(snapshot: T) => void>();
  return {
    get: () => state,
    set(next) {
      const value =
        typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      if (equals(state, value)) return;
      state = value;
      const snapshot = state;
      deliver(() => {
        for (const l of [...listeners]) l(snapshot);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
