import * as React from "react";
import { ArrowLeft } from "lucide-react";
import type { LibraryProduct, QuickAction } from "../../model/library.js";
import { tierLabel } from "../../model/library.js";
import { href } from "../../router.js";
import { cn } from "../../../lib/cn.js";
import { ProductArt } from "../ProductArt.js";
import { ProductIcon } from "../ProductIcon.js";
import { ProductMenu } from "../ProductMenu.js";
import { isIssueStatus, ProductStatusPill } from "../ProductStatus.js";
import { QuickActionButton } from "../QuickAction.js";

/**
 * The product header (§4.20): back to Library, the banner (16:9 full-bleed on phones, a centred
 * 3:1 band capped at 416 px on desktop), the 112 px icon (80 on phones) in front of its lower
 * edge, like an app store's product header; without a cover the icon stands alone beside the
 * name, and without an icon its letter tile stands in. The name as the page's `h1` (focus lands
 * here after adding a product), "by <developer> · <tier>" as text, the status only as a
 * right-aligned issue pill (healthy is silence), and the one lead action with the overflow menu.
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
  // No cover (or one the proxy failed to serve): the icon stands alone beside the name, rather
  // than a letter banner with the same letter tile on top of it.
  const [coverFailed, setCoverFailed] = React.useState(false);
  const hasCover = Boolean(pres.headerUrl) && !coverFailed;
  return (
    <div className="space-y-0">
      <a
        href={href.library()}
        className="mb-4 inline-flex items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Library
      </a>
      {hasCover ? (
        <ProductArt
          slug={product.slug}
          name={product.name}
          tint={pres.tint}
          src={pres.headerUrl}
          variant="banner"
          onError={() => setCoverFailed(true)}
          // The listing's 16:9 header (PORTAL.md Q-2): all of it on phones, full-bleed; on desktop
          // a centred 3:1 band, capped at 26 rem so it never fills the first screen. pk-vt-hero:
          // the Library tile's art flies into it and back (motion.css; named only during a
          // forward or back transition, MO-05).
          className="pk-vt-hero -mx-4 aspect-video desk:mx-0 desk:aspect-[3/1] desk:max-h-[26rem] desk:rounded-xl"
        />
      ) : null}
      <div
        data-cover={hasCover ? "image" : "none"}
        className={cn(
          "flex gap-4 desk:gap-6",
          hasCover
            ? "flex-col desk:flex-row desk:items-end desk:px-6"
            : "flex-row flex-wrap items-center pt-2 desk:flex-nowrap",
        )}
      >
        <ProductIcon
          slug={product.slug}
          name={product.name}
          tint={pres.tint}
          src={pres.iconUrl}
          size={112}
          lift={hasCover}
          tileClassName="border-4 border-surface-page max-desk:text-3xl"
          className={cn(
            // In front of the cover: the banner is positioned, so the icon needs its own
            // stacking position to paint over the banner's lower edge (§4.20). pk-vt-hero-icon:
            // the tile's icon flies into it with the art and the name (MO-05).
            "pk-vt-hero-icon relative z-10 max-desk:size-20",
            // Half the tile over the cover: pinned to the row's top, not its end, on desktop.
            hasCover && "-mt-10 desk:-mt-16 desk:self-start",
          )}
        />
        <div className="min-w-0 flex-1 space-y-2 desk:pb-1">
          {/* pk-vt-hero-title: the tile's name flies into it and back (MO-05). As wide as its
              text, like the tile's name, or the shared snapshot stretches (S-23 §3.4 item 4). */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="pk-vt-hero-title w-fit text-[1.75rem] font-bold leading-tight text-fg-strong outline-none desk:text-4xl"
          >
            {product.name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
            {pres.developer ? (
              <span>
                by{" "}
                <span className="font-bold text-accent-fg">
                  {pres.developer}
                </span>
              </span>
            ) : null}
            {tier ? (
              <span>
                {pres.developer ? (
                  <span aria-hidden className="mr-2">
                    ·
                  </span>
                ) : null}
                {tier}
              </span>
            ) : null}
            {/* A quiet non-issue status ("From signing in") reads as text after a dot, like the tier. */}
            {!isIssueStatus(product.status) &&
            product.status.tone !== "success" &&
            (pres.developer || tier) ? (
              <span aria-hidden>·</span>
            ) : null}
            <ProductStatusPill
              status={product.status}
              className={isIssueStatus(product.status) ? "ml-auto" : undefined}
            />
          </div>
        </div>
        <div className="flex gap-2 max-desk:w-full desk:pb-1">
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
