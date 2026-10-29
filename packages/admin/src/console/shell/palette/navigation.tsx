import * as React from "react";
import { Box } from "lucide-react";
import {
  featureOfSection,
  navItems,
  pageOf,
  platformItems,
  platformLinks,
  SETTINGS_HUB_PAGES,
  visibleSections,
  type GlobalPageId,
  type NavFeatures,
  type NavSection,
  type ProductPageId,
  type ServiceState,
} from "../../nav.js";
import { landingPage } from "../../access/can.js";
import { globalPage, navHref, productPage } from "../../routes.js";
import type { ProductLike } from "../bits.js";
import { filterItems } from "./rank.js";
import type { LinkPaletteItem, PaletteSource } from "./types.js";

/** A section as the operator knows it: the feature's name, never "Core" or a service's. */
export function sectionWords(section: NavSection): string {
  return featureOfSection(section.key)?.label ?? "Product";
}

/**
 * One product's pages as palette rows: every page of its enabled sections, then the settings
 * hub's tabs (Features, Keys and secrets, Members…), which are not sidebar items but are pages a
 * person types for. `across` is for a product that is not on screen (the palette opened from
 * Home): the product leads the detail and its name and slug are searchable.
 */
export function productPageRows(
  slug: string,
  productName: string | null,
  services: ServiceState,
  features: NavFeatures = null,
  across = false,
): LinkPaletteItem[] {
  const name = productName ?? slug;
  const items: LinkPaletteItem[] = [];
  const row = (
    p: ReturnType<typeof pageOf>,
    words: string,
    hub: boolean,
  ): LinkPaletteItem => {
    const Icon = p.icon;
    return {
      id: `nav:${slug}:${p.page}`,
      group: "Pages",
      label: p.paletteLabel ?? p.label,
      detail: across ? `${name} · ${words}` : `${words} · ${name}`,
      keywords: `${words} ${slug}${across ? ` ${name}` : ""}${hub ? " settings" : ""}${p.paletteLabel ? ` ${p.label}` : ""}${p.keywords ? ` ${p.keywords}` : ""}`,
      icon: <Icon aria-hidden className="size-4" />,
      shortcut: !across && p.shortcut ? `g ${p.shortcut}` : undefined,
      href: navHref(slug, p),
      // A settings tab is found by typing it, not listed untyped.
      ...(hub || across ? { matchOnly: true } : {}),
    };
  };
  for (const section of visibleSections(services)) {
    for (const p of navItems(section, features))
      items.push(row(p, sectionWords(section), false));
  }
  const listed = new Set(items.map((i) => i.id));
  for (const id of SETTINGS_HUB_PAGES) {
    const p = pageOf(id);
    if (!listed.has(`nav:${slug}:${p.page}`))
      items.push(row(p, "Settings", true));
  }
  return items;
}

/**
 * The navigation source (components.md §1.5, EXPERIENCE.md §0.3 J-1): every built page of the
 * current product's enabled sections first, then Home and Products, then the Platform section's
 * pages. Platform rows are `Platform`-grouped, which the palette shows only on a query match.
 * Nothing a product does not run is offered.
 */
export function navigationSource(
  slug: string | null,
  productName: string | null,
  services: ServiceState,
  features: NavFeatures = null,
): LinkPaletteItem[] {
  const items = slug
    ? productPageRows(slug, productName, services, features)
    : [];
  const global: LinkPaletteItem[] = platformLinks().map((p) => {
    const Icon = p.icon;
    return {
      id: `nav:${p.page}`,
      group: "Pages",
      label: p.label,
      detail: "Platform",
      keywords: "platform",
      icon: <Icon aria-hidden className="size-4" />,
      shortcut: p.page === "home" ? "g h" : undefined,
      href: globalPage(p.page as GlobalPageId),
    };
  });
  // ST-34.11: Personal tokens left the sidebar for the account menu, and stays findable here.
  const tokens = pageOf("personal-tokens");
  const TokensIcon = tokens.icon;
  global.push({
    id: "nav:personal-tokens",
    group: "Pages",
    label: tokens.label,
    detail: "Account",
    keywords: "account token pkey login cli packages pkeyp",
    icon: <TokensIcon aria-hidden className="size-4" />,
    href: globalPage("personal-tokens"),
  });
  for (const p of platformItems()) {
    const Icon = p.icon;
    global.push({
      id: `nav:${p.page}`,
      group: "Platform",
      label: p.label,
      detail: "Platform",
      keywords: p.keywords ? `platform ${p.keywords}` : "platform",
      icon: <Icon aria-hidden className="size-4" />,
      href: globalPage(p.page as GlobalPageId),
    });
  }
  // Off a product the global pages are all there is; on one, its own pages lead.
  return slug ? [...items, ...global] : global;
}

/** The products source: jump to any product's Overview. */
export function productSource(
  products: ProductLike[],
  landing: (slug: string, services: ServiceState) => ProductPageId = () =>
    "overview",
): LinkPaletteItem[] {
  return products.map((p) => ({
    id: `product:${p.slug}`,
    group: "Products",
    label: p.name,
    detail: p.slug,
    keywords: `${p.slug} product`,
    icon: <Box aria-hidden className="size-4" />,
    // A narrowed member lands on a page they can open (B-016).
    href: productPage(
      p.slug,
      landing(
        p.slug,
        ("services" in p ? (p.services ?? null) : null) as ServiceState,
      ),
    ),
    product: p,
  }));
}

/** Rows shown from products that are not on screen: enough to find one, never a wall. */
export const ACROSS_PRODUCTS_MAX = 8;

/**
 * From Home (no product on screen) a typed query also finds product pages and settings tabs in
 * any of the operator's products: "secret" finds Keys and secrets, each row naming its product.
 * Typed only, best first, capped.
 */
export function productPagesAcross(
  products: ProductLike[],
  query: string,
): LinkPaletteItem[] {
  if (query.trim() === "") return [];
  const rows = products.flatMap((p) =>
    productPageRows(
      p.slug,
      p.name,
      "services" in p ? (p.services ?? null) : null,
      null,
      true,
    ),
  );
  return filterItems(rows, query).slice(
    0,
    ACROSS_PRODUCTS_MAX,
  ) as LinkPaletteItem[];
}

export const productPagesAcrossPaletteSource: PaletteSource = {
  id: "product-pages",
  useItems: (ctx, query) =>
    ctx.slug === null ? productPagesAcross(ctx.products, query) : [],
};

export const navigationPaletteSource: PaletteSource = {
  id: "navigation",
  useItems: (ctx) => [
    ...navigationSource(ctx.slug, ctx.productName, ctx.services, ctx.features),
    ...accountSource(ctx.me.breakGlass === true),
  ],
};

/** The signed-in person's own page: not in the sidebar, so ⌘K is how a keyboard reaches it. */
export function accountSource(emergency: boolean): LinkPaletteItem[] {
  // An emergency session has no account behind it, so it has no methods to manage.
  if (emergency) return [];
  const page = pageOf("sign-in-methods");
  const Icon = page.icon;
  return [
    {
      id: "nav:sign-in-methods",
      group: "Pages",
      label: page.label,
      detail: "Account",
      keywords: `account ${page.keywords ?? ""}`,
      icon: <Icon aria-hidden className="size-4" />,
      href: globalPage("sign-in-methods"),
    },
  ];
}

export const productsPaletteSource: PaletteSource = {
  id: "products",
  useItems: (ctx) =>
    productSource(ctx.products, (slug, services) =>
      landingPage(ctx.me, slug, services),
    ),
};
