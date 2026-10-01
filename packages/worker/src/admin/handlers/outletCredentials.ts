/**
 * The Core admin handler for outlet credentials (P5-01), beside `secrets`:
 *
 *   GET    /api/products/<slug>/outlet-credentials        — metadata and health, never values
 *   PUT    /api/products/<slug>/outlet-credentials/<id>   — write-only; echoes the id only.
 *          `{kind: "asc-webhook-secret", generate: true}` (no `value`) has the Worker generate
 *          the secret (32 random bytes, hex) and store it without ever returning it: the App
 *          Store Connect connector's "register webhook" control then opens it and hands it to
 *          Apple (P5-02). No Distribution code may write a credential, so generation lives here.
 *   DELETE /api/products/<slug>/outlet-credentials/<id>
 *
 * Writes are audited as `outlet_credential.set` / `outlet_credential.delete` with the session's
 * actor, exactly as `secret.set` is. This file, the Distribution service and
 * `core/outletTokens.ts` are the only importers of `core/outletCredentials` the reach test
 * allows, and this is the only file outside the owner it lets name `putOutletCredential` or
 * `deleteOutletCredential` — and this one never opens a value: it seals, lists metadata and
 * deletes.
 *
 * The dispatcher has already required a platform-admin session (`canAdminProduct`). The check is
 * repeated here on purpose: "written only by a platform admin" is the custody rule, and it must
 * not quietly widen the day a product-level admin role exists.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  deleteOutletCredential,
  isOutletCredentialId,
  isOutletCredentialKind,
  isOutletId,
  listOutletCredentials,
  OUTLET_CREDENTIAL_KINDS,
  putOutletCredential,
} from "../../core/outletCredentials.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";

export async function handleOutletCredentials(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin only");

  if (id === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({
      ok: true,
      kinds: OUTLET_CREDENTIAL_KINDS,
      credentials: await listOutletCredentials(db, slug),
    });
  }

  if (!isOutletCredentialId(id)) return notFound();

  if (req.method === "DELETE") {
    if (!(await deleteOutletCredential(db, slug, id))) return notFound();
    await audit(
      db,
      slug,
      session,
      now,
      "outlet_credential.delete",
      { kind: "outlet_credential", id },
      `Deleted outlet credential ${id}`,
    );
    return adminJson({ ok: true, id });
  }

  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  if (!isOutletCredentialKind(body.kind)) {
    return err(
      422,
      ErrorCode.BadRequest,
      `kind must be one of ${OUTLET_CREDENTIAL_KINDS.join(", ")}`,
      { fields: ["kind"] },
    );
  }
  const outletId =
    body.outletId === undefined || body.outletId === null
      ? null
      : body.outletId;
  if (outletId !== null && !isOutletId(outletId)) {
    return err(422, ErrorCode.BadRequest, "outletId is not a valid id", {
      fields: ["outletId"],
    });
  }
  const expiresAt =
    body.expiresAt === undefined || body.expiresAt === null
      ? null
      : body.expiresAt;
  if (
    expiresAt !== null &&
    !(typeof expiresAt === "number" && Number.isInteger(expiresAt))
  ) {
    return err(
      422,
      ErrorCode.BadRequest,
      "expiresAt must be a unix time in seconds",
      { fields: ["expiresAt"] },
    );
  }
  // A Google key is pasted as the JSON file it arrives as; accept that string form for it.
  let value: unknown = body.value;
  if (body.generate !== undefined) {
    if (body.generate !== true || body.kind !== "asc-webhook-secret")
      return err(
        422,
        ErrorCode.BadRequest,
        "generate: true is accepted only for an asc-webhook-secret",
        { fields: ["generate"] },
      );
    if (body.value !== undefined)
      return err(
        422,
        ErrorCode.BadRequest,
        "give value or generate, not both",
        {
          fields: ["value"],
        },
      );
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    value = {
      secret: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
        "",
      ),
    };
  }
  if (body.kind === "google-service-account" && typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return err(
        422,
        ErrorCode.BadRequest,
        "value must be the service account's JSON key",
        { fields: ["value"] },
      );
    }
  }

  const result = await putOutletCredential(env, db, {
    product: slug,
    credentialId: id,
    kind: body.kind,
    outletId,
    value,
    expiresAt,
    actor: session.sub,
    now,
  });
  if (!result.ok) {
    return err(result.status, ErrorCode.BadRequest, result.message, {
      fields: [
        result.field === "id" || result.field === "kind"
          ? result.field
          : `value.${result.field}`,
      ],
    });
  }
  await audit(
    db,
    slug,
    session,
    now,
    "outlet_credential.set",
    { kind: "outlet_credential", id },
    `${result.created ? "Set" : "Rotated"} outlet credential ${id} (${body.kind}${body.generate === true ? ", generated" : ""})`,
  );
  // NEVER echo the value, its metadata or anything derived from it — the id only.
  return adminJson({ ok: true, id });
}
