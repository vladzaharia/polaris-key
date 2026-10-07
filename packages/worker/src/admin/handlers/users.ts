/**
 * A product's Users (`/manage/api/products/<slug>/users…`; I-12, S-16 §5.2).
 *
 * A CORE per-product resource, like Devices, and not Identity's `identity/*`: the Polaris Key
 * account is platform-level, licences of every product attach to it, and so every product has a
 * Users page whatever its Identity toggle says. With Identity off a row has no sign-in history,
 * no sessions and no sign-in columns; the page and its actions are otherwise the same.
 *
 *   GET  users                                   paged list (q, cursor, limit)
 *   GET  users/events                            the subject.merged / subject.deleted pull feed
 *   GET  users/<subject>                         one row (an absorbed subject answers mergedInto)
 *   GET  users/<subject>/export                  the subject's product data as JSON (audited)
 *   POST users/<subject>/data/delete             delete the subject's account × product data
 *   GET  users/<subject>/overrides               the subject's account overrides (U-03)
 *   PUT  users/<subject>/overrides               { updates }  edit them (`accountOverrides.ts`)
 *   POST users/<subject>/licenses/<id>/detach    the licence becomes floating
 *   POST users/<subject>/licenses/<id>/relink    { target, reason }   step-up
 *   POST users/relinks/<relinkId>/undo           { reason }           step-up, within 72 hours
 *
 * LX-30 (notes/S-24 §5.5, D20): the relink tool's two holder moves, keyed by the LICENCE so they
 * also reach a licence waiting for its email (no account, so no subject):
 *
 *   POST users/licenses/<id>/make-floating   { reason, confirm, signOutDevices? }  step-up
 *   POST users/licenses/<id>/reassign        { email, name?, reason, confirm }     step-up
 *   GET  users/licenses/<id>/relinks         the licence's moves, newest first, with their undo
 *
 * `confirm` is the typed confirmation (the licence's name, or its id), compared here. Both moves
 * are undone through `users/relinks/<relinkId>/undo`, like a relink.
 *
 * Every row is keyed by this product's pairwise subject. The account id never appears in a
 * response (it never leaves the Worker's Identity and Core code), nor the account's sign-in
 * methods, nor anything of another product: the queries live in Identity's `accounts/productUsers.ts`,
 * which names every field it emits, and they all carry the product.
 *
 * Relink is the recovery path Polaris offers instead of a recovery desk (S-16 §5.4 item 9), so it
 * carries every control the threat model lists: the operator's step-up (an interactive sign-in no
 * older than 5 minutes, `session.authAt`), the target named only by a subject of THIS product, a
 * mandatory reason, an audit row with before and after, notices to both accounts before the move,
 * a 72-hour undo, and an alert in the platform activity when one operator relinks more than
 * `RELINK_DAILY_ALERT_COUNT` times in 24 hours.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { getLicense, listDevicesByLicense } from "../../core/data.js";
import { deauthorizeDeviceAsAdmin } from "../../core/deviceAdmin.js";
import { loadProduct } from "../../core/products.js";
import { appendPlatformEvent } from "../../core/platformEvents.js";
import {
  RELINK_DAILY_ALERT_COUNT,
  deleteProductUserData,
  detachProductUserLicense,
  exportProductUser,
  licenseHolderMoves,
  listProductUsers,
  lookupProductUser,
  makeLicenseFloating,
  productUserDetail,
  reassignLicenseHolder,
  recordDevicesSignedOut,
  relinkLicense,
  undoRelink,
  type HolderMoveResult,
  type RelinkRefusal,
} from "../../services/identity/accounts/productUsers.js";
import type { AccountContext } from "../../services/identity/accounts/links.js";
import { audit } from "../audit.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { WriteChecks } from "../lib/writeChecks.js";
import { handleUserOverrides } from "./accountOverrides.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  isSteppedUp,
  type AdminSession,
} from "../session.js";

const EVENTS_PAGE = 100;

/** A refusal's HTTP status and message (the code is the refusal itself). */
const REFUSALS: Record<RelinkRefusal, [number, string]> = {
  license_not_found: [404, "This user holds no such license of this product."],
  target_not_found: [
    404,
    "No user of this product has that subject. Ask them to sign in to the product, or to get a support code on its page in their Polaris Key account.",
  ],
  same_subject: [409, "That user already holds this license."],
  target_unavailable: [409, "That user's account can't receive licenses."],
  reason_required: [422, "Give a reason of up to 500 characters."],
  conflict: [409, "The license moved in the meantime. Reload and try again."],
  relink_not_found: [404, "No such relink for this product."],
  undo_unavailable: [
    409,
    "This relink can't be undone: it was undone already, the 72 hours have passed, or the license has moved since.",
  ],
  already_floating: [409, "This license is already floating."],
  license_floating: [
    409,
    "This license is floating. Give it a holder with Assign instead.",
  ],
  same_holder: [409, "This license is already assigned to that email."],
  // The two below answer `bad_request` (an existing code) with `fields`; see `refused`.
  confirm_required: [
    400,
    "Type the license's name, or its id when it has none, to confirm.",
  ],
  email_invalid: [422, "Enter a valid email address."],
};

/** Refusals that are a malformed request, answered as `bad_request` with the field named. */
const FIELD_REFUSALS: Partial<
  Record<RelinkRefusal, { fields: string[]; reason?: string }>
> = {
  confirm_required: { fields: ["confirm"], reason: "confirm_required" },
  email_invalid: { fields: ["email"] },
};

function refused(reason: RelinkRefusal): Response {
  const [status, message] = REFUSALS[reason];
  const field = FIELD_REFUSALS[reason];
  if (field)
    return err(status, ErrorCode.BadRequest, message, {
      ...(field.reason ? { reason: field.reason } : {}),
      fields: field.fields,
    });
  return err(status, reason, message);
}

function stepUpRequired(): Response {
  return err(
    403,
    "step_up_required",
    "Sign in again to confirm it's you. Relinking needs a sign-in from the last 5 minutes.",
    { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
  );
}

/** The `users/events` cursor: `<created_at>.<id>`, opaque to the caller. */
function parseEventCursor(raw: string | null): [number, string] | null {
  if (!raw) return null;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{1,64})$/.exec(raw);
  return m ? [Number(m[1]), m[2]!] : null;
}

export async function handleProductUsers(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const product = await loadProduct(env, db, slug);
  if (!product) return notFound();
  const identityOn = product.services.identity?.enabled === true;
  const ctx: AccountContext = {
    db,
    env,
    now,
    origin: new URL(req.url).origin,
  };
  const url = new URL(req.url);
  const [first, second, third, fourth, ...extra] = rest;
  const actor = { sub: session.sub, name: session.name || null };

  // GET users
  if (first === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const page = await listProductUsers(db, slug, {
      identityOn,
      q: url.searchParams.get("q"),
      cursor: url.searchParams.get("cursor"),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    return adminJson({ identityOn, ...page });
  }

  // GET users/events — the pull feed (plans/I-04.md §8 Q8). Oldest first, so a consumer keeps
  // its last cursor and resumes from it.
  if (first === "events" && second === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const cursor = parseEventCursor(url.searchParams.get("cursor"));
    const rows = await db.all<{
      id: string;
      type: string;
      subject: string;
      payload_json: string | null;
      created_at: number;
    }>(
      `SELECT id, type, subject, payload_json, created_at FROM subject_events
        WHERE product = ? ${cursor ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
        ORDER BY created_at, id LIMIT ?`,
      slug,
      ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []),
      EVENTS_PAGE + 1,
    );
    const page = rows.slice(0, EVENTS_PAGE);
    const last = page[page.length - 1];
    return adminJson({
      events: page.map((e) => {
        let payload: unknown = null;
        try {
          payload = e.payload_json ? JSON.parse(e.payload_json) : null;
        } catch {
          payload = null;
        }
        return {
          id: e.id,
          type: e.type,
          subject: e.subject,
          at: e.created_at,
          payload,
        };
      }),
      nextCursor:
        rows.length > EVENTS_PAGE && last
          ? `${last.created_at}.${last.id}`
          : null,
      cursor: last
        ? `${last.created_at}.${last.id}`
        : (url.searchParams.get("cursor") ?? null),
    });
  }

  // POST users/relinks/<id>/undo
  if (first === "relinks") {
    if (!second || third !== "undo" || fourth !== undefined) return notFound();
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!isSteppedUp(session, now)) return stepUpRequired();
    const body = await readBody(req);
    const result = await undoRelink(ctx, {
      product: slug,
      relinkId: second,
      reason: body.reason,
      actor,
    });
    if (!result.ok) return refused(result.reason);
    await audit(
      db,
      slug,
      session,
      now,
      "user.license.relink.undo",
      { kind: "license", id: result.licenseId },
      JSON.stringify({
        relink: second,
        before: result.fromSubject,
        after: result.toSubject,
        reason: typeof body.reason === "string" ? body.reason.trim() : "",
      }),
    );
    return adminJson({
      ok: true,
      licenseId: result.licenseId,
      subject: result.toSubject,
      noticesSent: result.noticesSent,
    });
  }

  // LX-30: users/licenses/<id>/(make-floating | reassign | relinks)
  if (first === "licenses") {
    if (!second || !third || fourth !== undefined) return notFound();
    const licenseId = second;
    if (third === "relinks") {
      if (req.method !== "GET")
        return err(405, ErrorCode.BadRequest, "method not allowed");
      if (!(await getLicense(db, slug, licenseId)))
        return refused("license_not_found");
      return adminJson({
        relinks: await licenseHolderMoves(db, slug, licenseId, now),
      });
    }
    if (third !== "make-floating" && third !== "reassign") return notFound();
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!isSteppedUp(session, now)) return stepUpRequired();
    const body = await readBody(req);
    let result: HolderMoveResult;
    if (third === "make-floating") {
      result = await makeLicenseFloating(ctx, {
        product: slug,
        licenseId,
        reason: body.reason,
        confirm: body.confirm,
        actor,
      });
    } else {
      // The new holder's name and email are free text the signed profile carries.
      const checks = new WriteChecks()
        .text("name", body.name)
        .text("email", body.email)
        .response();
      if (checks) return checks;
      if (
        body.name !== undefined &&
        body.name !== null &&
        typeof body.name !== "string"
      )
        return err(422, ErrorCode.BadRequest, "name must be a string", {
          fields: ["name"],
        });
      result = await reassignLicenseHolder(ctx, {
        product: slug,
        licenseId,
        email: body.email,
        name: body.name,
        reason: body.reason,
        confirm: body.confirm,
        actor,
      });
    }
    if (!result.ok) return refused(result.reason);
    const floating = third === "make-floating";
    const signOut = floating && body.signOutDevices === true;
    // The move and its relink row (the undo) are written; the audit row and the alert follow
    // before any device is touched, so a sign-out that fails partway leaves both in place.
    await audit(
      db,
      slug,
      session,
      now,
      floating ? "user.license.make_floating" : "user.license.reassign",
      { kind: "license", id: licenseId },
      JSON.stringify({
        relink: result.relinkId,
        before: result.before,
        after: result.after,
        reason: typeof body.reason === "string" ? body.reason.trim() : "",
        ...(floating ? { signOutDevices: signOut } : {}),
      }),
    );
    if (result.alert) await relinkAlert(db, session, slug, now);
    const devicesSignedOut = signOut
      ? await signOutLicenseDevices(env, db, session, slug, licenseId, now)
      : 0;
    if (devicesSignedOut > 0)
      await recordDevicesSignedOut(db, slug, result.relinkId, devicesSignedOut);
    return adminJson({
      ok: true,
      relinkId: result.relinkId,
      undoUntil: result.undoUntil,
      noticesSent: result.noticesSent,
      alert: result.alert,
      ...(floating ? { devicesSignedOut } : {}),
    });
  }

  // Everything else is one row: users/<subject>[/…]
  const subject = first;
  const found = await lookupProductUser(db, slug, subject);
  if (found.kind === "not_found") return notFound();
  if (found.kind === "alias") {
    // An absorbed subject (D21): the row is the survivor's. Reads say so; writes refuse.
    if (req.method === "GET" && second === undefined)
      return adminJson({ mergedInto: found.subject });
    return err(409, "subject_merged", "This subject was merged.", {
      mergedInto: found.subject,
    });
  }

  if (second === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const user = await productUserDetail(ctx, slug, found, identityOn);
    return adminJson({ user });
  }

  if (second === "export" && third === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const doc = await exportProductUser(ctx, slug, found, identityOn);
    await audit(
      db,
      slug,
      session,
      now,
      "user.export",
      { kind: "subject", id: found.subject },
      `Exported ${found.subject}'s data for ${slug}`,
    );
    return adminJson(doc, 200, {
      "content-disposition": `attachment; filename="${slug}-${found.subject}.json"`,
    });
  }

  // U-03: the account override layer, on every product (Identity on or off).
  if (second === "overrides" && third === undefined) {
    return handleUserOverrides(
      req,
      env,
      db,
      session,
      {
        slug,
        subject: found.subject,
        configOn: product.services.config?.enabled === true,
      },
      now,
    );
  }

  if (second === "data" && third === "delete" && fourth === undefined) {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const { stores } = await deleteProductUserData(ctx, slug, found.subject);
    await audit(
      db,
      slug,
      session,
      now,
      "user.data.delete",
      { kind: "subject", id: found.subject },
      `Deleted ${found.subject}'s data for ${slug} (${stores.length === 0 ? "no stores" : stores.join(", ")})`,
    );
    return adminJson({ ok: true, stores });
  }

  if (second === "licenses" && third && fourth && extra.length === 0) {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const licenseId = third;
    if (fourth === "detach") {
      const done = await detachProductUserLicense(ctx, slug, found, licenseId);
      if (!done.ok) return refused("license_not_found");
      await audit(
        db,
        slug,
        session,
        now,
        "user.license.detach",
        { kind: "license", id: licenseId },
        JSON.stringify({ before: found.subject, after: null }),
      );
      return adminJson({ ok: true });
    }
    if (fourth === "relink") {
      if (!isSteppedUp(session, now)) return stepUpRequired();
      const body = await readBody(req);
      if (typeof body.target !== "string") return refused("target_not_found");
      const result = await relinkLicense(ctx, {
        product: slug,
        from: found,
        licenseId,
        target: body.target,
        reason: body.reason,
        actor,
      });
      if (!result.ok) return refused(result.reason);
      await audit(
        db,
        slug,
        session,
        now,
        "user.license.relink",
        { kind: "license", id: licenseId },
        JSON.stringify({
          relink: result.relinkId,
          before: result.fromSubject,
          after: result.toSubject,
          reason: typeof body.reason === "string" ? body.reason.trim() : "",
        }),
      );
      if (result.alert) await relinkAlert(db, session, slug, now);
      return adminJson({
        ok: true,
        relinkId: result.relinkId,
        subject: result.toSubject,
        undoUntil: result.undoUntil,
        noticesSent: result.noticesSent,
        alert: result.alert,
      });
    }
  }

  return notFound();
}

/**
 * Make floating's "Also sign out its devices": deauthorize each authorized device of the licence
 * (each audited as `device.deauthorize`, exactly as the Devices tab does). It runs after the move
 * is recorded and audited; the first device that fails stops it, and the answer is how many were
 * signed out, so a partial sign-out is reported rather than turned into an error.
 */
async function signOutLicenseDevices(
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  now: number,
): Promise<number> {
  let n = 0;
  try {
    for (const device of await listDevicesByLicense(db, slug, licenseId)) {
      if (device.status !== "authorized") continue;
      await deauthorizeDeviceAsAdmin({ env, db, session, now }, device);
      n += 1;
    }
  } catch {
    // Stop at the first failure; the count says how far it got.
  }
  return n;
}

/**
 * The platform alert when one operator passes `RELINK_DAILY_ALERT_COUNT` relinks and holder moves
 * in 24 hours (S-16 §5.4 item 9; LX-30 counts Make floating and Reassign… with the relinks).
 */
async function relinkAlert(
  db: Db,
  session: AdminSession,
  slug: string,
  now: number,
): Promise<void> {
  await appendPlatformEvent(db, {
    actor: {
      sub: session.sub,
      name: session.name || null,
      email: session.email || null,
    },
    at: now,
    action: "identity.relink.alert",
    target: { kind: "product", id: slug },
    summary: `${session.name || session.sub} relinked more than ${RELINK_DAILY_ALERT_COUNT} licenses in 24 hours`,
  });
}
