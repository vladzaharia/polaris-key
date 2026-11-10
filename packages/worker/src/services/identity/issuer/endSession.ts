/**
 * `GET` or `POST <issuer>/end-session` (I-21.12; V5 §12.13.9; OIDC RP-Initiated Logout 1.0;
 * threat IS-13). A relying party sends the person here to end their session. Nothing ends on this
 * route: it validates the request, stores a single-use handle (`endSessionStore.ts`) and `303`s to
 * the customer host's `/signout` page, where Polaris Locker asks "Sign out of Polaris Locker too?"
 * (`signout.ts`). The person decides there; the return to the relying party happens from there.
 *
 * ── THE ORDER OF REFUSALS (never a redirect to a request-supplied URL) ──────────────────────────
 *
 *   1. Repeated or oversized parameters are `invalid_request`: the first and the last cannot
 *      disagree. A `POST` reads its form body alone (the query is ignored).
 *   2. The client is the one `client_id` names or, with none, the hint's `aud`; the two agree when
 *      both are sent. An unknown, disabled or other product's client is the `invalid_client` page,
 *      and so is a `client_id` that is not a registered client's.
 *   3. The hint is verified as at `authorize` (`verifyIdTokenHint`: `alg` pinned, this product's
 *      keys, `iss`, and `aud` = the client above); an expired one is accepted. Anything else is
 *      `invalid_request`.
 *   4. `post_logout_redirect_uri` is used only when the client is known and the string equals one
 *      of its registered `postLogoutRedirectUris` (`matchRedirectUri`: the exact string, the
 *      loopback port aside). One sent without a client, or unmatched, is `invalid_request`. The
 *      return stored is the REGISTERED string, never one the request sent; the loopback port
 *      aside, which is the presented one (a native client's loopback port is free, RFC 8252 §7.3).
 *
 * Every refusal is one branded page about signing out ("Couldn't finish signing out"): it names
 * the app, says its sign-out isn't set up correctly, and links to Polaris Locker so the person can
 * sign out there. It never offers "try again", which cannot help with a misconfigured client. A product whose
 * issuer is off answers the registry's `404` (a `null` here). The route has a budget of 30 a
 * minute per client network, failing closed.
 */

import {
  AUTHORIZE_STATE_MAX,
  CLIENT_ID_PATTERN,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { appForPage, brandPageResponse } from "../../../core/brandPage.js";
import { escapeHtml } from "../../../platform/html.js";
import { customerHostname, customerOrigin } from "../../../core/hosts.js";
import { cardPage } from "../card/http.js";
import { readBodyText } from "../../../core/cappedBody.js";
import { redirect } from "../passthrough/authorize.js";
import { getActiveClient } from "./clientsRepo.js";
import { createEndSession } from "./endSessionStore.js";
import { hintAudience, verifyIdTokenHint } from "./idTokenHint.js";
import { matchRedirectUri } from "./redirect.js";
import { issuerServed } from "./served.js";

/** 30 a minute per client network (§12.13.11): the route writes one record. */
export const END_SESSION_RATE = {
  bucket: "identityEndSession",
  limit: 30,
  windowSec: 60,
};

/** A request is a few hundred bytes. */
const END_SESSION_FORM_CAP = 8 * 1024;
const CLIENT_ID_RE = new RegExp(CLIENT_ID_PATTERN);

/** The single value of a parameter; `undefined` when absent and `null` when repeated. */
function single(p: URLSearchParams, name: string): string | undefined | null {
  const all = p.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0]! : null;
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim();
  if (type?.toLowerCase() !== "application/x-www-form-urlencoded") return null;
  try {
    return new URLSearchParams(await readBodyText(req, END_SESSION_FORM_CAP));
  } catch {
    return null;
  }
}

/**
 * The one refusal of an end-session request that cannot go on (a request the issuer does not
 * understand, a client that is not a live client's): it speaks about signing out, says one thing
 * to do, and offers the way the person can still sign out of Polaris Locker themselves.
 */
function refusalPage(
  status: number,
  app: { name: string; iconUrl?: string | null },
  library: string,
): Response {
  const title = "Couldn't finish signing out";
  return brandPageResponse(status, {
    title,
    heading: title,
    body: `<p>${escapeHtml(`${app.name}'s sign-out isn't set up correctly. Let its developer know.`)}</p><p class="actions"><a class="button" href="${escapeHtml(library)}">Sign out in Polaris Locker</a></p>`,
    app,
  });
}

export async function handleEndSession(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  hooks?: ServiceHooks;
}): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  if (!(await issuerServed(db, product.slug))) return null;
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...END_SESSION_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return cardPage(429, {
      title: "Too many attempts",
      heading: "Too many attempts",
      body: "<p>Wait a minute, then try again.</p>",
    });

  const apiOrigin = new URL(req.url).origin;
  const customer =
    customerHostname(env) === null ? null : customerOrigin(env, req);
  const refuse = async (status: number): Promise<Response> =>
    refusalPage(status, await appForPage(ctx), `${customer ?? apiOrigin}/`);
  let params: URLSearchParams;
  if (req.method === "POST") {
    const form = await readForm(req);
    if (form === null) return refuse(400);
    params = form;
  } else params = new URL(req.url).searchParams;

  const clientParam = single(params, "client_id");
  const hint = single(params, "id_token_hint");
  const returnParam = single(params, "post_logout_redirect_uri");
  const stateParam = single(params, "state");
  if (
    clientParam === null ||
    hint === null ||
    returnParam === null ||
    stateParam === null ||
    (stateParam !== undefined && stateParam.length > AUTHORIZE_STATE_MAX)
  )
    return refuse(400);

  // The client: named, or the hint's audience. They agree when both are sent.
  const audience = hint === undefined ? undefined : hintAudience(hint);
  if (audience === null) return refuse(400);
  if (
    clientParam !== undefined &&
    audience !== undefined &&
    clientParam !== audience
  )
    return refuse(400);
  const clientId = clientParam ?? audience;
  let client = null;
  if (clientId !== undefined) {
    client = CLIENT_ID_RE.test(clientId)
      ? await getActiveClient(db, product.slug, clientId)
      : null;
    if (!client) return refuse(401);
  }

  const issuer = `${new URL(req.url).origin}/${product.slug}/identity`;
  let hintSub: string | null = null;
  if (hint !== undefined && client) {
    hintSub = await verifyIdTokenHint(
      db,
      product.slug,
      issuer,
      client.clientId,
      hint,
    );
    if (hintSub === null) return refuse(400);
  }

  // The return: only a registered string of a known client, never the one the request sent.
  let returnUri: string | null = null;
  if (returnParam !== undefined) {
    returnUri = client
      ? matchRedirectUri(
          client.postLogoutRedirectUris,
          returnParam,
          client.type,
        )
      : null;
    if (returnUri === null) return refuse(400);
  }

  const crossHost = customer !== null && customer !== apiOrigin;
  let created: Awaited<ReturnType<typeof createEndSession>>;
  try {
    created = await createEndSession(
      env,
      req,
      {
        product: product.slug,
        clientId: client?.clientId ?? null,
        returnUri,
        state:
          returnUri !== null && stateParam !== undefined ? stateParam : null,
        hintSub,
        crossHost,
      },
      now,
    );
  } catch {
    return cardPage(503, {
      title: "Couldn't finish signing out",
      heading: "Couldn't finish signing out",
      body: `<p>Go back to the app and try again.</p><p class="actions"><a class="button" href="${escapeHtml(`${customer ?? apiOrigin}/`)}">Sign out in Polaris Locker</a></p>`,
    });
  }
  const origin = crossHost && created.bindToken ? customer : apiOrigin;
  const res = redirect(
    303,
    `${origin}/signout?request=${created.handle}${
      crossHost && created.bindToken ? `&bind=${created.bindToken}` : ""
    }`,
  );
  if (created.setCookie) res.headers.append("set-cookie", created.setCookie);
  return res;
}
