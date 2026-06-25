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

import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import {
  getActiveSchema,
  getProduct,
  insertSchema,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertTier,
} from "../repo.js";
import { deactivateSchemas, nextSchemaVersion } from "../admin/repo.js";
import { getReleaseConfig } from "./index.js";
import { parseManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile } from "./github.js";

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
  ref?: string,
): Promise<string | undefined> {
  for (const path of paths) {
    const text = await fetchRepoFile(token, owner, repo, path, fetchImpl, ref);
    if (text !== null) return text;
  }
  return undefined;
}

/**
 * Re-apply a linked repo's `.pkey/` to an existing product. Resolves the GitHub coordinates
 * from `release_config`; if the product was never linked (no gh coordinates) it's an error.
 */
export async function resyncRepo(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ref?: string,
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
        ref,
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

  const updated: string[] = [];

  await db.run(
    `UPDATE products SET name = ?, compat_min = ?, compat_max = ?,
       default_max_offline_days = ?, default_machine_limit = ?, admin_group = ?,
       modified_at = ? WHERE slug = ?`,
    manifest.product.name,
    manifest.product.compatMin,
    manifest.product.compatMax,
    manifest.product.defaultMaxOfflineDays,
    manifest.product.defaultMachineLimit,
    manifest.product.adminGroup,
    now,
    slug,
  );
  updated.push("product");

  // ── schema: publish a new active version only when the catalog changed ──────
  const nextCatalogJson = JSON.stringify(manifest.catalog);
  const activeSchema = await getActiveSchema(db, slug);
  if (activeSchema?.catalog_json !== nextCatalogJson) {
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
    await db.run(
      `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
         sparkle_ed25519_pub = ?, summary_marker = ? WHERE product = ?`,
      rel.channelWorkflow || null,
      rel.betaBranch || "main",
      rel.binaryName || repo,
      rel.sparkleEd25519Pub || null,
      rel.summaryMarker || "pkey:summary",
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
        issuer: manifest.oidc.issuer,
        clientId: manifest.oidc.clientId,
        clientSecretSecret: manifest.oidc.clientSecretSecret,
        redirectUris: manifest.oidc.redirectUris ?? [],
        groupRoleMap: manifest.oidc.groupRoleMap ?? {},
      }),
    );
  }
  updated.push("oidc");

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

  stmts.push({ sql: "DELETE FROM tiers WHERE product = ?", params: [slug] });
  for (const t of manifest.tiers) {
    stmts.push(
      stmtInsertTier({
        product: slug,
        id: t.id,
        label: t.label,
        profileId: t.profileId ?? null,
        policyExpiryDays: t.policyExpiryDays ?? null,
        policyMachineLimit: t.policyMachineLimit ?? null,
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
