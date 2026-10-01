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
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db, DbStatement, Env } from "../../core/platform.js";
import {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  deactivateSchemas,
  getActiveSchema,
  getProduct,
  insertSchema,
  invalidateWidenedEdgeMintApprovals,
  listProfiles,
  listTiers,
  nextSchemaVersion,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  setServices,
  stmtDeleteOrphanEdgeMintApprovals,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertTier,
} from "../../core/ingest.js";
import { getReleaseConfig } from "./config.js";
import { parseManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile } from "./github.js";
import { isSafeBinaryName } from "./install.js";
import { manifestIssuerRefusal } from "./linkRepo.js";
import { MANIFEST_FILES } from "./manifestFiles.js";
import { releaseStoreSyncStatements } from "./sync.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import { manifestDeliverableStatements } from "./deliverables.js";
import { serializeServices } from "../../core/services.js";
import { serializeWebOrigins } from "../../core/cors.js";

export type ResyncResult =
  | { ok: true; updated: string[] }
  | { ok: false; error: string; errors?: string[] };

async function readManifestFile(
  token: string,
  owner: string,
  repo: string,
  paths: string[],
  fetchImpl: FetchImpl,
): Promise<string | undefined> {
  for (const path of paths) {
    const text = await fetchRepoFile(token, owner, repo, path, fetchImpl);
    if (text !== null) return text;
  }
  return undefined;
}

/**
 * Re-apply a linked repo's `.pkey/` to an existing product. Resolves the GitHub coordinates
 * from `release_config`; if the product was never linked (no gh coordinates) it's an error.
 *
 * SECURITY (R6-05). This deliberately takes NO ref. It used to accept `payload.after` from
 * the webhook body, which made the manifest applied to production a function of a value in
 * the request body — an unreviewed branch or an old commit — structurally defeating branch
 * protection and required review on `.pkey/`. Omitting the ref makes the Contents API serve
 * the DB-configured repo's own default branch, resolved by GitHub, with nothing
 * caller-supplied in the path.
 *
 * P0-12. Whatever the outcome, an edge-mint approval the product has WIDENED is deleted once the
 * manifest has been applied (`invalidateWidenedEdgeMintApprovals`): the writes below are not one
 * transaction, and a push refused half-way (a bad catalog, a tier still in use) — or one that
 * THROWS half-way (a D1 constraint in the final batch) — can already have written `services_json`
 * or `auto_issue_json`. The sweep therefore runs in a `finally`: a repo writer must not be able to
 * skip it by making the ingest fail after the widening writes. A `finally` does not run when the
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
): Promise<ResyncResult> {
  let result: ResyncResult;
  let dropped: string[];
  try {
    result = await applyRepoManifest(env, db, slug, now, fetchImpl);
  } finally {
    // Every manifest-owned input to an approval that this push got to write is written by now:
    // `services_json` and `auto_issue_json` by the un-batched writes, `oidc_config` in the batch.
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
): Promise<ResyncResult> {
  const product = await getProduct(db, slug);
  if (!product) return { ok: false, error: "unknown product" };
  if (product.release_source !== "github")
    return { ok: false, error: "product is not linked to a repo" };

  const cfg = await getReleaseConfig(db, slug);
  if (!cfg || !cfg.gh_owner || !cfg.gh_repo)
    return { ok: false, error: "product has no linked repo coordinates" };
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
      error: err instanceof Error ? err.message : "github access failed",
    };
  }

  const files: Record<string, string> = {};
  try {
    for (const name of ["schema", "product", "release"] as const) {
      const text = await readManifestFile(
        token,
        owner,
        repo,
        MANIFEST_FILES[name],
        fetchImpl,
      );
      if (text !== undefined) files[name] = text;
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "github manifest fetch failed",
    };
  }

  const result = parseManifest(files);
  if (!result.ok)
    return {
      ok: false,
      error: "manifest validation failed",
      errors: result.errors,
    };
  const manifest = result.manifest;
  if (manifest.product.slug !== slug) {
    return {
      ok: false,
      error: `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    };
  }

  // R9-01, at ingest. `oidc_config` is the one manifest-owned row with no admin-ownership
  // flag: this function DELETEs and re-INSERTs it unconditionally, so a `.pkey/product` push
  // can repoint the IdP that receives this product's OIDC `client_secret`. Only a NEW or
  // CHANGED issuer is gated — an issuer already stored in D1 is re-applied untouched, because
  // flipping the security posture of a running product on the deploy that ships this code is
  // its own outage, and the attack is the *change*, not the status quo. `provider: "platform"`
  // products (e.g. `djdl`) store no issuer and never reach the gate; a push that TRIES to move
  // such a product to a custom issuer is a change from `""` and is gated like any other.
  //
  // Deliberately BEFORE the first write: everything below this point is a sequence of
  // un-batched `db.run`s, so refusing later would leave half a manifest applied.
  const nextOidc =
    manifest.oidc?.provider === "custom" ? manifest.oidc : undefined;
  if (nextOidc) {
    const stored = await db.first<{ issuer: string | null }>(
      "SELECT issuer FROM oidc_config WHERE product = ?",
      slug,
    );
    // Raw string comparison, not host comparison: any edit to the value — a new host, a new
    // path, a new port — is a change, and a change is what gets gated.
    if ((stored?.issuer ?? "") !== nextOidc.issuer) {
      const refusal = manifestIssuerRefusal(env, nextOidc.issuer);
      if (refusal) return { ok: false, error: refusal };
    }
  }

  // P0-12 — an edge-mint approval the product has WIDENED (public without acknowledgement,
  // License turned off, sign-in trust changed) is deleted by the ingest, not merely skipped by
  // the mint, so that a revert cannot bring it back while credentials issued in between keep
  // working. Swept once here, before the first write, against the state the previous ingest
  // left — so a sweep that failed after that ingest's writes is caught before this push can
  // revert them — and once more after the last write, in `resyncRepo`.
  const droppedBefore = await invalidateWidenedEdgeMintApprovals(
    db,
    slug,
    now,
    "found widened at resync",
  );

  const updated: string[] = [];

  // `web_origins_json` (P0-05) rides with the product metadata: it is manifest-owned with no
  // operator claim, so it is rewritten unconditionally, and dropping `web.origins` from
  // `.pkey/product` clears it back to NULL (no origin allowed) rather than freezing the old list.
  await db.run(
    `UPDATE products SET name = ?,
       default_max_offline_days = ?, default_device_limit = ?, admin_group = ?,
       web_origins_json = ?, modified_at = ? WHERE slug = ?`,
    manifest.product.name,
    manifest.product.defaultMaxOfflineDays,
    manifest.product.defaultDeviceLimit,
    manifest.product.adminGroup,
    serializeWebOrigins(manifest.webOrigins),
    now,
    slug,
  );
  // The compatibility window is operator-claimable (P0-01, 0022_a): once an operator sets it in
  // `update/settings`, `compat_source = 'admin'` and this statement matches no row. The guard is
  // the UPDATE's own WHERE clause — the same shape as `setServices` — not a read-then-write.
  await db.run(
    `UPDATE products SET compat_min = ?, compat_max = ?
       WHERE slug = ? AND COALESCE(compat_source, 'manifest') = 'manifest'`,
    manifest.product.compatMin,
    manifest.product.compatMax,
    slug,
  );
  updated.push("product");

  // The fingerprint policy is manifest-owned only until an operator edits it live; after
  // that `setFingerprintPolicy` skips the write, so a push can't clobber their change.
  if (manifest.fingerprint) {
    await setFingerprintPolicy(
      db,
      slug,
      JSON.stringify(manifest.fingerprint),
      "manifest",
      now,
    );
    updated.push("fingerprint");
  }

  // Same ownership rule for the auto-issue policy: manifest-owned until an operator claims it.
  if (manifest.autoIssue) {
    await setAutoIssuePolicy(
      db,
      slug,
      JSON.stringify(manifest.autoIssue),
      "manifest",
      now,
    );
    updated.push("autoIssue");
  }

  // Service enablement + the device-registration policy, under the same ownership rule once
  // more. Unconditional (unlike the two above) because `services` is always present on a parsed
  // manifest — a manifest that declares no `modules:` block still means something definite,
  // namely the defaults. `registration` rides in the same value and is written only when the
  // manifest declared it, so dropping the key from `.pkey/product` returns the product to the
  // derived default rather than freezing whatever it last said. The `services_source = 'admin'`
  // guard lives inside `setServices`, so a push cannot turn a service back on after an operator
  // has turned it off live — nor re-open registration after one has closed it.
  await setServices(
    db,
    slug,
    serializeServices({
      services: manifest.services,
      ...(manifest.registration ? { registration: manifest.registration } : {}),
    }),
    "manifest",
    now,
  );
  updated.push("services");

  // ── schema: publish a new active version only when the catalog changed ──────
  const nextCatalogJson = JSON.stringify(manifest.catalog);
  const activeSchema = await getActiveSchema(db, slug);
  if (activeSchema?.catalog_json !== nextCatalogJson) {
    // Same screening the admin API applies before writing `product_schema`. A resync is
    // triggered by a repo webhook, so without this the sync path installs catalogs the admin
    // API would refuse — and the refusal is the only thing bounding `pattern` complexity.
    try {
      new Catalog(manifest.catalog as never).compileAll();
    } catch (e) {
      return {
        ok: false,
        error: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
    const version = await nextSchemaVersion(db, slug);
    await deactivateSchemas(db, slug);
    await insertSchema(db, {
      product: slug,
      catalog_version: version,
      catalog_json: nextCatalogJson,
      active: 1,
      created_at: now,
    });
    updated.push("schema");
  }

  // ── release_config: update the GitHub-distribution block in place ───────────
  const rel = manifest.release;
  if (rel) {
    // Defence in depth for R6-01 (the repo-name fallback bypasses the manifest boundary).
    const binaryName = rel.binaryName || repo;
    if (!isSafeBinaryName(binaryName)) {
      return {
        ok: false,
        error: `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
      };
    }
    // `artifact_policy_json` is the MANIFEST half of the artifact policy only. The operator half
    // (requireSparkleSignature, minimumSystemVersion) lives in `operator_policy_json`, which this
    // function never names — so rewriting this blob whole can no longer drop an operator's keys.
    await db.run(
      `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
         sparkle_ed25519_pub = ?, summary_marker = ?, manual_channels_json = ?,
         artifact_policy_json = ?, stable_tag_pattern = ?, ignore_tags_json = ?
         WHERE product = ?`,
      rel.channelWorkflow || null,
      rel.betaBranch || "main",
      binaryName,
      rel.sparkleEd25519Pub || null,
      rel.summaryMarker || "pkey:summary",
      rel.manualChannels.length ? JSON.stringify(rel.manualChannels) : null,
      rel.artifactPolicy ? JSON.stringify(rel.artifactPolicy) : null,
      rel.stableTagPattern,
      rel.ignoreTags.length ? JSON.stringify(rel.ignoreTags) : null,
      slug,
    );
    // The two access modes share ONE owner (`access_source`, 0022_b). Once an operator claims
    // them, this matches no row: a manifest cannot express `entitled`, so without the guard every
    // push would silently downgrade an entitled product to the manifest's mode (default public).
    await db.run(
      `UPDATE release_config SET metadata_access = ?, artifacts_access = ?
         WHERE product = ? AND COALESCE(access_source, 'manifest') = 'manifest'`,
      rel.access.metadata,
      rel.access.artifacts,
      slug,
    );
    updated.push("release");
  }

  // ── manifest-owned rows: replace from the code-first source of truth ─────────
  const stmts: DbStatement[] = [];
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

  const nextProfileIds = new Set(manifest.profiles.map((p) => p.id));
  for (const profile of await listProfiles(db, slug)) {
    if (!nextProfileIds.has(profile.id)) {
      const refs = await countLicensesUsingProfile(db, slug, profile.id);
      if (refs > 0)
        return {
          ok: false,
          error: `cannot remove profile ${profile.id}; ${refs} license(s) still reference it`,
        };
    }
  }
  stmts.push({ sql: "DELETE FROM profiles WHERE product = ?", params: [slug] });
  for (const p of manifest.profiles) {
    stmts.push(
      stmtInsertProfile({
        product: slug,
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        payloadJson: JSON.stringify(p.payload),
        modifiedAt: now,
      }),
    );
  }
  updated.push("profiles");

  const nextTierIds = new Set(manifest.tiers.map((t) => t.id));
  for (const tier of await listTiers(db, slug)) {
    if (!nextTierIds.has(tier.id)) {
      const refs = await countLicensesUsingTier(db, slug, tier.id);
      if (refs > 0)
        return {
          ok: false,
          error: `cannot remove tier ${tier.id}; ${refs} license(s) still reference it`,
        };
    }
  }
  stmts.push({ sql: "DELETE FROM tiers WHERE product = ?", params: [slug] });
  for (const t of manifest.tiers) {
    stmts.push(
      stmtInsertTier({
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
      }),
    );
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

  // The app deliverable's declaration (P2-04): `release_deliverables.def_json` and the channels'
  // `includes`. Before the truth store below, which classifies by the same declaration.
  if (rel) {
    stmts.push(...manifestDeliverableStatements(slug, rel.app, now));
    updated.push("deliverables");
  }

  // ── release truth store: the same pass, one extra GitHub read (P2.T2) ───────
  //
  // `release_metadata`/`release_artifacts`/`release_channels`/`release_health` have existed as
  // write-orphaned scaffolding since 0007. This is the writer. It rides in the SAME batch as the
  // manifest-owned rows so a resync is one transaction: a truth store that landed separately
  // could survive a failure that rolled the rest back, and the portal would then list releases
  // for a product whose tiers had not been updated.
  //
  // The row is re-read rather than reused, because the UPDATE above may just have changed the
  // access modes the store records.
  const syncedCfg = rel ? await getReleaseConfig(db, slug) : cfg;
  if (syncedCfg) {
    // The map just parsed, not the persisted one: this batch is what persists it.
    const storeStmts = await releaseStoreSyncStatements(
      env,
      db,
      syncedCfg,
      now,
      fetchImpl,
      rel ? { app: rel.app } : {},
    );
    if (storeStmts.length > 0) {
      stmts.push(...storeStmts);
      updated.push("releases");
    }
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
    // A resync can change the tag filter, the manual channels and the store: drop every cached
    // resolution of this product (P2-05, `ghCache.ts`).
    await bumpReleaseGeneration(env, slug, now);
  }

  if (droppedBefore.length > 0) updated.push("edgeMintApprovals");
  return { ok: true, updated };
}
