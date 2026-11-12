/**
 * A press on the sign-in card, the way the card's page sends it: the portal API with the Locker
 * session, the CSRF header and the request's binder cookie, each of which a test may leave out.
 */
import { SETTINGS } from "../src/mount.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handlePortalApi } from "../src/services/identity/portal/api.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { portalHooksFor } from "./portalHarness.js";
import { NOW } from "./seed.js";

export interface CardSession {
  cookie: string;
  csrf: string;
}

/** A live Locker session for `accountId`. */
export async function portalLogin(
  env: Env,
  db: Db,
  accountId: string,
  at = NOW,
): Promise<CardSession> {
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    { accountId, name: "Ada", email: "ada@example.com" },
    at,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

export interface CardPress {
  /** The card's origin: the API host, or the customer host. */
  origin: string;
  /** The request handle. */
  handle: string;
  /** The last path segment: `continue`, `cancel` or `key`. */
  verb: string;
  /** The Locker session; absent presses without one. */
  session?: CardSession;
  /** The binder cookie pair; absent presses without one. */
  binder?: string | null;
  /** The CSRF header: the session's own by default, `null` for none. */
  csrf?: string | null;
  /** A `Sec-Fetch-Site` value. */
  site?: string;
  body?: unknown;
}

export function cardPress(
  env: Env,
  db: Db,
  p: CardPress,
  now = NOW,
): Promise<Response> {
  const path = `/api/signin/requests/${p.handle}/${p.verb}`;
  const cookies = [p.session?.cookie, p.binder].filter(Boolean);
  const csrf = p.csrf === undefined ? p.session?.csrf : p.csrf;
  return handlePortalApi(
    new Request(`${p.origin}${path}`, {
      method: "POST",
      headers: {
        ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
        ...(csrf ? { [PORTAL_CSRF_HEADER]: csrf } : {}),
        ...(p.site ? { "sec-fetch-site": p.site } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(p.body ?? {}),
    }),
    env,
    db,
    path,
    now,
    portalHooksFor(env, db),
    SETTINGS,
  );
}

/** The redirect a card press answered, as a URL. */
export async function redirectOf(res: Response): Promise<URL> {
  expectOk(res);
  return new URL(((await res.json()) as { redirect: string }).redirect);
}

function expectOk(res: Response): void {
  if (res.status !== 200) throw new Error(`card press answered ${res.status}`);
}
