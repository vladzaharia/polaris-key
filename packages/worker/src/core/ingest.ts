/**
 * The manifest-ingestion seam (design spec §5.1: "the webhook/resync pipeline stays
 * core-owned").
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * `linkRepo` and `resyncRepo` live under `services/release/` because a repo link IS the release
 * service's front door — the GitHub coordinates it needs, the installation token it mints, the
 * `.pkey/` files it reads. But what they WRITE is the whole product: the `products` row, the
 * catalog, the signing key, tiers, profiles, provisioning, OIDC, edge-mint recipes. Almost none
 * of that is Release's data (spec §5.2).
 *
 * A service may import `core/` and nothing else (`test/boundaries.test.ts`), so those writers
 * have to be reachable through Core or the ingestion path could not live in a service at all.
 * This file is that door, and — like `core/data.ts` — it is deliberately a COUNTABLE list: the
 * complete inventory of what the ingest may touch, in one core-owned file, so widening it is a
 * visible edit here rather than an unnoticed new import inside a service.
 *
 * Nothing is defined here. Every symbol keeps its definition (and its comments) in `repo.ts` or
 * `admin/repo.ts`; adding behaviour to a re-export module is how a façade becomes a second
 * implementation.
 */

export {
  getActiveSchema,
  getProduct,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  setServices,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertReleaseConfig,
  stmtInsertSchema,
  stmtInsertTier,
  upsertProductSyncState,
  type ProductRow,
} from "../repo.js";

export {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  listProfiles,
  listTiers,
  nextSchemaVersion,
  stmtDeactivateSchemas,
} from "../admin/repo.js";

/**
 * R12-02's envelope encryption, opened to the manifest ingest.
 *
 * These three were console-only: `applyOverrides` (the profile/override editor) was the single
 * caller, so a value that arrived through `.pkey/product`'s `licensing.profiles[].payload`
 * instead of through the console was written to `profiles.payload_json` in CLEARTEXT — under a
 * catalog key the product itself declares `kind: "secret"`. The same push also OVERWROTE
 * whatever an operator had rotated the value to, which is an incident response silently
 * reverted by a routine repo commit. Both ingest paths (`linkRepo`, `resyncRepo`) now seal on
 * write and refuse to clobber an already-sealed stored value, and they reach the helpers
 * through this door because a service may not import `admin/` directly.
 */
export {
  isManagedSecretKey,
  isSealedEnvelope,
  managedValueMatches,
  sealManagedValue,
} from "../admin/lib/managedSecrets.js";
