import * as React from "react";
import { reducedMotion, tokenMs } from "./reducedMotion.js";

/**
 * Count from the number on screen to a new one (notes/S-23 §6.1 "count"). Time comes from the frame
 * timestamps, so a slowed animation timeline (DevTools) or a background tab slows the count with
 * the rest of the motion (S-23 §3.4 item 7). Under reduced motion the number swaps at once.
 */

export interface CountUpOptions {
  /** Where the first count starts (default: no count on mount; the value shows as it is). */
  from?: number;
  /** Milliseconds (default: the `deliberate` token, 480 ms; 0 under reduced motion). */
  duration?: number;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** The number to show this frame while counting towards `value`. */
export function useCountUp(
  value: number,
  options: CountUpOptions = {},
): number {
  const { from, duration } = options;
  const [shown, setShown] = React.useState(from ?? value);
  const shownRef = React.useRef(shown);
  shownRef.current = shown;

  React.useEffect(() => {
    const start = shownRef.current;
    const ms = duration ?? tokenMs("--pk-duration-deliberate", 480);
    if (
      start === value ||
      ms <= 0 ||
      reducedMotion() ||
      typeof requestAnimationFrame !== "function"
    ) {
      setShown(value);
      return;
    }
    let first: number | null = null;
    let frame = 0;
    const step = (now: number): void => {
      first ??= now;
      const t = Math.min(1, (now - first) / ms);
      setShown(Math.round(start + (value - start) * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return shown;
}

export interface CountUpProps extends CountUpOptions {
  value: number;
  /** Formats both the counting and the final number (default: `toLocaleString()`). */
  format?: (n: number) => string;
  className?: string;
}

/**
 * A counting number with exactly one accessible value: the visible digits are `aria-hidden` while
 * a visually hidden twin holds the final number, so a screen reader hears it once (S-23 §6.5).
 */
export function CountUp({
  value,
  format = (n) => n.toLocaleString(),
  className,
  ...options
}: CountUpProps): React.ReactElement {
  const shown = useCountUp(value, options);
  return (
    <span className={className} data-count-up="">
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
