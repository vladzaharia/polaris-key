/// <reference types="@cloudflare/workers-types" />

/**
 * Re-fetch a linked repo's manifest and re-apply it to an already-registered product. This is
 * the "resync" path: an operator pushes new manifest files and asks Polaris Key to pick up the
 * changes WITHOUT minting a new product or touching the signing key.
 *
 * Minimal-viable scope (diff-then-update): we re-parse the manifest and update the catalog
 * (new active schema version), the release block (channel/binary/marker/pub), and the OIDC +
 * tiers rows. The signing key, secrets, and edge-mint key material are NOT re-minted here, and
 * edge-mint APPROVALS are never written here (P0-12) — only orphaned ones are deleted.
 *
 * ST-01b (notes/S-18 §4.5, model C). Every check runs before the first write and every write goes
 * in ONE `db.batch`, so a refused resync writes nothing. A setting the console has claimed
 * (`product_settings`: the name, the licence defaults, the web origins, the catalog) is skipped;
 * tiers and profiles are applied per row, leaving `console` rows alone; and each setting or row
 * the batch changes gets its own `setting.resync` audit row.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db, DbStatement, Env } from "../../core/platform.js";
import {
  auditValue,
  claimGuardParams,
  CLAIMED_SQL,
  claimsForApply,
  endBreakGlassStatements,
  systemResyncRefusal,
  type BreakGlassClaim,
  countLicensesUsingTier,
  getActiveSchema,
  getManifestSnapshot,
  getProduct,
  invalidateWidenedEdgeMintApprovals,
  isManagedSecretKey,
  isSealedEnvelope,
  listProfiles,
  listTiers,
  liveRowClaimKeys,
  nextSchemaVersion,
  parsePayload,
  parseWebOrigins,
  RESYNC_ACTOR,
  stmtDeleteManifestProfile,
  stmtDeleteManifestTier,
  stmtDeleteOrphanEdgeMintApprovals,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProvisioning,
  stmtInsertSchema,
  stmtInsertTier,
  stmtSetAutoIssuePolicy,
  stmtSetFingerprintPolicy,
  stmtSetServices,
  stmtSettingAudit,
  stmtUpsertManifestProfile,
  stmtUpsertManifestTier,
  unlessClaimed,
  type ClaimKey,
  type ProductRow,
  type TierRow,
} from "../../core/ingest.js";
import { getReleaseConfig, type ReleaseConfigRow } from "./config.js";
import {
  parseManifest,
  type ManifestProfile,
  type ParsedManifest,
} from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { getRepoIdentity } from "./github.js";
import { isSafeBinaryName } from "./install.js";
import { manifestIssuerRefusal } from "./linkRepo.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import { releaseStoreSync } from "./sync.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import { manifestDeliverableStatements } from "./deliverables.js";
import { resolveAndStore, type StoreOutcome } from "./packs/sets.js";
import { enqueueReleaseMirrors } from "./mirror.js";
import { releaseKeysForSync } from "./records.js";
import { parseServices, serializeServices } from "../../core/services.js";
import type { ManifestIngest } from "../../core/registry.js";
import { serializeWebOrigins } from "../../core/cors.js";
import {
  applyServiceTransitions,
  MANIFEST_RESYNC_ACTOR,
} from "../../core/servicesTransitions.js";
import {
  getPublisherPolicy,
  manifestPublisherChanged,
  stmtDeleteManifestPublisher,
  stmtUpsertManifestPublisher,
} from "../../core/publisher.js";
import { randomId } from "../../core/platform.js";
import { manifestSnapshotStatement } from "../../core/manifestSnapshot.js";
import { reservedNamesMode } from "../../core/reservedNames.js";
import { reservedDisplayNamesMode } from "../../core/reservedDisplayNames.js";
import {
  syncHostedAssets,
  type AssetWarning,
} from "../../core/hostedAssetPulls.js";
import { repoBlobLookup } from "./assetSource.js";

export type ResyncResult =
  | {
      ok: true;
      updated: string[];
      /**
       * Parts of the manifest the sync refused while applying the rest (P3-03:
       * `release_key_is_product_key`, which keeps the previous `releaseKeys`). Absent when none.
       */
      refused?: { code: string; path: string; message: string }[];
      /**
       * P4-12: the pack-set re-resolution's outcome, when it failed (the sets were cleared;
       * the resync itself applied) or stored sets. Absent otherwise.
       */
      packSets?: StoreOutcome;
      /**
       * ST-01b: what the console has claimed and this resync therefore left alone — setting keys
       * (`core.name`, `config.catalog`, …) and console-owned rows (`tier:<id>`, `profile:<id>`).
       * Absent when none.
       */
      claimed?: string[];
      /**
       * ST-01b (S-18 §4.5 item 3): console rows holding the id of a row the manifest newly
       * declares. The console row is kept and the manifest's row is not applied. Absent when none.
       */
      conflicts?: { path: string; message: string }[];
      /**
       * HA-05: `asset_unreachable` for each declared asset whose source is failing (the last good
       * copy keeps serving). Warnings, never errors: a CDN outage never fails a resync. Absent
       * when none.
       */
      warnings?: AssetWarning[];
      /**
       * ST-20 (S-18 §4.5 item 7): the live break-glass claims after this resync (a
       * manifest-authoritative product's time-boxed console claims; each is also in `claimed`).
       * Every resync summary lists them. Absent when none.
       */
      breakGlass?: BreakGlassClaim[];
      /**
       * ST-20: the break-glass claims this resync ended, because their 7 days ran out or the
       * manifest changed the field; the manifest's value applied. Absent when none.
       */
      breakGlassEnded?: { key: ClaimKey; why: "expired" | "changed" }[];
    }
  | { ok: false; error: string; errors?: string[] };

/**
 * The `product_sync_state` notes for an applied resync: the parts it refused (P3-03) and the
 * console-row conflicts it kept (ST-01b), as stored JSON and as one readable line.
 */
export function resyncNotes(result: Extract<ResyncResult, { ok: true }>): {
  errors_json: string | null;
  message: string | null;
} {
  const lines = [
    ...(result.refused ?? []).map((r) => `${r.code}: ${r.message}`),
    ...(result.conflicts ?? []).map((c) => `conflict ${c.path}: ${c.message}`),
    // ST-20: every resync summary lists the live break-glass claims (not errors: no note row).
    ...(result.breakGlass ?? []).map(
      (b) =>
        `break-glass claim on ${b.key} until ${new Date(b.expiresAt * 1000).toISOString()}`,
    ),
  ];
  const notes = [
    ...(result.refused ?? []),
    ...(result.conflicts ?? []).map((c) => ({ conflict: true, ...c })),
  ];
  return {
    errors_json: notes.length > 0 ? JSON.stringify(notes) : null,
    message: lines.length > 0 ? lines.join("; ") : null,
  };
}

/**
 * Re-apply a linked repo's `.pkey/` to an existing product. Resolves the GitHub coordinates
 * from `release_config`; if the product was never linked (no gh coordinates) it's an error.
 *
 * SECURITY (R6-05). This deliberately takes NO ref. It used to accept `payload.after` from
 * the webhook body, which made the manifest applied to production a function of a value in
 * the request body — an unreviewed branch or an old commit — structurally defeating branch
 * protection and required review on `.pkey/`. The documents are read from the DB-configured
 * repo's own default branch, pinned to the ONE head commit GitHub resolves for it
 * (`fetchPinnedManifestFiles`, ST-01a), with nothing caller-supplied choosing the content.
 *
 * ST-01a. The apply's batch also writes the product's manifest snapshot
 * (`product_manifest_snapshot`, origin `resync`, `applied_sha` = that pinned commit).
 *
 * P0-12. Whatever the outcome, an edge-mint approval the product has WIDENED is deleted once the
 * manifest has been applied (`invalidateWidenedEdgeMintApprovals`). Since ST-01b the apply is one
 * batch, so a refused or throwing push writes none of `services_json`, `auto_issue_json` or
 * `oidc_config`; the sweep still runs in a `finally`, so a repo writer can never skip it by making
 * the ingest fail. A `finally` does not run when the
 * Worker is KILLED after those writes (CPU limit, a cancelled webhook), so this is not the
 * guarantee: every writer of an approval input sweeps BEFORE it writes — `applyRepoManifest`, and
 * the console's services and License-policy edits (`core/servicesAdmin.ts`,
 * `services/license/admin/policy.ts`) — so no revert can be the first thing to look.
 */
export async function resyncRepo(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest?: ManifestIngest,
): Promise<ResyncResult> {
  // ST-20 (S-18 §4.5 item 8): the system product has one writer, the deploy hook, which applies
  // the root `.pkey/` at the deployed commit. A webhook push or a console resync would apply the
  // default branch's head instead, so two deploys of one commit could differ: refused, before any
  // GitHub read or write.
  const system = await getProduct(db, slug);
  const refusal = system ? systemResyncRefusal(system) : null;
  if (refusal) return { ok: false, error: refusal };
  let result: ResyncResult;
  let dropped: string[];
  try {
    result = await applyRepoManifest(env, db, slug, now, fetchImpl, ingest);
  } finally {
    // Every manifest-owned input to an approval that this push wrote is written by now (all in
    // the apply's one batch: `services_json`, `auto_issue_json`, `oidc_config`).
    // An approval this push widened is dropped here, audited as `config.mint.invalidate`, and its
    // recipe is `pending` until an operator re-approves it — a later push, or a console edit, that
    // reverts the widening cannot restore it. Runs on the throw path too.
    dropped = await invalidateWidenedEdgeMintApprovals(
      db,
      slug,
      now,
      "widened by a manifest push",
    );
  }
  if (
    result.ok &&
    dropped.length > 0 &&
    !result.updated.includes("edgeMintApprovals")
  )
    result.updated.push("edgeMintApprovals");
  return result;
}

async function applyRepoManifest(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl,
  ingest: ManifestIngest | undefined,
): Promise<ResyncResult> {
  const read = await readLinkedManifest(env, db, slug, now, fetchImpl);
  if (!read.ok)
    return {
      ok: false,
      error: read.error,
      ...(read.errors ? { errors: read.errors } : {}),
    };
  const {
    product,
    owner,
    repo,
    cfg,
    files,
    token,
    commit: appliedSha,
    manifest,
  } = read;

  // R9-01, at ingest — see `issuerChangeRefusal`. Deliberately BEFORE the first write, like every
  // other check (ST-01b): nothing is written until the apply's one batch.
  const issuerRefusal = await issuerChangeRefusal(env, db, slug, manifest);
  if (issuerRefusal) return { ok: false, error: issuerRefusal };

  // P2-02 — the trusted-publisher policy, resolved BEFORE the first write for the same reason: a
  // GitHub failure here must refuse the push, not leave half a manifest applied. An
  // operator-claimed policy (`source = 'admin'`) is never touched — no lookup, no write
  // (`stmtUpsertManifestPublisher` is also guarded inside the statement).
  const publisher = await resolveManifestPublisher(
    db,
    slug,
    manifest,
    token,
    owner,
    repo,
    fetchImpl,
  );
  if (!publisher.ok) return { ok: false, error: publisher.error };
  const { current: currentPublisher, claimed: publisherClaimed } = publisher;
  const nextPublisher = publisher.next;

  // ── ST-01b: every check before the first write ──────────────────────────────
  //
  // Everything from here to the batch reads and decides; nothing writes until `db.batch` below,
  // so a refused resync — a bad catalog, an unsafe binary name, a dropped tier or profile still
  // in use — leaves every row exactly as it was (S-18 §2.1: before ST-01b the tier and profile
  // refusals ran after the product-row writes, and a refused resync was half-applied).

  // The incoming catalog, built once (see `screenCatalog`): screened here when it changed and the
  // console has not claimed it, and asked by the profile carry-forward below (R2) which keys are
  // still managed secrets.
  // ST-20: a break-glass claim whose field this manifest changes (or whose 7 days ran out) ends
  // in this apply's batch, so it is not in `claims` and the field applies like any other.
  const applyClaims = await claimsForApply(db, slug, manifest, now);
  const claims = applyClaims.claimed;
  const nextCatalogJson = JSON.stringify(manifest.catalog);
  const activeSchema = await getActiveSchema(db, slug);
  const catalogClaimed = claims.has("config.catalog");
  const catalogChanged =
    !catalogClaimed && activeSchema?.catalog_json !== nextCatalogJson;
  const screened = screenCatalog(manifest, catalogChanged);
  if (!screened.ok) return { ok: false, error: screened.error };
  const incomingCatalog = screened.catalog;

  // The catalog the profile carry-forward (R2) asks which keys are managed secrets: the one that
  // stays installed. With `config.catalog` claimed that is the console's catalog, not the
  // manifest's (which is not installed), so a secret the console catalog declares and an operator
  // sealed on a manifest profile is carried rather than silently wiped. The stored catalog was
  // screened when it was published; one that no longer parses falls back to the manifest's.
  let carryCatalog = incomingCatalog;
  if (catalogClaimed && activeSchema) {
    try {
      carryCatalog = new Catalog(
        JSON.parse(activeSchema.catalog_json) as never,
      );
    } catch {
      carryCatalog = incomingCatalog;
    }
  }

  // Defence in depth for R6-01 (the repo-name fallback bypasses the manifest boundary).
  const rel = manifest.release;
  const binaryRefusal = unsafeBinaryNameRefusal(manifest, repo);
  if (binaryRefusal) return { ok: false, error: binaryRefusal };
  const binaryName = rel ? rel.binaryName || repo : null;

  // Tiers and profiles, per row (S-18 §4.5 item 3). A `manifest` row the manifest still declares
  // is upserted; a `console` row (created or edited in the console) is never touched; a `manifest`
  // row the manifest dropped is deleted only when nothing references it, and otherwise the whole
  // resync is refused, before any write. A console row holding the id of a manifest row is
  // skipped: a claim when the last applied manifest declared that id too, a conflict (reported)
  // when the id is new to the manifest.
  const previous = await getManifestSnapshot(db, slug);
  const previousIds = snapshotRowIds(previous?.manifest_json);
  const storedProfiles = await listProfiles(db, slug);
  const storedTiers = await listTiers(db, slug);
  const consoleProfiles = new Set(
    storedProfiles.filter((p) => p.source === "console").map((p) => p.id),
  );
  const consoleTiers = new Set(
    storedTiers.filter((t) => t.source === "console").map((t) => t.id),
  );
  const nextProfileIds = new Set(manifest.profiles.map((p) => p.id));
  const nextTierIds = new Set(manifest.tiers.map((t) => t.id));
  const refused: { code: string; path: string; message: string }[] = [];
  // LX-06: row-backed settings the console has claimed. The owning services' ingest hooks skip
  // them in SQL; they are named here so the result says what was left alone.
  const claimed: string[] = await liveRowClaimKeys(db, slug, now);
  const conflicts: { path: string; message: string }[] = [];
  const skip = (
    kind: "tier" | "profile",
    id: string,
    owned: Set<string>,
    before: Set<string>,
  ): boolean => {
    if (!owned.has(id)) return false;
    if (before.has(id)) claimed.push(`${kind}:${id}`);
    else
      conflicts.push({
        path: `/${kind === "tier" ? "tiers" : "profiles"}/${id}`,
        message: `a ${kind} with id ${id} was created in the console; it is kept, and the manifest's ${kind} is not applied until one of them is renamed`,
      });
    return true;
  };
  const applyTiers = manifest.tiers.filter(
    (t) => !skip("tier", t.id, consoleTiers, previousIds.tiers),
  );
  const applyProfiles = manifest.profiles.filter(
    (p) => !skip("profile", p.id, consoleProfiles, previousIds.profiles),
  );
  const dropTiers = storedTiers.filter(
    (t) => t.source !== "console" && !nextTierIds.has(t.id),
  );
  const dropProfiles = storedProfiles.filter(
    (p) => p.source !== "console" && !nextProfileIds.has(p.id),
  );
  for (const tier of dropTiers) {
    const refs = await countLicensesUsingTier(db, slug, tier.id);
    if (refs > 0)
      return {
        ok: false,
        error: `cannot remove tier ${tier.id}; ${refs} license(s) still reference it`,
      };
  }
  // The tiers that survive this resync: the console's, plus the manifest's applied ones.
  const survivingTierProfiles = [
    ...storedTiers
      .filter((t) => consoleTiers.has(t.id))
      .map((t) => t.profile_id),
    ...applyTiers.map((t) => t.profileId ?? null),
  ];
  for (const profile of dropProfiles) {
    const refs =
      (await countLicensesListingProfile(db, slug, profile.id)) +
      survivingTierProfiles.filter((p) => p === profile.id).length;
    if (refs > 0)
      return {
        ok: false,
        error: `cannot remove profile ${profile.id}; ${refs} license(s) or tier(s) still reference it`,
      };
  }

  // `releaseKeys` (P3-03): never a product signing key, current or retired. A refused set keeps
  // the previous value — a partial set would drop a key CI may already sign with — and is
  // reported, as the rest of the manifest is still applied.
  const releaseKeys = rel
    ? await releaseKeysForSync(db, slug, rel.releaseKeys)
    : null;
  if (releaseKeys && !releaseKeys.ok)
    for (const r of releaseKeys.refused)
      refused.push({
        code: r.code,
        path: "/release/releaseKeys",
        message: r.message,
      });

  // P0-12 — an edge-mint approval the product has WIDENED (public without acknowledgement,
  // License turned off, sign-in trust changed) is deleted by the ingest, not merely skipped by
  // the mint, so that a revert cannot bring it back while credentials issued in between keep
  // working. Swept once here, after the checks and before the batch, against the state the
  // previous ingest left — so a sweep that failed after that ingest's writes is caught before
  // this push can revert them — and once more after the batch, in `resyncRepo`.
  const droppedBefore = await invalidateWidenedEdgeMintApprovals(
    db,
    slug,
    now,
    "found widened at resync",
  );

  // ── the writes: ONE batch ───────────────────────────────────────────────────
  const updated: string[] = [];
  // The ended break-glass claims go first, so every claim guard below already sees them gone.
  const stmts: DbStatement[] = await endBreakGlassStatements(
    db,
    slug,
    applyClaims.ended,
    { actor: RESYNC_ACTOR, sha: appliedSha, now },
  );
  const audits: DbStatement[] = [];
  const auditSetting = (
    key: string,
    before: unknown,
    after: unknown,
    claimKey: ClaimKey | null = null,
  ): void => {
    const stmt = stmtSettingAudit(
      slug,
      now,
      RESYNC_ACTOR,
      "setting.resync",
      "setting",
      key,
      `${key} set from the manifest${appliedSha ? ` at ${appliedSha.slice(0, 12)}` : ""}: ${auditValue(before)} → ${auditValue(after)}`,
      // ST-04: the structured before/after beside the summary.
      { before, after },
    );
    // A claimable key's audit row carries the same in-statement guard as its write, so a claim
    // made after `claims` was read leaves neither the write nor an audit row claiming it happened.
    audits.push(claimKey ? unlessClaimed(stmt, slug, claimKey, now) : stmt);
  };

  // The product row's manifest fields (S-18 §4.5 item 1). A field the console has claimed
  // (`product_settings`, ST-01b) is skipped; `admin_group` is manifest-only and always follows
  // the manifest (owner decision 1). `web_origins_json` (P0-05) keeps `omitClears`: dropping
  // `web.origins` from `.pkey/product` clears it back to NULL (no origin allowed) rather than
  // freezing the old list — unless the console has claimed it.
  const nextOrigins = serializeWebOrigins(manifest.webOrigins);
  const productFields: [string, ClaimKey | null, unknown, unknown][] = [
    ["name", "core.name", product.name, manifest.product.name],
    [
      "default_max_offline_days",
      "license.defaults.maxOfflineDays",
      product.default_max_offline_days,
      manifest.product.defaultMaxOfflineDays,
    ],
    [
      "default_device_limit",
      "license.defaults.deviceLimit",
      product.default_device_limit,
      manifest.product.defaultDeviceLimit,
    ],
    ["admin_group", null, product.admin_group, manifest.product.adminGroup],
    [
      "web_origins_json",
      "core.web.origins",
      product.web_origins_json ?? null,
      nextOrigins,
    ],
  ];
  const sets: string[] = [];
  const setParams: (string | number | null)[] = [];
  for (const [column, key, before, after] of productFields) {
    if (key && claims.has(key)) {
      claimed.push(key);
      continue;
    }
    // `claims` was read before the GitHub round trips above; a console save may have claimed the
    // key since. The guard is therefore in the statement itself (the column keeps its value while
    // a live claim exists), like `compat_source` below and the tiers' `source` guard.
    if (key) {
      sets.push(
        `${column} = CASE WHEN ${CLAIMED_SQL} THEN ${column} ELSE ? END`,
      );
      setParams.push(
        ...claimGuardParams(slug, key, now),
        after as string | number | null,
      );
    } else {
      sets.push(`${column} = ?`);
      setParams.push(after as string | number | null);
    }
    if (before !== after)
      auditSetting(
        key ?? "core.adminGroup",
        column === "web_origins_json"
          ? parseWebOrigins(before as string | null)
          : before,
        column === "web_origins_json" ? [...manifest.webOrigins] : after,
        key,
      );
  }
  stmts.push({
    sql: `UPDATE products SET ${[...sets, "modified_at = ?"].join(", ")} WHERE slug = ?`,
    params: [...setParams, now, slug],
  });
  // The compatibility window is operator-claimable (P0-01, 0022_a): once an operator sets it in
  // `update/settings`, `compat_source = 'admin'` and this statement matches no row. The guard is
  // the UPDATE's own WHERE clause — the same shape as `setServices` — not a read-then-write.
  stmts.push({
    sql: `UPDATE products SET compat_min = ?, compat_max = ?
            WHERE slug = ? AND COALESCE(compat_source, 'manifest') = 'manifest'`,
    params: [manifest.product.compatMin, manifest.product.compatMax, slug],
  });
  updated.push("product");

  // The fingerprint policy is manifest-owned only until an operator edits it live; after
  // that the statement's guard skips the write, so a push can't clobber their change.
  if (manifest.fingerprint) {
    stmts.push(
      stmtSetFingerprintPolicy(
        slug,
        JSON.stringify(manifest.fingerprint),
        "manifest",
        now,
      ),
    );
    updated.push("fingerprint");
  }

  // Same ownership rule for the auto-issue policy: manifest-owned until an operator claims it.
  if (manifest.autoIssue) {
    stmts.push(
      stmtSetAutoIssuePolicy(
        slug,
        JSON.stringify(manifest.autoIssue),
        "manifest",
        now,
      ),
    );
    updated.push("autoIssue");
  }

  // Service enablement + the device-registration policy, under the same ownership rule once
  // more. Unconditional (unlike the two above) because `services` is always present on a parsed
  // manifest — a manifest that declares no `modules:` block still means something definite,
  // namely the defaults. `registration` rides in the same value and is written only when the
  // manifest declared it, so dropping the key from `.pkey/product` returns the product to the
  // derived default rather than freezing whatever it last said. The `services_source = 'admin'`
  // guard lives inside the statement, so a push cannot turn a service back on after an operator
  // has turned it off live — nor re-open registration after one has closed it.
  const manifestServicesJson = serializeServices({
    services: manifest.services,
    ...(manifest.registration ? { registration: manifest.registration } : {}),
  });
  stmts.push(stmtSetServices(slug, manifestServicesJson, "manifest", now));
  updated.push("services");

  // ── schema: publish a new active version only when the catalog changed ──────
  // ...and the console has not claimed it (`config.catalog`, one claimable unit).
  if (catalogClaimed) claimed.push("config.catalog");
  if (catalogChanged) {
    const version = await nextSchemaVersion(db, slug);
    // Guarded in SQL as well: a console catalog publish that claims `config.catalog` after
    // `claims` was read must not be deactivated and replaced by this push.
    stmts.push(
      {
        sql: `UPDATE product_schema SET active = 0
                WHERE product = ? AND NOT ${CLAIMED_SQL}`,
        params: [slug, ...claimGuardParams(slug, "config.catalog", now)],
      },
      unlessClaimed(
        stmtInsertSchema({
          product: slug,
          catalog_version: version,
          catalog_json: nextCatalogJson,
          active: 1,
          created_at: now,
        }),
        slug,
        "config.catalog",
        now,
      ),
    );
    audits.push(
      unlessClaimed(
        stmtSettingAudit(
          slug,
          now,
          RESYNC_ACTOR,
          "setting.resync",
          "setting",
          "config.catalog",
          `config.catalog published from the manifest as v${version}${appliedSha ? ` at ${appliedSha.slice(0, 12)}` : ""}`,
        ),
        slug,
        "config.catalog",
        now,
      ),
    );
    updated.push("schema");
  }

  // ── release_config: update the GitHub-distribution block in place ───────────
  // The row the truth store below reads is this batch's result, built here rather than re-read:
  // the batch has not run yet.
  let syncedCfg: ReleaseConfigRow = cfg;
  if (rel) {
    // `artifact_policy_json` is the MANIFEST half of the artifact policy only. The operator half
    // (requireSparkleSignature, minimumSystemVersion) lives in `operator_policy_json`, which this
    // function never names — so rewriting this blob whole can no longer drop an operator's keys.
    const block = {
      channel_workflow: rel.channelWorkflow || null,
      beta_branch: rel.betaBranch || "main",
      binary_name: binaryName,
      sparkle_ed25519_pub: rel.sparkleEd25519Pub || null,
      summary_marker: rel.summaryMarker || "pkey:summary",
      manual_channels_json: rel.manualChannels.length
        ? JSON.stringify(rel.manualChannels)
        : null,
      artifact_policy_json: rel.artifactPolicy
        ? JSON.stringify(rel.artifactPolicy)
        : null,
      stable_tag_pattern: rel.stableTagPattern,
      ignore_tags_json: rel.ignoreTags.length
        ? JSON.stringify(rel.ignoreTags)
        : null,
    };
    stmts.push({
      sql: `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
              sparkle_ed25519_pub = ?, summary_marker = ?, manual_channels_json = ?,
              artifact_policy_json = ?, stable_tag_pattern = ?, ignore_tags_json = ?
              WHERE product = ?`,
      params: [
        block.channel_workflow,
        block.beta_branch,
        block.binary_name,
        block.sparkle_ed25519_pub,
        block.summary_marker,
        block.manual_channels_json,
        block.artifact_policy_json,
        block.stable_tag_pattern,
        block.ignore_tags_json,
        slug,
      ],
    });
    syncedCfg = { ...syncedCfg, ...block };
    if (releaseKeys?.ok) {
      stmts.push({
        sql: "UPDATE release_config SET release_keys_json = ? WHERE product = ?",
        params: [releaseKeys.json, slug],
      });
      syncedCfg = { ...syncedCfg, release_keys_json: releaseKeys.json };
    }
    // The two access modes share ONE owner (`access_source`, 0022_b). Once an operator claims
    // them, this matches no row: a manifest cannot express `entitled`, so without the guard every
    // push would silently downgrade an entitled product to the manifest's mode (default public).
    stmts.push({
      sql: `UPDATE release_config SET metadata_access = ?, artifacts_access = ?
              WHERE product = ? AND COALESCE(access_source, 'manifest') = 'manifest'`,
      params: [rel.access.metadata, rel.access.artifacts, slug],
    });
    if ((cfg.access_source ?? "manifest") === "manifest")
      syncedCfg = {
        ...syncedCfg,
        metadata_access: rel.access.metadata,
        artifacts_access: rel.access.artifacts,
      };
    updated.push("release");
  }

  // ── manifest-owned rows: replace from the code-first source of truth ─────────
  stmts.push({
    sql: "DELETE FROM oidc_config WHERE product = ?",
    params: [slug],
  });
  if (manifest.oidc) {
    stmts.push(
      stmtInsertOidcConfig({
        product: slug,
        provider: manifest.oidc.provider,
        issuer: manifest.oidc.issuer,
        clientId: manifest.oidc.clientId,
        clientSecretSecret: manifest.oidc.clientSecretSecret,
        redirectUris: manifest.oidc.redirectUris ?? [],
        groupRoleMap: manifest.oidc.groupRoleMap ?? {},
      }),
    );
  }
  updated.push("oidc");

  // Profiles, per row (above). One carve-out on the rows this resync owns: their SECRET VALUES. A
  // manifest cannot express a secret value (a sealed envelope is minted by the console under
  // `PLATFORM_KEK`, and a plaintext secret has no place in a repo), so an operator sets one on a
  // profile in the console without claiming it, and without this every `.pkey/` push wiped it
  // (R2). Each row's slot is reserved here with the manifest's payload, and `withStoredSecrets`
  // fills the carried values in immediately before the batch (below), so a console edit made
  // while this push was still reading GitHub is the one carried. A dropped manifest profile goes,
  // secrets and all.
  const profileSlots: { index: number; profile: ManifestProfile }[] = [];
  for (const p of dropProfiles) {
    stmts.push(stmtDeleteManifestProfile(slug, p.id));
    audits.push(rowAudit(slug, now, "profile", p.id, "removed"));
  }
  const storedProfileById = new Map(storedProfiles.map((p) => [p.id, p]));
  for (const p of applyProfiles) {
    profileSlots.push({ index: stmts.length, profile: p });
    stmts.push(profileStatement(slug, p, p.payload, now));
  }
  updated.push("profiles");

  const storedTierById = new Map(storedTiers.map((t) => [t.id, t]));
  for (const t of dropTiers) {
    stmts.push(stmtDeleteManifestTier(slug, t.id));
    audits.push(rowAudit(slug, now, "tier", t.id, "removed"));
  }
  for (const t of applyTiers) {
    const input = {
      product: slug,
      id: t.id,
      label: t.label,
      profileId: t.profileId ?? null,
      policyExpiryDays: t.policyExpiryDays ?? null,
      policyDeviceLimit: t.policyDeviceLimit ?? null,
      policyFingerprint: t.policyFingerprint ?? null,
      channels: t.channels,
      minVersion: t.minVersion,
      maxVersion: t.maxVersion,
      modifiedAt: now,
    };
    stmts.push(stmtUpsertManifestTier(input));
    const stored = storedTierById.get(t.id);
    if (!stored) audits.push(rowAudit(slug, now, "tier", t.id, "added"));
    else if (tierShape(stored) !== tierShape(stmtInsertTier(input).params))
      audits.push(rowAudit(slug, now, "tier", t.id, "changed"));
  }
  updated.push("tiers");

  stmts.push({
    sql: "DELETE FROM provisioning_config WHERE product = ?",
    params: [slug],
  });
  for (const h of manifest.provisioning)
    stmts.push(stmtInsertProvisioning({ product: slug, ...h }));
  updated.push("provisioning");

  stmts.push({
    sql: "DELETE FROM edge_mint_config WHERE product = ?",
    params: [slug],
  });
  for (const e of manifest.edgeMint) {
    stmts.push(
      stmtInsertEdgeMint({
        product: slug,
        id: e.id,
        alg: e.alg,
        signingKeySecret: e.signingKeySecret,
        kid: e.kid,
        claimsTemplate: e.claimsTemplate ?? {},
        ttlSeconds: e.ttlSeconds,
        audience: e.audience ?? null,
      }),
    );
  }
  // P0-12: approvals are the operator's, so a resync never WRITES one — the re-inserted rows
  // above stay approved only where they are column-for-column what an operator approved, and a
  // changed field leaves the recipe inert (404) until it is approved again. What a resync does
  // own is cleanup: a recipe id the manifest no longer declares takes its approval with it, so
  // a later push re-adding that id with the same fields cannot inherit a stale approval.
  stmts.push(stmtDeleteOrphanEdgeMintApprovals(slug));
  updated.push("edgeMint");

  // The trusted-publisher policy (P2-02): manifest-owned rows follow the manifest — written when
  // declared, dropped when not — and a change is audited. A claimed row is left exactly as the
  // operator set it, whatever the manifest says.
  if (!publisherClaimed) {
    stmts.push(
      nextPublisher
        ? stmtUpsertManifestPublisher({ product: slug, ...nextPublisher, now })
        : stmtDeleteManifestPublisher(slug),
    );
    if (manifestPublisherChanged(currentPublisher, nextPublisher)) {
      updated.push("publisher");
      stmts.push(
        auditStatement(
          slug,
          now,
          `manifest:${owner}/${repo}`,
          nextPublisher
            ? `Trusted publisher set from the manifest: ${nextPublisher.repository} ${nextPublisher.workflow} (environment ${nextPublisher.environment})`
            : "Trusted publisher removed: the manifest no longer declares publishing.trustedPublisher",
        ),
      );
    }
  }

  // The app deliverable's declaration (P2-04): `release_deliverables.def_json` and the channels'
  // `includes`. Before the truth store below, which classifies by the same declaration.
  if (rel) {
    stmts.push(
      ...manifestDeliverableStatements(
        slug,
        rel.app,
        now,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    );
    updated.push("deliverables");
  }

  // ── the services' own manifest rows (P2b-02): Core's ingest pipeline ─────────
  //
  // Every ENABLED service's `manifestIngest` (Distribution's outlets and transports today), in
  // this same batch. Enablement is the product's set as this batch leaves it — the stored set
  // when an operator claimed it, the manifest's otherwise — so a service an operator turned off
  // live does not have its rows rewritten by a push that still says on. Release never imports the
  // services that answer (AGENTS rule 6): the pipeline is handed down from the composition root.
  if (ingest) {
    const servicesJson =
      product.services_source === "admin"
        ? product.services_json
        : manifestServicesJson;
    const services = parseServices(servicesJson).services;
    const serviceRows = ingest(manifest, slug, services, now);
    stmts.push(...serviceRows.statements);
    updated.push(...serviceRows.slugs);
  }

  // ── release truth store: the same pass, one extra GitHub read (P2.T2) ───────
  //
  // `release_metadata`/`release_artifacts`/`release_channels`/`release_health` have existed as
  // write-orphaned scaffolding since 0007. This is the writer. It rides in the SAME batch as the
  // manifest-owned rows so a resync is one transaction: a truth store that landed separately
  // could survive a failure that rolled the rest back, and the portal would then list releases
  // for a product whose tiers had not been updated.
  {
    // The map just parsed, not the persisted one: this batch is what persists it.
    const store = await releaseStoreSync(
      env,
      db,
      syncedCfg,
      now,
      fetchImpl,
      rel ? { app: rel.app } : {},
    );
    if (store.statements.length > 0) {
      stmts.push(...store.statements);
      updated.push("releases");
    }
    // A GitHub release tagged with a pack release id (P4-02) is skipped, never merged.
    for (const tag of store.packTagConflicts)
      refused.push({
        code: "release_tag_is_pack_release",
        path: `releases/${tag}`,
        message: `GitHub release "${tag}" was not synced: a pack release already has that id`,
      });
  }

  // R2 — the profiles' carried secret values, read as late as possible: after every GitHub read
  // above, with nothing but this one D1 read between the snapshot and the batch. A console edit
  // landing inside that single round trip is the only one a push can still overwrite.
  if (profileSlots.length > 0) {
    const stored = new Map(
      (await listProfiles(db, slug)).map((p) => [p.id, p.payload_json]),
    );
    for (const { index, profile } of profileSlots) {
      const payload = withStoredSecrets(
        profile.payload,
        stored.get(profile.id),
        carryCatalog,
      );
      stmts[index] = profileStatement(slug, profile, payload, now);
      const before = storedProfileById.get(profile.id);
      if (!before)
        audits.push(rowAudit(slug, now, "profile", profile.id, "added"));
      else if (
        before.name !== profile.name ||
        (before.description ?? null) !== (profile.description ?? null) ||
        before.payload_json !== JSON.stringify(payload)
      )
        audits.push(rowAudit(slug, now, "profile", profile.id, "changed"));
    }
  }

  // Per-field resync audit (S-18 §4.6): one row per setting or row this batch changes, in it.
  stmts.push(...audits);

  // ST-01a: the manifest this batch applies, recorded IN the batch — the snapshot lands exactly
  // when the rows do. Not reported in `updated`: it is bookkeeping, not a manifest section.
  stmts.push(
    await manifestSnapshotStatement(
      slug,
      "resync",
      appliedSha,
      files,
      manifest,
      now,
    ),
  );

  let packSets: StoreOutcome | null = null;
  await db.batch(stmts);
  // PX-W17: the consequences of the services set now STORED (the manifest's, or the operator's
  // when the row is admin-claimed and the batch's write was a no-op). Idempotent: an Identity-off
  // product's stragglers heal here on every resync.
  await applyServiceTransitions(
    env,
    db,
    slug,
    parseServices((await getProduct(db, slug))?.services_json).services,
    MANIFEST_RESYNC_ACTOR,
    now,
  );
  // A resync can change the tag filter, the manual channels and the store: drop every cached
  // resolution of this product (P2-05, `ghCache.ts`).
  await bumpReleaseGeneration(env, slug, now);
  // ...and may change a pack's binding or channels, or the store's app releases (P4-12). A
  // failed resolution clears the sets and is answered; it never fails the resync.
  if (rel) packSets = await resolveAndStore(db, slug, now);
  // HA-08 (S-20 §6.3): the release files the store's rows left without a copy of ours, queued
  // after the batch and best-effort (`enqueueReleaseMirrors` never throws).
  if (rel) await enqueueReleaseMirrors(env, db, slug, now);

  // HA-05 (notes/S-20 §6.4): the hosted-asset pulls this manifest owes, enqueued AFTER the batch
  // (a new slot's row references the product) and best-effort (`syncHostedAssets` never throws).
  // Repo paths are compared by git blob at the pinned commit, through the token this resync holds.
  const assets = await syncHostedAssets(env, db, {
    product: slug,
    manifest,
    commit: appliedSha,
    repoBlob: repoBlobLookup(token, owner, repo, appliedSha, fetchImpl),
    now,
  });
  if (assets.enqueued > 0) updated.push("assets");

  if (droppedBefore.length > 0) updated.push("edgeMintApprovals");
  return {
    ok: true,
    updated,
    ...(refused.length > 0 ? { refused } : {}),
    ...(claimed.length > 0 ? { claimed } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(packSets && (!packSets.ok || packSets.sets > 0) ? { packSets } : {}),
    ...(assets.warnings.length > 0 ? { warnings: assets.warnings } : {}),
    ...(applyClaims.live.length > 0 ? { breakGlass: applyClaims.live } : {}),
    ...(applyClaims.ended.length > 0
      ? {
          breakGlassEnded: applyClaims.ended.map((e) => ({
            key: e.key,
            why: e.why,
          })),
        }
      : {}),
  };
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
function tierShape(t: TierRow | DbStatement["params"]): string {
  if (Array.isArray(t))
    // stmtInsertTier's params: product, id, label, profile, expiry, limit, channels, min, max,
    // fingerprint, modifiedAt.
    return JSON.stringify(t.slice(2, 10));
  return JSON.stringify([
    t.label,
    t.profile_id,
    t.policy_expiry_days,
    t.policy_device_limit,
    t.channels_json,
    t.min_version,
    t.max_version,
    t.policy_fingerprint ?? null,
  ]);
}

/** The resync audit row for one tier or profile the batch adds, changes or removes. */
function rowAudit(
  product: string,
  now: number,
  kind: "tier" | "profile",
  id: string,
  what: "added" | "changed" | "removed",
): DbStatement {
  return stmtSettingAudit(
    product,
    now,
    RESYNC_ACTOR,
    "setting.resync",
    kind,
    id,
    `${kind === "tier" ? "Tier" : "Profile"} ${id} ${what} by the manifest`,
  );
}

/** One profile row of the resync's batch. */
function profileStatement(
  product: string,
  profile: ManifestProfile,
  payload: Record<string, unknown>,
  now: number,
): DbStatement {
  return stmtUpsertManifestProfile({
    product,
    id: profile.id,
    name: profile.name,
    description: profile.description ?? null,
    payloadJson: JSON.stringify(payload),
    modifiedAt: now,
  });
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

/** The audit row for a manifest-driven publisher change, in the resync's batch. */
function auditStatement(
  product: string,
  now: number,
  actor: string,
  summary: string,
): DbStatement {
  return {
    sql: `INSERT INTO audit
            (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
             target_id, parent_id, summary)
          VALUES (?, ?, ?, ?, 'Manifest resync', NULL, 'ci.publisher.manifest', 'ci_publisher',
                  ?, NULL, ?)`,
    params: [product, randomId("aud"), now, actor, product, summary],
  };
}

/**
 * Which pre-write check refused a read of a linked product's manifest. A subset of
 * `linkExisting.ts`'s `LinkCheck`, so the resync dry run can name it the way link does.
 */
export type LinkedManifestCheck = "product" | "app" | "manifest" | "slug";

export type LinkedManifestRead =
  | {
      ok: true;
      /** The product row as read before the GitHub round trips (ST-01b compares its fields). */
      product: ProductRow;
      owner: string;
      repo: string;
      /** The product's `release_config` row the coordinates came from. */
      cfg: ReleaseConfigRow;
      /** The `.pkey/` documents as read (the manifest snapshot records them). */
      files: Record<string, string>;
      /** The repo-scoped installation token the read used. */
      token: string;
      /** The default-branch commit every document was read at (ST-01a). */
      commit: string;
      manifest: ParsedManifest;
    }
  | {
      ok: false;
      check: LinkedManifestCheck;
      error: string;
      errors?: string[];
    };

/**
 * The read half of a resync, shared by `resyncRepo` and the console's dry run (`planResync`,
 * UX-78) so the plan the operator confirms is read exactly as the resync reads it: the product
 * must be linked, the coordinates come from `release_config`, the token is scoped to that one
 * repository, every document is read at ONE GitHub-resolved commit of the default branch
 * (ST-01a, R6-05: nothing caller-supplied chooses the ref), parsed with the platform's
 * reserved-name severity, and the manifest must name this product. Writes nothing.
 */
export async function readLinkedManifest(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<LinkedManifestRead> {
  const product = await getProduct(db, slug);
  if (!product)
    return { ok: false, check: "product", error: "unknown product" };
  if (product.release_source !== "github")
    return {
      ok: false,
      check: "product",
      error: "product is not linked to a repo",
    };

  const cfg = await getReleaseConfig(db, slug);
  if (!cfg || !cfg.gh_owner || !cfg.gh_repo)
    return {
      ok: false,
      check: "product",
      error: "product has no linked repo coordinates",
    };
  const owner = cfg.gh_owner;
  const repo = cfg.gh_repo;

  let token: string;
  try {
    const installId =
      cfg.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    // Structured scope, not a bare repo name — the string form is the legacy path and
    // yields an installation-wide token plus a second cache entry (R5-03).
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      check: "app",
      error: err instanceof Error ? err.message : "github access failed",
    };
  }

  let files: Record<string, string>;
  let commit: string;
  try {
    ({ files, sha: commit } = await fetchPinnedManifestFiles(
      token,
      owner,
      repo,
      fetchImpl,
    ));
  } catch (err) {
    return {
      ok: false,
      check: "manifest",
      error:
        err instanceof Error ? err.message : "github manifest fetch failed",
    };
  }

  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    reservedDisplayNames: await reservedDisplayNamesMode(env, db),
  });
  if (!result.ok)
    return {
      ok: false,
      check: "manifest",
      error: "manifest validation failed",
      errors: result.errors,
    };
  const manifest = result.manifest;
  if (manifest.product.slug !== slug)
    return {
      ok: false,
      check: "slug",
      error: `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    };
  return {
    ok: true,
    product,
    owner,
    repo,
    cfg,
    files,
    token,
    commit,
    manifest,
  };
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
  const binaryName = manifest.release.binaryName || repo;
  if (isSafeBinaryName(binaryName)) return null;
  return `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`;
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
    if (catalogChanged) catalog.compileAll();
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
  token: string,
  owner: string,
  repo: string,
  fetchImpl: FetchImpl,
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
    const identity = await getRepoIdentity(token, owner, repo, fetchImpl);
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
