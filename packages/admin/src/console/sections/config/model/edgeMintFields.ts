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
  ttlSeconds: "Token lifetime",
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

/** Who may mint, as the editor words it. */
export const REQUIRES_LABELS: Record<EdgeMintRecipe["requires"], string> = {
  licensed: "A device with a usable license",
  registered: "Any device of this product",
  none: "Anyone",
};

const REQUIRES_RANK = { licensed: 0, registered: 1, none: 2 } as const;

/** A lifetime in words: "1 hour", "90 minutes", "45 seconds". */
export function lifetime(seconds: number | null): string {
  if (seconds === null) return "Not set";
  const unit = (n: number, one: string): string =>
    `${n} ${one}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/**
 * What a change allows that the last approval did not: a longer lifetime, a wider "who may mint".
 * `null` for a narrowing or unchanged recipe, and for one never approved.
 */
export function widening(recipe: EdgeMintRecipe): string | null {
  const was = recipe.approval;
  if (!was) return null;
  const lines: string[] = [];
  if (
    typeof recipe.ttlSeconds === "number" &&
    typeof was.ttlSeconds === "number" &&
    recipe.ttlSeconds > was.ttlSeconds
  )
    lines.push(
      `A leaked token works for ${lifetime(recipe.ttlSeconds)} instead of ${lifetime(was.ttlSeconds)}.`,
    );
  if (REQUIRES_RANK[recipe.requires] > REQUIRES_RANK[was.requires])
    lines.push(
      recipe.requires === "none"
        ? "Anyone can now mint it."
        : "Any device of this product can now mint it, licensed or not.",
    );
  return lines.length ? lines.join(" ") : null;
}

/** A field value as the operator reads it: a lifetime in units, who may mint in words, "Not set". */
export function readable(
  field: keyof EdgeMintRecipeFields,
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (field === "ttlSeconds") return lifetime(Number(value));
  if (field === "requires")
    return (
      REQUIRES_LABELS[value as EdgeMintRecipe["requires"]] ?? String(value)
    );
  return String(value);
}

/** A claims template as pretty JSON lines (the raw text when it does not parse). */
export function claimLines(json: string | null | undefined): string[] {
  if (json === null || json === undefined || json === "") return [];
  try {
    return JSON.stringify(JSON.parse(json), null, 2).split("\n");
  } catch {
    return json.split("\n");
  }
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** A line diff of two line lists (longest common subsequence). */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
  const t = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i]![j] =
        a[i] === b[j]
          ? t[i + 1]![j + 1]! + 1
          : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!)
      out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
