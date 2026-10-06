import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * Expand (notes/S-23 §6.1; MO-06): an inline region that opens in place, such as the portal's
 * Remove confirm under a device (and the sign-in card's Replace, the same pattern). The region is
 * `.pk-expand` (src/motion.css): its grid row opens 0fr → 1fr at `moderate` and its content fades
 * in after `micro`; closing runs the reverse, and the content leaves the DOM once that has
 * finished, so a closed region holds nothing (out of the tab order, the accessibility tree and the
 * page's text). Under reduced motion the tokens are 0 ms: the same steps, at once.
 *
 * Opening renders the content closed first, reads that style, then sets `data-open`, so the grid
 * row has a start to move from. A region that mounts open shows open at once: it never replays on
 * a remount. `onOpen` runs as soon as `data-open` is in the DOM (the content is visible and
 * focusable then: move focus here); `onOpened` once the opening has finished, or at once without
 * an animation (bring the region into view here, once it has its height).
 */
export interface ExpandProps {
  open: boolean;
  /** The region's id (the trigger's `aria-controls`). */
  id?: string;
  className?: string;
  children: React.ReactNode;
  onOpen?: () => void;
  onOpened?: (region: HTMLElement) => void;
}

/** Resolves when every animation on `el` and inside it has finished or been cancelled. */
function settled(el: Element): Promise<void> {
  if (typeof el.getAnimations !== "function") return Promise.resolve();
  return Promise.all(
    el
      .getAnimations({ subtree: true })
      .map((a) => a.finished.catch(() => undefined)),
  ).then(() => undefined);
}

export function Expand({
  open,
  id,
  className,
  children,
  onOpen,
  onOpened,
}: ExpandProps): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  /** The content is in the DOM: open, opening or still closing. */
  const [mounted, setMounted] = React.useState(open);
  /** `data-open` is set. */
  const [shown, setShown] = React.useState(open);
  if (open && !mounted) setMounted(true);
  // Closing starts in the same render as the request, so the content never waits on an effect.
  if (!open && shown) setShown(false);
  const callbacks = React.useRef({ onOpen, onOpened });
  callbacks.current = { onOpen, onOpened };
  const opened = React.useRef(shown);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !shown) {
      // The closed style must be computed before data-open lands, or nothing moves.
      if (typeof getComputedStyle === "function")
        void getComputedStyle(el).gridTemplateRows;
      setShown(true);
      return;
    }
    if (!open && mounted) {
      // The content leaves once the closing has run (at once with nothing to wait for). A
      // re-open before then cancels this, so nothing is left waiting to unmount it.
      let cancelled = false;
      void settled(el).then(() => {
        if (!cancelled) setMounted(false);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [open, mounted, shown]);

  React.useLayoutEffect(() => {
    const was = opened.current;
    opened.current = shown;
    const el = ref.current;
    if (!shown || was || !el) return;
    callbacks.current.onOpen?.();
    let cancelled = false;
    void settled(el).then(() => {
      if (!cancelled) callbacks.current.onOpened?.(el);
    });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  return (
    <div
      ref={ref}
      id={id}
      data-open={shown ? "" : undefined}
      className={cn("pk-expand", className)}
    >
      {mounted ? <div>{children}</div> : null}
    </div>
  );
}
