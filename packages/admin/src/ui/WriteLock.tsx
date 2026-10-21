import * as React from "react";

/**
 * A view-only member's lock (ST-08n). A page that cannot be written wraps its content in
 * `WriteLock`; the write controls (Button, the inputs, Switch, Select, SegmentedControl, the
 * upload label) read it and render locked, while reads stay usable. A read control inside the
 * lock (Copy, Show, Retry, sort, a help popover, a preview toggle) sits under `Unlocked`.
 *
 * A locked Button stays focusable (`aria-disabled` and the reason as its tooltip); a locked
 * input is read-only, not disabled, so its value stays legible and reachable.
 */
interface Lock {
  locked: boolean;
  reason?: string;
}

const LockContext = React.createContext<Lock>({ locked: false });

export function WriteLock({
  locked,
  reason,
  children,
}: {
  locked: boolean;
  reason?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const value = React.useMemo(() => ({ locked, reason }), [locked, reason]);
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

/** A read subtree inside a lock: its controls work. */
export function Unlocked({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <WriteLock locked={false}>{children}</WriteLock>;
}

export function useWriteLock(): Lock {
  return React.useContext(LockContext);
}
