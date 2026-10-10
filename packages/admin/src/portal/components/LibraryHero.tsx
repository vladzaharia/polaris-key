import * as React from "react";
import { ArrowRight } from "lucide-react";
import type { LibraryProduct, QuickAction } from "../model/library.js";
import { devicesText, tierLabel } from "../model/library.js";
import { href } from "../router.js";
import { PlatformGlyphs } from "./Glyphs.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";
import { ProductStatusPill } from "./ProductStatus.js";
import { QuickActionButton } from "./QuickAction.js";
import { SeatMeter } from "./SeatMeter.js";
import { StorePills } from "./StorePills.js";

/**
 * The one-product hero (§4.13): art (1.45 fr) and a side panel with the icon, name, status and
 * tier, the primary action (solid: the one lead), "Also yours on" (live store links, G2), a short
 * summary with the seat meter (G5) and the product-page link.
 *
 * Side by side from 1024 px (`split`), and on a short (landscape) screen from 560 px. The art is
 * never cropped and never has text over it (§0.3): in a column taller than its 16:9 it is
 * contained over a blurred cover copy of itself (`ProductArt` `fit="contain"`). Below that the hero
 * stacks as on phones: the art at 16:9 across the full width, the panel underneath, with the
 * panel tight enough that the download is on the first screen at 1023 × 900. A short screen also
 * tightens the panel.
 */
export function LibraryHero({
  product,
  action,
}: {
  product: LibraryProduct;
  action: QuickAction;
}): React.ReactElement {
  const { best, presentation: pres } = product;
  const tier = best ? tierLabel(best.tier) : null;
  const includes = (best?.entitlements ?? [])
    .filter((e) => e.key !== "channels")
    .map((e) => e.label);
  return (
    <article
      aria-labelledby="hero-name"
      className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1 split:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] short:min-[35rem]:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]"
    >
      <ProductArt
        slug={product.slug}
        name={product.name}
        tint={pres.tint}
        src={pres.headerUrl}
        variant="banner"
        // No cover: a bare tint field; the icon beside the name already shows the letter.
        letter={false}
        // Whole art, never cropped: contained over a blurred cover copy where the column is taller
        // than the art's 16:9 (side by side); exactly 16:9 when stacked.
        fit="contain"
        className="aspect-video w-full max-h-[min(40svh,28rem)] split:aspect-auto split:max-h-none split:self-stretch short:min-[35rem]:aspect-auto short:min-[35rem]:max-h-none short:min-[35rem]:self-stretch"
      />
      <div className="flex min-w-0 flex-col gap-5 p-6 wide:p-9 short:gap-3 short:p-5">
        <div className="flex items-center gap-4">
          <ProductIcon
            slug={product.slug}
            name={product.name}
            tint={pres.tint}
            src={pres.iconUrl}
            size={64}
          />
          <div className="min-w-0">
            <h2
              id="hero-name"
              className="truncate text-2xl font-bold text-fg-strong desk:text-3xl"
            >
              {product.name}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProductStatusPill status={product.status} />
          {tier ? (
            <span className="inline-flex h-6 items-center rounded-md border border-border-strong px-2 text-xs text-fg-strong">
              {tier}
            </span>
          ) : null}
        </div>
        <QuickActionButton
          product={product}
          action={action}
          lead
          twoLine
          className="w-full"
        />
        <StorePills stores={product.stores} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 border-t border-border pt-5 text-sm">
          {product.kind === "entry" ? (
            // An open product (PS-04): nothing to licence, so no licence or seat facts.
            <>
              <dt className="text-fg-muted">License</dt>
              <dd className="text-fg-strong">None needed</dd>
            </>
          ) : (
            <>
              <dt className="text-fg-muted">License</dt>
              <dd className="text-fg-strong">{product.status.note}</dd>
              <dt className="text-fg-muted">Devices</dt>
              <dd className="space-y-2 text-fg-strong">
                <span className="block">
                  {`${devicesText(product.deviceCount, product.seats?.limit)} in use`}
                </span>
                {product.seats ? (
                  <SeatMeter
                    inUse={product.seats.inUse}
                    limit={product.seats.limit}
                    className="max-w-48"
                  />
                ) : null}
              </dd>
            </>
          )}
          {includes.length ? (
            <>
              <dt className="text-fg-muted">Includes</dt>
              <dd className="text-fg-strong">{includes.join(", ")}</dd>
            </>
          ) : null}
          {product.platforms.length ? (
            <>
              <dt className="text-fg-muted">Runs on</dt>
              <dd>
                <PlatformGlyphs platforms={product.platforms} />
              </dd>
            </>
          ) : null}
        </dl>
        <a
          href={href.product(product.slug)}
          className="mt-auto inline-flex items-center gap-2 self-start font-bold text-accent-fg hover:underline"
        >
          {product.kind === "entry"
            ? "Details and downloads"
            : "License, devices and all versions"}
          <ArrowRight aria-hidden className="size-4" />
        </a>
      </div>
    </article>
  );
}
