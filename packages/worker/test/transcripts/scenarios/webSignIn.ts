/// <reference types="@cloudflare/workers-types" />
// Scenario SETUP for a sign-in made through authorize and token (I-08): the same requests a
// browser and an SDK make, sent through the router but not recorded. A scenario whose subject is
// something else (identity-attach) uses it to put the account on the device the way a completed
// web sign-in does, instead of writing the binding by hand.

import { createHash } from "node:crypto";
import { dispatchWith } from "../../../src/dispatch.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import { BASE_URL, type World } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import { PRODUCT } from "../world.js";

export const WEB_APP = "https://app.example";
export const WEB_CALLBACK = `${WEB_APP}/auth/callback`;

/** The product registers its web origin and callback path (what `web.origins` and
 *  `identity.redirectPaths` hold after a manifest sync). */
export async function registerWebApp(w: World): Promise<void> {
  w.env.PORTAL_SESSION_SECRET = "transcript-portal-session-secret";
  await w.db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([WEB_APP]),
    PRODUCT,
  );
  await w.db.run(
    `INSERT OR REPLACE INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.redirectPaths', ?, 'manifest', ?, 'resync')`,
    PRODUCT,
    JSON.stringify(["/auth/callback"]),
    T0,
  );
}

/** A portal session for the account: the cookie pair and its CSRF value. */
export async function portalSession(
  w: World,
  account: { id: string; email: string },
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId: account.id, email: account.email, name: null },
    T0,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

const send = (
  w: World,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  now = T0,
): Promise<Response> =>
  dispatchWith(
    new Request(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );

/**
 * Sign `account` in on DEVICE through authorize, Continue and token. `bearer` is the device's
 * own token when it holds one (the sign-in then keeps the licence it runs on). Returns the
 * `token` response's JSON.
 */
export async function webSignIn(
  w: World,
  account: { id: string; email: string },
  bearer: string | null,
  now = T0,
): Promise<Record<string, unknown>> {
  const verifier = "setup-verifier-0123456789-abcdefghijklmnopqrstuvwx";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const session = await portalSession(w, account);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: PRODUCT,
    redirect_uri: WEB_CALLBACK,
    state: "setup-state-0123456789",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorized = await send(
    w,
    "GET",
    `/${PRODUCT}/identity/authorize?${query}`,
    {},
    undefined,
    now,
  );
  if (authorized.status !== 303)
    throw new Error(`setup authorize: ${authorized.status}`);
  const handle = new URL(authorized.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const binder = authorized.headers.get("set-cookie")!.split(";")[0]!;
  const proceeded = await send(
    w,
    "POST",
    `/api/signin/requests/${handle}/continue`,
    {
      cookie: `${session.cookie}; ${binder}`,
      [PORTAL_CSRF_HEADER]: session.csrf,
    },
    undefined,
    now,
  );
  if (proceeded.status !== 200)
    throw new Error(
      `setup continue: ${proceeded.status} ${await proceeded.text()}`,
    );
  const redirect = ((await proceeded.json()) as { redirect: string }).redirect;
  const code = new URL(redirect).searchParams.get("code")!;
  const tokened = await send(
    w,
    "POST",
    `/${PRODUCT}/identity/token`,
    {
      "content-type": "application/x-www-form-urlencoded",
      "x-pkey-device": DEVICE,
      "x-pkey-version": VERSION,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: PRODUCT,
      code,
      code_verifier: verifier,
      redirect_uri: WEB_CALLBACK,
    }).toString(),
    now,
  );
  if (tokened.status !== 200) throw new Error(`setup token: ${tokened.status}`);
  return (await tokened.json()) as Record<string, unknown>;
}
