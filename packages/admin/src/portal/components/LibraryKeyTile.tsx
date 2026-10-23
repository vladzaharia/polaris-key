import * as React from "react";
import { KeyRound } from "lucide-react";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useActivate } from "../activate.js";

/**
 * The Library's own entry for a key (2-7 products, B12): the grid's last tile, dashed and quiet
 * beside the products, with its one outlined action. Always one grid cell, never a band across
 * the rest of the row.
 */
export function LibraryKeyTile(): React.ReactElement {
  const activate = useActivate();
  return (
    <li aria-labelledby="key-tile-h" className="grid @container">
      {/* A cell: the key and the title, the button at the foot, level with the tiles' actions.
          Under 13 rem the icon sits above the title. */}
      <div className="flex flex-col gap-3 overflow-hidden rounded-xl border border-dashed border-border-strong bg-transparent p-3">
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
          className="h-auto min-h-10 w-full max-w-64 shrink-0 whitespace-normal py-1.5 text-center pointer-coarse:min-h-11 @max-[13rem]:[&_svg]:hidden"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          {t("common.activateLicense")}
        </Button>
      </div>
    </li>
  );
}
