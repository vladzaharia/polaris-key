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

import { Catalog } from "@plrs/catalog";
import { type Env, secret } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { generateEd25519, seal } from "../keyvault.js";
import {
  getProduct,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertReleaseConfig,
  stmtInsertSchema,
  stmtInsertTier,
} from "../repo.js";
import { parseManifest, type ParsedManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile } from "./github.js";
import { isSafeBinaryName } from "./install.js";

export type LinkRepoResult =
  | {
      ok: true;
      slug: string;
      kid: string;
      /** Raw Ed25519 public key (base64url) for SDK trust sets. */
      publicKey: string;
      trustKeys: Record<string, string>;
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
export function parseRepoUrl(
  repoUrl: string,
): { owner: string; repo: string } | null {
  const trimmed = repoUrl
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  // Accept https://github.com/owner/repo, git@github.com:owner/repo, or owner/repo.
  const m =
    trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i) ??
    trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Operator allowlist of the hosts a **repo-supplied** OIDC issuer may name, read from the
 * `OIDC_ISSUER_ALLOWLIST` var as a comma/whitespace-separated list of `host[:port]` entries.
 * Returns `null` when the issuer may be persisted, or the operator-facing refusal otherwise.
 *
 * This is the ingest half of R9-01, and — unlike the copy at the sink (`oidc.ts`
 * `issuerHostAllowed`, which treats "unset" as "unenforced") — it **fails closed**: with no
 * allowlist configured, no manifest may introduce a custom issuer at all.
 *
 * The asymmetry is deliberate and is the whole point of doing this here rather than there.
 * `oidc.issuer` is the base of the token POST that carries the product's OIDC `client_secret`,
 * of the JWKS fetch that decides which keys may sign an ID token, and of the anonymous 302 out
 * of `/<product>/auth/start` — and it arrives from a `.pkey/` file that any repo *writer* can
 * push, not from a platform admin. `isSafeIssuerUrl` bounds that value's *shape* (https, no
 * credentials, no reserved address literal), but nothing at the character level distinguishes
 * `https://id.example` from `https://exfil.attacker.example`; only an operator can. The sink
 * cannot fail closed, because it cannot tell a row written yesterday from one written by an
 * attacker's push five minutes ago, and refusing both would take every already-configured
 * custom-OIDC product offline on the deploy that ships this code. The two ingest paths —
 * this file (first write) and `resync.ts` (issuer *change*) — are exactly where that
 * distinction exists, so they are where the control belongs.
 *
 * Matched on `URL.host` (port included) and lower-cased, identically to the sink: a value
 * accepted here must also survive `oidc.ts` at runtime, or linking would mint a product whose
 * login is dead on arrival. There is deliberately **no** loopback carve-out — the manifest
 * validator's `wrangler dev` exception is about address *shape*, and an operator running
 * against a local IdP sets `OIDC_ISSUER_ALLOWLIST=localhost:8788`, which the sink needs anyway
 * the moment any allowlist exists.
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
  if (!parsed)
    return {
      ok: false,
      error: "could not parse a github owner/repo from the URL",
    };
  const { owner, repo } = parsed;

  // Discover the installation + mint a token. These throw on App-config / install problems;
  // we map them to a structured error rather than a 500.
  let installId: number;
  let token: string;
  try {
    installId = await discoverInstallation(env, owner, repo, now, fetchImpl);
    // Structured scope, not a bare repo name: the string form is the legacy path, which
    // yields an installation-wide token and its own cache entry (R5-03).
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

  // Read the `.pkey/` files (schema + product required, release optional). Missing required
  // files surface as parseManifest errors below.
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
    // `fetchRepoFile` throws on a non-404 upstream status and on an over-cap body. Surfacing
    // that as a structured error (as `resync.ts` already did) keeps an oversized or hostile
    // `.pkey/` file a clean 4xx for the operator instead of an unhandled 500.
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

  if (await getProduct(db, manifest.product.slug)) {
    return {
      ok: false,
      error: `product already exists: ${manifest.product.slug}`,
    };
  }

  return registerFromManifest(
    env,
    db,
    manifest,
    { owner, repo, installId },
    now,
  );
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
  const encPrivate = await seal(env, privatePkcs8Pem, {
    product: slug,
    kind: "signing-key",
    id: kid,
  });

  // Defaults: binary name = repo name; summary marker = the parser default.
  const rel = manifest.release;
  const binaryName = rel?.binaryName || gh.repo;
  const summaryMarker = rel?.summaryMarker || "pkey:summary";

  // Defence in depth for R6-01: the manifest boundary already enforces this class, but the
  // repo-name fallback does not go through it — and this value is interpolated into the
  // `curl | sh` installer served to every user of the product.
  if (!isSafeBinaryName(binaryName)) {
    return {
      ok: false,
      error: `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
    };
  }

  // R9-01, at ingest and fail-closed (see `manifestIssuerRefusal`). A first write has no
  // already-working `oidc_config` row to protect, so an unset allowlist refuses it outright.
  // A product that does not name a custom issuer never reaches this branch: `djdl` ships
  // `provider: "platform"` and no issuer at all, so linking it is unaffected.
  if (manifest.oidc?.provider === "custom") {
    const refusal = manifestIssuerRefusal(env, manifest.oidc.issuer);
    if (refusal) return { ok: false, error: refusal };
  }

  // The admin API screens every catalog it accepts (`admin/handlers/schema.ts`,
  // `admin/handlers/products.ts` both `compileAll()` before writing). The repo-sync path did
  // not, so a manifest from GitHub could install a catalog the admin API would have rejected
  // — unsupported keywords, or a `pattern` the validator cannot compile. Screen it here too,
  // so there is no route into `product_schema` that skips the check.
  try {
    new Catalog(manifest.catalog as never).compileAll();
  } catch (e) {
    return {
      ok: false,
      error: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }

  const statements: DbStatement[] = [
    stmtInsertProduct({
      slug,
      name: manifest.product.name,
      signing_kid: kid,
      signing_pub: publicRawB64url,
      compat_min: manifest.product.compatMin,
      compat_max: manifest.product.compatMax,
      default_max_offline_days: manifest.product.defaultMaxOfflineDays,
      default_device_limit: manifest.product.defaultDeviceLimit,
      admin_group: manifest.product.adminGroup,
      branding_json: null,
      release_source: "github",
      // Which Polaris services this product runs, in the SAME atomic batch as the row itself.
      // Not applied afterwards like the fingerprint/auto-issue policies: enablement decides
      // which routes a product has, so there must be no instant where a product row exists
      // without it. A freshly linked product is always manifest-owned.
      services_json: JSON.stringify(manifest.services),
      services_source: "manifest",
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
        provider: manifest.oidc.provider,
        issuer: manifest.oidc.issuer,
        clientId: manifest.oidc.clientId,
        clientSecretSecret: manifest.oidc.clientSecretSecret,
        redirectUris: manifest.oidc.redirectUris ?? [],
        groupRoleMap: manifest.oidc.groupRoleMap ?? {},
      }),
    );
  }

  for (const p of manifest.profiles) {
    statements.push(
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

  for (const t of manifest.tiers) {
    statements.push(
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
      artifactPolicyJson: rel?.artifactPolicy
        ? JSON.stringify(rel.artifactPolicy)
        : null,
      metadataAccess: rel?.access.metadata ?? "public",
      artifactsAccess: rel?.access.artifacts ?? "public",
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
        audience: e.audience ?? null,
      }),
    );
  }

  await db.batch(statements);

  // Applied after the batch because the product row must exist first. A freshly linked
  // product is always manifest-owned, so this is unconditional here (unlike resync).
  if (manifest.fingerprint) {
    await setFingerprintPolicy(
      db,
      slug,
      JSON.stringify(manifest.fingerprint),
      "manifest",
      now,
    );
  }
  if (manifest.autoIssue) {
    await setAutoIssuePolicy(
      db,
      slug,
      JSON.stringify(manifest.autoIssue),
      "manifest",
      now,
    );
  }

  // Secrets the manifest references by NAME (OIDC client secret, edge-mint key material) but
  // that an operator must still supply out-of-band via PUT /secrets. Names only — never values.
  const remainingSecrets = collectSecretNames(manifest);

  const install =
    remainingSecrets.length > 0
      ? `Linked ${gh.owner}/${gh.repo}. Supply these secrets via PUT /api/products/${slug}/secrets/<name>: ${remainingSecrets.join(", ")}.`
      : `Linked ${gh.owner}/${gh.repo}. No additional secrets required.`;

  return {
    ok: true,
    slug,
    kid,
    publicKey: publicRawB64url,
    trustKeys: { [kid]: publicRawB64url },
    install,
    remainingSecrets,
  };
}

/** Collect the distinct secret NAMES a manifest references (OIDC + edge-mint key material). */
function collectSecretNames(manifest: ParsedManifest): string[] {
  const names = new Set<string>();
  if (manifest.oidc?.provider === "custom" && manifest.oidc.clientSecretSecret)
    names.add(manifest.oidc.clientSecretSecret);
  for (const e of manifest.edgeMint)
    if (e.signingKeySecret) names.add(e.signingKeySecret);
  for (const h of manifest.provisioning)
    if (h.secretKey) names.add(h.secretKey);
  return [...names];
}
