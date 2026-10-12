import type {
  EdgeMintIdentity,
  EdgeMintRecipe,
  EdgeMintRecipeFields,
} from "../../../../api.js";

/** The labels of the recipe fields an approval is pinned to. */
export const FIELD_LABELS: Record<keyof EdgeMintRecipeFields, string> = {
  alg: "Algorithm",
  signingKeySecret: "Signing secret",
  kid: "Key id (kid)",
  claimsTemplateJson: "Claims template",
  ttlSeconds: "Token lifetime (seconds)",
  audience: "Audience",
  requires: "Who may mint",
  requiredEntitlement: "Required entitlement",
};

/** The order the fields are shown in. */
export const FIELD_ORDER: (keyof EdgeMintRecipeFields)[] = [
  "alg",
  "signingKeySecret",
  "kid",
  "audience",
  "ttlSeconds",
  "requires",
  "requiredEntitlement",
  "claimsTemplateJson",
];

const REASON_LABELS: Record<string, string> = {
  registration: "Registration opened",
  license: "License turned off",
  identity: "Sign-in trust changed",
};

/** The sign-in identity rows shown beside a recipe. */
export const IDENTITY_ROWS: [string, keyof EdgeMintIdentity][] = [
  ["Provider", "provider"],
  ["Issuer", "issuer"],
  ["Client id", "clientId"],
  ["Group map", "groupRoleMapJson"],
];

/** The pinned fields of a recipe, without the approval bookkeeping around them. */
export function fieldsOf(recipe: EdgeMintRecipeFields): EdgeMintRecipeFields {
  return {
    alg: recipe.alg,
    signingKeySecret: recipe.signingKeySecret,
    kid: recipe.kid,
    claimsTemplateJson: recipe.claimsTemplateJson,
    ttlSeconds: recipe.ttlSeconds,
    audience: recipe.audience,
    requires: recipe.requires,
    requiredEntitlement: recipe.requiredEntitlement,
  };
}

/** A field value as text: an em dash for an absent one. */
export const show = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "—" : String(value);

/** What a changed-field name reads as: a reason label, a field label, or the name itself. */
export function changedLabel(
  field: EdgeMintRecipe["changedFields"][number],
): string {
  return (
    REASON_LABELS[field] ??
    FIELD_LABELS[field as keyof EdgeMintRecipeFields] ??
    field
  );
}
