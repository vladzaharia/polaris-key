/**
 * Continue for a registered client's request (I-21.8; V5 §12.13.3 rules 2, 4 and 5; D22; threats
 * IS-2, IS-4, IS-8). `POST /api/signin/requests/:handle/continue`, after the account session, the
 * portal CSRF check, the binder and the rate limit that the own client's Continue also passes.
 *
 * Nothing is consumed until every check has passed, so a refusal leaves the card able to try
 * again; then the request is TAKEN in one atomic consume (one press, one answer). The checks, in
 * order, each re-made HERE because the card is not trusted and time has passed since `authorize`:
 *
 *   1. The client is still active and the issuer still on (else the same 404 as an unknown handle).
 *   2. `choice` is refused (`400 bad_request`): a registered client binds no device or licence.
 *   3. An `id_token_hint` names the account that is signing in; another account is answered
 *      `login_required` to the registered redirect URI (the handle is taken).
 *   4. A fresh sign-in is needed when the request asked for one (`prompt=login`, `max_age`): the
 *      session's own signed sign-in time must be after the request was made, else `409
 *      reauth_required` and the card signs the person in again. `auth_time` is that time.
 *   5. `consent.claims` holds every `claims.required` claim the request reaches and only claims it
 *      reaches, else `400 bad_request`: declining a required claim is Cancel.
 *   6. The product's terms are accepted (or this press accepts the version it was shown).
 *
 * Continue writes the client grant (never `account_product_grants`) and answers
 * `{"redirect": "<redirect_uri>?code=…&state=…&iss=…"}`. The code carries the claims the person
 * granted, the scope, the nonce, the challenge (or none) and `auth_time`.
 */

import type { IssuerClaim } from "@polaris-key/protocol/identity";
import { appendAudit } from "../../../core/audit.js";
import {
  existingSubjectFor,
  subjectFor,
} from "../../../core/accounts/accountSubjects.js";
import { ErrorCode } from "../../../core/errors.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import type { Db } from "../../../db/types.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { randomId } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { cardJson } from "../card/http.js";
import { stmtRecordTermsAcceptance } from "../accounts/terms.js";
import { issueAuthorizationCode } from "../passthrough/code.js";
import {
  takeSignInRequest,
  type SignInRequestRecord,
} from "../passthrough/request.js";
import { issuerOf } from "../passthrough/authorize.js";
import { consentScope } from "../passthrough/routes.js";
import { termsGate } from "../productTerms.js";
import { getActiveClient } from "./clientsRepo.js";
import { claimsFromConsent, claimsOfScopes, lineScopes } from "./coverage.js";
import { clientGrantStatement } from "./grantsRepo.js";
import { needsFreshSignIn, requestCreatedAt } from "./reauth.js";
import { withQuery } from "./redirect.js";
import { issuerServed } from "./served.js";

const refuse = (status: number, error: string): Response =>
  cardJson({ error }, status);

export interface RegisteredContinue {
  req: Request;
  env: Env;
  db: Db;
  handle: string;
  now: number;
  settings?: SettingsRegistry | undefined;
  record: SignInRequestRecord;
  accountId: string;
  /** The session's signed sign-in time (epoch seconds). */
  authTime: number;
  body: Record<string, unknown>;
}

/** `{redirect}` to the registered URI with these members, and the app's `state`. */
function redirectTo(
  cx: RegisteredContinue,
  members: Record<string, string>,
): Response {
  const authz = cx.record.authz!;
  return cardJson({
    redirect: withQuery(authz.redirectUri, {
      ...members,
      ...(authz.state !== null ? { state: authz.state } : {}),
      iss: issuerOf(cx.req, { slug: cx.record.product }),
    }),
  });
}

export async function continueRegistered(
  cx: RegisteredContinue,
): Promise<Response> {
  const { env, db, now, record, accountId, body } = cx;
  const slug = record.product;
  const authz = record.authz!;
  const reg = authz.registered!;
  const client = (await issuerServed(db, slug))
    ? await getActiveClient(db, slug, authz.clientId)
    : null;
  if (!client) return refuse(404, ErrorCode.NotFound);
  if (body.choice !== undefined) return refuse(400, ErrorCode.BadRequest);

  // 3. The hinted account is the one signing in.
  if (reg.hintSub !== null) {
    const subject = await existingSubjectFor(db, accountId, slug);
    if (subject === null || !constantTimeEqual(subject, reg.hintSub)) {
      if (!(await takeSignInRequest(env, cx.req, cx.handle, now)))
        return refuse(404, ErrorCode.NotFound);
      return redirectTo(cx, { error: "login_required" });
    }
  }

  // 4. A fresh sign-in, when the request asked for one.
  if (
    needsFreshSignIn(reg, cx.authTime, now, requestCreatedAt(record.expiresAt))
  )
    return refuse(409, "reauth_required");

  // 5. The claims granted: every required one, and only ones the request reaches.
  const reached = claimsOfScopes(authz.scope);
  const granted = claimsFromConsent<IssuerClaim>(body, reached);
  if (granted === null) return refuse(400, ErrorCode.BadRequest);
  if (
    !client.claims.required
      .filter((c) => reached.includes(c))
      .every((c) => granted.includes(c))
  )
    return refuse(400, ErrorCode.BadRequest);

  // 6. The product's terms.
  const gate = await termsGate(
    { env, db, ...(cx.settings ? { registry: cx.settings } : {}) },
    accountId,
    slug,
    body.terms,
  );
  if (!gate.ok) return refuse(409, "terms_required");

  // Every check has passed: take the request, then write.
  const taken = await takeSignInRequest(env, cx.req, cx.handle, now);
  if (!taken?.authz) return refuse(404, ErrorCode.NotFound);
  const subject = await subjectFor(db, accountId, slug, now);
  const lines = lineScopes(authz.scope);
  await db.batch([
    clientGrantStatement(
      {
        accountId,
        clientId: client.clientId,
        product: slug,
        claimsGranted: granted,
        claimsDeclined: reached.filter((c) => !granted.includes(c)),
        scopes: lines,
        scopeHash: await consentScope(reached, lines),
      },
      now,
    ),
    ...(gate.accept
      ? [stmtRecordTermsAcceptance(accountId, slug, gate.accept, now)]
      : []),
  ]);
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: "identity.client.continue",
    target_kind: "client",
    target_id: client.clientId,
    parent_id: null,
    summary: `Continued to a registered client (${granted.join(", ") || "no optional claims"})`,
  });
  const code = await issueAuthorizationCode(
    env,
    {
      product: slug,
      clientId: client.clientId,
      redirectUri: authz.redirectUri,
      accountId,
      subject,
      scope: authz.scope,
      choice: null,
      nonce: authz.nonce,
      licenseChoice: "card",
      registered: { claims: granted, authTime: cx.authTime },
    },
    authz.codeChallenge,
  );
  return redirectTo(cx, { code });
}
