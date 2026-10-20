import * as React from "react";
import { KeyRound } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useActivate } from "../activate.js";

/**
 * How many columns the key tile takes: the whole row when the products fill their rows (it then
 * lays out as one line), else one cell, never part of a row.
 */
export function keyTileSpan(count: number, columns: 2 | 3): 1 | 2 | 3 {
  return (count % columns === 0 ? columns : 1) as 1 | 2 | 3;
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
 * beside the products, with its one outlined action. One cell, or a whole row (one line) when the
 * products fill their rows.
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
        SPAN[3][keyTileSpan(count, 3)],
      )}
    >
      {/* A phone: the key beside the text, the button full width under them. In a one-cell tile
          (from 900 px) a flat well stands where a product's art would be, the key at its centre,
          and the button sits at the foot, level with the tiles' actions. A tile with a row to
          itself is one line: the 48 px key, the title, the button on the right. */}
      <div className="flex flex-col gap-4 overflow-hidden rounded-xl border border-dashed border-border-strong bg-transparent p-4 desk:gap-0 desk:p-0 @2xl:flex-row @2xl:items-center @2xl:gap-6 @2xl:p-6">
        <div
          aria-hidden
          className="hidden min-h-40 max-h-[17.5rem] w-full flex-1 items-center justify-center bg-surface-sunken desk:flex @2xl:hidden"
        >
          <span className="inline-flex size-16 items-center justify-center rounded-2xl bg-accent-subtle text-accent-fg">
            <KeyRound className="size-7" />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3 desk:px-5 desk:pt-5 @2xl:flex-1 @2xl:p-0">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent-fg desk:hidden @2xl:inline-flex @2xl:size-12"
          >
            <KeyRound className="size-5" />
          </span>
          <h3 id="key-tile-h" className="text-lg font-semibold text-fg-strong">
            {t("signin.link.key")}
          </h3>
        </div>
        <div className="desk:mt-auto desk:p-5 @2xl:mt-0 @2xl:p-0">
          <Button
            variant="quiet"
            size="lg"
            className="h-11 w-full shrink-0 @2xl:w-auto"
            iconStart={<KeyRound aria-hidden />}
            onClick={() => activate.open()}
          >
            {t("activate.submit")}
          </Button>
        </div>
      </div>
    </li>
  );
}
