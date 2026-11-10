/**
 * The card's entry for a registered client's request (I-21.7; V5 §12.13.3 rules 2 and 3;
 * decision D4; threats IS-3, IS-4, IS-8).
 *
 * `GET /signin?request=rq_…` on the customer host, reached by the `303` from `authorize` (and, with
 * the customer host on, after the bind hop has set the `__Host-pk_req` binder). It is the first
 * place that can see the Polaris Locker session: a PRODUCT route never reads the account cookie
 * (`core/accounts/accountCookies.ts`), so `authorize` itself cannot decide `prompt=none`. This is
 * where it is decided, on the one host that holds the session, before any card is drawn.
 *
 * It answers `null` (draw the card as usual) or a `303` straight to the REGISTERED redirect URI
 * the request already validated, and nothing else:
 *
 *   `prompt=none`   never shows the card. With a live session that satisfies `max_age` and the
 *                   hint, a client grant that covers the request and no step left for the person
 *                   (the product's terms accepted), the answer carries a code. Otherwise it carries
 *                   `login_required` (no session, one too old, another account than the hint's),
 *                   `consent_required` (no covering grant) or `interaction_required` (terms).
 *   interactive     with no session, the card signs in as usual (`null`). A live session whose
 *                   subject is not the `id_token_hint`'s is `login_required` all the same; any
 *                   other session shows the card, which asks again for a `login` prompt or a
 *                   session older than `max_age` and always ends in a press of Continue (D22).
 *
 * The handle is TAKEN (one atomic consume) whenever this answers a redirect, so the request
 * yields one answer. `HEAD` and a request without the binder never get here (`HEAD` must not spend
 * it), a request of the own client is never touched, and a client that is gone, disabled or whose
 * issuer is off since `authorize` leaves the card to answer its `404`. No code, `state` or error
 * is ever in a fragment, and the target is `redirectUri` from the stored request, never a query.
 */

import { appendAudit } from "../../../core/audit.js";
import {
  existingSubjectFor,
  subjectFor,
} from "../../../core/accounts/accountSubjects.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { randomId } from "../../../platform/crypto.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { redirect, issuerOf } from "../passthrough/authorize.js";
import { issueAuthorizationCode } from "../passthrough/code.js";
import {
  readSignInRequest,
  takeSignInRequest,
  type AuthzRecord,
} from "../passthrough/request.js";
import { termsAccepted } from "../accounts/terms.js";
import { productTerms } from "../productTerms.js";
import { checkAccountSession } from "../portal/accountSessions.js";
import {
  portalSessionAuthenticatedAt,
  portalSessionFromRequest,
} from "../portal/session.js";
import { getActiveClient } from "./clientsRepo.js";
import { claimsForCode, grantCovers } from "./coverage.js";
import { getClientGrant, touchClientGrant } from "./grantsRepo.js";
import { withQuery } from "./redirect.js";
import { issuerServed } from "./served.js";

/** The silent path's budget per account: Continue's, in its own bucket. */
export const SILENT_RATE = {
  bucket: "identityIssuerSilent",
  limit: 30,
  windowSec: 60,
};

/** RFC 6749 §4.1.2.1: a redirect-only code, not a registered wire code. */
const SERVER_ERROR = "server_error";

type Denial = "login_required" | "consent_required" | "interaction_required";

/** What the entry does with a registered client's request, before any card is drawn. */
export async function silentSignInEntry(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  settings?: SettingsRegistry,
): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const handle = new URL(req.url).searchParams.get("request") ?? "";
  const record = await readSignInRequest(env, req, handle, now);
  const authz = record?.authz;
  const reg = authz?.registered;
  if (!record || !authz || !reg) return null;
  const slug = record.product;
  const client = (await issuerServed(db, slug))
    ? await getActiveClient(db, slug, authz.clientId)
    : null;
  if (!client) return null;
  const cx: Answer = {
    req,
    env,
    db,
    handle,
    now,
    authz,
    slug,
    issuer: issuerOf(req, { slug }),
  };

  const cookie = await portalSessionFromRequest(env, req, now);
  const checked = cookie
    ? await checkAccountSession(env, db, cookie, now)
    : null;
  const live = checked?.status === "live" ? checked : null;
  if (checked?.status === "unavailable" && reg.prompt.none)
    return answer(cx, { error: SERVER_ERROR });

  // No session: an interactive request signs in as usual; `prompt=none` cannot.
  if (!live || !cookie)
    return reg.prompt.none ? answer(cx, { error: "login_required" }) : null;

  // A session of another account than the hint's is `login_required`, whatever the prompt.
  if (reg.hintSub !== null) {
    const subject = await existingSubjectFor(db, live.accountId, slug);
    if (subject === null || !constantTimeEqual(subject, reg.hintSub))
      return answer(cx, { error: "login_required" });
  }
  if (!reg.prompt.none) return null;

  // Each silent answer signs a code in the person's name: a per-account budget like Continue's
  // (30 a minute, failing closed), so a page cannot drive the session in a loop.
  if (
    !(await rateLimitOk(
      env,
      "_portal",
      { ...SILENT_RATE, id: live.accountId },
      now,
    ))
  )
    return answer(cx, { error: SERVER_ERROR });

  // `prompt=none` with a session: `max_age`, then consent, then anything else the card would show.
  const authTime = portalSessionAuthenticatedAt(cookie);
  if (reg.maxAge !== null && (reg.maxAge === 0 || now - authTime > reg.maxAge))
    return answer(cx, { error: "login_required" });
  const grant = await getClientGrant(db, slug, live.accountId, client.clientId);
  if (!grant || !grantCovers(grant, authz.scope, client.claims.required))
    return answer(cx, { error: "consent_required" });
  const terms = await productTerms(
    { env, db, ...(settings ? { registry: settings } : {}) },
    slug,
  );
  if (terms && !(await termsAccepted(db, live.accountId, slug, terms.version)))
    return answer(cx, { error: "interaction_required" });

  return answer(cx, {
    code: {
      accountId: live.accountId,
      subject: await subjectFor(db, live.accountId, slug, now),
      claims: claimsForCode(grant, authz.scope),
      authTime,
    },
  });
}

interface Answer {
  req: Request;
  env: Env;
  db: Db;
  handle: string;
  now: number;
  authz: AuthzRecord;
  slug: string;
  issuer: string;
}

type Outcome =
  | { error: Denial | typeof SERVER_ERROR }
  | {
      code: {
        accountId: string;
        subject: string;
        claims: string[];
        authTime: number;
      };
    };

/**
 * Take the handle, then `303` to the registered redirect URI with the outcome. `null` when the
 * handle was already taken (a concurrent entry won): the card answers its own `404`.
 */
async function answer(cx: Answer, outcome: Outcome): Promise<Response | null> {
  const { req, env, db, handle, now, authz, slug, issuer } = cx;
  const taken = await takeSignInRequest(env, req, handle, now);
  if (!taken?.authz) return null;
  const state: Record<string, string> =
    authz.state !== null ? { state: authz.state } : {};
  if ("error" in outcome)
    return redirect(
      303,
      withQuery(authz.redirectUri, {
        error: outcome.error,
        ...state,
        iss: issuer,
      }),
    );
  const c = outcome.code;
  const code = await issueAuthorizationCode(
    env,
    {
      product: slug,
      clientId: authz.clientId,
      redirectUri: authz.redirectUri,
      accountId: c.accountId,
      subject: c.subject,
      scope: authz.scope,
      choice: null,
      nonce: authz.nonce,
      licenseChoice: "card",
      registered: { claims: c.claims, authTime: c.authTime },
    },
    authz.codeChallenge,
  );
  await touchClientGrant(db, slug, c.accountId, authz.clientId, now);
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: c.subject,
    actor_name: null,
    actor_email: null,
    action: "identity.client.signin",
    target_kind: "client",
    target_id: authz.clientId,
    parent_id: null,
    summary: "Signed in to a registered client without asking (prompt=none)",
  });
  return redirect(
    303,
    withQuery(authz.redirectUri, { code, ...state, iss: issuer }),
  );
}
