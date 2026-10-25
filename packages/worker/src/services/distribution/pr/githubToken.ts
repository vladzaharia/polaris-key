/**
 * The CI token exchange for tap and bucket pull requests (A-32.7; SETUP W18).
 *
 *     POST /<p>/distribution/pr/github-token      `pkeyci_` + distribution:pr (opt-in)
 *         { outlet, store? }  ->  { ok, token, expiresAt, repository }
 *
 * A `direct` outlet declares its own Homebrew tap (`homebrewTap`) and/or Scoop bucket
 * (`scoopBucket`). The run asks for a GitHub token for one of them and opens the pull request
 * with it, so `pkey storefront` needs no personal token. The token is Contents and Pull requests
 * write on that one repository for GitHub's one hour; Release mints it (the App is Release's)
 * and Distribution reaches it only through `ctx.hooks.githubPrToken()`.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────────────────────
 *
 *   - The repository is never the caller's word: it is the outlet row's declared identity, and
 *     must pass the manifest's own pattern (no `Homebrew/*`, no `ScoopInstaller/*`). A winget,
 *     Flathub or any other outlet kind has no repository here and is refused.
 *   - Release off: the route does not exist (the not-found), like every hook consumer on `null`.
 *   - The token is in the one response (`Cache-Control: no-store`). It is not stored and not
 *     audited: the trail names the outlet and the repository. Nothing else prints it.
 *   - Rate-limited per product, failing closed (it mints a credential), before any GitHub call.
 *   - Audited as `distribution.pr.github_token`.
 */

import {
  HOMEBREW_TAP_PATTERN,
  SCOOP_BUCKET_PATTERN,
} from "@polaris-key/manifest";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { randomId } from "../../../platform/crypto.js";
import { parseJsonColumn } from "../../../platform/json.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import {
  errorResponse,
  ErrorCode,
  json,
  notFound,
} from "../../../core/errors.js";
import { appendAudit } from "../../../core/audit.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { ciActor, type CiPrincipal } from "../../../core/ciScope.js";
import { getOutlet } from "../outlets.js";

/** The request body: an outlet id and a store name. */
export const MAX_GITHUB_TOKEN_BODY_BYTES = 1024;

/** Per product: a run needs one or two tokens; this is room for retries, not for a loop. */
export const GITHUB_TOKEN_RATE = { limit: 20, windowSec: 3600 } as const;

/** The response, typed here and in the CLI only (plan D-G9). */
export interface GithubTokenResponse {
  ok: true;
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
  /** `<owner>/<repo>`. */
  repository: string;
}

const STORES = {
  homebrew: { field: "homebrewTap", pattern: HOMEBREW_TAP_PATTERN },
  scoop: { field: "scoopBucket", pattern: SCOOP_BUCKET_PATTERN },
} as const;
type Store = keyof typeof STORES;

export interface GithubTokenContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  principal: CiPrincipal;
}

function refuse(reason: string, message: string, status = 400): Response {
  return errorResponse(status, ErrorCode.BadRequest, message, { reason });
}

const noStore = (res: Response): Response => {
  res.headers.set("Cache-Control", "no-store");
  return res;
};

export async function exchangeGithubToken(
  ctx: GithubTokenContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { env, db, product, hooks, now, principal } = ctx;
  const minter = hooks.githubPrToken();
  if (!minter) return notFound();

  const outletId = body.outlet;
  if (typeof outletId !== "string" || outletId === "" || outletId.length > 64)
    return refuse("bad_outlet", "outlet must be an outlet id");
  if (
    body.store !== undefined &&
    body.store !== "homebrew" &&
    body.store !== "scoop"
  )
    return refuse("bad_store", "store must be homebrew or scoop");

  const row = await getOutlet(db, product, outletId);
  if (!row || row.removed_at !== null)
    return refuse("unknown_outlet", "no such outlet");
  if (row.kind !== "direct")
    return refuse(
      "outlet_not_supported",
      "only a direct outlet's tap or bucket takes a token",
    );
  const identity = parseJsonColumn(row.identity_json);
  const declared = (store: Store): string | null => {
    const v =
      identity && typeof identity === "object"
        ? (identity as Record<string, unknown>)[STORES[store].field]
        : undefined;
    return typeof v === "string" && STORES[store].pattern.test(v) ? v : null;
  };
  const candidates = (Object.keys(STORES) as Store[]).filter(
    (s) => (body.store === undefined || body.store === s) && declared(s),
  );
  if (candidates.length === 0)
    return refuse(
      "no_repository",
      "the outlet declares no valid tap or bucket",
    );
  if (candidates.length > 1)
    return refuse(
      "store_required",
      "the outlet declares a tap and a bucket; name the store",
    );
  const repository = declared(candidates[0]!)!;
  const [owner, repo] = repository.split("/") as [string, string];

  // Over the budget before any GitHub call. Charged only after the request is well-formed, so
  // a malformed body spends nothing.
  if (
    !(await rateLimitOk(
      env,
      product,
      { bucket: "ciGithubToken", id: product, ...GITHUB_TOKEN_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many token requests");

  let grant;
  try {
    grant = await minter.mint(owner, repo);
  } catch (e) {
    // The message carries a status at most (`mintInstallationToken`); a 403/422 is GitHub
    // saying the installation was never granted Pull requests or Contents write.
    const status = /: (\d{3})$/.exec(e instanceof Error ? e.message : "")?.[1];
    return errorResponse(503, "unavailable", "GitHub did not issue a token", {
      reason:
        status === "403" || status === "422" ? "app_permission" : "github",
    });
  }
  if (!grant)
    return errorResponse(
      404,
      ErrorCode.NotFound,
      "the GitHub App is not installed on that repository",
      { reason: "app_not_installed" },
    );

  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(principal),
    actor_name: "CI",
    actor_email: null,
    action: "distribution.pr.github_token",
    target_kind: "outlet",
    target_id: outletId,
    parent_id: null,
    summary: `Issued a pull-request token for ${repository}`,
  });
  const res: GithubTokenResponse = {
    ok: true,
    token: grant.token,
    expiresAt: grant.expiresAt,
    repository,
  };
  return noStore(json(res));
}
