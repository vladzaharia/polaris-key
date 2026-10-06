import * as React from "react";
import { cn } from "../lib/cn.js";
import { announce } from "./LiveRegion.js";

/**
 * Loading feedback beyond skeletons (components.md §5.3).
 *
 * `useLoadingAnnouncement("licenses", isLoading)` announces "Loading licenses…" when a load
 * starts and "Licenses loaded" when it finishes, through the shared polite announcer (UI-13).
 */
export function useLoadingAnnouncement(noun: string, loading: boolean): void {
  const was = React.useRef(false);
  React.useEffect(() => {
    if (loading && !was.current) announce(`Loading ${noun}…`);
    if (!loading && was.current) {
      announce(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} loaded`);
    }
    was.current = loading;
  }, [noun, loading]);
}

/** Delay a boolean: true only once it has stayed true for `ms`. */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return shown;
}

/**
 * The background-refetch indicator: a 2 px indeterminate line under the page header, shown only
 * after 400 ms so quick refetches never flash, and never replacing content. Decorative
 * (`aria-hidden`); the page's live region carries any announcement. A neutral bar, never the mark.
 *
 * Motion (notes/S-23 §6.1, D6; MO-09): the track fades in (`base`) and a third-width bar sweeps
 * across it on the `pk-refetch` keyframes (transform only, one `shimmer` period per pass) from
 * src/motion.css: a loading indicator, so it is allowed to loop. Under reduced motion (the OS
 * setting or html[data-motion="reduce"]) nothing moves: the bar stands still, full width and dimmed.
 */
export function RefetchBar({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}): React.ReactElement {
  const shown = useDelayedFlag(active, 400);
  return (
    <div
      aria-hidden
      data-active={shown || undefined}
      className={cn(
        "relative h-0.5 w-full overflow-hidden data-[active]:animate-pk-fade-in motion-reduce:animate-none",
        className,
      )}
    >
      {shown ? (
        <div className="absolute inset-y-0 left-0 w-1/3 animate-pk-refetch rounded-full bg-fg-subtle motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-50" />
      ) : null}
    </div>
  );
}
