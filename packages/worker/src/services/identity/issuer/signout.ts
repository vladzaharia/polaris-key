/**
 * The customer host's side of end-session (I-21.12; V5 §12.13.9; threat IS-13). `end-session`
 * validated the request and stored a handle (`endSessionStore.ts`); the page at `/signout` asks
 * "Sign out of Polaris Locker too?" and these three same-origin JSON routes serve it, dispatched
 * by the portal API:
 *
 *   GET  /api/signout/requests/:handle           `EndSessionView`. The binder, not a session: the
 *                                                person may have none on this host.
 *   POST /api/signout/requests/:handle/confirm   Sign out: ends this browser's Polaris Locker
 *                                                session and no other, then `{redirect}`.
 *   POST /api/signout/requests/:handle/cancel    Stay signed in: ends nothing, then `{redirect}`.
 *
 * A handle that is unknown, expired, taken, presented without its binder, or for a product whose
 * Identity or issuer is off answers `404 not_found`, always in the same shape. Both POSTs are
 * same-origin only, and when this browser holds a Polaris Locker session they need its CSRF header
 * (`X-PKey-Portal-CSRF`), the way every session-changing call of the portal does. They TAKE the
 * handle: one atomic consume, so two presses yield one answer. A `redirect` is the registered
 * `post_logout_redirect_uri` of a client that is still active (else `null`), with the relying
 * party's `state` when it sent one, built from the stored record and never from the request.
 *
 * What ends: the Polaris Locker session on this host (`revokeSessionByHash` and the cleared
 * cookie), and nothing else. Refresh tokens and client grants survive (V5 §12.13.7). The ending is
 * audited as `identity.session.end` in the product's trail, naming the client.
 */

import type { EndSessionView } from "@polaris-key/protocol/identity";
import { appendAudit } from "../../../core/audit.js";
import { isSameOriginRequest } from "../../../core/accounts/browserRequestGuard.js";
import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import { ErrorCode } from "../../../core/errors.js";
import { loadProductPublic } from "../../../core/products.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { cardJson } from "../card/http.js";
import { clientRecordFor } from "../passthrough/client.js";
import type { PortalHooksFor } from "../portal/api.js";
import {
  checkAccountSession,
  revokeSessionByHash,
} from "../portal/accountSessions.js";
import {
  PORTAL_CSRF_HEADER,
  buildPortalClearCookie,
  portalSessionFromRequest,
} from "../portal/session.js";
import {
  LINK_FLOW_COOKIE,
  clearAccountRealmCookie,
} from "../../../core/accounts/accountCookies.js";
import { getActiveClient, type ClientRecord } from "./clientsRepo.js";
import {
  readEndSession,
  takeEndSession,
  type EndSessionRecord,
} from "./endSessionStore.js";
import { withQuery } from "./redirect.js";
import { registeredClientRecord } from "./registeredView.js";
import { issuerServed } from "./served.js";

/** The answers' budget: 30 a minute per client network, failing closed. */
export const SIGNOUT_RATE = {
  bucket: "identitySignout",
  limit: 30,
  windowSec: 60,
};

const NOT_FOUND = (): Response => cardJson({ error: "not_found" }, 404);

/** The client of a stored request, only while it is still active and the issuer is served. */
async function liveClient(
  db: Db,
  record: EndSessionRecord,
): Promise<ClientRecord | null> {
  if (record.clientId === null) return null;
  return (await issuerServed(db, record.product))
    ? getActiveClient(db, record.product, record.clientId)
    : null;
}

/** `GET /api/signout/requests/:handle`. */
export async function endSessionView(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (!(await limited(env, req, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const record = await readEndSession(env, req, handle, now);
  if (!record) return NOT_FOUND();
  const product = await loadProductPublic(db, record.product);
  if (!product || !product.services.identity.enabled) return NOT_FOUND();
  if (!(await issuerServed(db, product.slug))) return NOT_FOUND();
  const app = await clientRecordFor(env, db, product, "web", now, hooksFor);
  const stored = await liveClient(db, record);
  const registered =
    stored === null
      ? null
      : await registeredClientRecord(
          env,
          db,
          product,
          stored,
          record.returnUri ?? "",
          app.developerName,
        );
  const cookie = await portalSessionFromRequest(env, req, now);
  const checked = cookie
    ? await checkAccountSession(env, db, cookie, now)
    : null;
  const returns = stored !== null && record.returnUri !== null;
  const view: EndSessionView = {
    request: handle,
    product: { appName: app.appName, iconUrl: app.iconUrl },
    client: registered
      ? {
          name: registered.name,
          developerName: registered.developerName,
          iconUrl: registered.iconUrl,
          nameVerified: registered.nameVerified,
        }
      : null,
    returns,
    returnHost: returns ? registered!.returnHost : null,
    signedIn: checked?.status === "live",
    expiresAt: record.expiresAt,
  };
  return cardJson(view);
}

async function limited(env: Env, req: Request, now: number): Promise<boolean> {
  return rateLimitOk(
    env,
    "_portal",
    { ...SIGNOUT_RATE, id: clientNetwork(req) },
    now,
  );
}

/** `POST /api/signout/requests/:handle/confirm` (Sign out) and `…/cancel` (Stay signed in). */
export async function handleEndSessionAnswer(
  req: Request,
  env: Env,
  db: Db,
  handle: string,
  action: "confirm" | "cancel",
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  if (!isSameOriginRequest(req)) return NOT_FOUND();
  if (!(await limited(env, req, now)))
    return cardJson({ error: "rate_limited" }, 429);
  // The handle is looked at, not spent, until every check below has passed.
  if (!(await readEndSession(env, req, handle, now))) return NOT_FOUND();

  // A browser with a Polaris Locker session proves the CSRF header (`session.csrf`) on both
  // answers; one without has no session to end, and the same-origin check and binder stand.
  const session = await portalSessionFromRequest(env, req, now);
  if (session) {
    const presented = req.headers.get(PORTAL_CSRF_HEADER);
    if (!presented || !constantTimeEqual(presented, session.csrf))
      return cardJson({ error: ErrorCode.Forbidden, message: "csrf" }, 403);
  }
  const record = await takeEndSession(env, req, handle, now);
  if (!record) return NOT_FOUND();
  const client = await liveClient(db, record);

  const cookies: string[] = [];
  if (action === "confirm" && session) {
    const checked = await checkAccountSession(env, db, session, now);
    if (checked.status === "live") {
      await revokeSessionByHash(db, checked.idHash, now);
      cookies.push(
        buildPortalClearCookie(),
        clearAccountRealmCookie(LINK_FLOW_COOKIE),
      );
      await appendAudit(db, {
        product: record.product,
        id: randomId("aud"),
        at: now,
        actor_sub: await existingSubjectFor(
          db,
          checked.accountId,
          record.product,
        ),
        actor_name: null,
        actor_email: null,
        action: "identity.session.end",
        target_kind: client ? "client" : "session",
        target_id: client?.clientId ?? null,
        parent_id: null,
        summary: client
          ? "Signed out of Polaris Locker from a client's end-session request"
          : "Signed out of Polaris Locker from an end-session request",
      });
    }
  }
  const redirect =
    client !== null && record.returnUri !== null
      ? record.state !== null
        ? withQuery(record.returnUri, { state: record.state })
        : record.returnUri
      : null;
  return cardJson({ redirect }, 200, cookies);
}
