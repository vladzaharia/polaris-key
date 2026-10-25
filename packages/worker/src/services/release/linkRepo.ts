/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub-forward product creation: paste a repo URL, read its `.pkey/` manifest, mint a
 * per-product Ed25519 signing key (sealed under the platform KEK), and register the product
 * atomically. This is the "link a repo" path; the manual path lives in admin/handlers.
 *
 * The flow:
 *   1. Parse `owner/repo` from the URL.
 *   2. Discover the App installation on that repo, mint an installation token.
 *   3. Read `schema.*`, `product.*`, `release.*` (JSON or YAML) from `.pkey/`
 *      (`manifestFiles.ts`), and parse them.
 *   4. Generate + seal an Ed25519 key; assemble the products + child rows.
 *   5. Insert everything in ONE `db.batch` so a partial product can never exist.
 *
 * Everything talks to GitHub through an injectable `fetchImpl`, so the whole thing unit-tests
 * with a stubbed fetch (no network).
 */

import {} from "@polaris-key/catalog";
import {
  PRODUCT_SLUG_MAX,
  PRODUCT_SLUG_RE,
  SYSTEM_PRODUCT_SLUG,
  isReservedProductSlug,
  type ManifestDocumentName,
} from "@polaris-key/manifest";
import { type Env } from "../../platform/env.js";
import { feedSkipped } from "./resync.js";
import { sha256Hex } from "../../platform/hash.js";
import type { Db } from "../../db/types.js";
import { getProduct } from "../../core/products/store.js";
import {
  GH_SLUG_RE,
  parseManifest,
  type ParsedManifest,
} from "@polaris-key/manifest";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile, getRepoIdentity } from "./github.js";
import {} from "./install.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import {
  type CreateChoices,
  type CreatedDefaults,
} from "../../core/products/createDefaults.js";
import type { Ingest } from "../../core/ingest/types.js";
import { repoBlobLookup } from "./assetSource.js";
import { reservedNamesMode } from "../../core/licensing/reservedNames.js";
import type { LinkCheck } from "./linkExisting.js";
import { displayNameOptions } from "../../core/accounts/reservedDisplayNames.js";

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
      /** ST-42: what the create wrote beyond the manifest's own rows. */
      defaults: CreatedDefaults;
      /** F-34.2: ecosystems whose feed the manifest could not provision, with why. */
      feedProvisionSkipped?: { ecosystem: string; reason: string }[];
    }
  | {
      ok: false;
      error: string;
      errors?: string[];
      /** 409 when the `.pkey/` read is not the one the dry run checked (`manifestDigest`). */
      status?: 409;
      /** ST-42: a create choice the request got wrong (a 422 with this stable reason). */
      reason?: string;
      fields?: string[];
      codes?: string[];
    };

/** ST-42: the create choices and who made them, handed to the link. */
export interface LinkCreate {
  choices: CreateChoices;
  /** The console session's subject: the author of the console-owned default rows. */
  author: string;
}

/**
 * Pull `{owner, repo}` from a GitHub URL or a bare `owner/repo`. Returns null on garbage.
 *
 * Both halves must satisfy the manifest validator's own `GH_SLUG_RE`, whichever arm matched. They
 * are interpolated UNENCODED into `api.github.com` paths (`github.ts`, `githubApp.ts`) and stored
 * as the product's permanent coordinates, so a character class that admits `?`, `#`, `:`, `..` or
 * any other non-slash byte (`https://github.com/acme/repo?x=`, `https://github.com/../../orgs/x/y`)
 * would steer a request to another path. `.pkey/release` has bounded the same two strings with
 * that rule all along; this is the console's door onto the identical values, so it is the
 * identical rule — imported, not re-typed, because two copies of a character class is how one of
 * them drifts.
 */
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
    trimmed.match(/^([^/]+)\/([^/]+)$/);
  if (!m || !m[1] || !m[2]) return null;
  if (!GH_SLUG_RE.test(m[1]) || !GH_SLUG_RE.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

import {} from "../../core/ingest/shared.js";

// ── create probes (UX-72: FLOWS.md §3.11 W23, W24) ─────────────────────────────────────────

// The slug shape, the router and admin-action reservations and the system product all come
// from `@polaris-key/manifest` (P0-14: one slug rule): `PRODUCT_SLUG_RE`, `PRODUCT_SLUG_MAX`
// and `isReservedProductSlug`. A slug the check calls `available` is one every create path,
// and the manifest validator, will take.

/**
 * The slug a name derives, as the console's `slugFromName` does: lowercase ASCII letters and
 * digits, every other run one hyphen, none at either end, at most 64 characters.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PRODUCT_SLUG_MAX)
    .replace(/-+$/, "");
}

/** W24's answer. `suggestion` is a free slug (checked against the registry), or null. */
export type SlugCheck =
  | { slug: string; status: "available" }
  | {
      slug: string;
      status: "taken" | "reserved" | "invalid";
      message: string;
      suggestion: string | null;
    };

/** The first free variant of `base`: `-app`, then `-2`, `-3`… (the console's `suggestSlug`). */
async function freeVariant(db: Db, base: string): Promise<string | null> {
  if (!base) return null;
  const rows = await db.all<{ slug: string }>(
    // Slugs carry no LIKE metacharacters (`%`, `_`), so the prefix needs no escaping.
    "SELECT slug FROM products WHERE slug = ? OR slug LIKE ?",
    base,
    `${base}-%`,
  );
  const taken = new Set(rows.map((r) => r.slug));
  const free = (s: string) =>
    PRODUCT_SLUG_RE.test(s) && !taken.has(s) && !isReservedProductSlug(s);
  if (free(base)) return base;
  const fit = (suffix: string) =>
    `${base.slice(0, PRODUCT_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
  if (free(fit("-app"))) return fit("-app");
  for (let i = 2; i < 1000; i++) if (free(fit(`-${i}`))) return fit(`-${i}`);
  return null;
}

/**
 * Is `slug` free for a new product (W24)? Reads one prefix of the registry, never the whole of
 * it. `available`, or why not with a free suggestion: `invalid` (the shape), `reserved` (a router
 * path, an admin action or the system product), `taken` (a product has it).
 */
export async function checkSlug(db: Db, slug: string): Promise<SlugCheck> {
  if (!PRODUCT_SLUG_RE.test(slug)) {
    const derived = slugFromName(slug);
    return {
      slug,
      status: "invalid",
      message:
        slug.length > PRODUCT_SLUG_MAX
          ? `A slug has at most ${PRODUCT_SLUG_MAX} characters.`
          : "Use lowercase letters, digits and hyphens, starting with a letter or digit.",
      suggestion: derived ? await freeVariant(db, derived) : null,
    };
  }
  if (isReservedProductSlug(slug))
    return {
      slug,
      status: "reserved",
      message:
        slug === SYSTEM_PRODUCT_SLUG
          ? `${slug} is the platform's own product.`
          : `${slug} is reserved for a platform route.`,
      suggestion: await freeVariant(db, `${slug}-app`),
    };
  if (await getProduct(db, slug))
    return {
      slug,
      status: "taken",
      message: `${slug} is taken.`,
      suggestion: await freeVariant(db, slug),
    };
  return { slug, status: "available" };
}

/** The registered product whose repository is `owner/repo` (GitHub names are case-blind). */
export async function productForRepository(
  db: Db,
  owner: string,
  repo: string,
): Promise<string | null> {
  const row = await db.first<{ product: string }>(
    `SELECT rc.product AS product
       FROM release_config rc
       JOIN products p ON p.slug = rc.product
      WHERE p.release_source = 'github'
        AND lower(rc.gh_owner) = lower(?) AND lower(rc.gh_repo) = lower(?)
      ORDER BY rc.product
      LIMIT 1`,
    owner,
    repo,
  );
  return row?.product ?? null;
}

/** Every linked repository → its product, keyed `owner/repo` lower-cased (W22's marks). */
export async function productsByRepository(
  db: Db,
): Promise<Map<string, string>> {
  const rows = await db.all<{
    product: string;
    gh_owner: string;
    gh_repo: string;
  }>(
    `SELECT rc.product, rc.gh_owner, rc.gh_repo
       FROM release_config rc
       JOIN products p ON p.slug = rc.product
      WHERE p.release_source = 'github'
        AND rc.gh_owner IS NOT NULL AND rc.gh_repo IS NOT NULL
      ORDER BY rc.product`,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.gh_owner}/${r.gh_repo}`.toLowerCase();
    if (!out.has(key)) out.set(key, r.product);
  }
  return out;
}

/**
 * sha-256 over the `.pkey/` files read, in name order: what the operator checked. A push that
 * leaves `.pkey/` alone moves the commit but not the digest, so it does not refuse the create or
 * the link. Shared by both link paths (`linkExisting.ts` pins its Link with it too).
 */
export async function digestManifestFiles(
  files: Record<string, string>,
): Promise<string> {
  const canonical = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((name) => [name, files[name]]),
  );
  return sha256Hex(canonical);
}

/** One thing that blocks a create, placed on its `.pkey/` document and JSON path when it has one. */
export interface ManifestProblem {
  check: LinkCheck;
  /** The `.pkey/` document (`product`, `schema`, `release`, `distribution`), or null. */
  file: ManifestDocumentName | null;
  /** A JSON pointer into that document, or null for the document as a whole. */
  path: string | null;
  message: string;
  /** A free slug, when the problem is the slug. */
  suggestion?: string;
}

const PROBLEM_LINE =
  /^(schema|product|release|distribution)(\/[^:]*)?: ([\s\S]+)$/;

/** `parseManifest`'s `<file><path>: <message>` lines as problems with their file and path. */
export function manifestProblems(errors: readonly string[]): ManifestProblem[] {
  return errors.map((line) => {
    const m = line.match(PROBLEM_LINE);
    return m
      ? {
          check: "manifest" as const,
          file: m[1] as ManifestDocumentName,
          path: m[2] ?? "/",
          message: m[3]!,
        }
      : { check: "manifest" as const, file: null, path: null, message: line };
  });
}

/**
 * Whether `slug` (the manifest's) may be registered for `owner/repo`: the repository is not a
 * product already (F15), and the slug is free. The refusal wording is the one link-repo has
 * always answered, which the console's `errorCopy` reads (`reserved slug`, `product already
 * exists`).
 */
async function createSlugProblems(
  db: Db,
  slug: string,
  owner: string,
  repo: string,
): Promise<{
  registeredAs: string | null;
  /** The slug check's verdict, or null when the repository is a product already (not run). */
  verdict: SlugCheck | null;
  problems: ManifestProblem[];
}> {
  const registeredAs = await productForRepository(db, owner, repo);
  if (registeredAs)
    return {
      registeredAs,
      verdict: null,
      problems: [
        {
          check: "repository",
          file: null,
          path: null,
          message:
            registeredAs === slug
              ? `product already exists: ${slug}`
              : `${owner}/${repo} is already product ${registeredAs}; resync it instead`,
        },
      ],
    };
  const verdict = await checkSlug(db, slug);
  if (verdict.status === "available")
    return { registeredAs, verdict, problems: [] };
  const message =
    // F-03: the system product is created only by the platform bootstrap (`ensureSystemProduct`,
    // `POST /manage/api/platform/feeds/bootstrap`), never by registering a repository.
    slug === SYSTEM_PRODUCT_SLUG
      ? `reserved slug: ${SYSTEM_PRODUCT_SLUG} is the platform's own product, created by the package-feeds bootstrap`
      : verdict.status === "reserved"
        ? `reserved slug: ${slug} is a platform route`
        : verdict.status === "taken"
          ? `product already exists: ${slug}`
          : `invalid slug: ${verdict.message}`;
  return {
    registeredAs,
    verdict,
    problems: [
      {
        check: "slug",
        file: "product",
        path: "/product/slug",
        message,
        ...(verdict.suggestion ? { suggestion: verdict.suggestion } : {}),
      },
    ],
  };
}

/** A refusal before the manifest could be read: the URL, the App, the fetch. */
export interface CreateRefusal {
  ok: false;
  status: 422;
  check: Extract<LinkCheck, "repository" | "app" | "manifest">;
  error: string;
}

/** What `.pkey/` read at one commit, through the App, for a product that does not exist yet. */
interface RepoRead {
  ok: true;
  owner: string;
  repo: string;
  installId: number;
  token: string;
  commit: string;
  files: Record<string, string>;
  manifestDigest: string;
}

/** The URL, the App installation and the pinned `.pkey/` read link-repo and its dry run share. */
async function readRepoForCreate(
  env: Env,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<RepoRead | CreateRefusal> {
  const refuse = (
    check: CreateRefusal["check"],
    error: string,
  ): CreateRefusal => ({ ok: false, status: 422, check, error });
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed)
    return refuse(
      "repository",
      "could not parse a github owner/repo from the URL",
    );
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
    return refuse(
      "app",
      err instanceof Error ? err.message : "github access failed",
    );
  }

  // Read the manifest files (schema + product required, release optional). Missing required
  // files surface as parseManifest errors. ST-01a: every document at ONE commit, the default
  // branch's head as GitHub resolves it (`fetchPinnedManifestFiles`).
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
    // `fetchRepoFile` throws on a non-404 upstream status and on an over-cap body. Surfacing
    // that as a structured error (as `resync.ts` already did) keeps an oversized or hostile
    // `.pkey/` file a clean 4xx for the operator instead of an unhandled 500.
    return refuse(
      "manifest",
      err instanceof Error ? err.message : "github manifest fetch failed",
    );
  }
  return {
    ok: true,
    owner,
    repo,
    installId,
    token,
    commit,
    files,
    manifestDigest: await digestManifestFiles(files),
  };
}

/** The workflow F9 trusts at create when it exists (SETUP D19, D48). */
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";

/** W23: the product as it will be, or why it cannot be created yet. Writes nothing. */
export interface CreateDryRun {
  ok: true;
  /** `owner/repo` as parsed from what the operator gave. */
  repository: string;
  installationId: number;
  /** The default-branch commit every document was read at. */
  commit: string;
  /** Hand back to link-repo: a `.pkey/` that changed since refuses the create (409). */
  manifestDigest: string;
  /** True when nothing blocks the create. */
  ready: boolean;
  /** Name, slug and presentation from `.pkey/product`; null when the manifest does not parse. */
  product: {
    slug: string;
    name: string;
    presentation: ParsedManifest["presentation"] | null;
  } | null;
  /** W24's answer for the manifest's slug; null when the manifest does not parse. */
  slug: SlugCheck | null;
  /** The product registered from this repository already (F15: open it instead), or null. */
  registeredAs: string | null;
  /** Enabled services, in the manifest's order. */
  services: string[];
  /** The catalog `.pkey/schema` becomes as version 1. */
  catalog: { entries: number } | null;
  /**
   * The platforms the product ships and where they were read. `artifact-map` is `.pkey/release`'s
   * `deliverables.app.artifacts`; `none` when nothing declares them (SETUP W21's project-file
   * detection adds a `project-files` source when it lands).
   */
  platforms: { values: string[]; source: "artifact-map" | "none" };
  /** Secret NAMES the manifest references, set after create (never values). */
  secrets: string[];
  /** Whether `.github/workflows/release.yml` exists at the commit; null when GitHub would not say. */
  releaseWorkflow: boolean | null;
  /** Whether the create adds the Free tier: License on and the manifest declares no tier. */
  starterTier: "free" | "none";
  /** Every blocking problem, with its file and path. Empty when `ready`. */
  problems: ManifestProblem[];
}

/**
 * The create dry run (W23): `linkRepo`'s checks, every one, for a product that does not exist
 * yet, and the product as it will be. Writes nothing. A refusal before the manifest is read (the
 * URL, the App, the fetch) is a `CreateRefusal`; everything after it is a problem in the answer,
 * so the console can list them all at once.
 */
export async function prepareCreate(
  env: Env,
  db: Db,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
): Promise<CreateDryRun | CreateRefusal> {
  const read = await readRepoForCreate(env, repoUrl, now, fetchImpl);
  if (!read.ok) return read;
  const { owner, repo, token, commit, files } = read;

  let releaseWorkflow: boolean | null;
  try {
    releaseWorkflow =
      (await fetchRepoFile(
        token,
        owner,
        repo,
        RELEASE_WORKFLOW_PATH,
        fetchImpl,
        commit,
      )) !== null;
  } catch {
    releaseWorkflow = null;
  }

  const base = {
    ok: true as const,
    repository: `${owner}/${repo}`,
    installationId: read.installId,
    commit,
    manifestDigest: read.manifestDigest,
    releaseWorkflow,
  };

  // The same severities the create parses with (plans/P0-26.md D5: the dry run now includes the
  // reserved display names, as the create always did).
  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    ...(await displayNameOptions(env, db)),
  });
  if (!result.ok) {
    return {
      ...base,
      ready: false,
      product: null,
      slug: null,
      registeredAs: await productForRepository(db, owner, repo),
      services: [],
      catalog: null,
      platforms: { values: [], source: "none" },
      secrets: [],
      starterTier: "none" as const,
      problems: manifestProblems(result.errors),
    };
  }
  const manifest = result.manifest;
  const slug = manifest.product.slug;

  const { registeredAs, verdict, problems } = await createSlugProblems(
    db,
    slug,
    owner,
    repo,
  );
  // The pure refusals the create applies before it writes (an unsafe binary name, an issuer
  // outside the allowlist, a catalog the validator refuses), and the trusted publisher's numeric
  // ids, resolved at create: a lookup that fails would refuse the create, so it is a problem now
  // rather than a surprise then. The pipeline's dry run lists every one.
  const dry = await ingest.plan(env, db, {
    mode: "create",
    product: slug,
    manifest,
    now,
    source: {
      origin: "link",
      sha: commit,
      files,
      fetchImpl,
      repo: {
        owner,
        name: repo,
        installId: read.installId,
        identity: () => getRepoIdentity(token, owner, repo, fetchImpl),
        hasFile: async () => false,
        blob: async () => "error",
      },
    },
  });
  for (const p of dry.problems)
    problems.push({
      check: "policy",
      file: p.file ?? null,
      path: p.path ?? null,
      message: p.message,
    });

  const artifacts = manifest.release?.app?.artifacts ?? [];
  const platforms = [...new Set(artifacts.map((a) => String(a.platform)))];
  const entries = (manifest.catalog as { entries?: unknown }).entries;

  return {
    ...base,
    ready: problems.length === 0,
    product: {
      slug,
      name: manifest.product.name,
      presentation: manifest.presentation ?? null,
    },
    slug: verdict ?? (await checkSlug(db, slug)),
    registeredAs,
    services: Object.entries(manifest.services)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k),
    catalog: { entries: Array.isArray(entries) ? entries.length : 0 },
    platforms: {
      values: platforms,
      source: platforms.length ? "artifact-map" : "none",
    },
    secrets: collectSecretNames(manifest),
    starterTier:
      manifest.services.license.enabled && manifest.tiers.length === 0
        ? ("free" as const)
        : ("none" as const),
    problems,
  };
}

/**
 * Link a GitHub repo as a new Polaris Key product. Returns a structured result rather than
 * throwing on the expected failure modes (bad URL, app not installed, manifest errors) so the
 * admin handler can surface a clean 4xx.
 *
 * `opts.manifestDigest` is the dry run's (W23): when given, a `.pkey/` that changed since the
 * check refuses with 409 ("check again") instead of registering a manifest nobody looked at.
 */
export async function linkRepo(
  env: Env,
  db: Db,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
  opts: { manifestDigest?: string; create?: LinkCreate } = {},
): Promise<LinkRepoResult> {
  const read = await readRepoForCreate(env, repoUrl, now, fetchImpl);
  if (!read.ok) return { ok: false, error: read.error };
  const { owner, repo, installId, token, commit, files } = read;
  if (
    opts.manifestDigest !== undefined &&
    opts.manifestDigest !== read.manifestDigest
  )
    return {
      ok: false,
      status: 409,
      error: "the repository's .pkey/ changed since the check; check again",
    };

  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    ...(await displayNameOptions(env, db)),
  });
  if (!result.ok)
    return {
      ok: false,
      error: "manifest validation failed",
      errors: result.errors,
    };
  const manifest = result.manifest;

  const { problems } = await createSlugProblems(
    db,
    manifest.product.slug,
    owner,
    repo,
  );
  if (problems[0]) return { ok: false, error: problems[0].message };

  return registerFromManifest(
    env,
    db,
    manifest,
    { owner, repo, installId, token },
    { sha: commit, files },
    now,
    fetchImpl,
    ingest,
    opts.create,
  );
}

/**
 * Register the product a parsed manifest describes: the one Core pipeline in `create` mode
 * (P0-26). Release's part here is the GitHub source adapter: the coordinates, the pinned commit's
 * documents, the repository ids and the blob lookups, handed down as a `ManifestSource`.
 */
export async function registerFromManifest(
  env: Env,
  db: Db,
  manifest: ParsedManifest,
  gh: { owner: string; repo: string; installId: number; token: string },
  applied: { sha: string; files: Record<string, string> },
  now: number,
  fetchImpl: FetchImpl,
  ingest: Ingest,
  create?: LinkCreate,
): Promise<LinkRepoResult> {
  const slug = manifest.product.slug;
  const result = await ingest.run(env, db, {
    mode: "create",
    product: slug,
    manifest,
    now,
    source: {
      origin: "link",
      sha: applied.sha,
      files: applied.files,
      fetchImpl,
      repo: {
        owner: gh.owner,
        name: gh.repo,
        installId: gh.installId,
        identity: () => getRepoIdentity(gh.token, gh.owner, gh.repo, fetchImpl),
        hasFile: async (path) =>
          (await fetchRepoFile(
            gh.token,
            gh.owner,
            gh.repo,
            path,
            fetchImpl,
            applied.sha,
          )) !== null,
        blob: repoBlobLookup(
          gh.token,
          gh.owner,
          gh.repo,
          applied.sha,
          fetchImpl,
        ),
      },
    },
    ...(create ? { create } : {}),
  });
  if (!result.ok)
    return {
      ok: false,
      error: result.error,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.fields !== undefined ? { fields: result.fields } : {}),
      ...(result.codes !== undefined ? { codes: result.codes } : {}),
    };
  const created = result.created!;
  // Secrets the manifest references by NAME (OIDC client secret, edge-mint key material) but
  // that an operator must still supply out-of-band via PUT /secrets. Names only, never values.
  const remainingSecrets = collectSecretNames(manifest);
  const refusedKeys = (result.facts.releaseKeysRefused as string[]) ?? [];
  const install =
    (remainingSecrets.length > 0
      ? `Linked ${gh.owner}/${gh.repo}. Supply these secrets via PUT /api/products/${slug}/secrets/<name>: ${remainingSecrets.join(", ")}.`
      : `Linked ${gh.owner}/${gh.repo}. No additional secrets required.`) +
    (refusedKeys.length === 0
      ? ""
      : ` release_key_is_product_key: ${refusedKeys.join(", ")} refused; no releaseKeys were stored.`);
  return {
    ok: true,
    slug,
    kid: created.kid,
    publicKey: created.publicKey,
    trustKeys: { [created.kid]: created.publicKey },
    install,
    remainingSecrets,
    defaults: created.defaults,
    ...feedSkipped(result.facts),
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
