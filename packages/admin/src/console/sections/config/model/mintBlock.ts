import type { MintBlock } from "@polaris-key/catalog";
import type { ConfigEntry, EdgeMintRecipe } from "../../../../api.js";

/** The longest a minted token lives, in seconds (the Worker's own ceiling). */
export const MINT_TTL_MAX = 3600;

/** The recipe the Worker stores, as an entry's `mint` block. */
export function blockFromRecipe(recipe: EdgeMintRecipe): MintBlock {
  let claims: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = recipe.claimsTemplateJson
      ? JSON.parse(recipe.claimsTemplateJson)
      : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      claims = parsed as Record<string, unknown>;
  } catch {
    claims = undefined;
  }
  return {
    alg: recipe.alg,
    signingKeySecret: recipe.signingKeySecret,
    ...(recipe.kid ? { kid: recipe.kid } : {}),
    ...(claims && Object.keys(claims).length > 0
      ? { claimsTemplate: claims }
      : {}),
    ttlSeconds: recipe.ttlSeconds,
    ...(recipe.audience ? { audience: recipe.audience } : {}),
    requires: recipe.requires,
    ...(recipe.requiredEntitlement
      ? { requiredEntitlement: recipe.requiredEntitlement }
      : {}),
  };
}

/** What the form shows: the draft's block, else the stored recipe, else an empty ES256 one. */
export function blockOf(
  entry: ConfigEntry,
  recipe: EdgeMintRecipe | null | undefined,
): MintBlock {
  if (entry.mint) return entry.mint;
  if (recipe) return blockFromRecipe(recipe);
  return { alg: "ES256", signingKeySecret: "" };
}

/** The entry with its `mint` block set (an edit; an untouched entry carries none). */
export function withMint(entry: ConfigEntry, mint: MintBlock): ConfigEntry {
  return { ...entry, mint };
}
