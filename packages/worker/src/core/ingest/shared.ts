/**
 * What the ingest contributors and the dry runs share (P0-26): the pure refusals, the profile
 * secret carry-forward, the tier/profile row ids of a snapshot, and the audit-guard helpers.
 * Moved verbatim from `services/release/resync.ts` (which re-exports them until P0-26b removes the
 * dry runs' use of them).
 */

import { Catalog } from "@polaris-key/catalog";
import { SYSTEM_ACTORS } from "../audit.js";
import { catalogDeliveryIssues } from "../configDelivery.js";
import type { Db, DbParam, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { secret } from "../../platform/env.js";
import { listProfiles, TIER_COMPARED_PARAMS } from "../licensing/store.js";
import { type TierRow } from "../repo.js";
import {
  auditValue,
  stmtSettingAudit,
  unlessClaimed,
  type ClaimKey,
} from "../settingsClaims.js";
import { isManagedSecretKey, isSealedEnvelope } from "../managedSecrets.js";
import { parsePayload } from "../console/redact.js";
import { getPublisherPolicy } from "../publisher.js";
import type { ParsedManifest } from "@polaris-key/manifest";
import {
  managedSecretKeyPredicate,
  parseStoredCatalog,
  sealedProfilePayload,
} from "./manifestSecrets.js";

/** Is this safe to interpolate into the installer? (`services/release/install.ts` `BINARY_NAME_RE`.) */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isSafeBinaryName = (value: string): boolean =>
  BINARY_NAME_RE.test(value);

/**
 * R9-01, at ingest, fail-closed (create) and on change (apply): the OIDC issuer's host must be
 * on the operator's allowlist. The refusal message, or `null`.
 */
export function manifestIssuerRefusal(env: Env, issuer: string): string | null {
  const hosts = (secret(env, "OIDC_ISSUER_ALLOWLIST") ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  let host: string | null = null;
  try {
    host = new URL(issuer).host.toLowerCase();
  } catch {
    host = null;
  }
  if (host !== null && hosts.includes(host)) return null;
  return (
    `oidc.issuer ${JSON.stringify(issuer)} is not in OIDC_ISSUER_ALLOWLIST; ` +
    `a platform operator must allowlist that host before a repo manifest can point ` +
    `this product's identity provider at it`
  );
}

/** The tier and profile ids a stored snapshot declared (ST-01b: claim vs conflict). */
export function snapshotRowIds(json: string | undefined): {
  tiers: Set<string>;
  profiles: Set<string>;
} {
  const ids = (v: unknown): Set<string> =>
    new Set(
      Array.isArray(v)
        ? v
            .map((x) =>
              x && typeof x === "object" ? (x as { id?: unknown }).id : null,
            )
            .filter((id): id is string => typeof id === "string")
        : [],
    );
  if (!json) return { tiers: new Set(), profiles: new Set() };
  try {
    const m = JSON.parse(json) as { tiers?: unknown; profiles?: unknown };
    return { tiers: ids(m.tiers), profiles: ids(m.profiles) };
  } catch {
    return { tiers: new Set(), profiles: new Set() };
  }
}

/** Licences that list a profile directly (`license_profiles`), the referrer a tier is not. */
export async function countLicensesListingProfile(
  db: Db,
  product: string,
  profileId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM license_profiles WHERE product = ? AND profile_id = ?",
    product,
    profileId,
  );
  return r?.n ?? 0;
}

/** A comparable rendering of a tier's manifest-owned columns (stored row or insert params). */
export function tierShape(t: TierRow | DbStatement["params"]): string {
  if (Array.isArray(t))
    // stmtInsertTier's params: product, id, label, profile, expiry, limit, channels, min, max,
    // fingerprint, rank, offline grace (LX-08), modifiedAt.
    return JSON.stringify(t.slice(...TIER_COMPARED_PARAMS));
  return JSON.stringify([
    t.label,
    t.profile_id,
    t.policy_expiry_days,
    t.policy_device_limit,
    t.channels_json,
    t.min_version,
    t.max_version,
    t.policy_fingerprint ?? null,
    t.rank ?? 0,
    t.policy_offline_grace_days ?? null,
  ]);
}

/** The resync audit row for one tier or profile the batch adds, changes or removes. */
export function rowAudit(
  product: string,
  now: number,
  kind: "tier" | "profile",
  id: string,
  what: "added" | "changed" | "removed",
): DbStatement {
  return stmtSettingAudit(
    product,
    now,
    SYSTEM_ACTORS.resync,
    "setting.resync",
    kind,
    id,
    `${kind === "tier" ? "Tier" : "Profile"} ${id} ${what} by the manifest`,
  );
}

// ── The manifest-written fields' audit rows ──────────────────────────────────

/** A condition an audit row must still meet when the batch runs, as SQL with its params. */
export interface OwnerGuard {
  sql: string;
  params: DbParam[];
}

/**
 * True while the row's `*_source` marker still says the manifest owns it (an absent marker reads
 * as the manifest's): the predicate each ownership-claimable statement carries in its own `WHERE`,
 * so a claim made after the resync read the row skips the audit row of the write it skipped.
 * Only ever called with column and table names that are code constants.
 */
export function manifestOwned(
  product: string,
  table: string,
  keyColumn: string,
  sourceColumn: string,
): OwnerGuard {
  return {
    sql: `COALESCE((SELECT ${sourceColumn} FROM ${table} WHERE ${keyColumn} = ?), 'manifest') = 'manifest'`,
    params: [product],
  };
}

/**
 * `stmt` (a single-row `INSERT INTO t (cols) VALUES (...)`) rewritten to insert nothing once
 * `guard` fails: `unlessClaimed`'s counterpart for the `*_source` markers.
 */
export function whileManifestOwned(
  stmt: DbStatement,
  guard: OwnerGuard,
): DbStatement {
  const m = /^(\s*INSERT INTO [^(]+\([^)]*\))\s*VALUES\s*\(([^)]*)\)\s*$/s.exec(
    stmt.sql,
  );
  if (!m)
    throw new Error("whileManifestOwned: not a single-row INSERT ... VALUES");
  return {
    sql: `${m[1]} SELECT ${m[2]} WHERE ${guard.sql}`,
    params: [...stmt.params, ...guard.params],
  };
}

/** The payload bucket the console writes a catalog entry's value into (`applyOverrides`). */
const BUCKET_OF_KIND = {
  secret: "secrets",
  config: "config",
  flag: "entitlements",
} as const;
type Bucket = (typeof BUCKET_OF_KIND)[keyof typeof BUCKET_OF_KIND];

/**
 * A manifest profile payload with the secret values its stored predecessor held carried forward
 * (R2). A stored entry is carried only when all three hold:
 *
 *   - the INCOMING catalog still declares its key a managed secret (`isManagedSecretKey`: a
 *     `secret` entry, or a `config` entry flagged `secret: true`), in the bucket that kind is
 *     stored in. What the push says about the catalog decides, not the shape of the old value:
 *     a key the new catalog drops, or stops calling secret, is not carried;
 *   - the stored value is a sealed envelope (R12-02). A plaintext value is never carried — it
 *     is either a pre-sealing row or a value a manifest once wrote, and neither is a secret the
 *     console vouches for;
 *   - the manifest's own map for that bucket does not declare the key. The manifest stays the
 *     last word on anything it actually says.
 *
 * Carried values are copied verbatim, never opened or re-sealed, so the stored ciphertext and its
 * `updatedAt` are unchanged.
 */
export function withStoredSecrets(
  manifestPayload: Record<string, unknown>,
  storedJson: string | undefined,
  catalog: Catalog,
): Record<string, unknown> {
  if (storedJson === undefined) return manifestPayload;
  const stored = parsePayload(storedJson);
  const keep =
    (bucket: Bucket) =>
    (key: string, entry: { value?: unknown } | undefined): boolean => {
      const meta = catalog.entryByKey(key);
      return (
        meta !== undefined &&
        isManagedSecretKey(catalog, key) &&
        BUCKET_OF_KIND[meta.kind] === bucket &&
        isSealedEnvelope(entry?.value)
      );
    };
  const next: Record<string, unknown> = { ...manifestPayload };
  let changed = false;
  for (const bucket of ["secrets", "config", "entitlements"] as const) {
    const merged = carried(
      stored[bucket],
      manifestPayload[bucket],
      keep(bucket),
    );
    if (merged) {
      next[bucket] = merged;
      changed = true;
    }
  }
  return changed ? next : manifestPayload;
}

/** One bucket of `withStoredSecrets`: the stored entries `keep` selects and the manifest does
 *  not declare, under the manifest's own entries. `null` when nothing is carried. */
function carried(
  stored: Record<string, { value?: unknown } | undefined>,
  declared: unknown,
  keep: (key: string, entry: { value?: unknown } | undefined) => boolean,
): Record<string, unknown> | null {
  const own: Record<string, unknown> =
    declared && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : {};
  const kept = Object.entries(stored).filter(
    ([key, entry]) => !Object.hasOwn(own, key) && keep(key, entry),
  );
  if (kept.length === 0) return null;
  return { ...Object.fromEntries(kept), ...own };
}

/**
 * R9-01, at ingest. `oidc_config` is the one manifest-owned row with no admin-ownership flag:
 * `applyRepoManifest` DELETEs and re-INSERTs it unconditionally, so a `.pkey/product` push can
 * repoint the IdP that receives this product's OIDC `client_secret`. Only a NEW or CHANGED issuer
 * is gated — an issuer already stored in D1 is re-applied untouched, because flipping the security
 * posture of a running product on the deploy that ships this code is its own outage, and the
 * attack is the *change*, not the status quo. `provider: "platform"` products (e.g. `djdl`) store
 * no issuer and never reach the gate; a push that TRIES to move such a product to a custom issuer
 * is a change from `""` and is gated like any other. The refusal message, or `null`.
 */
export async function issuerChangeRefusal(
  env: Env,
  db: Db,
  slug: string,
  manifest: ParsedManifest,
): Promise<string | null> {
  if (manifest.oidc?.provider !== "custom") return null;
  const stored = await db.first<{ issuer: string | null }>(
    "SELECT issuer FROM oidc_config WHERE product = ?",
    slug,
  );
  // Raw string comparison, not host comparison: any edit to the value — a new host, a new
  // path, a new port — is a change, and a change is what gets gated.
  if ((stored?.issuer ?? "") === manifest.oidc.issuer) return null;
  return manifestIssuerRefusal(env, manifest.oidc.issuer);
}

/**
 * R6-01 defence in depth: the release block's binary name (the repo name when the manifest
 * leaves it out, which bypasses the manifest's own boundary) must be safe. The refusal message,
 * or `null` (also when the manifest has no release block).
 */
export function unsafeBinaryNameRefusal(
  manifest: ParsedManifest,
  repo: string,
): string | null {
  if (!manifest.release) return null;
  return binaryNameRefusal(manifest.release.binaryName || repo);
}

/** The refusal for an unsafe binary name, or `null`. */
export function binaryNameRefusal(binaryName: string): string | null {
  if (isSafeBinaryName(binaryName)) return null;
  return `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`;
}

/**
 * The Sparkle verification key is what proves a DMG is authentic: the update feed verifies every
 * `.sig` sidecar against `release_config.sparkle_ed25519_pub` and drops an item that does not
 * verify, so a push that swaps the key makes the pusher's own signature the one the feed accepts.
 * Refused on the CHANGE, like the issuer gate, not on the status quo: setting the key where none is
 * stored and clearing it stay allowed (with no key the feed fails closed unless an operator opted
 * the product out of signature checks, so clearing costs a repo writer the feed rather than
 * winning it).
 *
 * Nothing else writes this column: `release.sparkleEd25519Pub` is manifest-owned and the console
 * has no writer for it. So the way to rotate it on purpose is the pair of pushes the refusal
 * names, remove it and then set the new one. That is friction, not a loophole: the removal is an
 * audit row and the feed is dark in between, so a rotation is visible instead of silent. The
 * refusal message, or `null`.
 */
export function sparkleKeyRefusal(
  manifest: ParsedManifest,
  storedKey: string | null | undefined,
  slug: string,
): string | null {
  const next = manifest.release?.sparkleEd25519Pub || "";
  if (!next || !storedKey || next === storedKey) return null;
  return `manifest replaces the stored Sparkle public key for ${slug}; a repo push may not swap the key that authenticates this product's builds in one step. To rotate it on purpose, push .pkey/release with sparkleEd25519Pub removed (the update feed fails closed while no key is set), then push the new key`;
}

/**
 * The sealed-secret refusal `applyRepoManifest` reaches when it builds the profile rows (a manifest
 * value that would replace an already-sealed one, or one that cannot be sealed), asked up front
 * against the profiles as they stand, for the link check and the resync dry run. Writes nothing.
 * `incomingCatalog` is the manifest's; the stored one joins it, as the apply does. The profile the
 * refusal is about and its message, or `null`.
 */
export async function profileSecretsRefusal(
  env: Env,
  db: Db,
  slug: string,
  manifest: ParsedManifest,
  incomingCatalog: Catalog,
  storedCatalogJson: string | null | undefined,
): Promise<{ profile: string; error: string } | null> {
  const storedCatalog = parseStoredCatalog(storedCatalogJson);
  const isSecretKey = managedSecretKeyPredicate(
    storedCatalog ? [incomingCatalog, storedCatalog] : [incomingCatalog],
  );
  const storedProfiles = await listProfiles(db, slug);
  const stored = new Map(storedProfiles.map((p) => [p.id, p]));
  for (const profile of manifest.profiles) {
    // A console row holding the id is kept and the manifest's is not applied.
    const row = stored.get(profile.id);
    if (row?.source === "console") continue;
    const sealed = await sealedProfilePayload(
      env,
      slug,
      profile.id,
      profile.payload,
      isSecretKey,
      row?.payload_json,
    );
    if (!sealed.ok) return { profile: profile.id, error: sealed.error };
  }
  return null;
}

/**
 * Build the manifest's catalog and, when it changed, apply the same screening the admin API
 * applies before writing `product_schema`. A resync is triggered by a repo webhook, so without
 * this the sync path installs catalogs the admin API would refuse — and the refusal is the only
 * thing bounding `pattern` complexity. Built INSIDE the try: the manifest validator does not
 * prove every entry is an object (a Config-off product's `entries: [null]` gets through), and the
 * constructor reads them; a throw would escape `resyncRepo` and, on a webhook, abort the whole
 * per-product loop with no sync-state row.
 */
export function screenCatalog(
  manifest: ParsedManifest,
  catalogChanged: boolean,
): { ok: true; catalog: Catalog } | { ok: false; error: string } {
  try {
    const catalog = new Catalog(manifest.catalog as never);
    if (catalogChanged) {
      catalog.compileAll();
      const bad = catalogDeliveryIssues(catalog.entries);
      if (bad.length > 0) throw new Error(bad.join("; "));
    }
    return { ok: true, catalog };
  } catch (e) {
    return {
      ok: false,
      error: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

export interface ManifestPublisher {
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  workflow: string;
  environment: string;
}

/**
 * P2-02 — the trusted-publisher policy the manifest asks for. An operator-claimed policy
 * (`source = 'admin'`) is never touched: no lookup, and `next` stays `null`. Otherwise a declared
 * `trustedPublisher` needs the repository's numeric ids from GitHub; a failed lookup refuses the
 * push (it runs before the first write, so nothing is half-applied). Writes nothing.
 */
export async function resolveManifestPublisher(
  db: Db,
  slug: string,
  manifest: ParsedManifest,
  identityOf: () => Promise<{ id: number; ownerId: number; fullName: string }>,
): Promise<
  | {
      ok: true;
      current: Awaited<ReturnType<typeof getPublisherPolicy>>;
      claimed: boolean;
      next: ManifestPublisher | null;
    }
  | { ok: false; error: string }
> {
  const current = await getPublisherPolicy(db, slug);
  const claimed = current?.source === "admin";
  const declared = manifest.release?.trustedPublisher ?? null;
  if (!declared || claimed) return { ok: true, current, claimed, next: null };
  try {
    const identity = await identityOf();
    return {
      ok: true,
      current,
      claimed,
      next: {
        repositoryId: identity.id,
        repositoryOwnerId: identity.ownerId,
        repository: identity.fullName,
        workflow: declared.workflow,
        environment: declared.environment,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not resolve the repository's ids for publishing.trustedPublisher: ${err instanceof Error ? err.message : "github lookup failed"}`,
    };
  }
}

/**
 * The per-field resync audit (S-18 §4.6) one contributor writes: `auditSetting` collects rows in
 * `audits`. A claimable key's row carries the same in-statement guard as its write, so a claim
 * made after `claims` was read leaves neither the write nor an audit row claiming it happened. A
 * key owned through a `*_source` marker gets the same from its marker (`ownedBy`).
 */
export function settingAuditor(
  slug: string,
  now: number,
  sha: string | null,
): {
  audits: DbStatement[];
  auditSetting: (
    key: string,
    before: unknown,
    after: unknown,
    claimKey?: ClaimKey | null,
    ownedBy?: OwnerGuard | null,
  ) => void;
} {
  const audits: DbStatement[] = [];
  const auditSetting = (
    key: string,
    before: unknown,
    after: unknown,
    claimKey: ClaimKey | null = null,
    ownedBy: OwnerGuard | null = null,
  ): void => {
    const stmt = stmtSettingAudit(
      slug,
      now,
      SYSTEM_ACTORS.resync,
      "setting.resync",
      "setting",
      key,
      `${key} set from the manifest${sha ? ` at ${sha.slice(0, 12)}` : ""}: ${auditValue(before)} → ${auditValue(after)}`,
      // ST-04: the structured before/after beside the summary.
      { before, after },
    );
    audits.push(
      claimKey
        ? unlessClaimed(stmt, slug, claimKey, now)
        : ownedBy
          ? whileManifestOwned(stmt, ownedBy)
          : stmt,
    );
  };
  return { audits, auditSetting };
}
