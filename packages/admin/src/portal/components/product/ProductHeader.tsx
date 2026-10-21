import { t } from "../../../lib/copy.js";
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
 * end-aligned issue pill (healthy is silence), and the one lead action with the overflow menu.
 *
 * On a short screen (§8: at most 512 px tall) the art steps aside for the task: no banner, and the
 * no-cover arrangement (the icon beside the name), so the lead action is on the first screen.
 */
export function ProductHeader({
  product,
  action,
  headingRef,
  onRemove,
  menuTriggerRef,
}: {
  product: LibraryProduct;
  action: QuickAction;
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** The overflow menu's Remove from my library (PX-23), or an entry's Remove from library. */
  onRemove?: () => void;
  /** The overflow menu's button, for an inline confirmation that hands focus back to it. */
  menuTriggerRef?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  const pres = product.presentation;
  const tier = product.best ? tierLabel(product.best.tier) : null;
  // A quiet non-issue status ("From signing in") reads as text after a dot, like the tier. The dot
  // ends the run before it (never its own flex item), so it cannot wrap away from its neighbour.
  const trailingDot =
    !isIssueStatus(product.status) &&
    product.status.tone !== "success" &&
    Boolean(pres.developer || tier);
  const dot = (
    <span aria-hidden className="ms-2">
      ·
    </span>
  );
  // No cover (or one the proxy failed to serve): the icon stands alone beside the name, rather
  // than a letter banner with the same letter tile on top of it.
  const [coverFailed, setCoverFailed] = React.useState(false);
  const hasCover = Boolean(pres.headerUrl) && !coverFailed;
  return (
    <div className="space-y-0">
      <a
        href={href.library()}
        className="mb-4 inline-flex items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong pointer-coarse:min-h-11"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("locker.library.title")}
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
          // a centred 5:1 band, capped at 13.75 rem (and 26 vh) so License and Devices start in the first
          // viewport (LK-polish M3); phones cap at 11 rem. pk-vt-hero:
          // the Library tile's art flies into it and back (motion.css; named only during a
          // forward or back transition, MO-05).
          className="pk-vt-hero -mx-4 max-desk:h-44 desk:mx-0 desk:w-full desk:aspect-[5/1] desk:max-h-[min(13.75rem,26vh)] desk:rounded-xl short:hidden"
        />
      ) : null}
      <div
        data-cover={hasCover ? "image" : "none"}
        className={cn(
          "flex gap-4 desk:gap-6",
          hasCover
            ? // On a short screen, the no-cover row below (the banner is hidden there).
              "flex-col desk:flex-row desk:items-end desk:px-6 short:flex-row short:flex-wrap short:items-center short:px-0 short:pt-2 short:desk:flex-nowrap"
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
          tileClassName="outline-4 -outline-offset-4 outline-surface-page max-desk:text-3xl"
          className={cn(
            // In front of the cover: the banner is positioned, so the icon needs its own
            // stacking position to paint over the banner's lower edge (§4.20). pk-vt-hero-icon:
            // the tile's icon flies into it with the art and the name (MO-05).
            "pk-vt-hero-icon relative z-10 max-desk:size-20",
            // Half the tile over the cover: pinned to the row's top, not its end, on desktop.
            hasCover &&
              "-mt-10 desk:-mt-16 desk:self-start short:mt-0 short:self-auto",
          )}
        />
        <div className="min-w-0 flex-1 space-y-2 desk:pb-1">
          {/* pk-vt-hero-title: the tile's name flies into it and back (MO-05). As wide as its
              text, like the tile's name, or the shared snapshot stretches (S-23 §3.4 item 4). */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            dir="auto"
            className="pk-vt-hero-title w-fit max-w-full text-headline font-semibold leading-tight text-fg-strong outline-none [overflow-wrap:anywhere] desk:text-4xl"
          >
            {product.name}
          </h1>
          {/* A quiet non-issue status ("From signing in") reads as text after a dot, like the
              tier; the dot ends the text run before it, never its own flex item. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
            {pres.developer ? (
              <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                by{" "}
                <span dir="auto" className="font-medium text-accent-fg">
                  {pres.developer}
                </span>
                {trailingDot && !tier ? dot : null}
              </span>
            ) : null}
            {tier ? (
              <span>
                {pres.developer ? (
                  <span aria-hidden className="me-2">
                    ·
                  </span>
                ) : null}
                {tier}
                {trailingDot ? dot : null}
              </span>
            ) : null}
            <ProductStatusPill
              status={product.status}
              className={isIssueStatus(product.status) ? "ms-auto" : undefined}
            />
          </div>
        </div>
        <div
          data-product-actions=""
          className="flex gap-2 max-desk:w-full desk:pb-1"
        >
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
            entry={product.kind === "entry"}
            onRemove={onRemove}
            triggerRef={menuTriggerRef}
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-border-strong text-fg-strong hover:bg-hover"
          />
        </div>
      </div>
    </div>
  );
}
