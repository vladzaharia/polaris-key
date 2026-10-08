import { PRODUCT_SLUG_MAX, PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import type {
  CreateManualProductResult,
  LinkRepoResult,
  ProductDetail,
  ProductSigningBundle,
  RotateKeyResult,
} from "../api.js";

/** The release source of a product, preferably supplied by the backend. */
export type ReleaseSource = "github" | "manual";

export function releaseSourceOf(
  product: Pick<ProductDetail, "releaseSource">,
): ReleaseSource {
  return normalizeReleaseSource(product.releaseSource) ?? "manual";
}

function normalizeReleaseSource(value: unknown): ReleaseSource | null {
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  if (
    source === "github" ||
    source === "gh" ||
    source === "repo" ||
    source === "repository"
  )
    return "github";
  if (source === "manual") return "manual";
  return null;
}

type ProductKeyCarrier = Partial<
  ProductDetail & CreateManualProductResult & LinkRepoResult & RotateKeyResult
> & {
  product?: ProductDetail | null;
};

export interface ResolvedSigningBundle {
  kid: string | null;
  alg: string | null;
  publicKey: string | null;
  jwksUrl: string | null;
  jwks: unknown | null;
  trustKeys: Record<string, string>;
}

/** Resolve the current signing/trust-key bundle. */
export function signingBundleOf(
  input: ProductKeyCarrier | null | undefined,
): ResolvedSigningBundle {
  const product = input?.product ?? null;
  const bundles = [input?.signing, product?.signing].filter(
    isRecord,
  ) as ProductSigningBundle[];

  const kid = firstString(input?.kid, ...bundles.map((b) => b.kid)) ?? null;
  const publicKey =
    firstString(...bundles.flatMap((b) => [b.publicKey, b.publicKeyPem])) ??
    null;
  const trustKeys = mergeTrustKeys(...bundles.map((b) => b.trustKeys));
  if (kid && publicKey && !trustKeys[kid]) trustKeys[kid] = publicKey;

  return {
    kid,
    alg: firstString(...bundles.map((b) => b.alg)) ?? null,
    publicKey: publicKey ?? (kid ? (trustKeys[kid] ?? null) : null),
    jwksUrl: firstString(...bundles.map((b) => b.jwksUrl)) ?? null,
    jwks: firstDefined(...bundles.map((b) => b.jwks)) ?? null,
    trustKeys,
  };
}

function mergeTrustKeys(...values: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [key, publicKey] of Object.entries(value)) {
      if (typeof publicKey === "string" && publicKey.trim())
        out[key] = publicKey;
    }
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown | undefined {
  return values.find((value) => value !== undefined && value !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Best-effort detection of a likely-valid slug. The server is the authority, but catching the
 * obvious cases (blank, spaces, uppercase, illegal chars, too long) before the round-trip gives
 * a fast, inline error. Mirrors the one product slug shape in `@polaris-key/manifest` (P0-14).
 */
export function slugError(slug: string): string | null {
  const t = slug.trim();
  if (t === "") return "A slug is required.";
  if (t.length > PRODUCT_SLUG_MAX)
    return `A slug has at most ${PRODUCT_SLUG_MAX} characters.`;
  if (!PRODUCT_SLUG_RE.test(t))
    return "Use lowercase letters, digits, and hyphens.";
  return null;
}
