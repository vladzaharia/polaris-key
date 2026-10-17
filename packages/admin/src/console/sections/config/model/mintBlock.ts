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

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : x,
  );

const normal = (b: MintBlock): string =>
  canonical({
    alg: b.alg,
    signingKeySecret: b.signingKeySecret,
    kid: b.kid || null,
    audience: b.audience || null,
    ttlSeconds: b.ttlSeconds ?? 3600,
    requires: b.requires ?? "licensed",
    requiredEntitlement: b.requiredEntitlement || null,
    claimsTemplate: b.claimsTemplate ?? {},
  });

/**
 * True when the draft's `mint` block differs from the stored recipe: an edit that reverted to the
 * stored values is no edit. Without a stored recipe any block counts.
 */
export function mintEdited(
  entry: ConfigEntry,
  recipe: EdgeMintRecipe | null | undefined,
): boolean {
  if (!entry.mint) return false;
  if (!recipe) return true;
  return normal(entry.mint) !== normal(blockFromRecipe(recipe));
}
