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
 * A failed attempt is counted per `client_id` and network (10 a minute, then 429); a correct credential
 * is never refused by that count, so a stranger who knows the public `client_id` cannot lock the
 * client out. A high per-`client_id` count (200 a minute) is kept as a signal and refuses nothing.
 */

import { CLIENT_ID_PATTERN } from "@polaris-key/protocol/identity";
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

const CLIENT_ID_RE = new RegExp(CLIENT_ID_PATTERN);

export interface IssuerTokenCx {
  req: Request;
  env: Env;
  db: Db;
  slug: string;
  now: number;
  form: Map<string, string>;
}

/** Failed client authentications per `client_id` and network: the budget that can refuse (§12.13.11). */
export const AUTH_FAIL_RATE = {
  bucket: "identityIssuerAuthFail",
  limit: 20,
  windowSec: 60,
};
/** Failed authentications per `client_id` from anywhere: a signal only, it never refuses. */
export const AUTH_SIGNAL_RATE = { ...AUTH_FAIL_RATE, limit: 200 };
/**
 * Requests to `token` (§12.13.11): a public client, whose caller is a person's device or browser,
 * 30 a minute per `client_id` and network; a confidential client, whose caller is the developer's
 * server, 600 a minute per `client_id` from anywhere. Both fail closed.
 */
export const PUBLIC_TOKEN_RATE = {
  bucket: "identityIssuerToken",
  limit: 30,
  windowSec: 60,
};
export const CONFIDENTIAL_TOKEN_RATE = {
  bucket: "identityIssuerTokenConfidential",
  limit: 600,
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

/**
 * Authenticate the client (§12.13.2). The credential is verified FIRST and a correct one is never
 * refused by a failure budget: only a request that fails is counted, per `client_id` and network, so
 * a stranger spraying a public `client_id` can neither lock the client out nor spend its budget. A
 * failure is `401 invalid_client`, or `429` once this network has used its failures.
 */
export async function authenticate(cx: IssuerTokenCx): Promise<Authed> {
  const { req, env, db, slug, now, form } = cx;
  const basic = basicOf(req);
  const attempted = basic !== null;
  const bodyId = form.get("client_id");
  const id = basic && basic !== "malformed" ? basic.id : bodyId;
  const refuse = async (): Promise<Authed> => {
    if (id !== undefined && CLIENT_ID_RE.test(id)) {
      await rateLimitOk(env, slug, { ...AUTH_SIGNAL_RATE, id }, now);
      const within = await rateLimitOk(
        env,
        slug,
        { ...AUTH_FAIL_RATE, id: `${id}:${clientNetwork(req)}` },
        now,
      );
      if (!within)
        return { ok: false, response: tooMany(AUTH_FAIL_RATE.windowSec) };
    }
    return { ok: false, response: invalidClient(attempted) };
  };
  if (basic === "malformed" || !id || !CLIENT_ID_RE.test(id)) return refuse();
  // The header and the body must agree when both name a client.
  if (basic && bodyId !== undefined && bodyId !== basic.id) return refuse();
  const client = (await issuerServed(db, slug))
    ? await getActiveClient(db, slug, id)
    : null;
  const secret = basic ? basic.secret : form.get("client_secret");
  // Both methods at once is refused whatever they say.
  if (basic && form.get("client_secret") !== undefined) return refuse();
  if (client?.type === "web") {
    // Exactly one method, and a live secret. Verified even when absent, so an unknown client and
    // a wrong secret cost the same.
    const ok = await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return secret !== undefined && ok ? { ok: true, client } : refuse();
  }
  // Unknown client: spend the same hash a real one would, then refuse.
  if (!client) {
    await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return refuse();
  }
  // A public client holds no secret: one sent anywhere is refused, so it cannot be mistaken for one.
  if (secret !== undefined || attempted) return refuse();
  return { ok: true, client };
}
