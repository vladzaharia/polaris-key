import * as React from "react";
import type { ConfigEntry } from "../../../../api.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { codecs, Link, navigate, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { useEdgeMint } from "../data.js";
import { reviewHref, usePendingRecipes } from "../model/pending.js";

/** True for a minted-token entry: the only kind that carries a recipe. */
export const isMinted = (e: ConfigEntry): boolean => e.delivery === "edgeMint";

/** A minted token's approval state, as a pill beside its key; nothing for any other entry. */
export function RecipePill({
  slug,
  entry,
}: {
  slug: string;
  entry: ConfigEntry;
}): React.ReactElement | null {
  const recipe = useEdgeMint(slug).data?.recipes?.find(
    (x) => x.id === entry.key,
  );
  if (!isMinted(entry) || !recipe) return null;
  return <StatusPill domain="edgeMint" state={recipe.status} size="sm" />;
}

/** The recipe's approval state and the way to the approve drawer, for a minted key's drawer. */
export function RecipeApproval({
  slug,
  entry,
}: {
  slug: string;
  entry: ConfigEntry;
}): React.ReactElement | null {
  const recipe = useEdgeMint(slug).data?.recipes?.find(
    (x) => x.id === entry.key,
  );
  if (!isMinted(entry) || !recipe) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm font-medium text-fg-strong">Recipe</span>
      <StatusPill domain="edgeMint" state={recipe.status} size="sm" />
      <Link
        to={r.catalogEntry(slug, entry.key, true)}
        className="inline-flex min-h-6 items-center text-sm text-accent-fg underline underline-offset-2"
      >
        {recipe.status === "approved" ? "View approval" : "Review and approve"}
      </Link>
    </div>
  );
}

/** "Review recipe": the one pending recipe, or the catalog when there are several or none. */
export function ReviewRecipeLink({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const pending = usePendingRecipes(slug).recipes;
  return (
    <Link
      to={reviewHref(slug, pending)}
      className="text-sm text-accent-fg underline underline-offset-2"
    >
      Review recipe
    </Link>
  );
}

/**
 * The old Edge mint address lands on the catalog with `?review=1`: with exactly one recipe
 * awaiting approval it goes straight to that recipe's drawer; otherwise the parameter just drops.
 */
export function ReviewJump({ slug }: { slug: string }): null {
  const [review] = useSearchParam("review", codecs.string());
  const { recipes, ready } = usePendingRecipes(slug);
  React.useEffect(() => {
    if (!review || !ready) return;
    navigate(reviewHref(slug, recipes), { replace: true });
  }, [review, ready, slug, recipes]);
  return null;
}
