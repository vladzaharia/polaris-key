// Run async jobs one at a time, in the order they were queued; a failed job does not stop the next.

export type Serial = <T>(fn: () => Promise<T>) => Promise<T>;

export function serialQueue(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
