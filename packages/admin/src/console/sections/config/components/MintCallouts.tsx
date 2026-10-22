import * as React from "react";
import { KeyRound } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Unlocked } from "../../../../ui/WriteLock.js";
import { codecs, useSearchParam } from "../../../router.js";
import { useEdgeMint } from "../data.js";
import { changedLabel } from "../model/edgeMintFields.js";
import { blockOf, mintEdited, withMint } from "../model/mintBlock.js";
import { ttlLabel } from "../model/mintView.js";
import { AddSigningKey, needsKey } from "./RecipeState.js";

/**
 * What stops a minted token from minting, at the head of its entry card
 * (config.entry-minted-token): the approval it waits for, or the signing key it lacks. Both are
 * warnings, because minting is stopped in both.
 */
export function MintCallouts({
  slug,
  entry,
  onChange,
}: {
  slug: string;
  entry: ConfigEntry;
  onChange: (next: ConfigEntry) => void;
}): React.ReactElement | null {
  const [, setRecipeId] = useSearchParam("recipe", codecs.string());
  const stored = useEdgeMint(slug).data?.recipes;
  const recipe =
    stored === undefined
      ? undefined
      : (stored.find((x) => x.id === entry.key) ?? null);
  const [addingKey, setAddingKey] = React.useState(false);
  if (!recipe) return null;
  const block = blockOf(entry, recipe);
  const edited = mintEdited(entry, recipe);
  const keyless = needsKey(recipe);
  const approved = recipe.approval ?? null;
  const ttlOnly =
    recipe.status === "changed" &&
    recipe.changedFields.length === 1 &&
    recipe.changedFields[0] === "ttlSeconds";
  return (
    <>
      {recipe.status !== "approved" ? (
        <Callout
          tone="warning"
          title={
            ttlOnly && approved && !edited
              ? `Lifetime changed from ${ttlLabel(approved.ttlSeconds)} to ${ttlLabel(recipe.ttlSeconds)}`
              : "Minting is stopped until you approve"
          }
          action={
            edited ? undefined : (
              // Reading the recipe is open to a view-only member; the drawer gates Approve.
              <span className="flex flex-wrap items-center gap-2">
                {ttlOnly && approved ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      onChange(
                        withMint(entry, {
                          ...block,
                          ttlSeconds: approved.ttlSeconds,
                        }),
                      )
                    }
                  >
                    Keep {ttlLabel(approved.ttlSeconds)}
                  </Button>
                ) : null}
                <Unlocked>
                  <Button
                    size="sm"
                    variant="outline"
                    data-recipe-opener=""
                    onClick={() => setRecipeId(entry.key)}
                  >
                    Review and approve…
                  </Button>
                </Unlocked>
              </span>
            )
          }
        >
          {edited
            ? "Your unpublished edits aren't part of the saved recipe. Publish the catalog, then approve it."
            : ttlOnly
              ? "Minting is stopped until you approve."
              : recipe.status === "changed" && recipe.changedFields.length > 0
                ? `Changed since approval: ${recipe.changedFields.map(changedLabel).join(", ")}.`
                : null}
        </Callout>
      ) : null}
      {keyless ? (
        <Callout
          tone="warning"
          title="Minting hasn't started: no signing key"
          action={
            <Button
              size="sm"
              variant="outline"
              iconStart={<KeyRound aria-hidden />}
              onClick={() => setAddingKey(true)}
            >
              Add the key…
            </Button>
          }
        >
          The recipe is approved, but a repository never holds the key. Until it
          is added, the app's{" "}
          <code className="font-mono text-xs">mintToken("{entry.key}")</code>{" "}
          calls fail.
        </Callout>
      ) : null}
      <AddSigningKey
        slug={slug}
        recipe={recipe}
        replace={false}
        open={addingKey}
        onOpenChange={setAddingKey}
      />
    </>
  );
}
