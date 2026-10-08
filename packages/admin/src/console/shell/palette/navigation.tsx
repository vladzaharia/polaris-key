import * as React from "react";
import { Box } from "lucide-react";
import {
  navItems,
  type NavFeatures,
  platformItems,
  platformLinks,
  visibleSections,
  type GlobalPageId,
  type ProductPageId,
  type ServiceState,
} from "../../nav.js";
import { globalPage, productPage } from "../../routes.js";
import type { ProductLike } from "../bits.js";
import type { LinkPaletteItem, PaletteSource } from "./types.js";

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
  const items: LinkPaletteItem[] = [];
  if (slug) {
    for (const section of visibleSections(services)) {
      for (const p of navItems(section, features)) {
        const Icon = p.icon;
        items.push({
          id: `nav:${slug}:${p.page}`,
          group: "Pages",
          label: p.paletteLabel ?? p.label,
          detail: `${section.label} · ${productName ?? slug}`,
          keywords: `${section.label} ${slug}${p.paletteLabel ? ` ${p.label}` : ""}${p.keywords ? ` ${p.keywords}` : ""}`,
          icon: <Icon aria-hidden className="size-4" />,
          shortcut: p.shortcut ? `g ${p.shortcut}` : undefined,
          href: productPage(slug, p.page as ProductPageId),
        });
      }
    }
  }
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
  for (const p of platformItems()) {
    const Icon = p.icon;
    global.push({
      id: `nav:${p.page}`,
      group: "Platform",
      label: p.label,
      detail: "Platform",
      keywords: "platform",
      icon: <Icon aria-hidden className="size-4" />,
      href: globalPage(p.page as GlobalPageId),
    });
  }
  // Off a product the global pages are all there is; on one, its own pages lead.
  return slug ? [...items, ...global] : global;
}

/** The products source: jump to any product's Overview. */
export function productSource(products: ProductLike[]): LinkPaletteItem[] {
  return products.map((p) => ({
    id: `product:${p.slug}`,
    group: "Products",
    label: p.name,
    detail: p.slug,
    keywords: `${p.slug} product`,
    icon: <Box aria-hidden className="size-4" />,
    href: productPage(p.slug, "overview"),
    product: p,
  }));
}

export const navigationPaletteSource: PaletteSource = {
  id: "navigation",
  useItems: (ctx) =>
    navigationSource(ctx.slug, ctx.productName, ctx.services, ctx.features),
};

export const productsPaletteSource: PaletteSource = {
  id: "products",
  useItems: (ctx) => productSource(ctx.products),
};
