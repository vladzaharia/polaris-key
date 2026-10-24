import type { AttentionItemDto } from "../../../../api.js";
import { useAttention } from "../../../data/hooks.js";
import { r } from "../../../routes.js";

/**
 * The minted-token recipes of one product that await an operator's approval, from the server's
 * attention read (`mint.pending` items carry the recipe id in their action's query).
 */
export function pendingRecipesOf(
  items: readonly AttentionItemDto[] | undefined,
  slug: string,
): string[] {
  return (items ?? [])
    .filter((i) => i.kind === "mint.pending" && i.product?.slug === slug)
    .map((i) => i.action.query?.recipe)
    .filter((id): id is string => typeof id === "string");
}

/** The product's pending recipes; `ready` once the attention read has answered. */
export function usePendingRecipes(slug: string): {
  recipes: string[];
  ready: boolean;
} {
  const attention = useAttention();
  return {
    recipes: pendingRecipesOf(attention.data, slug),
    ready: attention.isSuccess,
  };
}

/** Straight to the recipe when exactly one awaits approval; the catalog when there are several. */
export function reviewHref(slug: string, pending: string[]): string {
  return pending.length === 1
    ? r.catalogEntry(slug, pending[0]!, true)
    : r.catalog(slug);
}
