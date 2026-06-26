import type {
  CreateManualProductBody,
  CreateManualProductResult,
  LinkRepoResult,
  ProductDetail,
  ProductModuleSummary,
  ProductOnboarding,
  ProductSetupAction,
  ProductSetupState,
  ProductSigningBundle,
  RotateKeyResult,
} from "../../api.js";

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

export interface NormalizedProductModule {
  id: string;
  label: string;
  description: string | null;
  status: string;
  configured: boolean | null;
  missing: string[];
}

/** Normalize module arrays or keyed module objects from product/setup/onboarding payloads. */
export function modulesOf(
  product: Pick<ProductDetail, "modules" | "setup" | "onboarding">,
): NormalizedProductModule[] {
  return normalizeModules(
    product.modules ?? product.onboarding?.modules ?? product.setup?.modules,
  );
}

export function setupStateOf(
  product: Pick<ProductDetail, "setup" | "onboarding">,
): ProductSetupState | null {
  return product.setup ?? product.onboarding?.setup ?? null;
}

export function onboardingOf(
  product: Pick<ProductDetail, "onboarding">,
): ProductOnboarding | null {
  return product.onboarding ?? null;
}

export function nextActionsOf(
  product: Pick<ProductDetail, "setup" | "onboarding">,
): ProductSetupAction[] {
  const actions =
    product.setup?.nextActions ??
    product.onboarding?.nextActions ??
    product.onboarding?.setup?.nextActions;
  if (!Array.isArray(actions)) return [];
  return actions.map((action, index) =>
    typeof action === "string"
      ? { id: `action-${index}`, label: action }
      : action,
  );
}

function normalizeModules(value: unknown): NormalizedProductModule[] {
  if (Array.isArray(value))
    return value.map((item, index) => normalizeModule(String(index), item));
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, item]) => normalizeModule(key, item));
}

function normalizeModule(key: string, item: unknown): NormalizedProductModule {
  if (typeof item === "boolean") {
    return {
      id: key,
      label: titleize(key),
      description: null,
      status: item ? "configured" : "missing",
      configured: item,
      missing: [],
    };
  }
  if (typeof item === "string") {
    return {
      id: key,
      label: titleize(key),
      description: null,
      status: item,
      configured: null,
      missing: [],
    };
  }
  const record: ProductModuleSummary = isRecord(item)
    ? (item as ProductModuleSummary)
    : {};
  const id = firstString(record.id, record.key, key) ?? key;
  const configured =
    typeof record.configured === "boolean"
      ? record.configured
      : typeof record.enabled === "boolean"
        ? record.enabled
        : null;
  const missing = [
    ...stringList(record.missing),
    ...stringList(record.missingSecrets),
  ];
  return {
    id,
    label: firstString(record.label, record.name, titleize(id)) ?? titleize(id),
    description: firstString(record.description) ?? null,
    status:
      firstString(record.status) ??
      (configured === false || missing.length
        ? "missing"
        : configured
          ? "configured"
          : "unknown"),
    configured,
    missing,
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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function titleize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Format an epoch-seconds timestamp as a short, locale-aware date (or an em-dash if absent). */
export function formatDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "—";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** A non-empty trimmed string or `undefined` — keeps optional body fields out of the wire. */
export function trimmedOrUndefined(value: string): string | undefined {
  const t = value.trim();
  return t === "" ? undefined : t;
}

/** Parse an integer field; returns `undefined` for blank/non-numeric input. */
export function intOrUndefined(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Best-effort detection of a likely-valid slug. The server is the authority, but catching the
 * obvious cases (blank, spaces, uppercase, illegal chars) before the round-trip gives a fast,
 * inline error.
 */
export function slugError(slug: string): string | null {
  const t = slug.trim();
  if (t === "") return "A slug is required.";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t))
    return "Use lowercase letters, digits, and hyphens.";
  return null;
}

/**
 * The schema textarea accepts JSON or YAML. We only *validate* JSON here (and pass a parsed
 * object straight through); anything that isn't JSON is forwarded as a raw string so the
 * server's YAML parser can take it. Returns a parse error only for malformed JSON that
 * nonetheless looks like JSON (starts with `{`/`[`).
 */
export function parseSchemaField(raw: string): {
  value: CreateManualProductBody["schema"];
  error: string | null;
} {
  const t = raw.trim();
  if (t === "") return { value: undefined, error: null };
  const looksJson = t.startsWith("{") || t.startsWith("[");
  if (looksJson) {
    try {
      return {
        value: JSON.parse(t) as CreateManualProductBody["schema"],
        error: null,
      };
    } catch {
      return { value: undefined, error: "Schema is not valid JSON." };
    }
  }
  // Treat as raw (YAML or a server-understood string form).
  return { value: t, error: null };
}

/** Coerce an unknown API error into a human-readable, possibly multi-line message. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; fields?: string[] };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (Array.isArray(e.fields) && e.fields.length)
      parts.push(e.fields.join(", "));
    if (parts.length) return parts.join(" — ");
  }
  return "Request failed.";
}
