import * as React from "react";
import { reducedMotion } from "./reducedMotion.js";

/**
 * Presence for transients Radix does not own (a bar, an inline notice, a bulk-action strip): what
 * Radix's own Presence does for its primitives. The child gets `data-state="open"` while `open`,
 * then `data-state="closed"`, and stays mounted until the exit animation that state starts has
 * finished (motion.css keys enter and exit on `.pk-transient` / `.animate-pk-in` and
 * `[data-state]`). Without the Web Animations API (jsdom), with no exit animation, or under
 * reduced motion, it unmounts at once.
 */

export interface PresenceProps {
  open: boolean;
  /** One element that accepts `data-state` and a ref (a DOM element or a ref-forwarding component). */
  children: React.ReactElement<{
    "data-state"?: string;
    ref?: React.Ref<Element>;
  }>;
  /** Called once the child has unmounted after closing. */
  onExited?: () => void;
}

/** Resolves when every animation on `el` itself (not its children) has finished or been cancelled. */
export function settle(el: Element): Promise<void> {
  if (typeof el.getAnimations !== "function") return Promise.resolve();
  return Promise.all(
    el.getAnimations().map((a) => a.finished.catch(() => undefined)),
  ).then(() => undefined);
}

export function Presence({
  open,
  children,
  onExited,
}: PresenceProps): React.ReactElement | null {
  const [mounted, setMounted] = React.useState(open);
  const node = React.useRef<Element | null>(null);
  const exited = React.useRef(onExited);
  exited.current = onExited;

  if (open && !mounted) setMounted(true);

  React.useLayoutEffect(() => {
    if (open || !mounted) return;
    const el = node.current;
    let cancelled = false;
    const done = (): void => {
      if (cancelled) return;
      setMounted(false);
      exited.current?.();
    };
    if (!el || reducedMotion() || typeof el.getAnimations !== "function") {
      done();
      return;
    }
    void settle(el).then(done);
    return () => {
      cancelled = true;
    };
  }, [open, mounted]);

  if (!mounted) return null;

  const childRef = (children.props as { ref?: React.Ref<Element> }).ref;
  const ref = (el: Element | null): void => {
    node.current = el;
    if (typeof childRef === "function") childRef(el);
    else if (childRef && typeof childRef === "object")
      (childRef as React.RefObject<Element | null>).current = el;
  };
  return React.cloneElement(children, {
    "data-state": open ? "open" : "closed",
    ref,
  });
}
