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
 * Nothing is defined here. Every symbol keeps its definition (and its comments) in `repo.ts`,
 * `admin/repo.ts`, `edgeMintApproval.ts`, `admin/lib/redact.ts` or `admin/lib/managedSecrets.ts`;
 * adding behaviour to a re-export module is how a façade becomes a second implementation.
 */

export {
  getActiveSchema,
  getProduct,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  stmtDeleteManifestProfile,
  stmtDeleteManifestTier,
  stmtDeleteOrphanEdgeMintApprovals,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertReleaseConfig,
  stmtInsertSchema,
  stmtInsertTier,
  stmtSetAutoIssuePolicy,
  stmtSetFingerprintPolicy,
  stmtSetServices,
  stmtUpsertManifestProfile,
  stmtUpsertManifestTier,
  upsertProductSyncState,
  type ProductRow,
  type TierRow,
} from "../repo.js";

export { invalidateWidenedEdgeMintApprovals } from "./edgeMintApproval.js";

export {
  countLicensesUsingTier,
  listProfiles,
  listTiers,
  nextSchemaVersion,
} from "../admin/repo.js";

// R2: the resync reads a surviving profile's stored payload to carry its secret values forward,
// asking the incoming catalog which keys are still managed secrets. Readers only; sealing stays
// with the console's write path.
export { parsePayload } from "../admin/lib/redact.js";
export {
  isManagedSecretKey,
  isSealedEnvelope,
} from "../admin/lib/managedSecrets.js";

// ST-01b: the resync skips the settings the console has claimed (`product_settings`), and writes
// one audit row per setting it changes.
// ST-20: a break-glass claim (manifest-authoritative mode) ends at the first apply that changes
// its field, and a resync of the system product is refused (the deploy hook is its writer).
export {
  auditValue,
  claimedKeys,
  claimGuardParams,
  CLAIMED_SQL,
  claimsForApply,
  endBreakGlassStatements,
  RESYNC_ACTOR,
  stmtSettingAudit,
  systemResyncRefusal,
  unlessClaimed,
  type BreakGlassClaim,
  type ClaimKey,
  type EndedBreakGlass,
} from "./settingsClaims.js";
export { getManifestSnapshot } from "./manifestSnapshot.js";
export { parseWebOrigins } from "./cors.js";
