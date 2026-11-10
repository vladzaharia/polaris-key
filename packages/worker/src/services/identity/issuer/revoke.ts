/**
 * `POST <issuer>/revoke` (I-21.11; V5 §12.13.7; RFC 7009; threat IS-5). A registered client ends one
 * of its own refresh tokens, and with it the whole family. Client authentication is `token`'s
 * (`clientAuth.ts`), CORS is `token`'s.
 *
 * It answers `200` with an empty body and `no-store` for: a refresh token of this client (the family
 * is revoked, and a token already spent or ended revokes it too), an access token (which is NOT
 * revoked: it ends within 600 s), and a token that is unknown or malformed (RFC 7009 §2.2: nothing
 * changes, and the answer does not say so). A refresh token of ANOTHER client of the product is `400
 * unauthorized_client` and revokes nothing. A missing `token` is `invalid_request`.
 */

import { ISSUER_REFRESH_TOKEN_PATTERN } from "@polaris-key/protocol/identity";
import { ErrorCode, methodNotAllowed } from "../../../core/errors.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { oauth, readForm } from "../passthrough/oauthHttp.js";
import { authenticate, scopedCors } from "./clientAuth.js";
import { findRefreshToken, revokeRefreshFamily } from "./refreshRepo.js";
import { issuerServed } from "./served.js";

const TOKEN_RE = new RegExp(ISSUER_REFRESH_TOKEN_PATTERN);

export async function handleRevoke(
  req: Request,
  env: Env,
  db: Db,
  slug: string,
  now: number,
): Promise<Response | null> {
  if (req.method !== "POST") return methodNotAllowed();
  if (!(await issuerServed(db, slug))) return null;
  const form = await readForm(req);
  if (!form)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "A form-encoded body is required.",
    );
  const auth = await authenticate({ req, env, db, slug, now, form });
  if (!auth.ok) return scopedCors(auth.response, null);
  const { client } = auth;
  const token = form.get("token");
  if (!token)
    return scopedCors(
      oauth(400, ErrorCode.InvalidRequest, "token is required."),
      client,
    );
  if (TOKEN_RE.test(token)) {
    const row = await findRefreshToken(env, db, slug, token);
    if (row && row.clientId !== client.clientId)
      return scopedCors(oauth(400, ErrorCode.UnauthorizedClient), client);
    if (row) await revokeRefreshFamily(db, slug, row.familyId, now);
  }
  return scopedCors(
    new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    }),
    client,
  );
}
