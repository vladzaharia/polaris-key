// Row types, and the platform-deploys reads. The queries moved to the owner stores (P0-18):
// `core/products/store.ts` (products, key custody, schema, registration), `core/licensing/store.ts`
// (licences, keys, tiers, profiles) and `core/devices/store.ts` (devices, seats, fingerprints);
// the audit trail to `core/audit.ts`. Every query is product-scoped (a mandatory `product`
// predicate on every statement) so a tenant boundary can't be crossed even on a logic bug, and
// takes the `Db` abstraction, so it unit-tests against in-memory SQLite and runs unchanged on D1.

import type { Db, DbParam, DbStatement } from "../db/types.js";

// ── Row types (mirror migrations/0001_init.sql) ──────────────────────────────
export interface ProductRow {
  slug: string;
  name: string;
  signing_kid: string;
  signing_pub: string | null;
  compat_min: string;
  compat_max: string;
  default_max_offline_days: number;
  default_device_limit: number;
  admin_group: string | null;
  /** Never written since ST-47; the column stays until a migration drops it. */
  branding_json?: string | null;
  release_source: string | null;
  status?: string;
  deleted_at?: number | null;
  // Fingerprint policy (migrations/0010_fingerprint.sql). `source` decides whether a manifest
  // resync may rewrite `fingerprint_policy_json` or must leave an operator's live edit alone.
  fingerprint_policy_json?: string | null;
  fingerprint_policy_source?: string;
  // Auto-issue policy (migrations/0011_auto_issue.sql), same ownership rules.
  auto_issue_json?: string | null;
  auto_issue_source?: string;
  // Polaris Key service enablement (migrations/0019+0020), same ownership rules again. Parsed by
  // `core/services.ts`; NULL reads back as the defaults (license + config).
  services_json?: string | null;
  services_source?: string | null;
  // Ownership of `compat_min`/`compat_max` (migrations/0022_a), same rules once more: NULL or
  // 'manifest' lets a resync rewrite the window, 'admin' (set by `update/settings`) makes it skip.
  compat_source?: string | null;
  // The per-product CORS allowlist (migrations/0024): a JSON array of exact origins from the
  // manifest's `web.origins`. Manifest-owned with no `_source` column — link writes it, every
  // resync rewrites it. NULL reads back as "no origin allowed". Parsed by `core/cors.ts`.
  web_origins_json?: string | null;
  /** 1 for the platform's own product (`SYSTEM_PRODUCT_SLUG`, migrations/0058_a), set only by
   *  the package-feeds bootstrap; delete and rename refuse it. */
  system?: number;
  // The device-trust policy (migrations/0053_d/e, P6-02): operator-owned, never written by an
  // ingest. NULL reads back as the default policy (`core/trust/deviceTrust.ts`).
  trust_policy_json?: string | null;
  trust_policy_source?: string;
  // `.pkey/product` `presentation` (migrations/0106, HA-12), as `serializePresentation` writes it
  // (`core/products.ts`). Manifest-only: link, resync and the system product's deploy hook write
  // it; NULL when undeclared. Read by `core/products.ts` for discovery's `core.presentation`.
  presentation_json?: string | null;
  created_at: number;
  modified_at: number;
}

// Sealed Ed25519 signing key material (migrations/0003_keyvault.sql). enc_private_json is a
// `JSON.stringify(Sealed)` blob opened under the platform KEK; public_b64url is the raw key.
export interface ProductKeyRow {
  product: string;
  kid: string;
  alg: string;
  public_b64url: string;
  enc_private_json: string;
  status: string;
  created_at: number;
  rotated_at: number | null;
  /** Stamped by the revoke action (0021); NULL for keys revoked before the column existed. */
  revoked_at: number | null;
}

// Sealed per-product secret (OIDC client secret, edge-mint key material, …).
export interface ProductSecretRow {
  product: string;
  name: string;
  enc_value_json: string;
  /**
   * What the secret may be used for (P0-12, migration 0025): NULL = general, `'edge-mint'` = an
   * operator marked it as edge-mint signing material. Set only through the admin API. On a
   * write, `undefined` leaves an existing row's usage alone (a new row is general).
   */
  usage?: string | null;
  created_at: number;
  modified_at: number;
}

export interface LicenseRow {
  product: string;
  id: string;
  status: string;
  sub: string | null;
  name: string | null;
  email: string | null;
  groups_json: string | null;
  tier_id: string | null;
  activated_at: number;
  expires_at: number | null;
  max_offline_days: number | null;
  overrides_json: string | null;
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  // How this license came into existence: admin | oidc | enroll (0011_auto_issue.sql).
  origin?: string;
  /** The hwid an enrolled license is bound to; NULL for every other origin. */
  enroll_hwid?: string | null;
  /**
   * Which issuer class produced `email` on this row: `'platform'` or `'custom'`
   * (0118_license_email_issuer.sql). Stamped at WRITE time by the OIDC lane from the provider that
   * was resolved for the sign-in, so a later manifest push cannot re-decide it; NULL = no issuer
   * vouched for the address (an admin-created, batch-created or enrolled licence), and the portal's
   * auto-link rules then read the product's live provider. INTERNAL: never in a developer-facing
   * response.
   */
  email_issuer_class?: string | null;
  /** I-05: the Polaris Key account the licence is attached to; NULL = floating. INTERNAL — the
   *  global account id never reaches a developer-facing response, so every shaper names the
   *  columns it emits. Written only through `core/accounts/accountSubjects.ts`. */
  account_id?: string | null;
  /** LX-14a (0084): the licence's own seat limit, a positive integer; NULL (or absent on a row
   *  read before the migration) inherits the tier, a `deviceLimit` entitlement, then the product
   *  default. Written only by the admin licence PATCH. */
  device_limit?: number | null;
  /** LX-28 (0095_b): the batch the licence was created in (`license_batches.id`); NULL (or absent
   *  on a row read before the migration) for every licence not created by a batch. Written only
   *  by the batch create (`services/license/batches.ts`). */
  batch_id?: string | null;
  /** LX-08 (0105_c) / LX-12: why a disabled licence ended (`revoked`, `superseded`, `refunded`,
   *  `chargeback`), written with the disable by `core/licensing/lifecycleWrites.ts`; NULL while
   *  active and on a licence disabled before LX-12. Read through `licenseLifecycleState`. */
  ended_reason?: string | null;
  /** LX-08 (0105_d): the licence that replaced this one (a merge's survivor); NULL otherwise. */
  superseded_by?: string | null;
  modified_by: string | null;
  modified_at: number;
}

export interface LicenseProfileRow {
  product: string;
  license_id: string;
  profile_id: string;
  sort_order: number;
}

export interface KeyRow {
  product: string;
  key_hash: string;
  license_id: string;
  status: string;
  label: string | null;
  created_at: number;
  created_by: string | null;
  last_used_at: number | null;
}

export interface DeviceRow {
  product: string;
  device_id: string;
  customer_id: string | null;
  license_id: string;
  status: string;
  first_seen: number;
  last_seen: number;
  ua: string | null;
  label: string | null;
  overrides_json: string | null;
  reported_json: string | null;
  token_hash: string | null;
  platform?: string | null;
  arch?: string | null;
  app_version?: string | null;
  sdk_name?: string | null;
  sdk_version?: string | null;
  /** R11-02 — the seat ordinal this device holds. NULL = holds no seat. Written only by
   *  `claimDeviceSeat`/`releaseDeviceSeat`; `upsertDevice` deliberately preserves it. */
  seat_no?: number | null;
  /** P6-02 — `basic` or `attested` (migrations/0053_a). Written only by `setDeviceTrust` and
   *  `resetDeviceTrust`; `upsertDevice` deliberately preserves it, like `seat_no`. */
  trust_level?: string;
  attested_at?: number | null;
  /** The last attestation verdict summary (never a raw token or attestation object). */
  attestation_json?: string | null;
  /** I-05 — the pairwise subject signed in on this device (S-17's binding), never the account
   *  id. Written only by `core/accounts/accountSubjects.ts` (`setDeviceSubject`, the clearing hook) and by
   *  `bindDevice`/`registerDeviceBinding` for a sign-in; `upsertDevice` preserves it. */
  subject?: string | null;
  /** I-05 — how the row was last bound: key | enroll | register | signin | store. NULL on rows
   *  written before migrations/0068_d. `upsertDevice` keeps the stored value when omitted. */
  bound_by?: DeviceBoundBy | null;
}

/** I-05 (plans/I-04.md §6.1): how a device row was last bound. */
export type DeviceBoundBy = "key" | "enroll" | "register" | "signin" | "store";

export interface ProfileRow {
  product: string;
  id: string;
  name: string;
  description: string | null;
  payload_json: string;
  modified_by: string | null;
  modified_at: number;
  /** ST-01b (0079): who owns the row. Absent on rows read before the migration ran. */
  source?: RowSource;
}

/**
 * ST-01b (migrations/0079): who owns a tier or profile row. A resync upserts only `manifest` rows
 * and leaves `console` rows (created or edited in the console) alone.
 */
export type RowSource = "manifest" | "console";

export interface TierRow {
  product: string;
  id: string;
  label: string;
  profile_id: string | null;
  policy_expiry_days: number | null;
  policy_device_limit: number | null;
  // Admin upgrade-channel + version-window policy (injected as enforced entitlements).
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  // Fingerprint enforcement strength for this tier; null inherits the product default.
  policy_fingerprint?: string | null;
  /** LX-08 (0105_g): higher is better (anchor choice, the OIDC group map, `syncTierOnSignIn`);
   *  0 by default. Optional only for rows built by hand. */
  rank?: number;
  /** LX-08 (0105_h): the tier default for a licence's offline grace (`max_offline_days`); NULL
   *  falls back to the product default. Stored for LX-09's `combined` mode. */
  policy_offline_grace_days?: number | null;
  /** LX-33.1 (0129): 1 marks the product's implicit Default tier (at most one per product); 0
   *  otherwise. No reader or writer yet. Optional because `upsertTier` callers build rows without it
   *  and the upsert must not write it. */
  implicit?: number;
  modified_by: string | null;
  modified_at: number;
  /** ST-01b (0079): who owns the row. */
  source?: RowSource;
}

// Current hardware fingerprint per device (migrations/0010_fingerprint.sql). One row per
// device — drift is recorded in `audit`, not kept as history here.
export interface FingerprintRow {
  product: string;
  device_id: string;
  hwid: string;
  components_json: string;
  anchor_hash: string | null;
  status: string;
  first_seen: number;
  last_seen: number;
  last_drift_at: number | null;
  last_drift_count: number | null;
  /** The first usable fingerprint bound to this device; never rewritten by drift. */
  baseline_components_json?: string | null;
  baseline_anchor_hash?: string | null;
  baseline_at?: number | null;
}

// Current software snapshot per device (migrations/0010_fingerprint.sql).
export interface DeviceFactsRow {
  product: string;
  device_id: string;
  os_name: string | null;
  os_version: string | null;
  os_build: string | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  ram_mb: number | null;
  machine_model: string | null;
  locale: string | null;
  timezone: string | null;
  runtime_name: string | null;
  runtime_version: string | null;
  probes_json: string | null;
  updated_at: number;
}

export interface SchemaRow {
  product: string;
  catalog_version: number;
  catalog_json: string;
  active: number;
  created_at: number;
}

export interface ProductSyncStateRow {
  product: string;
  source: string;
  status: string;
  last_checked_at: number;
  last_synced_at: number | null;
  commit_sha: string | null;
  changed_paths_json: string | null;
  updated_json: string | null;
  errors_json: string | null;
  message: string | null;
  /** ST-17: the `StoredSyncPlan` the last apply recorded (written by the ingest, not by `upsertProductSyncState`). */
  plan_json?: string | null;
}

// ── Platform deploys (A-11; written only by deploy.yml, read here) ─────────────────────────
export interface PlatformDeployRow {
  id: string;
  at: number;
  environment: string;
  tag: string;
  git_sha: string;
  run_url: string | null;
  scripts: string;
  latest_migration: string | null;
  cf_version_id: string | null;
  deltas_version_id: string | null;
  smoke: string | null;
}

export async function listPlatformDeploys(
  db: Db,
  opts: { beforeAt?: number; beforeId?: string; limit?: number } = {},
): Promise<PlatformDeployRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    return db.all<PlatformDeployRow>(
      `SELECT * FROM platform_deploys WHERE (at < ? OR (at = ? AND id < ?))
       ORDER BY at DESC, id DESC LIMIT ?`,
      opts.beforeAt,
      opts.beforeAt,
      opts.beforeId,
      limit,
    );
  }
  return db.all<PlatformDeployRow>(
    "SELECT * FROM platform_deploys ORDER BY at DESC, id DESC LIMIT ?",
    limit,
  );
}
