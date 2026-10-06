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
 * Phones: the art becomes a 16:9 strip above the panel.
 */
export function LibraryHero({
  product,
  action,
}: {
  product: LibraryProduct;
  action: QuickAction;
}): React.ReactElement {
  const { best, presentation: pres } = product;
  const tier = tierLabel(best.tier);
  const includes = best.entitlements
    .filter((e) => e.key !== "channels")
    .map((e) => e.label);
  return (
    <article
      aria-labelledby="hero-name"
      className="grid overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1 desk:grid-cols-[1.45fr_1fr]"
    >
      <ProductArt
        slug={product.slug}
        name={product.name}
        tint={pres.tint}
        src={pres.headerUrl}
        variant="banner"
        // No cover: a bare tint field; the icon beside the name already shows the letter.
        letter={false}
        className="aspect-video desk:aspect-auto desk:min-h-[26rem]"
      />
      <div className="flex flex-col gap-5 p-6 desk:p-9">
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
          License, devices and all versions
          <ArrowRight aria-hidden className="size-4" />
        </a>
      </div>
    </article>
  );
}
