// Cross-tab safety for the Connect state (R-6w). Two tabs of one app share one IndexedDB record;
// every read-modify-write of it runs under a Web Lock named for the record, and re-reads the
// record inside the lock. Where `navigator.locks` is absent the same-tab queue is all there is.

interface LockManagerLike {
  request<T>(
    name: string,
    optionsOrFn: unknown,
    fn?: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
}

export const locks = (): LockManagerLike | null => {
  try {
    const l = (globalThis as { navigator?: { locks?: LockManagerLike } })
      .navigator?.locks;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
};

/** Run `fn` holding the lock `name` (exclusive), or directly when there are no Web Locks. */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const l = locks();
  return l === null ? fn() : l.request(name, () => fn());
}
