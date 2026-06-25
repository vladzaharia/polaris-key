/**
 * `.pkey/` manifest parser — pure parsing + validation, NO database writes.
 *
 * A product's release coordinates and catalog live in a `.pkey/` directory in its repo
 * (or are supplied inline for manual product creation). The directory holds MULTIPLE
 * files, each independently JSON or YAML:
 *
 *   - `schema.{json,yaml,yml}`  → a `ProductCatalog` ({schemaVersion, entries[]}).
 *   - `product.{json,yaml,yml}` → product meta + `oidc` + `tiers[]` + `provisioning[]`.
 *   - `release.{json,yaml,yml}` → the `release` block + `edgeMint[]`.
 *
 * `parseManifest` accepts the raw file contents keyed by base name (no extension),
 * detects JSON vs YAML per file, validates the pieces, and returns a `ParsedManifest`
 * carrying the same data `products/gen-seed.ts` writes to D1 — but it performs no DB
 * writes itself. A later agent consumes `ParsedManifest` for the inserts.
 *
 * Validation aggregates ALL problems into `errors` rather than failing on the first.
 */

import { Catalog, type ProductCatalog } from "@polaris-key/catalog";
import { parse as parseYaml } from "yaml";

// ── Parsed shapes (mirroring products/djdl/*.json) ───────────────────────────

/** Product meta — the `products` row minus signing fields (assigned at registration). */
export interface ManifestProduct {
  slug: string;
  name: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultMachineLimit: number;
  adminGroup: string;
}

/** OIDC config block (`oidc_config` row). */
export interface ManifestOidc {
  issuer: string;
  clientId: string;
  clientSecretSecret: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}

/** A license tier (`tiers` row). */
export interface ManifestTier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyMachineLimit: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

/** A reusable managed-payload profile (`profiles` row). */
export interface ManifestProfile {
  id: string;
  name: string;
  description?: string | null;
  payload: Record<string, unknown>;
}

/** A provisioning hook (`provisioning_config` row). */
export interface ManifestProvisioning {
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}

/** The release-distribution block (`release_config` row, GitHub coordinates). */
export interface ManifestRelease {
  ghOwner: string;
  ghRepo: string;
  binaryName: string;
  channelWorkflow: string;
  betaBranch: string;
  summaryMarker: string;
  sparkleEd25519Pub: string;
}

/** An edge-mint signer (`edge_mint_config` row). */
export interface ManifestEdgeMint {
  id: string;
  alg: string;
  signingKeySecret: string;
  kid?: string;
  claimsTemplate: Record<string, unknown>;
  ttlSeconds: number;
  audience?: string | null;
}

/** Everything a `.pkey/` directory resolves to, ready for DB insertion by a later step. */
export interface ParsedManifest {
  product: ManifestProduct;
  catalog: ProductCatalog;
  oidc?: ManifestOidc;
  profiles: ManifestProfile[];
  tiers: ManifestTier[];
  provisioning: ManifestProvisioning[];
  release?: ManifestRelease;
  edgeMint: ManifestEdgeMint[];
}

export type ParseManifestResult =
  | { ok: true; manifest: ParsedManifest }
  | { ok: false; errors: string[] };

// ── Parsing helpers ──────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Parse one raw file as JSON, falling back to YAML. Detection is "try JSON first" because
 * every JSON document is also valid YAML — but JSON.parse is stricter and faster, so a
 * successful JSON.parse is authoritative; only on JSON failure do we hand the text to the
 * `yaml` parser (pure-JS, workerd-safe). Returns the parsed value or an error string.
 */
function parseDocument(
  name: string,
  raw: string,
): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // not JSON — fall through to YAML
  }
  try {
    return { value: parseYaml(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${name}: not valid JSON or YAML (${msg})` };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function nestedProductDoc(p: Record<string, unknown>): Record<string, unknown> {
  return isObject(p.product) ? p.product : p;
}

function normalizeCatalog(parsed: unknown): ProductCatalog | null {
  if (!isObject(parsed)) return null;
  if (Array.isArray(parsed.entries)) return parsed as unknown as ProductCatalog;
  if (Array.isArray(parsed.catalog)) {
    return {
      schemaVersion: Number(parsed.schemaVersion ?? 1),
      entries: parsed.catalog,
    } as unknown as ProductCatalog;
  }
  return null;
}

function normalizeTier(raw: unknown): ManifestTier | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const channels = Array.isArray(raw.channels)
    ? (raw.channels.filter((c) => typeof c === "string") as string[])
    : [];
  return {
    id: raw.id,
    label: String(raw.label ?? raw.id),
    profileId:
      typeof raw.profileId === "string"
        ? raw.profileId
        : typeof raw.profile === "string"
          ? raw.profile
          : null,
    policyExpiryDays:
      typeof raw.policyExpiryDays === "number"
        ? raw.policyExpiryDays
        : typeof raw.expiryDays === "number"
          ? raw.expiryDays
          : null,
    policyMachineLimit:
      typeof raw.policyMachineLimit === "number"
        ? raw.policyMachineLimit
        : typeof raw.machineLimit === "number"
          ? raw.machineLimit
          : null,
    channels,
    minVersion: typeof raw.minVersion === "string" ? raw.minVersion : null,
    maxVersion: typeof raw.maxVersion === "string" ? raw.maxVersion : null,
  };
}

function normalizeProfile(raw: unknown): ManifestProfile | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    name: String(raw.name ?? raw.label ?? raw.id),
    description: typeof raw.description === "string" ? raw.description : null,
    payload: asObject(raw.payload),
  };
}

function normalizeEdgeMint(raw: unknown): ManifestEdgeMint | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    alg: String(raw.alg ?? ""),
    signingKeySecret: String(raw.signingKeySecret ?? raw.signingKeyRef ?? ""),
    kid: typeof raw.kid === "string" ? raw.kid : undefined,
    claimsTemplate: asObject(raw.claimsTemplate),
    ttlSeconds: typeof raw.ttlSeconds === "number" ? raw.ttlSeconds : 3600,
    audience: typeof raw.audience === "string" ? raw.audience : null,
  };
}

/**
 * Parse a multi-file `.pkey/` manifest. `files` maps base names (no extension —
 * `"schema"`, `"product"`, `"release"`) to raw file contents. Each value may be JSON or
 * YAML. All validation errors are aggregated; on any failure `ok` is false.
 */
export function parseManifest(
  files: Record<string, string>,
): ParseManifestResult {
  const errors: string[] = [];

  // Parse each present document up front so syntax errors are surfaced once.
  const docs: Record<string, unknown> = {};
  for (const name of ["schema", "product", "release"] as const) {
    const raw = files[name];
    if (raw === undefined) continue;
    const res = parseDocument(name, raw);
    if ("error" in res) errors.push(res.error);
    else docs[name] = res.value;
  }

  // ── schema (required) → must construct a valid Catalog ──────────────────────
  let catalog: ProductCatalog | undefined;
  if (files.schema === undefined) {
    errors.push("schema: required (.pkey/schema.{json,yaml,yml} is missing)");
  } else if ("schema" in docs) {
    const parsed = docs.schema;
    const candidate = normalizeCatalog(parsed);
    if (!candidate) {
      errors.push(
        "schema: must be a ProductCatalog object with an `entries` array or v1 `catalog` array",
      );
    } else {
      try {
        new Catalog(candidate).compileAll();
        catalog = candidate;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`schema: invalid catalog fragment (${msg})`);
      }
    }
  }

  // ── product (required) → valid slug ─────────────────────────────────────────
  let product: ManifestProduct | undefined;
  let oidc: ManifestOidc | undefined;
  let profiles: ManifestProfile[] = [];
  let tiers: ManifestTier[] = [];
  let provisioning: ManifestProvisioning[] = [];
  if (files.product === undefined) {
    errors.push("product: required (.pkey/product.{json,yaml,yml} is missing)");
  } else if ("product" in docs) {
    const p = docs.product;
    if (!isObject(p)) {
      errors.push("product: must be an object");
    } else {
      const prod = nestedProductDoc(p);
      const licensing = asObject(p.licensing);
      const slug = prod.slug;
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
        errors.push(
          `product: invalid slug ${JSON.stringify(slug)} (must match ${SLUG_RE.source})`,
        );
      } else {
        product = {
          slug,
          name: String(prod.name ?? slug),
          compatMin: String(prod.compatMin ?? p.compatMin ?? "0.0.0"),
          compatMax: String(prod.compatMax ?? p.compatMax ?? "99.0.0"),
          defaultMaxOfflineDays: Number(
            prod.defaultMaxOfflineDays ??
              p.defaultMaxOfflineDays ??
              licensing.defaultMaxOfflineDays ??
              0,
          ),
          defaultMachineLimit: Number(
            prod.defaultMachineLimit ??
              p.defaultMachineLimit ??
              licensing.defaultMachineLimit ??
              0,
          ),
          adminGroup: String(prod.adminGroup ?? p.adminGroup ?? "admin"),
        };
      }
      if (p.oidc !== undefined) {
        if (!isObject(p.oidc)) errors.push("product.oidc: must be an object");
        else {
          const o = p.oidc;
          oidc = {
            issuer: String(o.issuer ?? ""),
            clientId: String(o.clientId ?? ""),
            clientSecretSecret: String(
              o.clientSecretSecret ?? o.clientSecretRef ?? "",
            ),
            redirectUris: Array.isArray(o.redirectUris)
              ? (o.redirectUris.filter(
                  (u) => typeof u === "string",
                ) as string[])
              : [],
            groupRoleMap: asObject(o.groupRoleMap),
          };
        }
      }
      const rawProfiles = p.profiles ?? licensing.profiles;
      if (rawProfiles !== undefined) {
        if (!Array.isArray(rawProfiles))
          errors.push("product.licensing.profiles: must be an array");
        else
          profiles = rawProfiles
            .map(normalizeProfile)
            .filter(Boolean) as ManifestProfile[];
      }
      const rawTiers = p.tiers ?? licensing.tiers;
      if (rawTiers !== undefined) {
        if (!Array.isArray(rawTiers))
          errors.push("product.licensing.tiers: must be an array");
        else
          tiers = rawTiers.map(normalizeTier).filter(Boolean) as ManifestTier[];
      }
      if (p.provisioning !== undefined) {
        if (!Array.isArray(p.provisioning))
          errors.push("product.provisioning: must be an array");
        else provisioning = p.provisioning as ManifestProvisioning[];
      }
    }
  }

  // ── release (optional) + edgeMint (optional, carried on the release doc) ─────
  let release: ManifestRelease | undefined;
  let edgeMint: ManifestEdgeMint[] = [];
  if ("release" in docs) {
    const r = docs.release;
    if (!isObject(r)) {
      errors.push("release: must be an object");
    } else {
      const rel = isObject(r.release) ? r.release : r;
      const provider = isObject(rel.provider) ? rel.provider : {};
      // `release` block fields. Carry them through even if partial — the DB-insert agent
      // applies its own column constraints; the parser only rejects a non-object shape.
      release = {
        ghOwner: String(
          (rel as Record<string, unknown>).ghOwner ?? provider.owner ?? "",
        ),
        ghRepo: String(
          (rel as Record<string, unknown>).ghRepo ?? provider.repo ?? "",
        ),
        binaryName: String((rel as Record<string, unknown>).binaryName ?? ""),
        channelWorkflow: String(
          (rel as Record<string, unknown>).channelWorkflow ?? "",
        ),
        betaBranch: String((rel as Record<string, unknown>).betaBranch ?? ""),
        summaryMarker: String(
          (rel as Record<string, unknown>).summaryMarker ?? "",
        ),
        sparkleEd25519Pub: String(
          (rel as Record<string, unknown>).sparkleEd25519Pub ?? "",
        ),
      };
      if (r.edgeMint !== undefined) {
        if (!Array.isArray(r.edgeMint))
          errors.push("release.edgeMint: must be an array");
        else
          edgeMint = r.edgeMint
            .map(normalizeEdgeMint)
            .filter(Boolean) as ManifestEdgeMint[];
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  // All required pieces validated above; the casts are sound here.
  return {
    ok: true,
    manifest: {
      product: product as ManifestProduct,
      catalog: catalog as ProductCatalog,
      oidc,
      profiles,
      tiers,
      provisioning,
      release,
      edgeMint,
    },
  };
}
