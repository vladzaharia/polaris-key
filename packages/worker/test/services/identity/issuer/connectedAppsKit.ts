/**
 * Shared setup for the Connected apps tests (I-21.15): a portal session for an account of the
 * issuer world, and `GET`/`PATCH`/`DELETE /api/me/connected-apps` calls through the portal API.
 */
import { issuePortalSessionRow } from "../../../portalSessionRow.js";
import { handlePortalApi } from "../../../portalHarness.js";
import { NOW } from "../../../seed.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../../src/services/identity/portal/session.js";
import type { World } from "../../connect/connectFixture.js";

export interface PortalCaller {
  cookie: string;
  csrf: string;
  accountId: string;
}

/** A live portal session for `accountId` in the world. */
export async function portalSessionFor(
  w: World,
  accountId: string,
  email = "ada@example.com",
): Promise<PortalCaller> {
  (w.env as unknown as Record<string, unknown>).PORTAL_SESSION_SECRET =
    "connected-apps-session-secret";
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, email, name: null },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf, accountId };
}

export interface CallOptions {
  /** Send the CSRF header (default). */
  csrf?: boolean;
  /** Send the session cookie (default). */
  cookie?: boolean;
  body?: unknown;
  at?: number;
}

export function connectedAppsCall(
  w: World,
  who: PortalCaller,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== false) headers.cookie = who.cookie;
  if (opts.csrf !== false) headers[PORTAL_CSRF_HEADER] = who.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }) as unknown as Request,
    w.env,
    w.db,
    path,
    opts.at ?? NOW,
  );
}
