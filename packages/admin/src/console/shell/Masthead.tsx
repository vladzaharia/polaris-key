import * as React from "react";
import { ChevronRight } from "lucide-react";
import { PolarisMark, ServiceIcon } from "@polaris-key/brand/react";
import type { ProductPresentation } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { ProductLogo } from "../../ui/ProductLogo.js";
import type { MastheadCrumb, MastheadValue } from "../../ui/Masthead.js";
import {
  featureOfSection,
  isPlatformPage,
  isProductPage,
  pageOf,
  sectionOf,
  type PageId,
  type ServiceAccent,
} from "../nav.js";
import { Link } from "../router.js";
import { productPage, r, type Route } from "../routes.js";
import type { ProductLike } from "./bits.js";

type IconId = Parameters<typeof ServiceIcon>[0]["id"];

/**
 * The orientation chip (B4): names the context once. A feature's glyph on its accent, the
 * product's icon on its own Core pages, the Pinned K on the Platform and global pages. Decorative.
 */
function Chip({
  kind,
  accent,
  product,
}: {
  kind: "product" | "service" | "platform";
  accent: ServiceAccent;
  product: ProductLike | null;
}): React.ReactElement {
  if (kind === "product" && product) {
    return (
      <ProductLogo
        name={product.name}
        presentation={
          (product as { presentation?: ProductPresentation }).presentation
        }
        size={24}
        className="size-5 rounded-md"
      />
    );
  }
  if (kind === "platform") {
    return (
      <span
        data-service="core"
        className="inline-flex size-5 items-center justify-center rounded-md bg-accent-subtle text-accent-fg"
      >
        <PolarisMark kind="key" size={14} theme="mono" />
      </span>
    );
  }
  return (
    <span
      data-service={accent}
      className="inline-flex size-5 items-center justify-center rounded-md bg-accent text-accent-on"
    >
      <ServiceIcon id={accent as IconId} size={14} />
    </span>
  );
}

/** The 48 px flat tile (B4): a glyph on the accent, the product's icon, no glow. */
function Tile({
  kind,
  accent,
  product,
}: {
  kind: "product" | "service";
  accent: ServiceAccent;
  product: ProductLike | null;
}): React.ReactElement | null {
  if (kind === "product") {
    if (!product) return null;
    return (
      <ProductLogo
        name={product.name}
        presentation={
          (product as { presentation?: ProductPresentation }).presentation
        }
        size={48}
        className="rounded-xl"
      />
    );
  }
  return (
    <span
      data-service={accent}
      // BRAND.md §7.8: a flat tile (raised fill, 1 px accent border, glyph in the accent), never a
      // solid accent plate.
      className="inline-flex size-12 items-center justify-center rounded-xl border border-accent bg-surface-raised text-accent-fg light:border-accent-fg"
    >
      <ServiceIcon id={accent as IconId} size={24} />
    </span>
  );
}

/** The ONE orientation line: chip, the shell's ancestors, then the page's own (minus the page). */
export function Orientation({
  chip,
  base,
  extra,
  chipHiddenFromDesktop,
}: {
  chip: React.ReactNode;
  base: MastheadCrumb[];
  extra: MastheadCrumb[];
  chipHiddenFromDesktop: boolean;
}): React.ReactElement {
  // The h1 is the page: the page's own last crumb names it, so the line stops at its parent.
  const crumbs = [...base, ...extra.slice(0, -1)];
  return (
    <nav aria-label="Breadcrumb" data-orientation="">
      <ol className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-fg-muted">
        <li
          aria-hidden
          data-orientation-chip=""
          className={cn("flex", chipHiddenFromDesktop && "lg:hidden")}
        >
          {chip}
        </li>
        {crumbs.map((c, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {c.to ? (
              <Link
                to={c.to}
                className="-my-0.5 inline-flex min-h-6 items-center rounded-xs text-fg-muted underline-offset-4 hover:text-fg-strong hover:underline"
              >
                {c.label}
              </Link>
            ) : (
              <span>{c.label}</span>
            )}
            {i === crumbs.length - 1 ? null : (
              <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The ancestors the shell knows for a page: product, then feature. Never "Platform" on a product page. */
export function baseCrumbs(
  page: PageId | null,
  route: Route,
  product: ProductLike | null,
  platform = true,
): { crumbs: MastheadCrumb[]; chip: "product" | "service" | "platform" } {
  if (route.kind === "product" && page && isProductPage(page)) {
    const slug = route.slug;
    const name = product?.name ?? slug;
    const section = sectionOf(page)!;
    if (section.key === "core") {
      // Overview is the product itself: its parent is Home, so the chip is Home's, not the
      // product's logo (on a phone that read as "DJDL's logo, Home").
      return page === "overview"
        ? { crumbs: [{ label: "Home", to: r.home() }], chip: "platform" }
        : {
            crumbs: [{ label: name, to: r.overview(slug) }],
            chip: "product",
          };
    }
    const feature = featureOfSection(section.key);
    const first = section.items.find((p) => p.inNav) ?? section.items[0]!;
    return {
      crumbs: [
        { label: name, to: r.overview(slug) },
        {
          label: feature?.label ?? section.label,
          to: productPage(slug, first.page as never),
        },
      ],
      chip: "service",
    };
  }
  if (page && isPlatformPage(page)) {
    return { crumbs: [{ label: "Platform" }], chip: "platform" };
  }
  if (page === "home") {
    // products.home: the Pinned K chip and "Platform", the h1 is Home. A member without the
    // Platform area is not in "Platform" (the switcher calls their context "All products").
    return {
      crumbs: platform ? [{ label: "Platform" }] : [],
      chip: "platform",
    };
  }
  if (page) {
    return {
      crumbs: [{ label: "Home", to: r.home() }],
      chip: "platform",
    };
  }
  return { crumbs: [], chip: "platform" };
}

/** What the shell hands every `PageHeader` below it (B4). */
export function mastheadValue({
  route,
  page,
  accent,
  product,
  platform = true,
  refused = false,
}: {
  route: Route;
  page: PageId | null;
  accent: ServiceAccent;
  product: ProductLike | null;
  /** The member holds the Platform area (default: yes). */
  platform?: boolean;
  /** The page is NoAccessPage: the line stops at the context chip, with no page named. */
  refused?: boolean;
}): MastheadValue {
  const based = baseCrumbs(page, route, product, platform);
  const chip = based.chip;
  const crumbs = refused ? [] : based.crumbs;
  const tileKind = page ? pageOf(page).tile : undefined;
  const hasTile =
    tileKind !== undefined && (tileKind === "service" || product !== null);
  const record =
    page === "overview" ||
    ((route.kind === "product" || route.kind === "global") &&
      (route.id !== undefined || route.child !== undefined));
  return {
    accent,
    record,
    tile: hasTile ? (
      <Tile kind={tileKind!} accent={accent} product={product} />
    ) : null,
    orientation: (extra) => (
      <Orientation
        chip={<Chip kind={chip} accent={accent} product={product} />}
        base={crumbs}
        extra={refused ? [] : extra}
        chipHiddenFromDesktop={hasTile}
      />
    ),
  };
}
