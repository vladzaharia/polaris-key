import * as React from "react";
import { ArrowLeft } from "lucide-react";
import type { LibraryProduct, QuickAction } from "../../model/library.js";
import { tierLabel } from "../../model/library.js";
import { href } from "../../router.js";
import { ProductArt } from "../ProductArt.js";
import { ProductIcon } from "../ProductIcon.js";
import { ProductMenu } from "../ProductMenu.js";
import { ProductStatusPill } from "../ProductStatus.js";
import { QuickActionButton } from "../QuickAction.js";

/**
 * The product header (§4.20): back to Library, the 320 px banner (full-bleed 16:9 on phones),
 * the 112 px icon overlapping it, the name as the page's `h1` (focus lands here after adding a
 * product), "by <developer>", status and tier, and the one lead action with the overflow menu.
 */
export function ProductHeader({
  product,
  action,
  headingRef,
}: {
  product: LibraryProduct;
  action: QuickAction;
  headingRef?: React.Ref<HTMLHeadingElement>;
}): React.ReactElement {
  const pres = product.presentation;
  const tier = tierLabel(product.best.tier);
  return (
    <div className="space-y-0">
      <a
        href={href.library()}
        className="mb-4 inline-flex items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Library
      </a>
      <ProductArt
        slug={product.slug}
        name={product.name}
        tint={pres.tint}
        variant="banner"
        className="-mx-4 aspect-video desk:mx-0 desk:aspect-auto desk:h-80 desk:rounded-xl"
      />
      <div className="flex flex-col gap-4 px-0 desk:flex-row desk:items-end desk:gap-6 desk:px-6">
        <ProductIcon
          slug={product.slug}
          name={product.name}
          tint={pres.tint}
          size={112}
          className="-mt-14 border-4 border-surface-page shadow-elevation-2 max-desk:size-20 max-desk:text-3xl desk:-mt-16"
        />
        <div className="min-w-0 flex-1 space-y-2 desk:pb-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-[1.75rem] font-bold leading-tight text-fg-strong outline-none desk:text-4xl"
          >
            {product.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-fg-muted">
            {pres.developer ? (
              <span>
                by{" "}
                <span className="font-bold text-accent-fg">
                  {pres.developer}
                </span>
              </span>
            ) : null}
            <ProductStatusPill status={product.status} />
            {tier ? (
              <span className="inline-flex h-6 items-center rounded-md border border-border-strong px-2 text-xs text-fg-strong">
                {tier}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 desk:pb-1">
          <QuickActionButton
            product={product}
            action={action}
            lead
            className="h-12 flex-1 px-6 desk:flex-none"
          />
          <ProductMenu
            slug={product.slug}
            name={product.name}
            onPage
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-border-strong text-fg-strong hover:bg-hover"
          />
        </div>
      </div>
    </div>
  );
}
