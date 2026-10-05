/// <reference types="@cloudflare/workers-types" />
/**
 * Trusted publishing (P2-02, README §3.4 "Publishing"): how CI authenticates to Polaris Key.
 *
 * A GitHub Actions job presents its OIDC token; if the token verifies and its claims satisfy the
 * product's publisher policy, the job gets a short-lived `pkeyci_` token. A CI that is not GitHub
 * uses an operator-issued, hashed, expiring `pkeyci_` token instead. With `release:publish` the
 * token buys an upload ticket: R2 temporary credentials that can write only
 * `staging/<product>/<ticketId>/`, and a one-shot ticket the submit route redeems. No long-lived
 * secret ever sits in the product's repository.
 *
 * Core, not Release: the credential store is substrate. Release's publish and policy routes,
 * Distribution's report routes (P2b-03) and later packages all authenticate a CI job through
 * `core/ciScope.ts` `requireCiScope`, which asks `lookupCiToken` here.
 *
 * ── VERIFICATION (README §3.4, notes/E5 §2.2) ───────────────────────────────────────────────
 *
 *   alg  RS256 only.          iss  exactly https://token.actions.githubusercontent.com — fixed,
 *   never configurable.       aud  `<origin>/<product>/release/publish`, product-bound.
 *   exp/nbf with 60 s skew.   jti  single-use (the UNIQUE index on `ci_tokens.jti`).
 *   JWKS from GitHub's `/.well-known/jwks`, cached in KV `HOT` for an hour and refetched at most
 *   once a minute when a token names an unknown `kid`. The fetcher is injectable for tests.
 *
 * ── THE POLICY (all required) ───────────────────────────────────────────────────────────────
 *
 *   repository_id, repository_owner_id   equal the linked repo's NUMERIC ids (pinned against
 *                                         name recycling; resolved from GitHub at link/resync)
 *   job_workflow_ref                      `<owner>/<repo>/<workflow>@<ref>` for the declared
 *                                         workflow, at the ref that triggered the run
 *   environment                           the declared environment (default `release`)
 *   ref_protected == "true", runner_environment == "github-hosted",
 *   event_name in push | release | workflow_dispatch    — platform-fixed, not configurable
 *
 * A manifest may name only the workflow and environment; the repo cannot weaken its own control
 * (the R6-03 precedent). An operator may claim the policy (`source = 'admin'`), after which a
 * resync leaves it alone.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────────────────────
 *
 * `ErrorCode` (unauthorized, forbidden, bad_request, not_found) with a machine-readable `reason`.
 * A new `PolarisErrorCode` would be a shared-protocol change (plan mode), and nothing but the
 * CLI reads these routes.
 */

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type { Env } from "../env.js";
import { secret } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { hashKey, mintOpaqueToken, randomId } from "../crypto.js";
import { appendAudit } from "../repo.js";
import { signJwtHs256 } from "./jwt.js";
import { readCappedText } from "./readCapped.js";
import {
  CI_SCOPES,
  CI_TOKEN_PREFIX,
  type CiPrincipal,
} from "./ciVocabulary.js";

// ── Constants ───────────────────────────────────────────────────────────────────────────────

/** GitHub Actions' OIDC issuer. A constant on purpose: an issuer that could be configured is an
 *  issuer an attacker could point at their own JWKS. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

/** Clock skew tolerated on `exp`/`nbf`/`iat`. */
export const OIDC_CLOCK_SKEW_SECONDS = 60;
/** How long the cached JWKS is trusted before a refetch. */
export const JWKS_CACHE_SECONDS = 3600;
/** The fastest an unknown `kid` may force a refetch. */
export const JWKS_REFETCH_MIN_SECONDS = 60;
const JWKS_KV_KEY = "gh:oidc:jwks";
/** A JWKS is a few keys; anything bigger is not GitHub's. */
const MAX_JWKS_BYTES = 64 * 1024;

/** An OIDC-minted `pkeyci_` token lives this long. */
export const OIDC_CI_TOKEN_TTL_SECONDS = 30 * 60;
/** An operator-issued static token expires at most this far out. */
export const STATIC_CI_TOKEN_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The scopes a new policy grants. `release:yank` is opt-in (an operator edits `scopes_json`). */
export const DEFAULT_CI_SCOPES: readonly string[] = [
  "release:publish",
  "release:promote",
  "distribution:report",
];

/** The events a trusted run may be triggered by. Platform-fixed. */
export const ALLOWED_OIDC_EVENTS: readonly string[] = [
  "push",
  "release",
  "workflow_dispatch",
];

/** The environment a policy requires when the manifest names none. */
export const DEFAULT_PUBLISH_ENVIRONMENT = "release";

/** An upload ticket lives at most this long (and never past its token). */
export const TICKET_MAX_TTL_SECONDS = 60 * 60;
/** Objects one ticket may cover. */
export const MAX_TICKET_OBJECTS = 256;
/** R2's single-part PutObject ceiling (5 GiB less 5 MiB). Multipart is not granted (see
 *  `UPLOAD_CREDENTIAL_ACTIONS`), so one object is one PUT. */
export const MAX_UPLOAD_OBJECT_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

/**
 * The S3 operations a ticket's temporary credentials allow — and nothing else. Not
 * `object-read-write`'s full set: no `GetObject` or `ListObjects*` (CI never reads), no
 * `CopyObject` or `UploadPartCopy` (a copy names a SOURCE key, and a copy from `gated/…` into the
 * ticket prefix would carry another product's object — with its stored checksum — into this
 * product's staging; THREAT-MODEL §3), and no multipart (a multipart object's stored checksum is
 * not the whole object's SHA-256, so `verifyStaged` could not use it). `HeadObject` lets CI
 * confirm its own upload, inside its own prefix.
 */
export const UPLOAD_CREDENTIAL_ACTIONS = ["PutObject", "HeadObject"] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const CI_TOKEN_SHAPE = /^pkeyci_[A-Za-z0-9_-]{43,}$/;
const TICKET_PREFIX = "pkeyup_";
const TICKET_SHAPE = /^pkeyup_[A-Za-z0-9_-]{43,}$/;

// ── Small helpers ───────────────────────────────────────────────────────────────────────────

/** The audience a product's publish token must carry: `<origin>/<product>/release/publish`. */
export function publishAudience(origin: string, product: string): string {
  return `${origin}/${product}/release/publish`;
}

function pepper(env: Env): string | undefined {
  return secret(env, "KEY_HASH_PEPPER");
}

/** Normalise a requested scope list against the vocabulary; `null` if any entry is unknown. */
export function normalizeScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const known = new Set<string>(CI_SCOPES);
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || !known.has(s)) return null;
    out.add(s);
  }
  return [...out].sort();
}

function parseScopes(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// ── The publisher policy (`ci_publishers`) ──────────────────────────────────────────────────

export interface PublisherPolicy {
  product: string;
  provider: "github";
  repositoryId: number;
  repositoryOwnerId: number;
  /** `owner/repo` as GitHub spells it. */
  repository: string;
  /** `.github/workflows/<file>.yml`. */
  workflow: string;
  environment: string;
  scopes: string[];
  source: "manifest" | "admin";
  createdAt: number;
  modifiedAt: number;
  modifiedBy: string | null;
}

interface PublisherRow {
  product: string;
  provider: string;
  repository_id: number;
  repository_owner_id: number;
  repository: string;
  workflow: string;
  environment: string;
  scopes_json: string;
  source: string;
  created_at: number;
  modified_at: number;
  modified_by: string | null;
}

function policyOf(r: PublisherRow): PublisherPolicy {
  return {
    product: r.product,
    provider: "github",
    repositoryId: r.repository_id,
    repositoryOwnerId: r.repository_owner_id,
    repository: r.repository,
    workflow: r.workflow,
    environment: r.environment,
    scopes: parseScopes(r.scopes_json),
    source: r.source === "admin" ? "admin" : "manifest",
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    modifiedBy: r.modified_by,
  };
}

export async function getPublisherPolicy(
  db: Db,
  product: string,
): Promise<PublisherPolicy | null> {
  const r = await db.first<PublisherRow>(
    "SELECT * FROM ci_publishers WHERE product = ?",
    product,
  );
  return r ? policyOf(r) : null;
}

/** What a manifest-owned policy is built from: the manifest's two fields plus GitHub's ids. */
export interface ManifestPublisherInput {
  product: string;
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  workflow: string;
  environment: string;
  now: number;
}

/**
 * Write a manifest-owned policy (link and resync). Never over an operator's claim: the update
 * applies only while `source = 'manifest'`, decided inside the statement. `scopes_json` is the
 * default on insert and kept on update — a manifest cannot grant itself scopes.
 */
export function stmtUpsertManifestPublisher(
  p: ManifestPublisherInput,
): DbStatement {
  return {
    sql: `INSERT INTO ci_publishers
            (product, provider, repository_id, repository_owner_id, repository, workflow,
             environment, scopes_json, source, created_at, modified_at, modified_by)
          VALUES (?, 'github', ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, 'manifest')
          ON CONFLICT(product) DO UPDATE SET
            repository_id = excluded.repository_id,
            repository_owner_id = excluded.repository_owner_id,
            repository = excluded.repository,
            workflow = excluded.workflow,
            environment = excluded.environment,
            modified_at = excluded.modified_at,
            modified_by = 'manifest'
          WHERE ci_publishers.source = 'manifest'`,
    params: [
      p.product,
      p.repositoryId,
      p.repositoryOwnerId,
      p.repository,
      p.workflow,
      p.environment,
      JSON.stringify([...DEFAULT_CI_SCOPES].sort()),
      p.now,
      p.now,
    ],
  };
}

/** A manifest that stops declaring a publisher drops its manifest-owned policy (never a claim). */
export function stmtDeleteManifestPublisher(product: string): DbStatement {
  return {
    sql: "DELETE FROM ci_publishers WHERE product = ? AND source = 'manifest'",
    params: [product],
  };
}

/** Does `next` differ from the manifest-owned fields of `cur`? (For resync's audit row.) */
export function manifestPublisherChanged(
  cur: PublisherPolicy | null,
  next: Omit<ManifestPublisherInput, "now" | "product"> | null,
): boolean {
  if (cur?.source === "admin") return false;
  if (!cur || !next) return (cur === null) !== (next === null);
  return (
    cur.repositoryId !== next.repositoryId ||
    cur.repositoryOwnerId !== next.repositoryOwnerId ||
    cur.repository !== next.repository ||
    cur.workflow !== next.workflow ||
    cur.environment !== next.environment
  );
}

export interface PublisherClaim {
  workflow?: string;
  environment?: string;
  scopes?: string[];
  repositoryId?: number;
  repositoryOwnerId?: number;
  repository?: string;
}

/**
 * An operator claims (or edits) the policy: `source = 'admin'`, so resync never touches it
 * again. Fields not given keep their current value; a product with no policy yet needs the
 * repository fields too. Returns the policy, or a message for a 400.
 */
export async function claimPublisherPolicy(
  db: Db,
  product: string,
  claim: PublisherClaim,
  actor: string,
  now: number,
): Promise<PublisherPolicy | { error: string }> {
  const cur = await getPublisherPolicy(db, product);
  const repositoryId = claim.repositoryId ?? cur?.repositoryId;
  const repositoryOwnerId = claim.repositoryOwnerId ?? cur?.repositoryOwnerId;
  const repository = claim.repository ?? cur?.repository;
  const workflow = claim.workflow ?? cur?.workflow;
  const environment =
    claim.environment ?? cur?.environment ?? DEFAULT_PUBLISH_ENVIRONMENT;
  const scopes = claim.scopes ?? cur?.scopes ?? [...DEFAULT_CI_SCOPES].sort();
  if (
    repositoryId === undefined ||
    repositoryOwnerId === undefined ||
    repository === undefined ||
    workflow === undefined
  )
    return {
      error:
        "no policy exists yet: repositoryId, repositoryOwnerId, repository and workflow are required",
    };
  await db.run(
    `INSERT INTO ci_publishers
       (product, provider, repository_id, repository_owner_id, repository, workflow,
        environment, scopes_json, source, created_at, modified_at, modified_by)
     VALUES (?, 'github', ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET
       repository_id = excluded.repository_id,
       repository_owner_id = excluded.repository_owner_id,
       repository = excluded.repository,
       workflow = excluded.workflow,
       environment = excluded.environment,
       scopes_json = excluded.scopes_json,
       source = 'admin',
       modified_at = excluded.modified_at,
       modified_by = excluded.modified_by`,
    product,
    repositoryId,
    repositoryOwnerId,
    repository,
    workflow,
    environment,
    JSON.stringify(scopes),
    now,
    now,
    actor,
  );
  return (await getPublisherPolicy(db, product))!;
}

// ── GitHub OIDC verification ────────────────────────────────────────────────────────────────

/** Fetch GitHub's JWKS. Injectable so tests sign with a local key and never touch the network. */
export type JwksFetcher = () => Promise<JSONWebKeySet>;

export const defaultJwksFetcher: JwksFetcher = async () => {
  const res = await fetch(GITHUB_JWKS_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  // Bounded while streaming: `res.text()` would buffer the whole body before the size check.
  const text = await readCappedText(
    res,
    MAX_JWKS_BYTES,
    () => new Error("jwks too large"),
  );
  return JSON.parse(text) as JSONWebKeySet;
};

interface CachedJwks {
  keys: JSONWebKeySet["keys"];
  fetchedAt: number;
}

async function readCachedJwks(env: Env): Promise<CachedJwks | null> {
  try {
    const raw = await env.HOT.get(JWKS_KV_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedJwks;
    return Array.isArray(v.keys) && typeof v.fetchedAt === "number" ? v : null;
  } catch {
    return null;
  }
}

async function refreshJwks(
  env: Env,
  now: number,
  fetcher: JwksFetcher,
): Promise<CachedJwks> {
  const set = await fetcher();
  if (!set || !Array.isArray(set.keys)) throw new Error("malformed jwks");
  const cached: CachedJwks = { keys: set.keys, fetchedAt: now };
  await env.HOT.put(JWKS_KV_KEY, JSON.stringify(cached), {
    expirationTtl: 24 * 60 * 60,
  });
  return cached;
}

/**
 * The JWKS that should hold `kid`: the cache if fresh and it has the kid; else a refetch, at most
 * once a minute (so a flood of tokens naming made-up kids costs GitHub one request a minute).
 */
async function jwksFor(
  env: Env,
  kid: string,
  now: number,
  fetcher: JwksFetcher,
): Promise<CachedJwks | null> {
  let cached = await readCachedJwks(env);
  const fresh = cached !== null && now - cached.fetchedAt < JWKS_CACHE_SECONDS;
  const hasKid = (c: CachedJwks | null) =>
    c !== null && c.keys.some((k) => k.kid === kid);
  if (fresh && hasKid(cached)) return cached;
  const mayRefetch =
    cached === null ||
    !fresh ||
    now - cached.fetchedAt >= JWKS_REFETCH_MIN_SECONDS;
  if (mayRefetch) {
    try {
      cached = await refreshJwks(env, now, fetcher);
    } catch {
      // Keep whatever we had; an unknown kid below is the answer.
    }
  }
  return cached;
}

/** The GitHub OIDC claims this module reads. Every one is a string in GitHub's tokens. */
export interface GithubOidcClaims extends JWTPayload {
  repository?: string;
  repository_id?: string;
  repository_owner_id?: string;
  job_workflow_ref?: string;
  ref?: string;
  ref_protected?: string | boolean;
  environment?: string;
  runner_environment?: string;
  event_name?: string;
  run_id?: string;
}

export type OidcVerifyResult =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; reason: "invalid_oidc_token"; message: string };

/**
 * Verify a GitHub Actions OIDC token's signature and registered claims. Does NOT apply the
 * publisher policy (`checkPublisherPolicy`) or the replay guard (the exchange's insert).
 */
export async function verifyGithubOidcToken(
  env: Env,
  token: string,
  opts: { audience: string; now: number; fetchJwks?: JwksFetcher },
): Promise<OidcVerifyResult> {
  const bad = (message: string): OidcVerifyResult => ({
    ok: false,
    reason: "invalid_oidc_token",
    message,
  });
  if (token.length > 16 * 1024) return bad("token too large");
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return bad("not a JWT");
  }
  if (header.alg !== "RS256") return bad("alg must be RS256");
  if (typeof header.kid !== "string" || header.kid === "")
    return bad("kid required");
  const jwks = await jwksFor(
    env,
    header.kid,
    opts.now,
    opts.fetchJwks ?? defaultJwksFetcher,
  );
  if (!jwks || !jwks.keys.some((k) => k.kid === header.kid))
    return bad("unknown signing key");
  try {
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: jwks.keys }),
      {
        issuer: GITHUB_OIDC_ISSUER,
        audience: opts.audience,
        algorithms: ["RS256"],
        clockTolerance: OIDC_CLOCK_SKEW_SECONDS,
        currentDate: new Date(opts.now * 1000),
        requiredClaims: ["exp", "iat", "jti", "sub"],
      },
    );
    return { ok: true, claims: payload as GithubOidcClaims };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) return bad("token expired");
    if (e instanceof joseErrors.JWTClaimValidationFailed)
      return bad(`claim check failed: ${e.claim}`);
    return bad("signature verification failed");
  }
}

export type PolicyCheck =
  | { ok: true }
  | { ok: false; claim: string; message: string };

/** Apply the product's publisher policy to verified claims. Every check is required. */
export function checkPublisherPolicy(
  policy: PublisherPolicy,
  claims: GithubOidcClaims,
): PolicyCheck {
  const fail = (claim: string, message: string): PolicyCheck => ({
    ok: false,
    claim,
    message,
  });
  const numeric = (v: unknown) =>
    typeof v === "string" && /^[0-9]{1,20}$/.test(v) ? v : null;
  if (numeric(claims.repository_id) !== String(policy.repositoryId))
    return fail("repository_id", "the token is not from the linked repository");
  if (numeric(claims.repository_owner_id) !== String(policy.repositoryOwnerId))
    return fail(
      "repository_owner_id",
      "the token is not from the linked repository's owner",
    );
  // `<owner>/<repo>/<workflow>@<ref>`: the declared workflow file of THIS repository, at the ref
  // that triggered the run. A reusable workflow in another repository, another workflow file, or
  // the workflow as it is on some other ref all fail here.
  const jwr =
    typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : "";
  const at = jwr.indexOf("@");
  const path = at > 0 ? jwr.slice(0, at) : "";
  const ref = at > 0 ? jwr.slice(at + 1) : "";
  const repoPrefix = `${policy.repository}/`;
  if (
    path.slice(0, repoPrefix.length).toLowerCase() !==
      repoPrefix.toLowerCase() ||
    path.slice(repoPrefix.length) !== policy.workflow
  )
    return fail(
      "job_workflow_ref",
      `the run is not ${policy.repository}'s ${policy.workflow}`,
    );
  if (ref === "" || typeof claims.ref !== "string" || ref !== claims.ref)
    return fail(
      "job_workflow_ref",
      "the workflow did not run from the ref that triggered it",
    );
  if (
    typeof claims.environment !== "string" ||
    claims.environment.toLowerCase() !== policy.environment.toLowerCase()
  )
    return fail(
      "environment",
      `the job must run in the ${policy.environment} environment`,
    );
  if (claims.ref_protected !== "true" && claims.ref_protected !== true)
    return fail(
      "ref_protected",
      "the ref must be protected by a branch or tag ruleset",
    );
  if (claims.runner_environment !== "github-hosted")
    return fail(
      "runner_environment",
      "the job must run on a GitHub-hosted runner",
    );
  if (
    typeof claims.event_name !== "string" ||
    !ALLOWED_OIDC_EVENTS.includes(claims.event_name)
  )
    return fail(
      "event_name",
      `the run must be triggered by ${ALLOWED_OIDC_EVENTS.join(", ")}`,
    );
  return { ok: true };
}

// ── `pkeyci_` tokens (`ci_tokens`) ──────────────────────────────────────────────────────────

/** Who a valid token belongs to, with what the publish routes need beyond `CiPrincipal`. */
export interface CiTokenRecord extends CiPrincipal {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly kind: "oidc" | "static";
  readonly expiresAt: number;
}

export function mintCiToken(): string {
  return `${CI_TOKEN_PREFIX}${mintOpaqueToken()}`;
}

export async function hashCiCredential(
  env: Env,
  value: string,
): Promise<string> {
  return hashKey(value, pepper(env));
}

interface CiTokenRow {
  token_hash: string;
  token_id: string;
  product: string;
  kind: string;
  scopes_json: string;
  subject: string;
  label: string | null;
  jti: string | null;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  created_by: string;
}

/**
 * Look a presented `pkeyci_` token up: `null` for a malformed, unknown, expired or revoked
 * token, or one whose product is deleted. The only accessor `requireCiScope` uses.
 */
export async function lookupCiToken(
  env: Env,
  db: Db,
  token: string,
  now: number,
): Promise<CiTokenRecord | null> {
  if (!CI_TOKEN_SHAPE.test(token)) return null;
  const tokenHash = await hashCiCredential(env, token);
  const r = await db.first<CiTokenRow>(
    `SELECT t.* FROM ci_tokens t JOIN products p ON p.slug = t.product
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
        AND p.status <> 'deleted'`,
    tokenHash,
    now,
  );
  if (!r) return null;
  return {
    product: r.product,
    subject: r.subject,
    scopes: parseScopes(r.scopes_json),
    tokenId: r.token_id,
    tokenHash: r.token_hash,
    kind: r.kind === "static" ? "static" : "oidc",
    expiresAt: r.expires_at,
  };
}

export interface IssuedCiToken {
  token: string;
  tokenId: string;
  expiresAt: number;
  scopes: string[];
}

export type ExchangeResult =
  | ({ ok: true } & IssuedCiToken)
  | {
      ok: false;
      status: 401 | 403 | 429;
      reason:
        | "invalid_oidc_token"
        | "oidc_token_replayed"
        | "publisher_not_configured"
        | "policy_mismatch"
        | "rate_limited";
      message: string;
      claim?: string;
    };

/**
 * The trusted-publisher exchange: a GitHub OIDC token in, a 30-minute `pkeyci_` token out.
 * Verification, then the policy, then `admit` (if given), then the single-use insert keyed on
 * the token's `jti`.
 *
 * `admit` is where the caller charges a product-wide budget. It runs only once the token is
 * GitHub-signed for this product's audience AND came from the product's own declared workflow,
 * so junk, unsigned or foreign-repository tokens can never spend that budget — they cost an
 * attacker only their per-IP allowance (THREAT-MODEL §3, "Trusted publishing").
 */
export async function exchangeOidcToken(
  env: Env,
  db: Db,
  input: {
    product: string;
    oidcToken: string;
    audience: string;
    now: number;
    fetchJwks?: JwksFetcher;
    admit?: () => Promise<boolean>;
  },
): Promise<ExchangeResult> {
  const v = await verifyGithubOidcToken(env, input.oidcToken, {
    audience: input.audience,
    now: input.now,
    ...(input.fetchJwks ? { fetchJwks: input.fetchJwks } : {}),
  });
  if (!v.ok)
    return { ok: false, status: 401, reason: v.reason, message: v.message };
  const policy = await getPublisherPolicy(db, input.product);
  if (!policy)
    return {
      ok: false,
      status: 403,
      reason: "publisher_not_configured",
      message: "this product has no trusted publisher",
    };
  const check = checkPublisherPolicy(policy, v.claims);
  if (!check.ok)
    return {
      ok: false,
      status: 403,
      reason: "policy_mismatch",
      message: check.message,
      claim: check.claim,
    };
  if (input.admit && !(await input.admit()))
    return {
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "too many token requests",
    };

  const token = mintCiToken();
  const tokenHash = await hashCiCredential(env, token);
  const tokenId = randomId("cit");
  const expiresAt = input.now + OIDC_CI_TOKEN_TTL_SECONDS;
  const runId =
    typeof v.claims.run_id === "string" ? `#run:${v.claims.run_id}` : "";
  const subject = `github:${v.claims.sub ?? ""}${runId}`.slice(0, 512);
  const jti = String(v.claims.jti);
  // Single-use: `idx_ci_tokens_jti` is UNIQUE, so a replayed OIDC token inserts nothing — in D1,
  // atomically, however many requests race. `changes === 0` IS the replay answer.
  const inserted = await db.runChanges(
    `INSERT INTO ci_tokens
       (token_hash, token_id, product, kind, scopes_json, subject, label, jti, issued_at,
        expires_at, revoked_at, created_by)
     VALUES (?, ?, ?, 'oidc', ?, ?, NULL, ?, ?, ?, NULL, 'oidc')
     ON CONFLICT DO NOTHING`,
    tokenHash,
    tokenId,
    input.product,
    JSON.stringify(policy.scopes),
    subject,
    jti,
    input.now,
    expiresAt,
  );
  if (inserted === 0)
    return {
      ok: false,
      status: 401,
      reason: "oidc_token_replayed",
      message: "this OIDC token was already exchanged",
    };
  await appendAudit(db, {
    product: input.product,
    id: randomId("aud"),
    at: input.now,
    actor_sub: `ci:${subject}`,
    actor_name: "CI",
    actor_email: null,
    action: "ci.token.exchange",
    target_kind: "ci_token",
    target_id: tokenId,
    parent_id: null,
    summary: `Exchanged a GitHub OIDC token from ${policy.repository} for a CI token (${policy.scopes.join(", ")})`,
  });
  return { ok: true, token, tokenId, expiresAt, scopes: policy.scopes };
}

/** Issue an operator's static token. Shown once; only its hash is stored. */
export async function issueStaticCiToken(
  env: Env,
  db: Db,
  input: {
    product: string;
    scopes: string[];
    expiresAt: number;
    label: string | null;
    createdBy: string;
    now: number;
  },
): Promise<IssuedCiToken> {
  const token = mintCiToken();
  const tokenHash = await hashCiCredential(env, token);
  const tokenId = randomId("cit");
  await db.run(
    `INSERT INTO ci_tokens
       (token_hash, token_id, product, kind, scopes_json, subject, label, jti, issued_at,
        expires_at, revoked_at, created_by)
     VALUES (?, ?, ?, 'static', ?, ?, ?, NULL, ?, ?, NULL, ?)`,
    tokenHash,
    tokenId,
    input.product,
    JSON.stringify(input.scopes),
    `static:${tokenId}`,
    input.label,
    input.now,
    input.expiresAt,
    input.createdBy,
  );
  return {
    token,
    tokenId,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
  };
}

export interface CiTokenListing {
  tokenId: string;
  kind: "oidc" | "static";
  scopes: string[];
  subject: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
}

/** A product's tokens, newest first — never a hash, never a token. */
export async function listCiTokens(
  db: Db,
  product: string,
  limit = 100,
): Promise<CiTokenListing[]> {
  const rows = await db.all<CiTokenRow>(
    `SELECT * FROM ci_tokens WHERE product = ?
      ORDER BY issued_at DESC, token_id DESC LIMIT ?`,
    product,
    limit,
  );
  return rows.map((r) => ({
    tokenId: r.token_id,
    kind: r.kind === "static" ? "static" : "oidc",
    scopes: parseScopes(r.scopes_json),
    subject: r.subject,
    label: r.label,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdBy: r.created_by,
  }));
}

/** Revoke a token (and every unredeemed ticket it holds). False if no live token had that id. */
export async function revokeCiToken(
  db: Db,
  product: string,
  tokenId: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{ token_hash: string }>(
    "SELECT token_hash FROM ci_tokens WHERE product = ? AND token_id = ? AND revoked_at IS NULL",
    product,
    tokenId,
  );
  if (!row) return false;
  await db.batch([
    {
      sql: "UPDATE ci_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      params: [now, row.token_hash],
    },
    {
      sql: `UPDATE ci_upload_tickets SET expires_at = MIN(expires_at, ?)
             WHERE token_hash = ? AND redeemed_at IS NULL`,
      params: [now, row.token_hash],
    },
  ]);
  return true;
}

/** Product deletion: every token of the product stops working in the same batch. */
export function stmtRevokeProductCiTokens(
  product: string,
  now: number,
): DbStatement {
  return {
    sql: "UPDATE ci_tokens SET revoked_at = ? WHERE product = ? AND revoked_at IS NULL",
    params: [now, product],
  };
}

// ── Upload tickets (`ci_upload_tickets`) ────────────────────────────────────────────────────

export interface TicketObject {
  sha256: string;
  size: number;
  /** The object is destined for `gated/blobs/…` rather than `blobs/…`. */
  gated: boolean;
}

/** Parse a ticket request's `objects`; a message on the first bad entry. */
export function parseTicketObjects(
  raw: unknown,
): TicketObject[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "objects must be a non-empty array" };
  if (raw.length > MAX_TICKET_OBJECTS)
    return { error: `at most ${MAX_TICKET_OBJECTS} objects per ticket` };
  const seen = new Map<string, TicketObject>();
  for (const [i, o] of raw.entries()) {
    if (!o || typeof o !== "object" || Array.isArray(o))
      return { error: `objects[${i}] must be an object` };
    const { sha256, size, gated } = o as Record<string, unknown>;
    if (typeof sha256 !== "string" || !HEX64.test(sha256))
      return { error: `objects[${i}].sha256 must be 64 lowercase hex` };
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_UPLOAD_OBJECT_BYTES
    )
      return {
        error: `objects[${i}].size must be an integer from 0 to ${MAX_UPLOAD_OBJECT_BYTES}`,
      };
    if (gated !== undefined && typeof gated !== "boolean")
      return { error: `objects[${i}].gated must be a boolean` };
    const key = `${gated === true ? "g" : "f"}:${sha256}`;
    const prev = seen.get(key);
    if (prev && prev.size !== size)
      return { error: `objects[${i}] repeats ${sha256} with another size` };
    seen.set(key, { sha256, size, gated: gated === true });
  }
  return [...seen.values()];
}

export interface IssuedTicket {
  ticket: string;
  ticketId: string;
  expiresAt: number;
}

/** Issue a ticket for `objects`, held by `holder`'s token, expiring with it (and within an hour). */
export async function issueUploadTicket(
  env: Env,
  db: Db,
  input: {
    product: string;
    holder: Pick<CiTokenRecord, "tokenHash" | "expiresAt">;
    objects: TicketObject[];
    now: number;
  },
): Promise<IssuedTicket> {
  const ticket = `${TICKET_PREFIX}${mintOpaqueToken()}`;
  const ticketHash = await hashCiCredential(env, ticket);
  // Public (it names the staging prefix), so it is NOT the redeemable secret.
  const ticketId = mintOpaqueToken().slice(0, 22);
  const expiresAt = Math.min(
    input.holder.expiresAt,
    input.now + TICKET_MAX_TTL_SECONDS,
  );
  await db.run(
    `INSERT INTO ci_upload_tickets
       (ticket_hash, ticket_id, product, token_hash, objects_json, issued_at, expires_at,
        redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ticketHash,
    ticketId,
    input.product,
    input.holder.tokenHash,
    JSON.stringify(input.objects),
    input.now,
    expiresAt,
  );
  return { ticket, ticketId, expiresAt };
}

export interface TicketRecord {
  ticketHash: string;
  ticketId: string;
  product: string;
  objects: TicketObject[];
  expiresAt: number;
}

export type TicketLookup =
  | { ok: true; ticket: TicketRecord }
  | {
      ok: false;
      status: 400 | 403 | 409;
      reason: "invalid_ticket" | "ticket_expired" | "ticket_redeemed";
      message: string;
    };

/**
 * The ticket a submit presents, if it is THIS product's, held by THIS token, unexpired and not
 * yet redeemed. Another product's ticket and another token's ticket are both `invalid_ticket`,
 * indistinguishable from an unknown one.
 */
export async function findUploadTicket(
  env: Env,
  db: Db,
  input: {
    ticket: unknown;
    product: string;
    holder: Pick<CiTokenRecord, "tokenHash">;
    now: number;
  },
): Promise<TicketLookup> {
  const invalid: TicketLookup = {
    ok: false,
    status: 403,
    reason: "invalid_ticket",
    message: "unknown upload ticket",
  };
  if (typeof input.ticket !== "string" || !TICKET_SHAPE.test(input.ticket))
    return invalid;
  const ticketHash = await hashCiCredential(env, input.ticket);
  const r = await db.first<{
    ticket_hash: string;
    ticket_id: string;
    product: string;
    token_hash: string;
    objects_json: string;
    expires_at: number;
    redeemed_at: number | null;
  }>("SELECT * FROM ci_upload_tickets WHERE ticket_hash = ?", ticketHash);
  if (
    !r ||
    r.product !== input.product ||
    r.token_hash !== input.holder.tokenHash
  )
    return invalid;
  if (r.redeemed_at !== null)
    return {
      ok: false,
      status: 409,
      reason: "ticket_redeemed",
      message: "this upload ticket was already redeemed",
    };
  if (r.expires_at <= input.now)
    return {
      ok: false,
      status: 403,
      reason: "ticket_expired",
      message: "this upload ticket has expired",
    };
  let objects: TicketObject[] = [];
  try {
    objects = JSON.parse(r.objects_json) as TicketObject[];
  } catch {
    objects = [];
  }
  return {
    ok: true,
    ticket: {
      ticketHash: r.ticket_hash,
      ticketId: r.ticket_id,
      product: r.product,
      objects,
      expiresAt: r.expires_at,
    },
  };
}

/**
 * Claim a ticket for one submit, atomically: `true` for exactly one of any number of racing
 * submits. A submit that then fails before its descriptor is written gives the claim back
 * (`releaseUploadTicket`) so CI can fix the upload and submit again; one that succeeds leaves the
 * ticket redeemed for good.
 */
export async function claimUploadTicket(
  db: Db,
  ticketHash: string,
  now: number,
): Promise<boolean> {
  const n = await db.runChanges(
    `UPDATE ci_upload_tickets SET redeemed_at = ?
      WHERE ticket_hash = ? AND redeemed_at IS NULL AND expires_at > ?`,
    now,
    ticketHash,
    now,
  );
  return n === 1;
}

export async function releaseUploadTicket(
  db: Db,
  ticketHash: string,
  claimedAt: number,
): Promise<void> {
  await db.run(
    "UPDATE ci_upload_tickets SET redeemed_at = NULL WHERE ticket_hash = ? AND redeemed_at = ?",
    ticketHash,
    claimedAt,
  );
}

// ── R2 temporary credentials ────────────────────────────────────────────────────────────────

/** The parent R2 token (Worker secrets) and the bucket it delegates. */
export interface R2Parent {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * The parent R2 token, or `null` when any piece is missing — then the uploads route answers
 * not-found, exactly as a Worker without the blob store does. Secrets: `R2_ACCOUNT_ID`,
 * `R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY`; var: `BLOBS_BUCKET_NAME`.
 */
/**
 * What the uploads route still lacks in this environment, by NAME (never a value): the `BLOBS`
 * binding and each piece `r2Parent` needs. Empty means `POST /<p>/release/publish/uploads` can
 * issue tickets. The deploy hook reports it so deploy.yml fails loudly instead of every SDK
 * publish meeting an unexplained 404 (the route itself stays indistinguishable from absent).
 */
export function uploadsMissing(env: Env): string[] {
  const missing: string[] = [];
  if (!env.BLOBS) missing.push("BLOBS (R2 binding)");
  const accountId = secret(env, "R2_ACCOUNT_ID");
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  else if (!/^[0-9a-f]{32}$/.test(accountId))
    missing.push("R2_ACCOUNT_ID (not a 32-hex account id)");
  for (const name of [
    "R2_PARENT_ACCESS_KEY_ID",
    "R2_PARENT_SECRET_ACCESS_KEY",
    "BLOBS_BUCKET_NAME",
  ] as const)
    if (!secret(env, name)) missing.push(name);
  return missing;
}

export function r2Parent(env: Env): R2Parent | null {
  const accountId = secret(env, "R2_ACCOUNT_ID");
  const accessKeyId = secret(env, "R2_PARENT_ACCESS_KEY_ID");
  const secretAccessKey = secret(env, "R2_PARENT_SECRET_ACCESS_KEY");
  const bucket = secret(env, "BLOBS_BUCKET_NAME");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  if (!/^[0-9a-f]{32}$/.test(accountId)) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export interface UploadCredentials {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
}

/** The staging prefix a ticket's credentials reach: `staging/<product>/<ticketId>/`. */
export function ticketPrefix(product: string, ticketId: string): string {
  return `staging/${product}/${ticketId}/`;
}

/**
 * Mint R2 temporary credentials locally (Cloudflare "client-side signing"): an HS256 JWT signed
 * with the parent secret access key (the SHA-256 hex of the parent token value, i.e. the S3
 * secret, not the token value itself), naming exactly one bucket, the `UPLOAD_CREDENTIAL_ACTIONS`
 * and exactly one prefix. The temporary secret is the SHA-256 hex of the JWT; the session token is
 * `base64("jwt/" + jwt)`; the access key id is the parent's. Nothing is fetched, and the parent
 * secret never leaves the Worker.
 *
 * The claims carry `actions` and NO `scope`. Cloudflare's docs show both together, but real R2
 * refuses a session token that names both: every PUT then fails with 400 `InvalidArgument` /
 * `X-Amz-Security-Token` (measured against the prod bucket, 2026-10-04, after the v0.8.17
 * deploy's SDK publish failed that way). With `actions` alone R2 accepts the token and enforces
 * it: PutObject and HeadObject inside the prefix succeed, while GetObject, DeleteObject and a PUT
 * outside the prefix are 403 AccessDenied.
 */
export async function mintUploadCredentials(
  parent: R2Parent,
  prefix: string,
  now: number,
  expiresAt: number,
): Promise<UploadCredentials> {
  if (!/^staging\/[a-z0-9-]{1,64}\/[A-Za-z0-9_-]{1,128}\/$/.test(prefix))
    throw new Error(
      "upload credentials are only ever scoped to a staging prefix",
    );
  const endpoint = `https://${parent.accountId}.r2.cloudflarestorage.com`;
  const claims = {
    bucket: parent.bucket,
    // No `scope`: R2 rejects a token that names `scope` and `actions` together (see above).
    actions: [...UPLOAD_CREDENTIAL_ACTIONS],
    paths: { prefixPaths: [prefix], objectPaths: [] },
    sub: parent.accountId,
    iss: parent.accessKeyId,
    aud: new URL(endpoint).host,
    iat: now,
    exp: expiresAt,
  };
  const jwt = await signJwtHs256(claims, parent.secretAccessKey);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jwt),
  );
  const secretAccessKey = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    endpoint,
    bucket: parent.bucket,
    accessKeyId: parent.accessKeyId,
    secretAccessKey,
    sessionToken: btoa(`jwt/${jwt}`),
    expiresAt,
  };
}

// ── Housekeeping ────────────────────────────────────────────────────────────────────────────

/**
 * The nightly sweep's share: tokens and tickets that expired more than a day ago. Safe for the
 * replay guard — an OIDC token's own `exp` is minutes, so its `jti` row is long useless by then.
 */
export async function pruneCiCredentials(
  db: Db,
  product: string,
  now: number,
): Promise<number> {
  const cutoff = now - 24 * 60 * 60;
  const tickets = await db.runChanges(
    "DELETE FROM ci_upload_tickets WHERE product = ? AND expires_at < ?",
    product,
    cutoff,
  );
  const tokens = await db.runChanges(
    "DELETE FROM ci_tokens WHERE product = ? AND expires_at < ?",
    product,
    cutoff,
  );
  return tickets + tokens;
}
