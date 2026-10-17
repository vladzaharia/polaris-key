import type { ProductDetail } from "../../../../api.js";
import { r } from "../../../routes.js";

/** The minted-token recipes that await an operator's approval, from the product's setup state. */
export function pendingRecipes(p: ProductDetail | undefined): string[] {
  const modules = p?.setup?.modules;
  if (!Array.isArray(modules)) return [];
  const edge = modules.find((m) => m.id === "edgeMint") as
    | { pendingApproval?: unknown }
    | undefined;
  return Array.isArray(edge?.pendingApproval)
    ? (edge.pendingApproval as string[])
    : [];
}

/** Straight to the recipe when exactly one awaits approval; the catalog when there are several. */
export function reviewHref(slug: string, pending: string[]): string {
  return pending.length === 1
    ? r.catalogEntry(slug, pending[0]!, true)
    : r.catalog(slug);
}

/** The checklist's "Review" action for a product's pending recipes. */
export function reviewAction(
  slug: string,
  p: ProductDetail,
): { label: string; href: string } {
  return { label: "Review", href: reviewHref(slug, pendingRecipes(p)) };
}
