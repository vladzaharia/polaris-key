/// <reference types="@cloudflare/workers-types" />

/**
 * The deploy hook (F-10 automation, owner decision 2026-10-04): `POST /webhooks/deploy`.
 *
 * `.github/workflows/deploy.yml` calls it after every production deploy, so the platform's own SDKs
 * stay registered on its package feeds with no hand step:
 *
 *   1. `ensureSystemProduct`: the system product `polaris-key` exists with `packageFeeds` on and
 *      the platform feeds seeded (the same idempotent path as the console's
 *      `POST /manage/api/platform/feeds/bootstrap`; a service, the switch or a feed an operator
 *      turned off stays off);
 *   2. `linkSystemProduct`: the system product is linked to the platform monorepo and its root
 *      `.pkey/` (sent in the body, from the tagged commit being deployed) is applied: the package
 *      deliverables every publish is checked against, and the trusted publisher
 *      (`publish-package.yml` in the `package-registry` environment) the SDK publishes exchange
 *      their OIDC tokens through.
 *      ST-20: the system product is manifest-authoritative (locked), so this apply also ends any
 *      break-glass claim whose 7 days ran out or whose field the manifest changed, and the answer
 *      lists the live ones (`breakGlass`, key and expiry) for the deploy summary.
 *   3. LX-08: one bounded pass of the licensing catch-up (`core/licensingCatchUp.ts`): store grants
 *      re-projected, OIDC-provisioned keys moved to their `oidc` grants. It runs after the answer
 *      (`waitUntil`; `licensing: {scheduled: true}`) and records its counts as a platform activity
 *      row (`licensing.catch_up`); without an execution context the answer carries them.
 *   4. The answer reports `uploads: {ready, missing}`: whether this Worker can issue the upload
 *      tickets every publish needs (the `BLOBS` binding and the parent R2 token, by name only).
 *      `scripts/register-platform.mjs` fails the deploy job on `ready: false`, so a missing R2
 *      secret is a red deploy, not a 404 in every SDK feed job.
 *
 * Safe to rerun: every write is an idempotent upsert, and a second call with the same manifest
 * changes nothing but `modified_at`.
 *
 * ── AUTHENTICATION ──────────────────────────────────────────────────────────────────────────
 *
 * The deploy job's own GitHub Actions OIDC token, `Authorization: Bearer <jwt>`, verified exactly
 * as a trusted publisher's (`core/publisher.ts`: RS256 against GitHub's JWKS, the fixed issuer,
 * `aud = <origin>/webhooks/deploy`, exp/nbf/iat, single-use `jti`), and then held to a policy the
 * Worker's configuration fixes, never a request:
 *
 *   repository_id, repository_owner_id   PLATFORM_REPOSITORY_ID, PLATFORM_REPOSITORY_OWNER_ID
 *   job_workflow_ref                      PLATFORM_REPOSITORY's .github/workflows/deploy.yml, at
 *                                         the ref that triggered the run, a `refs/tags/v*` tag
 *   environment                           PLATFORM_DEPLOY_ENVIRONMENT (default `production`)
 *   ref_protected, runner_environment, event_name   as every trusted publisher
 *
 * With any of the three PLATFORM_REPOSITORY* vars unset the route does not exist (404): a Worker
 * that is not the platform's own deployment has no deploy hook. No secret is stored anywhere: the
 * repository holds none, and the token is a GitHub-signed statement about the job that sent it.
 * The trust it buys is the deploy job's own (that job already holds CLOUDFLARE_API_TOKEN), and
 * the policy is narrower than the job: one workflow file, at a protected release tag, in the
 * environment whose reviewers gate production. THREAT-MODEL §3 "The deploy hook".
 *
 * The body is the root `.pkey/` as text (`{ files: { product, schema, release, distribution? } }`,
 * 256 KiB at most), parsed by the same validator as a repository link. The repository's numeric
 * ids the trusted publisher pins come from the verified token (equal to the configuration by
 * then), never from the manifest.
 */

import { SYSTEM_PRODUCT_SLUG, parseManifest } from "@polaris-key/manifest";
import type { Env } from "./env.js";
import { secret } from "./env.js";
import type { Db } from "./db/types.js";
import { errorResponse, ErrorCode, json } from "./core/errors.js";
import { clientNetwork, rateLimitOk } from "./core/rateLimit.js";
import { readCappedText } from "./core/readCapped.js";
import {
  checkPublisherPolicy,
  hashCiCredential,
  mintCiToken,
  OIDC_CI_TOKEN_TTL_SECONDS,
  verifyGithubOidcToken,
  type JwksFetcher,
  type PublisherPolicy,
  uploadsMissing,
} from "./core/publisher.js";
import { randomId } from "./crypto.js";
import { appendPlatformAudit } from "./repo.js";
import { manifestIngestFor } from "./core/registry.js";
import { SERVICES } from "./mount.js";
import {
  ensureSystemProduct,
  linkSystemProduct,
  systemManifestProblem,
  type SystemRepository,
} from "./admin/systemProduct.js";
import { MANIFEST_FILE_NAMES } from "./services/release/manifestFiles.js";
import { reservedNamesMode } from "./core/reservedNames.js";
import { reservedDisplayNamesMode } from "./core/reservedDisplayNames.js";
import { reconcilePackageFileRefs } from "./services/release/packages/refReconcile.js";
import { runLicensingCatchUp } from "./core/licensingCatchUp.js";

export const DEPLOY_HOOK_PATH = "/webhooks/deploy";
/** The one workflow whose runs may call the hook. */
export const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";
/** A release tag is `vMAJOR.MINOR.PATCH` with an optional prerelease. */
const DEPLOY_TAG_RE = /^refs\/tags\/v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const DEFAULT_DEPLOY_ENVIRONMENT = "production";
/** The root `.pkey/` is a few KiB; anything near this is not it. */
export const MAX_DEPLOY_HOOK_BODY_BYTES = 256 * 1024;
/** Per client IP, before any signature check (a deploy calls once, a rerun once more). */
const DEPLOY_HOOK_RL = { limit: 20, windowSec: 60 };
/** LX-08: licences the deploy hook's provisioned-keys pass examines (the nightly finishes). */
const DEPLOY_HOOK_LICENSING_BUDGET = 500;
/** The deploy hook's own rate-limit scope (`RateLimitDO` is keyed by name, not by product). */
const RL_SCOPE = "_platform-deploy-hook";

/** The platform repository and deploy environment the hook admits, or `null` (no hook). */
export function deployHookPolicy(
  env: Env,
): (SystemRepository & { environment: string }) | null {
  const repository = (secret(env, "PLATFORM_REPOSITORY") ?? "").trim();
  const id = (secret(env, "PLATFORM_REPOSITORY_ID") ?? "").trim();
  const ownerId = (secret(env, "PLATFORM_REPOSITORY_OWNER_ID") ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repository))
    return null;
  if (!/^[1-9][0-9]{0,19}$/.test(id) || !/^[1-9][0-9]{0,19}$/.test(ownerId))
    return null;
  const environment =
    (secret(env, "PLATFORM_DEPLOY_ENVIRONMENT") ?? "").trim() ||
    DEFAULT_DEPLOY_ENVIRONMENT;
  return {
    repository,
    repositoryId: Number(id),
    repositoryOwnerId: Number(ownerId),
    environment,
  };
}

/** Test seam: the JWKS fetcher the hook uses (`null` = GitHub's, through the KV cache). */
let jwksFetcherOverride: JwksFetcher | null = null;
export function setDeployHookJwksFetcherForTests(f: JwksFetcher | null): void {
  jwksFetcherOverride = f;
}

const refuse = (
  status: number,
  code: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) => errorResponse(status, code, message, { reason, ...extra });

/**
 * LX-08: one bounded licensing catch-up pass after a deploy. Never throws: a failure is the
 * outcome's `error`, and the nightly maintenance runs the pass again. A pass that runs after the
 * answer (`record`) leaves its outcome as a platform activity row (`licensing.catch_up`, counts
 * only), since the answer is gone by then.
 */
async function deployLicensingCatchUp(
  db: Db,
  now: number,
  actor: string,
  record: boolean,
): Promise<Record<string, unknown>> {
  let outcome: Record<string, unknown>;
  try {
    const r = await runLicensingCatchUp(
      db,
      SERVICES,
      now,
      DEPLOY_HOOK_LICENSING_BUDGET,
    );
    outcome = {
      products: r.products,
      failed: Object.keys(r.failures),
      provisioned: r.provisioned,
    };
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }
  if (!record) return outcome;
  try {
    await appendPlatformAudit(db, {
      id: randomId("paud"),
      at: now,
      actor_sub: actor,
      actor_name: "Deploy",
      actor_email: null,
      action: "licensing.catch_up",
      target_kind: "platform",
      target_id: null,
      summary:
        "error" in outcome
          ? `The licensing catch-up failed (${String(outcome.error).slice(0, 300)}); the nightly maintenance runs it again`
          : `Ran the licensing catch-up: ${String(outcome.products)} products re-projected; provisioned keys moved on ${JSON.stringify(outcome.provisioned)}`,
      before_json: null,
      after_json: JSON.stringify(outcome),
    });
  } catch {
    // Recording the outcome is best effort; the pass itself is idempotent and runs nightly.
  }
  return outcome;
}

export async function handleDeployHook(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  /** The request's execution context: the licensing catch-up runs after the answer (LX-08). */
  exec?: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const policy = deployHookPolicy(env);
  if (!policy) return errorResponse(404, ErrorCode.NotFound);
  if (req.method !== "POST")
    return errorResponse(405, "method_not_allowed", "method not allowed");
  if (
    !(await rateLimitOk(
      env,
      RL_SCOPE,
      { bucket: "deployHook", id: clientNetwork(req), ...DEPLOY_HOOK_RL },
      now,
    ))
  )
    return refuse(429, "rate_limited", "rate_limited", "too many requests");

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(auth);
  if (!m)
    return refuse(
      401,
      ErrorCode.Unauthorized,
      "invalid_oidc_token",
      "send the deploy job's GitHub Actions OIDC token as Authorization: Bearer",
    );
  const verified = await verifyGithubOidcToken(env, m[1]!, {
    audience: `${new URL(req.url).origin}${DEPLOY_HOOK_PATH}`,
    now,
    ...(jwksFetcherOverride ? { fetchJwks: jwksFetcherOverride } : {}),
  });
  if (!verified.ok)
    return refuse(
      401,
      ErrorCode.Unauthorized,
      verified.reason,
      verified.message,
    );
  const claims = verified.claims;
  const asPolicy: PublisherPolicy = {
    product: SYSTEM_PRODUCT_SLUG,
    provider: "github",
    repositoryId: policy.repositoryId,
    repositoryOwnerId: policy.repositoryOwnerId,
    repository: policy.repository,
    workflow: DEPLOY_WORKFLOW,
    environment: policy.environment,
    scopes: [],
    source: "admin",
    createdAt: 0,
    modifiedAt: 0,
    modifiedBy: null,
  };
  const check = checkPublisherPolicy(asPolicy, claims);
  if (!check.ok)
    return refuse(403, ErrorCode.Forbidden, "policy_mismatch", check.message, {
      claim: check.claim,
    });
  if (typeof claims.ref !== "string" || !claims.ref.startsWith("refs/tags/v"))
    return refuse(
      403,
      ErrorCode.Forbidden,
      "policy_mismatch",
      "the deploy hook is called from a release tag (refs/tags/v*) only",
      { claim: "ref" },
    );

  // The deploy is a `push` of a semver release tag at the commit this
  // Worker was built from. A dispatched run, a free-form `v*` ref or another commit's token is
  // refused whatever the workflow file says; `PKEY_GIT_SHA` is set by the same deploy.
  if (claims.event_name !== "push")
    return refuse(
      403,
      ErrorCode.Forbidden,
      "policy_mismatch",
      "the deploy hook is called by a push-triggered run only",
      { claim: "event_name" },
    );
  if (!DEPLOY_TAG_RE.test(claims.ref))
    return refuse(
      403,
      ErrorCode.Forbidden,
      "policy_mismatch",
      "the deploy hook is called from a semver release tag (refs/tags/vX.Y.Z) only",
      { claim: "ref" },
    );
  const builtSha = (env.PKEY_GIT_SHA ?? "").trim().toLowerCase();
  const claimSha =
    typeof claims.sha === "string" ? claims.sha.toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(builtSha) || claimSha !== builtSha)
    return refuse(
      403,
      ErrorCode.Forbidden,
      "policy_mismatch",
      "the token's commit is not the commit this Worker was built from",
      { claim: "sha" },
    );

  // The body: the root `.pkey/` as text, through the same parser as a repository link.
  let files: Record<string, string>;
  try {
    const text = await readCappedText(
      req as unknown as Response,
      MAX_DEPLOY_HOOK_BODY_BYTES,
      (d) => new Error(`the body is too large (${d})`),
    );
    const body = JSON.parse(text) as { files?: unknown };
    if (!body || typeof body.files !== "object" || body.files === null)
      throw new Error(
        "the body must be { files: { product, schema, release } }",
      );
    files = {};
    for (const [name, value] of Object.entries(body.files)) {
      if (!(MANIFEST_FILE_NAMES as readonly string[]).includes(name))
        throw new Error(`files.${name} is not a .pkey/ document`);
      if (typeof value !== "string")
        throw new Error(`files.${name} must be the document's text`);
      files[name] = value;
    }
  } catch (e) {
    return refuse(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      e instanceof Error ? e.message : "unreadable body",
    );
  }
  const parsed = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    reservedDisplayNames: await reservedDisplayNamesMode(env, db),
  });
  if (!parsed.ok)
    return refuse(
      400,
      ErrorCode.BadRequest,
      "invalid_manifest",
      "the root .pkey/ does not validate",
      { errors: parsed.errors },
    );

  const problem = systemManifestProblem(parsed.manifest, policy);
  if (problem)
    return refuse(409, ErrorCode.BadRequest, "wrong_manifest", problem);

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const runId =
    typeof claims.run_id === "string" ? `#run:${claims.run_id}` : "";
  const actor = `ci:github:${sub}${runId}`.slice(0, 512);

  const ensured = await ensureSystemProduct(env, db, actor, now);
  if (!ensured.ok)
    return refuse(409, ErrorCode.BadRequest, ensured.reason, ensured.message);

  // Single-use, like the publish exchange: the token's `jti` takes the UNIQUE `idx_ci_tokens_jti`
  // slot as a revoked, scope-less row under the system product (no token is issued; the row only
  // records that this OIDC token was spent, and the nightly sweep prunes it). A replayed token
  // inserts nothing — atomically, however many requests race.
  const spent = await db.runChanges(
    `INSERT INTO ci_tokens
       (token_hash, token_id, product, kind, scopes_json, subject, label, jti, issued_at,
        expires_at, revoked_at, created_by)
     VALUES (?, ?, ?, 'oidc', '[]', ?, 'deploy hook', ?, ?, ?, ?, 'deploy-hook')
     ON CONFLICT DO NOTHING`,
    await hashCiCredential(env, mintCiToken()),
    randomId("cit"),
    SYSTEM_PRODUCT_SLUG,
    `github:${sub}${runId}`.slice(0, 512),
    String(claims.jti),
    now,
    now + OIDC_CI_TOKEN_TTL_SECONDS,
    now,
  );
  if (spent === 0)
    return refuse(
      401,
      ErrorCode.Unauthorized,
      "oidc_token_replayed",
      "this OIDC token was already used",
    );

  const linked = await linkSystemProduct(
    db,
    parsed.manifest,
    {
      repository: policy.repository,
      repositoryId: policy.repositoryId,
      repositoryOwnerId: policy.repositoryOwnerId,
    },
    // ST-01a: the snapshot records the documents this body carried, applied at the commit this
    // deploy built (`PKEY_GIT_SHA`, which deploy.yml sets to the same `GITHUB_SHA` the job ran at).
    { files, sha: env.PKEY_GIT_SHA ?? null },
    now,
    manifestIngestFor(SERVICES),
  );
  if (!linked.ok)
    return refuse(409, ErrorCode.BadRequest, linked.reason, linked.message);

  // ST-20 (S-18 §4.5 item 7): every deploy summary lists the system product's live break-glass
  // claims. The answer goes to the deploy job's log, which may be readable beyond the operators,
  // so it carries each claim's key and expiry only; the reason and the claimant stay in the
  // console and this platform activity row.
  const iso = (at: number) => new Date(at * 1000).toISOString();
  const breakGlassNote =
    linked.breakGlass.length > 0
      ? `; live break-glass claims: ${linked.breakGlass.map((b) => `${b.key} until ${iso(b.expiresAt)} (${b.reason})`).join(", ")}`
      : "";
  const endedNote =
    linked.breakGlassEnded.length > 0
      ? `; ended break-glass claims: ${linked.breakGlassEnded.map((e) => `${e.key} (${e.why})`).join(", ")}`
      : "";

  await appendPlatformAudit(db, {
    id: randomId("paud"),
    at: now,
    actor_sub: actor,
    actor_name: "Deploy",
    actor_email: null,
    action: "feed.bootstrap",
    target_kind: "product",
    target_id: SYSTEM_PRODUCT_SLUG,
    summary:
      `${ensured.created ? "Created" : "Re-asserted"} the system product ${SYSTEM_PRODUCT_SLUG}, ` +
      `linked it to ${policy.repository} and applied its .pkey/ ` +
      `(${linked.packages.length} packages` +
      (linked.publisherClaimed
        ? "; an operator-claimed trusted publisher was replaced by the manifest's)"
        : linked.publisher
          ? `; trusted publisher ${linked.publisher.workflow} in ${linked.publisher.environment})`
          : "; no trusted publisher)") +
      breakGlassNote +
      endedNote,
    before_json: linked.replacedClaim
      ? JSON.stringify({ replacedPublisherClaim: linked.replacedClaim })
      : null,
    after_json: JSON.stringify({
      created: ensured.created,
      repository: policy.repository,
      packages: linked.packages,
      publisher: linked.publisher,
      publisherClaimed: linked.publisherClaimed,
      staticTokensRevoked: linked.staticTokensRevoked,
      ref: claims.ref,
      breakGlass: linked.breakGlass,
      breakGlassEnded: linked.breakGlassEnded,
    }),
  });

  // SEC-DST-1: the new Worker is live; heal any package ref the previous Worker wrote as
  // `artifact` between the migration and this deploy. Never a failed deploy.
  try {
    const healed = await reconcilePackageFileRefs(db);
    if (healed > 0)
      await appendPlatformAudit(db, {
        id: randomId("paud"),
        at: now,
        actor_sub: actor,
        actor_name: "Deploy",
        actor_email: null,
        action: "feed.bootstrap",
        target_kind: "product",
        target_id: SYSTEM_PRODUCT_SLUG,
        summary: `Reconciled ${healed} package-file blob ref(s) left by the previous Worker`,
        before_json: null,
        after_json: JSON.stringify({ reconciled: healed }),
      });
  } catch {
    // Never a failed deploy: the next cron tick runs the same pass.
  }

  // LX-08 (plans/LX-01.md §6.2 steps 2–4): the deploy-hook job `licensing.migrateProvisioned`
  // and the store-grant re-projection, one bounded pass right after the deploy that starts the
  // dual-write (`core/licensingCatchUp.ts`). The request's single-use `jti` is spent by now, so
  // the pass runs AFTER the answer (`waitUntil`): a pass the runtime cuts short can never turn the
  // deploy job's retry into `oidc_token_replayed`. Its outcome is then a platform activity row;
  // the nightly maintenance finishes whatever remains. Without an execution context (tests, a
  // direct call) it runs inline and the answer carries its outcome, a failure included, never a
  // failed deploy.
  let licensing: Record<string, unknown>;
  if (exec) {
    exec.waitUntil(deployLicensingCatchUp(db, now, actor, true));
    licensing = { scheduled: true };
  } else {
    licensing = await deployLicensingCatchUp(db, now, actor, false);
  }

  return json({
    ok: true,
    slug: SYSTEM_PRODUCT_SLUG,
    created: ensured.created,
    repository: policy.repository,
    packages: linked.packages,
    publisher: linked.publisher,
    publisherClaimed: linked.publisherClaimed,
    publisherChanged: linked.publisherChanged,
    staticTokensRevoked: linked.staticTokensRevoked,
    // ST-20: the live break-glass claims (key and expiry only) and the ones this deploy ended.
    breakGlass: linked.breakGlass.map((b) => ({
      key: b.key,
      expiresAt: b.expiresAt,
    })),
    breakGlassEnded: linked.breakGlassEnded,
    // Whether this Worker can issue upload tickets at all: every SDK publish needs one. Names
    // only; register-platform.mjs fails the deploy on `ready: false`.
    uploads: (() => {
      const missing = uploadsMissing(env);
      return { ready: missing.length === 0, missing };
    })(),
    // LX-08: the licensing catch-up's counts (no licence id, no purchase key).
    licensing,
  });
}
