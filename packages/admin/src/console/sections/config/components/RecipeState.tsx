import * as React from "react";
import { AlertTriangle, KeyRound } from "lucide-react";
import type { ConfigEntry, EdgeMintRecipe } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { FormField } from "../../../../ui/form.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
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
  if (needsKey(recipe))
    return (
      <StatusPill tone="warning" icon={AlertTriangle} size="sm">
        Needs a signing key
      </StatusPill>
    );
  return <StatusPill domain="edgeMint" state={recipe.status} size="sm" />;
}

/** An approved recipe whose signing secret was never set: it cannot mint yet. */
export const needsKey = (recipe: EdgeMintRecipe): boolean =>
  recipe.status === "approved" && recipe.secretUsage === "missing";

/** Signing key, before one exists (config.entry-minted-token-no-key): dashed, and where to get it. */
export function SigningKeyEmpty({
  recipe,
}: {
  recipe: EdgeMintRecipe;
}): React.ReactElement {
  return (
    <section
      aria-label="Signing key"
      className="space-y-1 rounded-lg border border-dashed border-border-strong p-4"
    >
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg-strong">
        <KeyRound aria-hidden className="size-4 text-fg-muted" />
        No key yet
      </h3>
      <p className="text-sm text-fg-muted">
        Download the private key for{" "}
        {recipe.kid ? (
          <>
            Key ID <code className="font-mono text-xs">{recipe.kid}</code>
          </>
        ) : (
          "this recipe"
        )}{" "}
        from the provider's developer account. It is sealed as you add it and
        can't be read back.
      </p>
    </section>
  );
}

/**
 * Adds the signing key: the product secret the recipe names, created with usage edge-mint so the
 * operator never names a secret. Write-only: the value is never shown again.
 */
export function AddSigningKey({
  slug,
  recipe,
  replace = false,
  open,
  onOpenChange,
}: {
  slug: string;
  recipe: EdgeMintRecipe;
  /** The key exists: this swaps it. */
  replace?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) {
      setValue("");
      setFailure(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    if (!value.trim()) {
      setFailure("Paste the key.");
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await mutate(
        "putProductSecret",
        slug,
        recipe.signingKeySecret,
        value,
        "edge-mint",
      );
      toast.success(replace ? "Signing key replaced" : "Signing key added");
      onOpenChange(false);
    } catch (err) {
      setFailure(errorCopy(err, { thing: "The key" }).description);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!saving}
      unsaved={!saving && value !== ""}
      title={replace ? "Replace the signing key" : "Add the signing key"}
      description="Sealed as you add it. It is never shown again."
    >
      <form onSubmit={submit} noValidate>
        <DialogBody>
          <FormField
            name="signing-key"
            label="Private key"
            required
            error={failure ?? undefined}
            announceError
            value={value}
          >
            {(f) => (
              <Textarea
                {...f}
                mono
                rows={6}
                spellCheck={false}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {replace ? "Replace key" : "Add key"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
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
      className="py-1 text-sm text-accent-fg underline underline-offset-2"
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
