import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useActivate } from "../activate.js";

/**
 * How many columns the key tile takes so the last row of a grid of `count` products is never
 * half empty: the rest of the row after the products (a whole row when they fill it).
 */
export function keyTileSpan(count: number, columns: 2 | 3): 1 | 2 | 3 {
  const rest = columns - (count % columns);
  return (rest === 0 ? columns : rest) as 1 | 2 | 3;
}

const SPAN = {
  2: { 1: "desk:col-span-1", 2: "desk:col-span-2" },
  3: {
    1: "wide:col-span-1",
    2: "wide:col-span-2",
    3: "wide:col-span-3",
  },
} as const;

/**
 * The Library's own entry for a key (2-7 products, B12): the grid's last tile, dashed and quiet
 * beside the products, with its one outlined action. It takes the rest of its row, so the grid
 * never ends half empty: at two columns it spans the row when the products fill it, and beside a
 * wide span it lays out as a row.
 */
export function LibraryKeyTile({
  count,
}: {
  /** The products before it in the grid. */
  count: number;
}): React.ReactElement {
  const activate = useActivate();
  return (
    <li
      className={cn(
        "grid @container",
        SPAN[2][keyTileSpan(count, 2) as 1 | 2],
        SPAN[3][keyTileSpan(count, 3)],
      )}
    >
      <aside
        aria-labelledby="key-tile-h"
        className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-strong bg-transparent p-6 text-center @2xl:flex-row @2xl:gap-6 @2xl:text-left"
      >
        <span
          aria-hidden
          className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent-fg"
        >
          <KeyRound className="size-7" />
        </span>
        <div className="min-w-0 space-y-1 @2xl:flex-1">
          <h2 id="key-tile-h" className="text-lg font-medium text-fg-strong">
            {t("signin.link.key")}
          </h2>
          <p className="text-sm text-fg-muted">
            Activate it to add its product here.
          </p>
        </div>
        <Button
          variant="quiet"
          size="lg"
          className="h-11 shrink-0"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          {t("activate.submit")}
        </Button>
      </aside>
    </li>
  );
}
