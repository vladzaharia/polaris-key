import * as React from "react";
import { cn } from "../../lib/cn.js";
import { reducedMotion } from "./reducedMotion.js";

/**
 * Success moments (notes/S-23 D5, §6.4; EXPERIENCE §0.7): a check draws once and six plain sparks
 * burst in the section accent, once per moment key, never the Polaris mark (BRAND §7.5: the star
 * never moves). Decorative: the moment itself is said in words next to it, so the whole thing is
 * `aria-hidden`. Under reduced motion, or once the key has been seen, the check is static and
 * there is no burst.
 */

const STORAGE_PREFIX = "pk-moment:";

/** Has this moment been shown before (in this browser)? Storage failures read as "not yet". */
export function momentSeen(key: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

/** Record the moment as shown. Storage may be unavailable (private mode, quota): then it is not kept. */
export function markMomentSeen(key: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, "1");
  } catch {
    /* storage unavailable: the moment may show again next time */
  }
}

/**
 * Claim a moment: true the first time a key is seen (and records it), false after. For callers
 * that run their own success visuals.
 */
export function celebrateOnce(key: string): boolean {
  if (momentSeen(key)) return false;
  markMomentSeen(key);
  return true;
}

/** The check `.pk-check` draws (`stroke-dashoffset`, S-23 §6.2 exception 3). */
function CheckGlyph({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      className="pk-check"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={48} />
    </svg>
  );
}

export interface SuccessCheckProps {
  /** Size of the check in px (default 24). */
  size?: number;
  className?: string;
}

/**
 * The success check alone, for a success that is not a first time (a device freed, MO-06): it
 * draws once when it mounts, with no sparks and no moment key, and is static under reduced
 * motion. A re-render never redraws it (only a new mount does). Decorative, like Celebration: the
 * success is said in words next to it.
 */
export function SuccessCheck({
  size = 24,
  className,
}: SuccessCheckProps): React.ReactElement {
  return (
    <span aria-hidden="true" className={cn("pk-celebration", className)}>
      <CheckGlyph size={size} />
    </span>
  );
}

export interface CelebrationProps {
  /** The moment's stable key, e.g. `first-activation:<account>` or `first-release:<product>`. */
  momentKey: string;
  /** Size of the check in px (default 24). */
  size?: number;
  className?: string;
}

export function Celebration({
  momentKey,
  size = 24,
  className,
}: CelebrationProps): React.ReactElement {
  // Decided once per mount, before the key is stored (StrictMode runs this twice; both agree).
  const [animate] = React.useState(
    () => !momentSeen(momentKey) && !reducedMotion(),
  );
  const [burst, setBurst] = React.useState(animate);
  const burstRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    markMomentSeen(momentKey);
  }, [momentKey]);

  // The sparks leave when their animations end, not on a timer, so a slowed or paused timeline is
  // safe (S-23 §3.4 item 7). With no animations to wait for, they leave at once.
  React.useEffect(() => {
    if (!burst) return;
    const el = burstRef.current;
    let cancelled = false;
    let frame = 0;
    const finish = (): void => {
      if (!cancelled) setBurst(false);
    };
    if (!el || typeof el.getAnimations !== "function") {
      finish();
      return;
    }
    const wait = (): void => {
      void Promise.all(
        el
          .getAnimations({ subtree: true })
          .map((a) => a.finished.catch(() => undefined)),
      ).then(finish);
    };
    if (typeof requestAnimationFrame === "function")
      frame = requestAnimationFrame(wait);
    else wait();
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }, [burst]);

  return (
    <span
      aria-hidden="true"
      data-celebrate={animate ? "" : undefined}
      data-static={animate ? undefined : ""}
      className={cn("pk-celebration", className)}
    >
      <CheckGlyph size={size} />
      {burst ? (
        <span ref={burstRef} className="pk-burst">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </span>
  );
}
