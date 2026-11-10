/**
 * Client authentication at the issuer's `token` and `revoke` (I-21.9, I-21.11; V5 §12.13.2; IS-12).
 *
 * A `web` client sends exactly one of `client_secret_basic` and `client_secret_post`; both, neither, a
 * wrong or revoked secret, or a `client_id` that differs between the header and the body is `401
 * invalid_client` (`WWW-Authenticate: Basic` after a `Basic` attempt). A `spa` or `native` client sends
 * `client_id` in the body and no secret anywhere. A secret is hashed and compared against every live
 * secret in constant time whether or not the client exists (`verifyClientSecret`), so an unknown
 * client, a client with no secret and a wrong secret cost the same.
 *
 * Two budgets sit in front, both failing closed: a failed-authentication bucket per `client_id`
 * (10 failures a minute, peeked before any secret is checked and spent by each failure), and a
 * request bucket keyed on `client_id` AND the caller's network, so one network cannot spend another's.
 */

import { CLIENT_CORS_HEADER } from "../../../core/cors.js";
import { ErrorCode } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import type { Db } from "../../../db/types.js";
import { base64DecodeEitherAlphabet } from "../../../platform/bytes.js";
import type { Env } from "../../../platform/env.js";
import { oauth } from "../passthrough/oauthHttp.js";
import {
  getActiveClient,
  verifyClientSecret,
  type ClientRecord,
} from "./clientsRepo.js";
import { issuerServed } from "./served.js";

export interface IssuerTokenCx {
  req: Request;
  env: Env;
  db: Db;
  slug: string;
  now: number;
  form: Map<string, string>;
}

/** Failed client authentications per `client_id`. */
export const AUTH_FAIL_RATE = {
  bucket: "identityIssuerAuthFail",
  limit: 10,
  windowSec: 60,
};
/** Requests per `client_id` and network. */
export const CLIENT_NET_RATE = {
  bucket: "identityIssuerClientNet",
  limit: 30,
  windowSec: 60,
};
/** Requests per `client_id`, whatever the network. */
export const CLIENT_TOKEN_RATE = {
  bucket: "identityIssuerToken",
  limit: 60,
  windowSec: 60,
};

/** The `client_id` and secret of an `Authorization: Basic` header, or `null` when it is not one. */
function basicOf(
  req: Request,
): { id: string; secret: string } | "malformed" | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!m) return "malformed";
  try {
    const raw = new TextDecoder().decode(base64DecodeEitherAlphabet(m[1]!));
    const at = raw.indexOf(":");
    if (at < 0) return "malformed";
    // RFC 6749 §2.3.1: both halves are form-urlencoded before they are joined.
    return {
      id: decodeURIComponent(raw.slice(0, at).replace(/\+/g, " ")),
      secret: decodeURIComponent(raw.slice(at + 1).replace(/\+/g, " ")),
    };
  } catch {
    return "malformed";
  }
}

/** The client id this request names (header or body), for the caller's dispatch. */
export function namedClientId(
  req: Request,
  form: Map<string, string>,
): string | null {
  const basic = basicOf(req);
  if (basic && basic !== "malformed") return basic.id;
  return form.get("client_id") ?? null;
}

/** The origins a `spa` client's redirect URIs are on: who may read its answers. */
export function clientCorsOrigins(client: ClientRecord | null): string {
  if (!client || client.type !== "spa") return "";
  const origins = new Set<string>();
  for (const uri of client.redirectUris)
    if (uri.startsWith("https://")) origins.add(new URL(uri).origin);
  return [...origins].join(" ");
}

/** Mark a response with who may read it cross-origin; the dispatcher turns it into CORS headers. */
export function scopedCors(
  res: Response,
  client: ClientRecord | null,
): Response {
  res.headers.set(CLIENT_CORS_HEADER, clientCorsOrigins(client));
  return res;
}

const invalidClient = (basic: boolean): Response => {
  const res = oauth(401, ErrorCode.InvalidClient);
  if (basic) res.headers.set("www-authenticate", 'Basic realm="polaris-key"');
  return res;
};

const tooMany = (windowSec: number): Response =>
  oauth(429, "rate_limited", undefined, { retryAfter: windowSec });

export type Authed =
  | { ok: true; client: ClientRecord }
  | { ok: false; response: Response };

/** Authenticate the client (§12.13.2). Every failure is the same `401 invalid_client`. */
export async function authenticate(cx: IssuerTokenCx): Promise<Authed> {
  const { req, env, db, slug, now, form } = cx;
  const basic = basicOf(req);
  const attempted = basic !== null;
  const bodyId = form.get("client_id");
  const id = basic && basic !== "malformed" ? basic.id : bodyId;
  const failed = async (): Promise<Authed> => {
    // Each failure spends the client's budget; the next attempt is refused once it is gone.
    if (id) await rateLimitOk(env, slug, { ...AUTH_FAIL_RATE, id }, now);
    return { ok: false, response: invalidClient(attempted) };
  };
  if (id) {
    if (!(await rateLimitOk(env, slug, { ...AUTH_FAIL_RATE, id }, now, true)))
      return { ok: false, response: tooMany(AUTH_FAIL_RATE.windowSec) };
    if (
      !(await rateLimitOk(
        env,
        slug,
        { ...CLIENT_NET_RATE, id: `${id}:${clientNetwork(req)}` },
        now,
      ))
    )
      return { ok: false, response: tooMany(CLIENT_NET_RATE.windowSec) };
  }
  if (basic === "malformed" || !id) return failed();
  // The header and the body must agree when both name a client.
  if (basic && bodyId !== undefined && bodyId !== basic.id) return failed();
  const client = (await issuerServed(db, slug))
    ? await getActiveClient(db, slug, id)
    : null;
  const secret = basic ? basic.secret : form.get("client_secret");
  // Both methods at once is refused whatever they say.
  if (basic && form.get("client_secret") !== undefined) return failed();
  if (client?.type === "web") {
    // Exactly one method, and a live secret. Verified even when absent, so an unknown client and
    // a wrong secret cost the same.
    const ok = await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return secret !== undefined && ok ? { ok: true, client } : failed();
  }
  // Unknown client: spend the same hash a real one would, then refuse.
  if (!client) {
    await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return failed();
  }
  // A public client holds no secret: one sent anywhere is refused, so it cannot be mistaken for one.
  if (secret !== undefined || attempted) return failed();
  return { ok: true, client };
}
