/**
 * The Core admin handler for outlet credentials (P5-01), beside `secrets`:
 *
 *   GET    /api/products/<slug>/outlet-credentials        — metadata and health, never values
 *   PUT    /api/products/<slug>/outlet-credentials/<id>   — write-only; echoes the id only.
 *          `{kind: "asc-webhook-secret", generate: true}` (no `value`) has the Worker generate
 *          the secret (32 random bytes, hex) and store it without ever returning it: the App
 *          Store Connect connector's "register webhook" control then opens it and hands it to
 *          Apple (P5-02). No Distribution code may write a credential, so generation lives here.
 *          `pin` (a kind in `OUTLET_CREDENTIAL_PINS` only, e.g. an `asc-api-key`'s App Store
 *          Connect app id) records the operator's pin: the one app the credential's connector may
 *          read and act on. Beside a `value` it is set with the value; ALONE (`{kind, pin}`, no
 *          `value`, no `generate`) it re-pins a stored credential without touching its value.
 *   DELETE /api/products/<slug>/outlet-credentials/<id>
 *
 * Writes are audited as `outlet_credential.set` / `outlet_credential.delete` with the session's
 * actor, exactly as `secret.set` is; a write that changes a pin adds one `outlet_credential.pin`
 * row naming the old and the new pin. The list answers `pins` (kind → the metadata field its pin
 * is stored under) so the console can show and edit pins without knowing the kinds. This file, the Distribution service and
 * `core/outletTokens.ts` are the only importers of `core/outletCredentials` the reach test
 * allows, and this is the only file outside the owner it lets name `putOutletCredential` or
 * `deleteOutletCredential` — and this one never opens a value: it seals, lists metadata and
 * deletes.
 *
 * A-16: a pin naming an app that a platform admin assigned to ANOTHER product through the
 * platform store connection (`platform_credential_pins`) is refused (409 `app_assigned_elsewhere`),
 * so a product's own key cannot be aimed at an app the team key serves for another product.
 * `planOwnRepins` is the same audited pin path, planned as statements for the platform
 * store-connections handler's atomic assignment when the product holds keys of its own.
 *
 * The dispatcher has already required a platform-admin session (`canAdminProduct`). The check is
 * repeated here on purpose: "written only by a platform admin" is the custody rule, and it must
 * not quietly widen the day a product-level admin role exists.
 */

import type { Env } from "../../env.js";
import type { Db, DbStatement } from "../../db/types.js";
import { auditStatement } from "../../repo.js";
import { randomId } from "../../crypto.js";
import { ErrorCode } from "../../core/errors.js";
import {
  deleteOutletCredential,
  isOutletCredentialId,
  isOutletCredentialKind,
  isOutletId,
  listOutletCredentials,
  OUTLET_CREDENTIAL_KINDS,
  OUTLET_CREDENTIAL_PINS,
  pinOutletCredential,
  planOutletCredentialRepin,
  putOutletCredential,
  validateOutletCredentialPin,
  type OutletCredentialKind,
  type OutletCredentialPinChange,
} from "../../core/outletCredentials.js";
import {
  platformCredentialForKind,
  platformPinHolder,
} from "../../core/platformCredentials.js";
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
      pins: Object.fromEntries(
        Object.entries(OUTLET_CREDENTIAL_PINS).map(([kind, spec]) => [
          kind,
          { field: spec.field, label: spec.label },
        ]),
      ),
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
  // A-16: the app this pin names may already be served to another product by the platform key.
  if (body.pin !== undefined) {
    const platformId = platformCredentialForKind(body.kind);
    const p = validateOutletCredentialPin(body.kind, body.pin);
    if (platformId && p.ok) {
      const holder = await platformPinHolder(db, platformId, p.value);
      if (holder !== null && holder !== slug)
        return err(
          409,
          "app_assigned_elsewhere",
          `${p.value} is assigned to product ${holder} through the platform store connection; unassign it there first`,
          { fields: ["pin"], product: holder },
        );
    }
  }
  const auditPin = (change: OutletCredentialPinChange | null) =>
    change
      ? audit(
          db,
          slug,
          session,
          now,
          "outlet_credential.pin",
          { kind: "outlet_credential", id },
          `Pinned outlet credential ${id} (${body.kind}) to ${change.field} ${change.after} (was ${change.before ?? "unpinned"})`,
        )
      : Promise.resolve();

  // A pin alone re-pins a stored credential; its value is not touched (nor needed).
  if (
    body.value === undefined &&
    body.generate === undefined &&
    body.pin !== undefined
  ) {
    const pinned = await pinOutletCredential(db, {
      product: slug,
      credentialId: id,
      kind: body.kind,
      pin: body.pin,
    });
    if (!pinned.ok) {
      if (pinned.status === 404) return notFound();
      return err(pinned.status, ErrorCode.BadRequest, pinned.message, {
        fields: [pinned.field],
      });
    }
    await auditPin(pinned.pinChange);
    return adminJson({ ok: true, id });
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
    ...(body.pin !== undefined ? { pin: body.pin } : {}),
    actor: session.sub,
    now,
  });
  if (!result.ok) {
    return err(result.status, ErrorCode.BadRequest, result.message, {
      fields: [
        result.field === "id" ||
        result.field === "kind" ||
        result.field === "pin"
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
  await auditPin(result.pinChange);
  // NEVER echo the value, its metadata or anything derived from it — the id only.
  return adminJson({ ok: true, id });
}

/**
 * Plan the re-pin of every active credential of `kind` the product holds of its own to `pin`
 * (A-16's app assignment): the `outlet_credential.pin` updates and their audit rows, as statements
 * for the caller's ONE atomic batch, through the same pin field and audit action as a pin-only PUT.
 * A key from another store account than the platform's (`account` says `different`) is refused,
 * never silently re-pinned; one whose account cannot be told (`unknown`) is skipped and reported.
 */
export async function planOwnRepins(
  db: Db,
  slug: string,
  session: AdminSession,
  now: number,
  kind: OutletCredentialKind,
  pin: string,
  account: Parameters<typeof planOutletCredentialRepin>[4],
): Promise<{
  writes: DbStatement[];
  repinned: string[];
  skipped: Array<{ id: string; reason: string }>;
  refused: Array<{ id: string; reason: string }>;
}> {
  const plan = await planOutletCredentialRepin(db, slug, kind, pin, account);
  const writes = [...plan.writes];
  for (const c of plan.changes)
    writes.push(
      auditStatement({
        product: slug,
        id: randomId("aud"),
        at: now,
        actor_sub: session.sub,
        actor_name: session.name,
        actor_email: session.email,
        action: "outlet_credential.pin",
        target_kind: "outlet_credential",
        target_id: c.id,
        parent_id: null,
        summary: `Pinned outlet credential ${c.id} (${kind}) to ${c.field} ${pin} (was ${c.before ?? "unpinned"}) by a platform store-connection assignment`,
      }),
    );
  return {
    writes,
    repinned: plan.changes.map((c) => c.id),
    skipped: plan.skipped,
    refused: plan.refused,
  };
}
