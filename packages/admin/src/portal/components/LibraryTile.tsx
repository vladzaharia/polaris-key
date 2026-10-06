import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "../../lib/cn.js";
import type { LibraryProduct, QuickAction } from "../model/library.js";
import { href } from "../router.js";
import { PlatformGlyphs } from "./Glyphs.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";
import { ProductMenu } from "./ProductMenu.js";
import { ProductStatusPill } from "./ProductStatus.js";
import { QuickActionButton } from "./QuickAction.js";

/**
 * A library tile (§4.14, §4.15): art with the status on a solid plate, the icon overlapping, the
 * name (`h3`, the link to the product page; the developer is the product page's), the reason line, platform glyphs, an
 * optional note and the outlined quick action with the overflow menu. `compact` is the 8+ grid.
 *
 * Motion (notes/S-23 §6.1; MO-07): under a pointer the tile lifts and its art scales a little;
 * pressing the tile's link presses the tile, while its own buttons press only themselves. The lift
 * sits on a wrapper because the card clips its art (`overflow-hidden`), which would clip the
 * lift's shadow too.
 */
export function LibraryTile({
  product,
  action,
  note,
  compact = false,
}: {
  product: LibraryProduct;
  action: QuickAction;
  /** A sentence under the meta line ("Windows and Linux only"). */
  note?: string | null;
  compact?: boolean;
}): React.ReactElement {
  const { presentation: pres } = product;
  return (
    <div className="pk-lift pk-pressable-card grid rounded-xl">
      <article
        aria-labelledby={`tile-${product.slug}`}
        className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1"
      >
        <ProductArt
          slug={product.slug}
          name={product.name}
          tint={pres.tint}
          src={pres.headerUrl}
          variant="tile"
          // No cover: a bare tint field. The icon (or its letter tile) already sits in front of the
          // art's lower edge, so a big letter here would show the product's letter twice; the
          // product page drops it the same way.
          letter={false}
          liftArt
          // The listing's header is 16:9 (PORTAL.md Q-2): the card shows all of it, centred, the
          // same art the product page's hero shows a centred band of.
          className="aspect-video"
        >
          {/* The header's safe bottom-right corner, inset by the card's own padding. */}
          <span
            className={cn(
              "absolute",
              compact ? "bottom-4 right-4" : "bottom-5 right-5",
            )}
          >
            <ProductStatusPill status={product.status} onArt />
          </span>
        </ProductArt>
        <div
          className={cn(
            "flex flex-1 flex-col px-5 pb-5",
            compact && "px-4 pb-4",
          )}
        >
          <div className="-mt-7 flex items-start gap-3">
            <ProductIcon
              slug={product.slug}
              name={product.name}
              tint={pres.tint}
              src={pres.iconUrl}
              size={64}
              lift
              className="relative"
              tileClassName="border-[3px] border-surface-raised"
            />
            {/* Below the art, never over it: the icon overlaps the art by 1.75 rem. */}
            <div className="min-w-0 pt-9">
              <h3
                id={`tile-${product.slug}`}
                className={cn(
                  "truncate font-bold text-fg-strong",
                  compact ? "text-base" : "text-lg",
                )}
              >
                <a
                  href={href.product(product.slug)}
                  className="pk-press-link rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {product.name}
                </a>
              </h3>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-fg-muted">
            <span className="min-w-0 truncate">{product.status.note}</span>
            <PlatformGlyphs
              platforms={product.platforms}
              className="shrink-0"
            />
          </div>
          {note ? (
            <p className="mt-3 flex gap-2 text-sm text-fg-muted">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              {note}
            </p>
          ) : null}
          <div className="relative mt-auto flex gap-2 pt-5">
            <QuickActionButton
              product={product}
              action={action}
              size={compact ? "md" : "lg"}
              className={cn("min-w-0 flex-1", compact ? "h-10" : "h-11")}
            />
            <ProductMenu
              slug={product.slug}
              name={product.name}
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md border border-border-strong text-fg-strong hover:bg-hover",
                compact ? "size-10" : "size-11",
              )}
            />
          </div>
        </div>
      </article>
    </div>
  );
}
