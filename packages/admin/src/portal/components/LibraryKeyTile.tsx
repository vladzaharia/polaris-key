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
      {/* The product tiles' shape: the same 5:2 band holding the key, the title on the names'
          line, one helper line, the button at the foot, level with the tiles' actions. */}
      <div className="flex flex-col overflow-hidden rounded-xl border border-dashed border-border-strong bg-transparent">
        <div
          aria-hidden
          className="flex aspect-[5/2] w-full items-center justify-center @max-[13rem]:aspect-auto @max-[13rem]:py-4"
        >
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-accent-subtle text-accent-fg">
            <KeyRound className="size-7" />
          </span>
        </div>
        <div className="flex flex-1 flex-col px-3 pb-3">
          <h3
            id="key-tile-h"
            className="pt-1 text-base font-semibold text-fg-strong"
          >
            {t("signin.link.key")}
          </h3>
          <p className="mt-1 text-sm text-fg-muted">{t("activate.lede")}</p>
          <div className="mt-auto" />
          <Button
            variant="quiet"
            className="mt-3 h-auto min-h-10 w-full whitespace-normal py-1.5 text-center pointer-coarse:min-h-11 @max-[13rem]:[&_svg]:hidden"
            iconStart={<KeyRound aria-hidden />}
            onClick={() => activate.open()}
          >
            {t("common.activateLicense")}
          </Button>
        </div>
      </div>
    </li>
  );
}
