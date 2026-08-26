/// <reference types="@cloudflare/workers-types" />

/**
 * Re-fetch a linked repo's `.pkey/` and re-apply it to an already-registered product. This is
 * the "resync" path: an operator pushes new `.pkey/` files and asks Polaris Key to pick up the
 * changes WITHOUT minting a new product or touching the signing key.
 *
 * Minimal-viable scope (diff-then-update): we re-parse the manifest and update the catalog
 * (new active schema version), the release block (channel/binary/marker/pub), and the OIDC +
 * tiers rows. The signing key, secrets, and edge-mint key material are NOT re-minted here.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import {
  getActiveSchema,
  getProduct,
  insertSchema,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertTier,
} from "../repo.js";
import {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  deactivateSchemas,
  listProfiles,
  listTiers,
  nextSchemaVersion,
} from "../admin/repo.js";
import { getReleaseConfig } from "./index.js";
import { parseManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile } from "./github.js";
import { isSafeBinaryName } from "./install.js";

export type ResyncResult =
  | { ok: true; updated: string[] }
  | { ok: false; error: string; errors?: string[] };

const PKEY_FILES: Record<"schema" | "product" | "release", string[]> = {
  schema: [".pkey/schema.json", ".pkey/schema.yaml", ".pkey/schema.yml"],
  product: [".pkey/product.json", ".pkey/product.yaml", ".pkey/product.yml"],
  release: [".pkey/release.json", ".pkey/release.yaml", ".pkey/release.yml"],
};

async function readPkeyFile(
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
 */
export async function resyncRepo(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
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
    token = await getInstallationToken(env, repo, installId, now, fetchImpl);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "github access failed",
    };
  }

  const files: Record<string, string> = {};
  try {
    for (const name of ["schema", "product", "release"] as const) {
      const text = await readPkeyFile(
        token,
        owner,
        repo,
        PKEY_FILES[name],
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

  const updated: string[] = [];

  await db.run(
    `UPDATE products SET name = ?, compat_min = ?, compat_max = ?,
       default_max_offline_days = ?, default_device_limit = ?, admin_group = ?,
       modified_at = ? WHERE slug = ?`,
    manifest.product.name,
    manifest.product.compatMin,
    manifest.product.compatMax,
    manifest.product.defaultMaxOfflineDays,
    manifest.product.defaultDeviceLimit,
    manifest.product.adminGroup,
    now,
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
    await db.run(
      `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
         sparkle_ed25519_pub = ?, summary_marker = ?, artifact_policy_json = ?,
         metadata_access = ?, artifacts_access = ? WHERE product = ?`,
      rel.channelWorkflow || null,
      rel.betaBranch || "main",
      binaryName,
      rel.sparkleEd25519Pub || null,
      rel.summaryMarker || "pkey:summary",
      rel.artifactPolicy ? JSON.stringify(rel.artifactPolicy) : null,
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
  updated.push("edgeMint");
  if (stmts.length > 0) await db.batch(stmts);

  return { ok: true, updated };
}
