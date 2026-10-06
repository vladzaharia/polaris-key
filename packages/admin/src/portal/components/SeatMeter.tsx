import * as React from "react";
import { cn } from "../../lib/cn.js";
import { setMeter } from "../../ui/motion/index.js";

/** Up to this many seats draw one segment each; more draw one continuous bar. */
const MAX_SEGMENTS = 10;

/**
 * A licence's seats as a meter (PORTAL.md §4.20, §4.25, §9.3): one segment per seat, used ones
 * filled in violet, all of them red once the limit is reached. `role="img"` with the reading as
 * its name ("2 of 3 devices in use"), so the bar is never the only carrier; callers show the
 * same words as visible text. CSP-safe: no inline style attribute (S-23 D8).
 *
 * Motion (notes/S-23 §6.1 "meter"; MO-06): segments ease their colour (`.pk-seg`), and the ones
 * whose seat changed pulse once (`data-changed`, set and cleared here; never on mount or on a
 * re-render with the same count). The continuous bar is always full width and draws its share
 * with `transform: scaleX` (`.pk-meter-fill`, the value through `setMeter`, i.e. the CSSOM), set
 * before the first paint, so it appears at its value and only later changes glide. Under reduced
 * motion the durations are 0: the same end state, at once.
 */
export function SeatMeter({
  inUse,
  limit,
  className,
}: {
  inUse: number;
  limit: number;
  className?: string;
}): React.ReactElement | null {
  const segmented = limit <= MAX_SEGMENTS;
  const segments = React.useRef<HTMLDivElement>(null);
  const fill = React.useRef<HTMLSpanElement>(null);
  const share = limit > 0 ? Math.min(1, Math.max(0, inUse / limit)) : 0;
  React.useLayoutEffect(() => {
    if (!segmented) setMeter(fill.current, share);
  }, [segmented, share]);
  usePulse(segments, inUse, limit, segmented);

  if (!(limit > 0)) return null;
  const full = inUse >= limit;
  const label = `${Math.min(inUse, limit)} of ${limit} ${limit === 1 ? "device" : "devices"} in use`;
  const color = full ? "bg-danger" : "bg-accent";
  if (segmented) {
    return (
      <div
        ref={segments}
        role="img"
        aria-label={label}
        className={cn("flex gap-1", className)}
      >
        {Array.from({ length: limit }, (_, i) => (
          <span
            key={i}
            data-used={i < inUse ? "" : undefined}
            className={cn(
              "pk-seg h-1.5 flex-1 rounded-full",
              i < inUse
                ? color
                : "bg-surface-sunken ring-1 ring-inset ring-border",
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border",
        className,
      )}
    >
      <span
        ref={fill}
        data-fill=""
        className={cn("pk-meter-fill block h-full w-full rounded-full", color)}
      />
    </div>
  );
}

/**
 * Pulse the segments whose seat changed since the last render (the range between the old and
 * the new count): `data-changed` scales them up (`.pk-seg[data-changed]` in motion.css) and comes
 * off once that transition has finished, so they ease back. With nothing animating (reduced
 * motion, no Web Animations API) it comes off in the same frame, before anything paints.
 */
function usePulse(
  root: React.RefObject<HTMLDivElement | null>,
  inUse: number,
  limit: number,
  segmented: boolean,
): void {
  const last = React.useRef(inUse);
  React.useLayoutEffect(() => {
    const was = last.current;
    last.current = inUse;
    const el = root.current;
    if (was === inUse || !segmented || !el) return;
    const from = Math.max(0, Math.min(was, inUse));
    const to = Math.min(limit, Math.max(was, inUse));
    const segs = Array.from(el.children).slice(from, to) as HTMLElement[];
    const clear = (): void => {
      for (const s of segs) delete s.dataset.changed;
    };
    for (const s of segs) s.dataset.changed = "";
    const running = segs.flatMap((s) =>
      typeof s.getAnimations === "function" ? s.getAnimations() : [],
    );
    if (running.length === 0) {
      clear();
      return;
    }
    let cancelled = false;
    void Promise.all(
      running.map((a) => a.finished.catch(() => undefined)),
    ).then(() => {
      if (!cancelled) clear();
    });
    return () => {
      cancelled = true;
      clear();
    };
  }, [root, inUse, limit, segmented]);
}
