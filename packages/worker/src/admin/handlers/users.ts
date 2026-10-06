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
import { loadProduct } from "../../core/products.js";
import { appendPlatformEvent } from "../../core/platformEvents.js";
import {
  RELINK_DAILY_ALERT_COUNT,
  deleteProductUserData,
  detachProductUserLicense,
  exportProductUser,
  listProductUsers,
  lookupProductUser,
  productUserDetail,
  relinkLicense,
  undoRelink,
  type RelinkRefusal,
} from "../../services/identity/accounts/productUsers.js";
import type { AccountContext } from "../../services/identity/accounts/links.js";
import { audit } from "../audit.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
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
};

function refused(reason: RelinkRefusal): Response {
  const [status, message] = REFUSALS[reason];
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
      if (result.alert) {
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
