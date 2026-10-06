/// <reference types="@cloudflare/workers-types" />

/**
 * Link an EXISTING product to a GitHub repository (EXPERIENCE.md §0.4 S1, AS 1.5): Settings →
 * Repository → **Link repository…**. The other link path, `linkRepo.ts`, creates a product from a
 * repository; this one hands a product that already exists (one created from nothing, or before
 * its repository had a `.pkey/`) over to its manifest.
 *
 * Two steps, so the operator sees what moves before anything is written:
 *
 *   1. `prepareLink` (the console's "Check"): the same checks `linkRepo` runs (the URL, the App
 *      installation, the manifest's parse) plus the ones only an existing product has (the
 *      manifest's slug is this product's, the product is not linked already) and every refusal
 *      resync would hit AFTER its first write (an issuer change outside the allowlist, an unsafe
 *      binary name, a catalog the validator refuses, a tier or profile licences still use). It
 *      writes nothing and answers the plan: what the manifest will apply, what stays because an
 *      operator set it in the console, what it deletes, and what blocks the link.
 *   2. `linkExistingProduct` (the console's "Link repository"): the same checks again, against
 *      the manifest as GitHub serves it now. The operator's check is pinned by `manifestDigest`:
 *      a push between the two steps refuses the link ("check again") instead of applying a
 *      manifest nobody looked at. Then the coordinates are written and `resyncRepo` applies the
 *      manifest, so a linked product's first apply and every later push run the same code.
 *
 * The plan (`planRepoManifest`) has the shape S-18 §4.5 gives ST-17's resync dry run
 * (`apply`, `skipClaimed`, `delete`, `conflicts`) and reads the same ownership columns
 * `applyRepoManifest` honours, so it says what that function will do. ST-17 makes resync, the
 * webhook and the deploy hook record it too.
 */

import { Catalog } from "@polaris-key/catalog";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db, Env } from "../../core/platform.js";
import {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  getActiveSchema,
  getProduct,
  listProfiles,
  listTiers,
  stmtInsertReleaseConfig,
} from "../../core/ingest.js";
import { parseServices } from "../../core/services.js";
import { reservedNamesMode } from "../../core/reservedNames.js";
import { getPublisherPolicy } from "../../core/publisher.js";
import { getReleaseConfig } from "./config.js";
import { parseManifest, type ParsedManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { isSafeBinaryName } from "./install.js";
import {
  digestManifestFiles,
  manifestIssuerRefusal,
  parseRepoUrl,
} from "./linkRepo.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import { resyncRepo, type ResyncResult } from "./resync.js";
import type { ManifestIngest } from "../../core/registry.js";

/** Which check a refusal belongs to: the console marks the rows before it passed. */
export type LinkCheck =
  | "product"
  | "repository"
  | "app"
  | "manifest"
  | "slug"
  | "policy";

/** One line of the plan. `id` names the row (a tier, a catalog key) when there is one. */
export interface PlanItem {
  area:
    | "source"
    | "product"
    | "compat"
    | "services"
    | "fingerprint"
    | "autoIssue"
    | "catalog"
    | "tiers"
    | "profiles"
    | "oidc"
    | "release"
    | "access"
    | "publisher"
    | "edgeMint"
    | "provisioning";
  id?: string;
  summary: string;
}

/** What applying a manifest to a product will do (S-18 §4.5's dry-run shape). */
export interface ManifestPlan {
  /** Values and rows the manifest writes. */
  apply: PlanItem[];
  /** Values the manifest declares but an operator set in the console: they stay. */
  skipClaimed: PlanItem[];
  /** Rows the product has that the manifest does not declare: they go. */
  delete: PlanItem[];
  /** What blocks the apply. Non-empty refuses the link. */
  conflicts: PlanItem[];
}

export type LinkRefusal = {
  ok: false;
  /** 409 when the manifest moved since the check; 422 for every other refusal. */
  status: 409 | 422;
  /** The coordinates had been written when the apply refused (or threw) and were put back. */
  afterWrite?: true;
  check: LinkCheck;
  error: string;
  errors?: string[];
};

export type PreparedLink =
  | {
      ok: true;
      /** `owner/repo`, as parsed from what the operator typed. */
      repository: string;
      owner: string;
      repo: string;
      installId: number;
      /** The default-branch commit the files were read at. */
      commit: string;
      /** sha-256 over the `.pkey/` files read: what the operator checked. A push that leaves
       *  `.pkey/` alone moves the commit but not the digest, so it does not refuse the link. */
      manifestDigest: string;
      manifest: ParsedManifest;
      plan: ManifestPlan;
      /** Secret NAMES the manifest references that the product does not hold yet. */
      remainingSecrets: string[];
    }
  | LinkRefusal;

export type LinkExistingResult =
  | {
      ok: true;
      repository: string;
      plan: ManifestPlan;
      updated: string[];
      refused?: Extract<ResyncResult, { ok: true }>["refused"];
      packSets?: Extract<ResyncResult, { ok: true }>["packSets"];
      remainingSecrets: string[];
    }
  | LinkRefusal;

const refuse = (
  check: LinkCheck,
  error: string,
  errors?: string[],
): LinkRefusal => ({
  ok: false,
  status: 422,
  check,
  error,
  ...(errors ? { errors } : {}),
});

/**
 * Check that `repoUrl`'s `.pkey/` can take over `slug`, and plan what it would change. Writes
 * nothing. Every refusal names the check it failed.
 */
export async function prepareLink(
  env: Env,
  db: Db,
  slug: string,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<PreparedLink> {
  const product = await getProduct(db, slug);
  if (!product) return refuse("product", "unknown product");
  // The system product is linked by the deploy hook from the platform repository, never here.
  if (product.system === 1 || slug === SYSTEM_PRODUCT_SLUG)
    return refuse(
      "product",
      `${slug} is the platform's own product: the deploy hook links it to the platform repository`,
    );
  if (product.release_source === "github") {
    const cfg = await getReleaseConfig(db, slug);
    const where =
      cfg?.gh_owner && cfg.gh_repo ? ` to ${cfg.gh_owner}/${cfg.gh_repo}` : "";
    return refuse(
      "product",
      `${slug} is already linked${where}; resync it instead`,
    );
  }

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed)
    return refuse(
      "repository",
      "could not parse a github owner/repo from the URL",
    );
  const { owner, repo } = parsed;

  let installId: number;
  let token: string;
  try {
    installId = await discoverInstallation(env, owner, repo, now, fetchImpl);
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch (err) {
    return refuse(
      "app",
      err instanceof Error ? err.message : "github access failed",
    );
  }

  // Read exactly as link and resync do: every document at the default branch's head, one commit
  // (ST-01a, `manifestFetch.ts`).
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
    return refuse(
      "manifest",
      err instanceof Error ? err.message : "github manifest fetch failed",
    );
  }
  // The same reserved-name severity link, resync and the deploy hook parse with (LX-05).
  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
  });
  if (!result.ok)
    return refuse("manifest", "manifest validation failed", result.errors);
  const manifest = result.manifest;

  if (manifest.product.slug !== slug)
    return refuse(
      "slug",
      `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    );

  // The refusals `applyRepoManifest` reaches only after its first write, run here first so a
  // link either applies whole or not at all.
  const binaryName = manifest.release?.binaryName || repo;
  if (manifest.release && !isSafeBinaryName(binaryName))
    return refuse(
      "policy",
      `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
    );
  if (manifest.oidc?.provider === "custom") {
    const stored = await db.first<{ issuer: string | null }>(
      "SELECT issuer FROM oidc_config WHERE product = ?",
      slug,
    );
    if ((stored?.issuer ?? "") !== manifest.oidc.issuer) {
      const refusal = manifestIssuerRefusal(env, manifest.oidc.issuer);
      if (refusal) return refuse("policy", refusal);
    }
  }
  // Screened only when it changed, as resync does: an unchanged catalog is already stored and
  // resync will not publish it again.
  const active = await getActiveSchema(db, slug);
  try {
    const catalog = new Catalog(manifest.catalog as never);
    if (active?.catalog_json !== JSON.stringify(manifest.catalog))
      catalog.compileAll();
  } catch (e) {
    return refuse(
      "policy",
      `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }

  const plan = await planRepoManifest(db, slug, manifest);
  plan.apply.unshift({
    area: "source",
    summary: `Source becomes ${owner}/${repo}: pushes to its default branch re-apply .pkey/`,
  });

  const held = new Set(
    (
      await db.all<{ name: string }>(
        "SELECT name FROM product_secrets WHERE product = ?",
        slug,
      )
    ).map((r) => r.name),
  );
  const remainingSecrets = secretNames(manifest).filter((n) => !held.has(n));

  return {
    ok: true,
    repository: `${owner}/${repo}`,
    owner,
    repo,
    installId,
    commit,
    manifestDigest: await digestManifestFiles(files),
    manifest,
    plan,
    remainingSecrets,
  };
}

/**
 * Link `slug` to `repoUrl` and apply its manifest. `manifestDigest` is the check's: a manifest
 * that changed since refuses with 409. A refusal from the apply itself puts the product back
 * to manual (the checks above make that a race with a push, not an expected path).
 */
export async function linkExistingProduct(
  env: Env,
  db: Db,
  slug: string,
  repoUrl: string,
  manifestDigest: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest?: ManifestIngest,
): Promise<LinkExistingResult> {
  const prepared = await prepareLink(env, db, slug, repoUrl, now, fetchImpl);
  if (!prepared.ok) return prepared;
  if (prepared.manifestDigest !== manifestDigest)
    return {
      ok: false,
      status: 409,
      check: "manifest",
      error: "the repository's .pkey/ changed since the check; check again",
    };
  if (prepared.plan.conflicts.length > 0)
    return refuse(
      "policy",
      "the manifest conflicts with this product",
      prepared.plan.conflicts.map((c) => c.summary),
    );

  const { owner, repo, installId, manifest } = prepared;
  const previous = await getProduct(db, slug);
  const prevConfig = await getReleaseConfig(db, slug);
  const rel = manifest.release;
  const row = stmtInsertReleaseConfig({
    product: slug,
    ghOwner: owner,
    ghRepo: repo,
    ghInstallationId: installId,
    channelWorkflow: rel?.channelWorkflow || null,
    betaBranch: rel?.betaBranch || "main",
    binaryName: rel?.binaryName || repo,
    sparkleEd25519Pub: rel?.sparkleEd25519Pub || null,
    summaryMarker: rel?.summaryMarker || "pkey:summary",
    metadataAccess: rel?.access.metadata ?? "public",
    artifactsAccess: rel?.access.artifacts ?? "public",
    accessSource: "manifest",
  });
  // The coordinates only. Everything else in the row (and the rest of the product) is the
  // resync's to write, under the same ownership rules every later push follows; a row that
  // already exists keeps its operator-owned columns.
  await db.batch([
    {
      sql: `${row.sql}
            ON CONFLICT(product) DO UPDATE SET
              gh_owner = excluded.gh_owner,
              gh_repo = excluded.gh_repo,
              gh_installation_id = excluded.gh_installation_id`,
      params: row.params,
    },
    {
      sql: `UPDATE products SET release_source = 'github', modified_at = ? WHERE slug = ?`,
      params: [now, slug],
    },
  ]);

  // Put the product back to manual: the source and the coordinates as they were. What a refused
  // resync already wrote stays, as for any resync (the checks above leave only a push racing
  // the apply able to get that far).
  const rollback = () =>
    db.batch([
      {
        sql: "UPDATE products SET release_source = ? WHERE slug = ?",
        params: [previous?.release_source ?? null, slug],
      },
      prevConfig
        ? {
            sql: "UPDATE release_config SET gh_owner = ?, gh_repo = ?, gh_installation_id = ? WHERE product = ?",
            params: [
              prevConfig.gh_owner,
              prevConfig.gh_repo,
              prevConfig.gh_installation_id,
              slug,
            ],
          }
        : {
            sql: "DELETE FROM release_config WHERE product = ?",
            params: [slug],
          },
    ]);

  let applied: ResyncResult;
  try {
    applied = await resyncRepo(env, db, slug, now, fetchImpl, ingest);
  } catch (err) {
    await rollback();
    throw err;
  }
  if (!applied.ok) {
    await rollback();
    return {
      ...refuse("policy", applied.error, applied.errors),
      afterWrite: true,
    };
  }
  return {
    ok: true,
    repository: prepared.repository,
    plan: prepared.plan,
    updated: applied.updated,
    ...(applied.refused ? { refused: applied.refused } : {}),
    ...(applied.packSets ? { packSets: applied.packSets } : {}),
    remainingSecrets: prepared.remainingSecrets,
  };
}

/** The distinct secret NAMES a manifest references (OIDC, edge-mint, provisioning hooks). */
function secretNames(manifest: ParsedManifest): string[] {
  const names = new Set<string>();
  if (manifest.oidc?.provider === "custom" && manifest.oidc.clientSecretSecret)
    names.add(manifest.oidc.clientSecretSecret);
  for (const e of manifest.edgeMint)
    if (e.signingKeySecret) names.add(e.signingKeySecret);
  for (const h of manifest.provisioning)
    if (h.secretKey) names.add(h.secretKey);
  return [...names];
}

const claimed = (source: string | null | undefined): boolean =>
  source === "admin";

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function parseJson(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function catalogKeys(catalog: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entries =
    catalog && typeof catalog === "object"
      ? (catalog as { entries?: unknown }).entries
      : undefined;
  if (!Array.isArray(entries)) return out;
  for (const e of entries)
    if (
      e &&
      typeof e === "object" &&
      typeof (e as { key?: unknown }).key === "string"
    )
      out.set((e as { key: string }).key, JSON.stringify(e));
  return out;
}

const list = (ids: string[]): string =>
  ids.length <= 4
    ? ids.join(", ")
    : `${ids.slice(0, 4).join(", ")} and ${ids.length - 4} more`;

/**
 * What applying `manifest` to `slug` will do, read from the same ownership columns
 * `applyRepoManifest` honours. Read-only. A row the manifest drops that licences still use is a
 * conflict (resync refuses it), not a deletion.
 */
export async function planRepoManifest(
  db: Db,
  slug: string,
  manifest: ParsedManifest,
): Promise<ManifestPlan> {
  const plan: ManifestPlan = {
    apply: [],
    skipClaimed: [],
    delete: [],
    conflicts: [],
  };
  const product = await getProduct(db, slug);
  if (!product) return plan;
  const m = manifest.product;

  // ── the product row ────────────────────────────────────────────────────────
  const fields: string[] = [];
  if (product.name !== m.name) fields.push(`name "${m.name}"`);
  if (product.default_max_offline_days !== m.defaultMaxOfflineDays)
    fields.push(`offline grace ${m.defaultMaxOfflineDays} days`);
  if (product.default_device_limit !== m.defaultDeviceLimit)
    fields.push(`device limit ${m.defaultDeviceLimit}`);
  if ((product.admin_group ?? null) !== (m.adminGroup ?? null))
    fields.push(
      m.adminGroup ? `admin group ${m.adminGroup}` : "no admin group",
    );
  if (!sameJson(parseJson(product.web_origins_json) ?? [], manifest.webOrigins))
    fields.push(`${manifest.webOrigins.length} web origins`);
  if (fields.length)
    plan.apply.push({ area: "product", summary: `Sets ${fields.join(", ")}` });

  const compatDiffers =
    product.compat_min !== m.compatMin || product.compat_max !== m.compatMax;
  if (compatDiffers)
    (claimed(product.compat_source) ? plan.skipClaimed : plan.apply).push({
      area: "compat",
      summary: claimed(product.compat_source)
        ? `Compatibility window stays ${product.compat_min} to ${product.compat_max} (set in the console)`
        : `Compatibility window ${m.compatMin} to ${m.compatMax}`,
    });

  // ── services ───────────────────────────────────────────────────────────────
  const current = parseServices(product.services_json).services;
  const on: string[] = [];
  const off: string[] = [];
  for (const [svc, v] of Object.entries(manifest.services)) {
    const was = current[svc as keyof typeof current]?.enabled ?? false;
    if (v.enabled && !was) on.push(svc);
    if (!v.enabled && was) off.push(svc);
  }
  if (on.length || off.length) {
    const what = [
      on.length ? `turns on ${list(on)}` : "",
      off.length ? `turns off ${list(off)}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    if (claimed(product.services_source))
      plan.skipClaimed.push({
        area: "services",
        summary: `Services stay as set in the console (the manifest ${what})`,
      });
    else plan.apply.push({ area: "services", summary: `Services: ${what}` });
  }

  // ── the two policies, declared-only ────────────────────────────────────────
  if (
    manifest.fingerprint &&
    !sameJson(parseJson(product.fingerprint_policy_json), manifest.fingerprint)
  )
    (claimed(product.fingerprint_policy_source)
      ? plan.skipClaimed
      : plan.apply
    ).push({
      area: "fingerprint",
      summary: claimed(product.fingerprint_policy_source)
        ? "Device fingerprint policy stays as set in the console"
        : "Device fingerprint policy from .pkey/product",
    });
  if (
    manifest.autoIssue &&
    !sameJson(parseJson(product.auto_issue_json), manifest.autoIssue)
  )
    (claimed(product.auto_issue_source) ? plan.skipClaimed : plan.apply).push({
      area: "autoIssue",
      summary: claimed(product.auto_issue_source)
        ? "Auto-issue stays as set in the console"
        : "Auto-issue policy from .pkey/product",
    });

  // ── catalog: one unit, a new version when it changed ───────────────────────
  const active = await getActiveSchema(db, slug);
  const before = catalogKeys(parseJson(active?.catalog_json));
  const after = catalogKeys(manifest.catalog);
  if ((active?.catalog_json ?? null) !== JSON.stringify(manifest.catalog)) {
    const added = [...after.keys()].filter((k) => !before.has(k));
    const changed = [...after.keys()].filter(
      (k) => before.has(k) && before.get(k) !== after.get(k),
    );
    const parts = [
      added.length ? `adds ${list(added)}` : "",
      changed.length ? `changes ${list(changed)}` : "",
    ].filter(Boolean);
    plan.apply.push({
      area: "catalog",
      summary: `Publishes a new catalog version${parts.length ? `: ${parts.join("; ")}` : ""}`,
    });
    for (const k of before.keys())
      if (!after.has(k))
        plan.delete.push({
          area: "catalog",
          id: k,
          summary: `Catalog key ${k}`,
        });
  }

  // ── tiers and profiles: replaced; a dropped row in use blocks ──────────────
  const tiers = await listTiers(db, slug);
  const tierIds = new Set(tiers.map((t) => t.id));
  for (const t of manifest.tiers)
    plan.apply.push({
      area: "tiers",
      id: t.id,
      summary: tierIds.has(t.id)
        ? `Tier ${t.id} replaced from the manifest`
        : `Tier ${t.id} added`,
    });
  const nextTiers = new Set(manifest.tiers.map((t) => t.id));
  for (const t of tiers) {
    if (nextTiers.has(t.id)) continue;
    const refs = await countLicensesUsingTier(db, slug, t.id);
    if (refs > 0)
      plan.conflicts.push({
        area: "tiers",
        id: t.id,
        summary: `Tier ${t.id} is not in the manifest but ${refs} ${refs === 1 ? "license uses" : "licenses use"} it: add it to .pkey/product or move them first`,
      });
    else plan.delete.push({ area: "tiers", id: t.id, summary: `Tier ${t.id}` });
  }

  const profiles = await listProfiles(db, slug);
  const profileIds = new Set(profiles.map((p) => p.id));
  for (const p of manifest.profiles)
    plan.apply.push({
      area: "profiles",
      id: p.id,
      summary: profileIds.has(p.id)
        ? `Profile ${p.id} replaced from the manifest (secret values set in the console are kept)`
        : `Profile ${p.id} added`,
    });
  const nextProfiles = new Set(manifest.profiles.map((p) => p.id));
  for (const p of profiles) {
    if (nextProfiles.has(p.id)) continue;
    const refs = await countLicensesUsingProfile(db, slug, p.id);
    if (refs > 0)
      plan.conflicts.push({
        area: "profiles",
        id: p.id,
        summary: `Profile ${p.id} is not in the manifest but ${refs} ${refs === 1 ? "license uses" : "licenses use"} it: add it to .pkey/schema or move them first`,
      });
    else
      plan.delete.push({
        area: "profiles",
        id: p.id,
        summary: `Profile ${p.id}`,
      });
  }

  // ── sign-in provider ───────────────────────────────────────────────────────
  const oidc = await db.first<{ provider: string; issuer: string | null }>(
    "SELECT provider, issuer FROM oidc_config WHERE product = ?",
    slug,
  );
  if (manifest.oidc)
    plan.apply.push({
      area: "oidc",
      summary:
        manifest.oidc.provider === "custom"
          ? `Sign-in provider ${manifest.oidc.issuer}`
          : "Sign-in through the platform provider",
    });
  else if (oidc)
    plan.delete.push({
      area: "oidc",
      summary: "Sign-in provider settings (the manifest declares none)",
    });

  // ── release, access, trusted publisher ─────────────────────────────────────
  const cfg = await getReleaseConfig(db, slug);
  if (manifest.release) {
    plan.apply.push({
      area: "release",
      summary: "Release settings from .pkey/release",
    });
    if (claimed(cfg?.access_source))
      plan.skipClaimed.push({
        area: "access",
        summary: "Release access modes stay as set in the console",
      });
  }
  const publisher = await getPublisherPolicy(db, slug);
  const declared = manifest.release?.trustedPublisher ?? null;
  if (publisher?.source === "admin") {
    if (declared)
      plan.skipClaimed.push({
        area: "publisher",
        summary: `Trusted publisher stays ${publisher.workflow} in ${publisher.repository} (set in the console)`,
      });
  } else if (declared)
    plan.apply.push({
      area: "publisher",
      summary: `Trusted publisher ${declared.workflow}`,
    });
  else if (publisher)
    plan.delete.push({
      area: "publisher",
      summary: "Trusted publisher (the manifest declares none)",
    });

  // ── edge-mint recipes and provisioning hooks: replaced whole ───────────────
  const recipes = await db.all<{ id: string }>(
    "SELECT id FROM edge_mint_config WHERE product = ?",
    slug,
  );
  const nextRecipes = new Set(manifest.edgeMint.map((e) => e.id));
  if (manifest.edgeMint.length)
    plan.apply.push({
      area: "edgeMint",
      summary: `Token recipes ${list([...nextRecipes])} (each waits for approval)`,
    });
  for (const r of recipes)
    if (!nextRecipes.has(r.id))
      plan.delete.push({
        area: "edgeMint",
        id: r.id,
        summary: `Token recipe ${r.id}`,
      });
  const hooks = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM provisioning_config WHERE product = ?",
    slug,
  );
  if (manifest.provisioning.length)
    plan.apply.push({
      area: "provisioning",
      summary: `${manifest.provisioning.length} provisioning ${manifest.provisioning.length === 1 ? "hook" : "hooks"}`,
    });
  else if ((hooks?.n ?? 0) > 0)
    plan.delete.push({
      area: "provisioning",
      summary: "Provisioning hooks (the manifest declares none)",
    });

  return plan;
}
