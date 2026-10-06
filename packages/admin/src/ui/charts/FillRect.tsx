import * as React from "react";
import { cn } from "../../lib/cn.js";
import { setMeter } from "../motion/index.js";

/**
 * A chart fill that moves (notes/S-23 §6.1 "meter", §6.2 rule 1; MO-09): the rect is always the
 * full width of its track and `transform: scaleX(--pk-meter)` draws the share, from its own left
 * edge (Tailwind `transform-fill`), so a new value glides at `slow`·`emphasized` instead of the SVG
 * width snapping. The value reaches the rect through the CSSOM (`setMeter`), never a `style`
 * attribute (S-23 D8). It is set before the first paint, so a chart appears at its value; only
 * later changes move. Under reduced motion the transition is 0 ms: an instant swap.
 */
export function FillRect({
  ratio,
  height,
  rx,
  className,
}: {
  /** The share to fill, 0–1 (clamped). */
  ratio: number;
  height: number;
  rx: number;
  /** The fill colour (`fill-accent`, `fill-danger`…). */
  className?: string;
}): React.ReactElement {
  const ref = React.useRef<SVGRectElement>(null);
  React.useLayoutEffect(() => setMeter(ref.current, ratio), [ratio]);
  return (
    <rect
      ref={ref}
      data-fill=""
      width="100%"
      height={height}
      rx={rx}
      className={cn("pk-meter-fill transform-fill", className)}
    />
  );
}
