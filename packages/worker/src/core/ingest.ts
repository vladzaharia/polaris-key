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
  insertSchema,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  setServices,
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
  upsertProductSyncState,
  type ProductRow,
} from "../repo.js";

export { invalidateWidenedEdgeMintApprovals } from "./edgeMintApproval.js";

export {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  deactivateSchemas,
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
