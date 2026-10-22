import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useActivate } from "../activate.js";

/**
 * How many columns the key tile takes: the rest of the products' last row, so the row is always
 * full (the whole row, as one line, when the products fill their rows).
 */
export function keyTileSpan(
  count: number,
  columns: 2 | 3 | 4 | 5,
): 1 | 2 | 3 | 4 | 5 {
  return (columns - (count % columns)) as 1 | 2 | 3 | 4 | 5;
}

/** The grid's columns by breakpoint (`tileGrid.ts`): 2, then 3 (desk), 4 (wide), 5 (xxl). */
const SPAN = {
  // `full`, not 2: below `desk` the grid is one column at large text, and a span of 2 would add one.
  2: { 1: "col-span-1", 2: "col-span-full" },
  3: { 1: "desk:col-span-1", 2: "desk:col-span-2", 3: "desk:col-span-3" },
  4: {
    1: "wide:col-span-1",
    2: "wide:col-span-2",
    3: "wide:col-span-3",
    4: "wide:col-span-4",
  },
  5: {
    1: "xxl:col-span-1",
    2: "xxl:col-span-2",
    3: "xxl:col-span-3",
    4: "xxl:col-span-4",
    5: "xxl:col-span-5",
  },
} as const;

/**
 * The Library's own entry for a key (2-7 products, B12): the grid's last tile, dashed and quiet
 * beside the products, with its one outlined action. It fills the rest of the last row: one cell,
 * or the whole row (one line) when the products fill their rows.
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
      aria-labelledby="key-tile-h"
      className={cn(
        "grid @container",
        SPAN[2][keyTileSpan(count, 2) as 1 | 2],
        SPAN[3][keyTileSpan(count, 3) as 1 | 2 | 3],
        SPAN[4][keyTileSpan(count, 4) as 1 | 2 | 3 | 4],
        SPAN[5][keyTileSpan(count, 5)],
      )}
    >
      {/* A cell: the key and the title, the button at the foot, level with the tiles' actions.
          A tile with a row to itself (from 36 rem) is one line: the key, the title, the button on the right. Under 13 rem the icon sits above the title. */}
      <div className="flex flex-col gap-3 overflow-hidden rounded-xl border border-dashed border-border-strong bg-transparent p-3 @xl:flex-row @xl:items-center @xl:gap-6 @xl:p-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 @max-[13rem]:flex-col @max-[13rem]:items-start @max-[13rem]:gap-2">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent-fg"
          >
            <KeyRound className="size-5" />
          </span>
          <h3
            id="key-tile-h"
            className="text-base font-semibold text-fg-strong"
          >
            {t("signin.link.key")}
          </h3>
        </div>
        <Button
          variant="quiet"
          className="h-auto min-h-10 w-full max-w-64 shrink-0 whitespace-normal py-1.5 text-center pointer-coarse:min-h-11 @max-[13rem]:[&_svg]:hidden @xl:w-auto"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          {t("common.activateLicense")}
        </Button>
      </div>
    </li>
  );
}
