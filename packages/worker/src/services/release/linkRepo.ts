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

import { Catalog } from "@polaris-key/catalog";
import {
  PRODUCT_SLUG_MAX,
  PRODUCT_SLUG_RE,
  SYSTEM_PRODUCT_SLUG,
  isReservedProductSlug,
  type ManifestDocumentName,
} from "@polaris-key/manifest";
import {
  generateEd25519,
  seal,
  secret,
  type Db,
  type DbStatement,
  type Env,
} from "../../core/platform.js";
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
} from "../../core/ingest.js";
import { parseManifest, type ParsedManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile, getRepoIdentity } from "./github.js";
import { isSafeBinaryName } from "./install.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import { syncReleaseStore } from "./sync.js";
import { manifestDeliverableStatements } from "./deliverables.js";
import { releaseKeysForSync } from "./records.js";
import { serializeServices } from "../../core/services.js";
import type { ManifestIngest } from "../../core/registry.js";
import { serializeWebOrigins } from "../../core/cors.js";
import { stmtUpsertManifestPublisher } from "../../core/publisher.js";
import { manifestSnapshotStatement } from "../../core/manifestSnapshot.js";
import { reservedNamesMode } from "../../core/reservedNames.js";
import type { LinkCheck } from "./linkExisting.js";

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
  | {
      ok: false;
      error: string;
      errors?: string[];
      /** 409 when the `.pkey/` read is not the one the dry run checked (`manifestDigest`). */
      status?: 409;
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
 * This is the ingest half of R9-01, and — unlike the copy at the sink
 * (`services/identity/oidc.ts`'s `issuerHostAllowed`, which treats "unset" as "unenforced") —
 * it **fails closed**: with no allowlist configured, no manifest may introduce a custom issuer
 * at all.
 *
 * The asymmetry is deliberate and is the whole point of doing this here rather than there.
 * `oidc.issuer` is the base of the token POST that carries the product's OIDC `client_secret`,
 * of the JWKS fetch that decides which keys may sign an ID token, and of the anonymous 302 out
 * of `/<product>/identity/auth/start` — and it arrives from a `.pkey/` file that any repo *writer*
 * can
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
 * accepted here must also survive the sink at runtime, or linking would mint a product whose
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
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical) as BufferSource,
    ),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
 * The pure refusals `registerFromManifest` applies before it writes (an unsafe binary name, an
 * issuer outside the allowlist, a catalog the validator refuses), in the order it applies them.
 * The dry run lists every one; the create refuses with the first.
 */
function createPolicyProblems(
  env: Env,
  manifest: ParsedManifest,
  repo: string,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  // Defence in depth for R6-01: the manifest boundary already enforces this class, but the
  // repo-name fallback does not go through it — and this value is interpolated into the
  // `curl | sh` installer served to every user of the product.
  const binaryName = manifest.release?.binaryName || repo;
  if (!isSafeBinaryName(binaryName))
    problems.push({
      check: "policy",
      file: "release",
      path: "/release/binaryName",
      message: `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
    });
  // R9-01, at ingest and fail-closed (see `manifestIssuerRefusal`). A first write has no
  // already-working `oidc_config` row to protect, so an unset allowlist refuses it outright.
  // A product that does not name a custom issuer never reaches this branch: `djdl` ships
  // `provider: "platform"` and no issuer at all, so linking it is unaffected.
  if (manifest.oidc?.provider === "custom") {
    const refusal = manifestIssuerRefusal(env, manifest.oidc.issuer);
    if (refusal)
      problems.push({
        check: "policy",
        file: "product",
        path: "/oidc/issuer",
        message: refusal,
      });
  }
  // The admin API screens every catalog it accepts (`admin/handlers/schema.ts`,
  // `admin/handlers/products.ts` both `compileAll()` before writing). The repo-sync path did
  // not, so a manifest from GitHub could install a catalog the admin API would have rejected
  // — unsupported keywords, or a `pattern` the validator cannot compile. Screen it here too,
  // so there is no route into `product_schema` that skips the check.
  try {
    new Catalog(manifest.catalog as never).compileAll();
  } catch (e) {
    problems.push({
      check: "policy",
      file: "schema",
      path: "/",
      message: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
    });
  }
  return problems;
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

  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
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
  problems.push(...createPolicyProblems(env, manifest, repo));

  // P2-02: the trusted publisher's numeric ids are resolved at create; a lookup that fails here
  // would refuse the create, so it is a problem now rather than a surprise then.
  if (manifest.release?.trustedPublisher) {
    try {
      await getRepoIdentity(token, owner, repo, fetchImpl);
    } catch (err) {
      problems.push({
        check: "policy",
        file: "release",
        path: "/release/publishing/trustedPublisher",
        message: `could not resolve the repository's ids for publishing.trustedPublisher: ${err instanceof Error ? err.message : "github lookup failed"}`,
      });
    }
  }

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
  ingest?: ManifestIngest,
  opts: { manifestDigest?: string } = {},
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
  );
}

/** Assemble + atomically insert all rows for a parsed manifest (GitHub coordinates supplied). */
async function registerFromManifest(
  env: Env,
  db: Db,
  manifest: ParsedManifest,
  gh: { owner: string; repo: string; installId: number; token: string },
  applied: { sha: string; files: Record<string, string> },
  now: number,
  fetchImpl: FetchImpl,
  ingest: ManifestIngest | undefined,
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
  // P3-03: a declared release key must never be a signing key of the product (the one minted
  // here included). Refused at link, the product starts with none, and the guidance says why.
  const releaseKeys = await releaseKeysForSync(
    db,
    slug,
    rel?.releaseKeys ?? [],
    [publicRawB64url],
  );
  const binaryName = rel?.binaryName || gh.repo;
  const summaryMarker = rel?.summaryMarker || "pkey:summary";

  // The pure refusals (R6-01's binary name, R9-01's issuer, the catalog screen), shared with
  // the dry run so it lists exactly what this would refuse (`createPolicyProblems`).
  const refused = createPolicyProblems(env, manifest, gh.repo)[0];
  if (refused) return { ok: false, error: refused.message };

  // P2-02: a declared trusted publisher pins the repository's NUMERIC ids, resolved here from
  // GitHub with the installation token — never taken from the manifest (a repo must not be able
  // to name someone else's repository as its publisher). Before the batch, so a failed lookup
  // refuses the link instead of registering a product without the policy it declared.
  let publisherStmt: DbStatement | null = null;
  if (rel?.trustedPublisher) {
    try {
      const identity = await getRepoIdentity(
        gh.token,
        gh.owner,
        gh.repo,
        fetchImpl,
      );
      publisherStmt = stmtUpsertManifestPublisher({
        product: slug,
        repositoryId: identity.id,
        repositoryOwnerId: identity.ownerId,
        repository: identity.fullName,
        workflow: rel.trustedPublisher.workflow,
        environment: rel.trustedPublisher.environment,
        now,
      });
    } catch (err) {
      return {
        ok: false,
        error: `could not resolve the repository's ids for publishing.trustedPublisher: ${err instanceof Error ? err.message : "github lookup failed"}`,
      };
    }
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
      // Which Polaris Key services this product runs — and, in the same value, who may register a
      // device against it (`core/services.ts` explains why the two share a column). In the SAME
      // atomic batch as the row itself, not applied afterwards like the fingerprint/auto-issue
      // policies: enablement decides which routes a product has, so there must be no instant
      // where a product row exists without it. A freshly linked product is manifest-owned.
      services_json: serializeServices({
        services: manifest.services,
        ...(manifest.registration
          ? { registration: manifest.registration }
          : {}),
      }),
      services_source: "manifest",
      // The compat window is manifest-owned until an operator sets it in `update/settings`.
      compat_source: "manifest",
      // The CORS allowlist (P0-05). Validated by the manifest parser; NULL when undeclared.
      web_origins_json: serializeWebOrigins(manifest.webOrigins),
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
      revoked_at: null,
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
      manualChannelsJson: rel?.manualChannels.length
        ? JSON.stringify(rel.manualChannels)
        : null,
      artifactPolicyJson: rel?.artifactPolicy
        ? JSON.stringify(rel.artifactPolicy)
        : null,
      metadataAccess: rel?.access.metadata ?? "public",
      artifactsAccess: rel?.access.artifacts ?? "public",
      // Manifest-owned until an operator claims the modes. `operatorPolicyJson` is deliberately
      // absent: the operator-only artifact policy has no manifest spelling (R6-03), so a freshly
      // linked product starts on the fail-safe defaults (signature required, no minimum).
      accessSource: "manifest",
      stableTagPattern: rel?.stableTagPattern ?? null,
      ignoreTagsJson: rel?.ignoreTags.length
        ? JSON.stringify(rel.ignoreTags)
        : null,
      releaseKeysJson: releaseKeys.ok ? releaseKeys.json : null,
    }),
  );

  // The app deliverable's declaration (P2-04), read back by the truth-store sync below.
  if (rel)
    statements.push(
      ...manifestDeliverableStatements(
        slug,
        rel.app,
        now,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    );

  // The trusted-publisher policy (P2-02), manifest-owned from the start. A row a previous product
  // of the same slug left behind is replaced only if it is manifest-owned too.
  if (publisherStmt) statements.push(publisherStmt);

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
  // P0-12: a freshly linked product's recipes are PENDING — a link never writes an approval,
  // because an approval is the operator's decision and the manifest is the repo's. So the link
  // deletes EVERY approval row under the slug, not only the orphans resync drops: a new slug
  // has none, and a row left by an earlier product of the same slug must not approve this
  // one's recipes (nor survive the widening sweep resync runs, which a link has no "before" for).
  statements.push({
    sql: "DELETE FROM edge_mint_approvals WHERE product = ?",
    params: [slug],
  });

  // Every enabled service's own manifest rows (P2b-02: Distribution's outlets and transports),
  // through Core's ingest pipeline and in the same atomic batch, AFTER the product row they
  // reference. A freshly linked product is manifest-owned, so the manifest's enablement is the
  // product's enablement.
  if (ingest)
    statements.push(
      ...ingest(manifest, slug, manifest.services, now).statements,
    );

  // ST-01a: the manifest snapshot (origin `link`), in the same atomic batch and after the product
  // row it references, so a linked product always has its applied manifest on record.
  statements.push(
    await manifestSnapshotStatement(
      slug,
      "link",
      applied.sha,
      applied.files,
      manifest,
      now,
    ),
  );

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

  // The release truth store, seeded from the repo's current releases (P2.T2). AFTER the batch
  // for the same reason the two policies above are: `release_metadata.product` references
  // `products(slug)`, so there must be a product row to point at. Best-effort by construction
  // (`syncReleaseStore` swallows GitHub failures) — a repo with no releases yet is the normal
  // case at link time, and a link must not fail because of it.
  await syncReleaseStore(env, db, slug, now, fetchImpl);

  // Secrets the manifest references by NAME (OIDC client secret, edge-mint key material) but
  // that an operator must still supply out-of-band via PUT /secrets. Names only — never values.
  const remainingSecrets = collectSecretNames(manifest);

  const install =
    (remainingSecrets.length > 0
      ? `Linked ${gh.owner}/${gh.repo}. Supply these secrets via PUT /api/products/${slug}/secrets/<name>: ${remainingSecrets.join(", ")}.`
      : `Linked ${gh.owner}/${gh.repo}. No additional secrets required.`) +
    (releaseKeys.ok
      ? ""
      : ` release_key_is_product_key: ${releaseKeys.refused.map((r) => r.kid).join(", ")} refused; no releaseKeys were stored.`);

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
