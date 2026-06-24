/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub-forward product creation: paste a repo URL, read its `.pkey/` manifest, mint a
 * per-product Ed25519 signing key (sealed under the platform KEK), and register the product
 * atomically. This is the "link a repo" path; the manual path lives in admin/handlers.
 *
 * The flow:
 *   1. Parse `owner/repo` from the URL.
 *   2. Discover the App installation on that repo, mint an installation token.
 *   3. Read `.pkey/schema.*`, `.pkey/product.*`, `.pkey/release.*` (JSON or YAML), parse them.
 *   4. Generate + seal an Ed25519 key; assemble the products + child rows.
 *   5. Insert everything in ONE `db.batch` so a partial product can never exist.
 *
 * Everything talks to GitHub through an injectable `fetchImpl`, so the whole thing unit-tests
 * with a stubbed fetch (no network).
 */

import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { generateEd25519, seal } from "../keyvault.js";
import {
  getProduct,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertProvisioning,
  stmtInsertReleaseConfig,
  stmtInsertSchema,
  stmtInsertTier,
} from "../repo.js";
import { parseManifest, type ParsedManifest } from "./manifest.js";
import { discoverInstallation, type FetchImpl, getInstallationToken } from "./githubApp.js";
import { fetchRepoFile } from "./github.js";

export type LinkRepoResult =
  | {
      ok: true;
      slug: string;
      kid: string;
      /** Operator guidance for any post-link configuration (e.g. secrets to supply). */
      install: string;
      /** NAMES of the sealed secrets the manifest references but didn't ship — never values. */
      remainingSecrets: string[];
    }
  | { ok: false; error: string; errors?: string[] };

/** The `.pkey/` files we look for, in extension-preference order (JSON beats YAML). */
const PKEY_FILES: Record<"schema" | "product" | "release", string[]> = {
  schema: [".pkey/schema.json", ".pkey/schema.yaml", ".pkey/schema.yml"],
  product: [".pkey/product.json", ".pkey/product.yaml", ".pkey/product.yml"],
  release: [".pkey/release.json", ".pkey/release.yaml", ".pkey/release.yml"],
};

/** Pull `{owner, repo}` from a GitHub URL or a bare `owner/repo`. Returns null on garbage. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  // Accept https://github.com/owner/repo, git@github.com:owner/repo, or owner/repo.
  const m =
    trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i) ??
    trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/** Read the first existing variant of a `.pkey/` file (extensions tried in order). */
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
 * Link a GitHub repo as a new Polaris Key product. Returns a structured result rather than
 * throwing on the expected failure modes (bad URL, app not installed, manifest errors) so the
 * admin handler can surface a clean 4xx.
 */
export async function linkRepo(
  env: Env,
  db: Db,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<LinkRepoResult> {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return { ok: false, error: "could not parse a github owner/repo from the URL" };
  const { owner, repo } = parsed;

  // Discover the installation + mint a token. These throw on App-config / install problems;
  // we map them to a structured error rather than a 500.
  let installId: number;
  let token: string;
  try {
    installId = await discoverInstallation(env, owner, repo, now, fetchImpl);
    token = await getInstallationToken(env, repo, installId, now, fetchImpl);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "github access failed" };
  }

  // Read the `.pkey/` files (schema + product required, release optional). Missing required
  // files surface as parseManifest errors below.
  const files: Record<string, string> = {};
  for (const name of ["schema", "product", "release"] as const) {
    const text = await readPkeyFile(token, owner, repo, PKEY_FILES[name], fetchImpl);
    if (text !== undefined) files[name] = text;
  }

  const result = parseManifest(files);
  if (!result.ok) return { ok: false, error: "manifest validation failed", errors: result.errors };
  const manifest = result.manifest;

  if (await getProduct(db, manifest.product.slug)) {
    return { ok: false, error: `product already exists: ${manifest.product.slug}` };
  }

  return registerFromManifest(env, db, manifest, { owner, repo, installId }, now);
}

/** Assemble + atomically insert all rows for a parsed manifest (GitHub coordinates supplied). */
async function registerFromManifest(
  env: Env,
  db: Db,
  manifest: ParsedManifest,
  gh: { owner: string; repo: string; installId: number },
  now: number,
): Promise<LinkRepoResult> {
  const slug = manifest.product.slug;
  const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}`;

  // Mint + seal the per-product Ed25519 signing key under the platform KEK.
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const encPrivate = await seal(env, privatePkcs8Pem);

  // `signing_key_secret` is a legacy column; we keep a derived name for back-compat but the
  // real key now lives sealed in product_keys (opened by loadProduct under the KEK).
  const signingKeySecret = `SIGNING_KEY__${slug.toUpperCase().replace(/-/g, "_")}`;

  // Defaults: binary name = repo name; summary marker = the parser default.
  const rel = manifest.release;
  const binaryName = rel?.binaryName || gh.repo;
  const summaryMarker = rel?.summaryMarker || "pkey:summary";

  const statements: DbStatement[] = [
    stmtInsertProduct({
      slug,
      name: manifest.product.name,
      signing_kid: kid,
      signing_key_secret: signingKeySecret,
      signing_pub: publicRawB64url,
      compat_min: manifest.product.compatMin,
      compat_max: manifest.product.compatMax,
      default_max_offline_days: manifest.product.defaultMaxOfflineDays,
      default_machine_limit: manifest.product.defaultMachineLimit,
      admin_group: manifest.product.adminGroup,
      branding_json: null,
      release_source: "github",
      created_at: now,
      modified_at: now,
    }),
    stmtInsertSchema({
      product: slug,
      catalog_version: 1,
      catalog_json: JSON.stringify(manifest.catalog),
      active: 1,
      created_at: now,
    }),
    stmtInsertProductKey({
      product: slug,
      kid,
      alg: "Ed25519",
      public_b64url: publicRawB64url,
      enc_private_json: encPrivate,
      status: "active",
      created_at: now,
      rotated_at: null,
    }),
  ];

  if (manifest.oidc) {
    statements.push(
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

  for (const t of manifest.tiers) {
    statements.push(
      stmtInsertTier({
        product: slug,
        id: t.id,
        label: t.label,
        profileId: t.profileId ?? null,
        policyExpiryDays: t.policyExpiryDays ?? null,
        policyMachineLimit: t.policyMachineLimit ?? null,
        modifiedAt: now,
      }),
    );
  }

  for (const h of manifest.provisioning) {
    statements.push(stmtInsertProvisioning({ product: slug, ...h }));
  }

  // release_config carries the GitHub coordinates discovered above.
  statements.push(
    stmtInsertReleaseConfig({
      product: slug,
      ghOwner: gh.owner,
      ghRepo: gh.repo,
      ghInstallationId: gh.installId,
      channelWorkflow: rel?.channelWorkflow || null,
      betaBranch: rel?.betaBranch || "main",
      binaryName,
      sparkleEd25519Pub: rel?.sparkleEd25519Pub || null,
      summaryMarker,
    }),
  );

  for (const e of manifest.edgeMint) {
    statements.push(
      stmtInsertEdgeMint({
        product: slug,
        id: e.id,
        alg: e.alg,
        signingKeySecret: e.signingKeySecret,
        kid: e.kid,
        claimsTemplate: e.claimsTemplate ?? {},
        ttlSeconds: e.ttlSeconds,
      }),
    );
  }

  await db.batch(statements);

  // Secrets the manifest references by NAME (OIDC client secret, edge-mint key material) but
  // that an operator must still supply out-of-band via PUT /secrets. Names only — never values.
  const remainingSecrets = collectSecretNames(manifest);

  const install =
    remainingSecrets.length > 0
      ? `Linked ${gh.owner}/${gh.repo}. Supply these secrets via PUT /api/products/${slug}/secrets/<name>: ${remainingSecrets.join(", ")}.`
      : `Linked ${gh.owner}/${gh.repo}. No additional secrets required.`;

  return { ok: true, slug, kid, install, remainingSecrets };
}

/** Collect the distinct secret NAMES a manifest references (OIDC + edge-mint key material). */
function collectSecretNames(manifest: ParsedManifest): string[] {
  const names = new Set<string>();
  if (manifest.oidc?.clientSecretSecret) names.add(manifest.oidc.clientSecretSecret);
  for (const e of manifest.edgeMint) if (e.signingKeySecret) names.add(e.signingKeySecret);
  for (const h of manifest.provisioning) if (h.secretKey) names.add(h.secretKey);
  return [...names];
}
