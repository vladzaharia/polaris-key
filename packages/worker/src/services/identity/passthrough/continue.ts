/// <reference types="@cloudflare/workers-types" />

/**
 * Continue and Cancel on the card (WIRE-CONTRACT-V4 §12.4; plans/I-08.md §3), dispatched by the
 * portal API:
 *
 *   POST /api/signin/requests/:handle/continue   {consent?, choice?, terms?}  -> {redirect}
 *   POST /api/signin/requests/:handle/cancel                                  -> {redirect}
 *
 * Both need the account session, the portal CSRF header (the dispatcher checks it for every
 * mutation) and the `__Host-pk_req` binder of the browser that started the request, which is the
 * R1-07 binding for the web redirect: the code is delivered only by the response to the press
 * made in the browser that holds the binder, and it goes to a URI the product registered.
 *
 * ── CONTINUE ────────────────────────────────────────────────────────────────────────────────
 *
 * "Continue to <App>" is always shown (plan D3): there is no skip, whatever was consented before.
 * It records app consent (`account_product_grants`: the claims granted, and the hash of what the
 * product asked), checks the product's terms and the licence choice, then TAKES the request in one
 * atomic consume and issues the code. Nothing is consumed until every check has passed, so a
 * refusal (`terms_required`, `license_choice_required`) leaves the card able to try again. The
 * device is unknown here: it binds at `token` (D5).
 *
 * ── CANCEL ──────────────────────────────────────────────────────────────────────────────────
 *
 * Takes the request and answers `{redirect}` to `redirect_uri?error=access_denied&state=…&iss=…`.
 * It needs no account state, but it does need the session and the binder, so a page elsewhere
 * cannot burn someone's request.
 */

import { appendAudit } from "../../../core/audit.js";
import { ErrorCode } from "../../../core/errors.js";
import { randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { loadProductPublic } from "../../../core/products.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { subjectFor } from "../../../core/accounts/accountSubjects.js";
import { rankAnchorCandidates } from "../../../core/licensing/anchor.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import { isSameOriginRequest } from "../../../core/accounts/browserRequestGuard.js";
import { cardJson, readJsonObject } from "../card/http.js";
import { getPortalAccount } from "../portal/repo.js";
import { stmtRecordTermsAcceptance, termsAccepted } from "../accounts/terms.js";
import { productTerms } from "../productTerms.js";
import { issuerOf } from "./authorize.js";
import { issueAuthorizationCode } from "./code.js";
import { takeSignInRequest } from "./request.js";
import { askedScopeHash, liveRequest } from "./routes.js";

/** Continue and Cancel: 30 a minute per account, failing closed. */
export const CONTINUE_RATE = {
  bucket: "identityContinue",
  limit: 30,
  windowSec: 60,
};

/** RFC 6749 §4.1.2.1: travels only in the redirect's query, so it is not a registered wire code. */
const ACCESS_DENIED = "access_denied";

const NOT_FOUND = (): Response => cardJson({ error: "not_found" }, 404);
const refuse = (status: number, error: string): Response =>
  cardJson({ error }, status);

/** `<redirect_uri>?code=…&state=…&iss=…`, or `?error=…`: the one place a redirect target is built. */
function target(
  redirectUri: string,
  issuer: string,
  state: string,
  member: { code: string } | { error: string },
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(member)) url.searchParams.set(k, v);
  url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export interface CardCaller {
  accountId: string;
}

/** `POST /api/signin/requests/:handle/cancel`. */
export async function handleSignInCancel(
  req: Request,
  env: Env,
  db: Db,
  caller: CardCaller,
  handle: string,
  now: number,
): Promise<Response> {
  if (!isSameOriginRequest(req)) return NOT_FOUND();
  const live = await liveRequest(env, db, req, handle, now);
  if (!live || !live.record.authz) return NOT_FOUND();
  if (
    !(await rateLimitOk(
      env,
      "_portal",
      { ...CONTINUE_RATE, id: caller.accountId },
      now,
    ))
  )
    return refuse(429, "rate_limited");
  const record = await takeSignInRequest(env, req, handle, now);
  if (!record?.authz) return NOT_FOUND();
  const { authz } = record;
  return cardJson({
    redirect: target(
      authz.redirectUri,
      issuerOf(req, { slug: record.product }),
      authz.state,
      { error: ACCESS_DENIED },
    ),
  });
}

/** `POST /api/signin/requests/:handle/continue`. */
export async function handleSignInContinue(
  req: Request,
  env: Env,
  db: Db,
  caller: CardCaller,
  handle: string,
  now: number,
  settings?: SettingsRegistry,
): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return refuse(400, ErrorCode.InvalidRequest);
  const live = await liveRequest(env, db, req, handle, now);
  if (!live || !live.record.authz) return NOT_FOUND();
  const { authz } = live.record;
  const product = await loadProductPublic(db, live.record.product);
  if (!product) return NOT_FOUND();
  if (
    !(await rateLimitOk(
      env,
      "_portal",
      { ...CONTINUE_RATE, id: caller.accountId },
      now,
    ))
  )
    return refuse(429, "rate_limited");

  const account = await getPortalAccount(db, caller.accountId, now);
  if (!account || account.status !== "active") return NOT_FOUND();
  if ((await erasureVerdict(env, now, account.id)) !== "clear")
    return refuse(503, "erasure_ledger_unavailable");

  // The claims granted: a subset of what the request asked for. Absent grants all of it.
  let granted: string[] = [...authz.scope];
  if (body.consent !== undefined) {
    const claims = (body.consent as { claims?: unknown } | null)?.claims;
    if (
      !Array.isArray(claims) ||
      !claims.every((c) => typeof c === "string" && authz.scope.includes(c))
    )
      return refuse(400, ErrorCode.InvalidRequest);
    granted = authz.scope.filter((s) => claims.includes(s));
  }

  // The product's terms: asked once per version. A session that never went through the gate for
  // this product (already signed in) accepts here, by sending the version it was shown.
  const terms = await productTerms(
    { env, db, ...(settings ? { registry: settings } : {}) },
    product.slug,
  );
  let acceptTerms = false;
  if (
    terms &&
    !(await termsAccepted(db, account.id, product.slug, terms.version))
  ) {
    if (body.terms !== terms.version) return refuse(409, "terms_required");
    acceptTerms = true;
  }

  // The licence choice is never silent (S-19 decision 3): an account that holds licences for the
  // product says which one this device runs on. `blocked` rows cannot be bound by a sign-in.
  let choice: { licenseId: string } | null = null;
  if (product.services.license.enabled) {
    const offer = await rankAnchorCandidates(db, product, account.id, now);
    if (offer.candidates.length > 0) {
      const wanted = (body.choice as { licenseId?: unknown } | undefined)
        ?.licenseId;
      const row = offer.candidates.find((c) => c.licenseId === wanted);
      if (!row || row.state === "blocked")
        return refuse(409, ErrorCode.LicenseChoiceRequired);
      choice = { licenseId: row.licenseId };
    }
  }

  // Every check has passed: take the request (one press, one code), then write.
  const record = await takeSignInRequest(env, req, handle, now);
  if (!record?.authz) return NOT_FOUND();

  const subject = await subjectFor(db, account.id, product.slug, now);
  const scopeHash = await askedScopeHash(product);
  await db.batch([
    {
      sql: `INSERT INTO account_product_grants
              (account_id, product, claims_json, granted_at, modified_at, scope_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, product) DO UPDATE SET
              claims_json = excluded.claims_json,
              modified_at = excluded.modified_at,
              scope_hash = excluded.scope_hash`,
      params: [
        account.id,
        product.slug,
        JSON.stringify(granted),
        now,
        now,
        scopeHash,
      ],
    },
    ...(acceptTerms && terms
      ? [stmtRecordTermsAcceptance(account.id, product.slug, terms, now)]
      : []),
  ]);
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: "signin.continue",
    target_kind: "product",
    target_id: product.slug,
    parent_id: null,
    summary: `Continued to ${record.authz.clientId} (${record.kind})`,
  });

  const code = await issueAuthorizationCode(
    env,
    {
      product: product.slug,
      clientId: record.authz.clientId,
      redirectUri: record.authz.redirectUri,
      accountId: account.id,
      subject,
      scope: granted,
      choice,
      nonce: record.authz.nonce,
      licenseChoice: record.authz.licenseChoice,
    },
    record.authz.codeChallenge,
  );
  return cardJson({
    redirect: target(
      record.authz.redirectUri,
      issuerOf(req, product),
      record.authz.state,
      { code },
    ),
  });
}
