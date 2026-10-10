/// <reference types="@cloudflare/workers-types" />

/**
 * Account → Profile's routes (PX-W16; PORTAL.md §4.30, G32, G33). Session-authenticated by the
 * portal cookie like every `/api/*` route below `requireSession`; the mutations need the
 * `X-PKey-Portal-CSRF` header, which `handlePortalApi` checks before dispatching here.
 *
 *   GET   /api/me/profile          the profile: name and picture with their sources and explicit
 *                                  flags, the locale, what each sign-in method supplied, and the
 *                                  person's own birth date with its source (I-33: the one route
 *                                  that ever answers it)
 *   PATCH /api/me/profile          an explicit choice: a typed name or a method's name; Initials,
 *                                  a method's picture or an upload; a birth date, or `null` to
 *                                  remove it
 *   POST  /api/me/profile/picture  an upload (PNG or JPEG, at most 5 MB), re-encoded and kept
 *                                  for a day until a PATCH puts it to use
 *
 * The rules (follow until chosen, explicit choices stick) and the storage live in
 * `card/profile.ts` and `card/avatars.ts`.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../env.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { sniffContentType, SNIFF_BYTES } from "../../../core/sniff.js";
import {
  AVATAR_ASSET_PATTERN,
  AVATAR_UPLOAD_MAX_BYTES,
  avatarView,
  prunePendingUploads,
  readBodyCapped,
  storeAvatar,
  UPLOAD_TYPES,
} from "../card/avatars.js";
import {
  profileView,
  updateProfile,
  type ProfileChange,
  type ProfileChangeRefusal,
} from "../card/profile.js";
import { err, notFound, portalJson, requireActionRateLimit } from "./api.js";
import { portalAudit } from "./repo.js";
import type { PortalSession } from "./session.js";

/** Uploads per account per hour (a re-encode and four writes each). */
export const AVATAR_UPLOADS_PER_HOUR = 10;
/** Profile edits per account and client per minute. */
export const PROFILE_EDITS_PER_MINUTE = 30;
/** The largest PATCH body read. */
const PATCH_MAX_BYTES = 4096;
/** The longest typed name read before it is made safe (it is then cut to 64 code points). */
const TYPED_NAME_MAX = 256;
/** A sign-in method's id, as `account_links.id` holds it. */
const LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Refusals answer a registered code (`conformance/parity/errors.json`: `bad_request`,
 * `not_found`, `body_too_large`) with `reason` naming the case for the profile editor, and a
 * message.
 */
const CHANGE_REFUSALS: Record<
  ProfileChangeRefusal,
  { status: number; body: { error: string; reason: string; message: string } }
> = {
  invalid_name: {
    status: 400,
    body: {
      error: "bad_request",
      reason: "invalid_name",
      message: "Enter a name.",
    },
  },
  invalid_birthdate: {
    status: 400,
    body: {
      error: "bad_request",
      reason: "invalid_birthdate",
      message: "Enter a date from 1900 to today.",
    },
  },
  unknown_source: {
    status: 404,
    body: {
      error: "not_found",
      reason: "unknown_source",
      message: "That sign-in method isn't on this account.",
    },
  },
  no_name: {
    status: 400,
    body: {
      error: "bad_request",
      reason: "no_name",
      message: "That sign-in method didn't share a name.",
    },
  },
  no_picture: {
    status: 400,
    body: {
      error: "bad_request",
      reason: "no_picture",
      message: "That sign-in method didn't share a picture.",
    },
  },
  unknown_upload: {
    status: 404,
    body: {
      error: "not_found",
      reason: "unknown_upload",
      message: "That upload has expired. Upload the picture again.",
    },
  },
};

/** The upload's own refusals, likewise. */
const UPLOAD_REFUSALS = {
  tooLarge: {
    error: "body_too_large",
    reason: "too_large",
    message: "Use a picture of 5 MB or less.",
  },
  patchTooLarge: {
    error: "body_too_large",
    reason: "too_large",
    message: "Send at most 4 KB.",
  },
  unsupported: {
    error: "bad_request",
    reason: "unsupported_type",
    message: "Use a PNG or JPEG picture.",
  },
  unreadable: {
    error: "bad_request",
    reason: "unreadable_image",
    message: "We couldn't read that picture. Try another PNG or JPEG.",
  },
} as const;

/** The PATCH body as a change, or the reason it is not one. */
export function parseProfileChange(
  body: unknown,
): { ok: true; change: ProfileChange } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, message: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter(
    (k) =>
      k !== "name" && k !== "nameFrom" && k !== "picture" && k !== "birthdate",
  );
  if (unknown.length > 0)
    return { ok: false, message: `Unknown field: ${unknown[0]}.` };
  const change: ProfileChange = {};
  if (b.name !== undefined && b.nameFrom !== undefined)
    return { ok: false, message: "Send name or nameFrom, not both." };
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.length > TYPED_NAME_MAX)
      return { ok: false, message: "name must be a string." };
    change.name = { typed: b.name };
  }
  if (b.nameFrom !== undefined) {
    if (typeof b.nameFrom !== "string" || !LINK_ID.test(b.nameFrom))
      return { ok: false, message: "nameFrom must be a sign-in method id." };
    change.name = { from: b.nameFrom };
  }
  if (b.picture !== undefined) {
    const p = b.picture;
    if (p === "initials") change.picture = { initials: true };
    else if (
      p &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      Object.keys(p).length === 1
    ) {
      const { from, upload } = p as { from?: unknown; upload?: unknown };
      if (typeof from === "string" && LINK_ID.test(from))
        change.picture = { from };
      else if (typeof upload === "string" && AVATAR_ASSET_PATTERN.test(upload))
        change.picture = { upload };
    }
    if (!change.picture)
      return {
        ok: false,
        message:
          'picture must be "initials", {"from": <method id>} or {"upload": <asset>}.',
      };
  }
  if (b.birthdate !== undefined) {
    // The date itself is checked against the clock in `updateProfile` (`invalid_birthdate`).
    if (b.birthdate !== null && typeof b.birthdate !== "string")
      return {
        ok: false,
        message: 'birthdate must be "YYYY-MM-DD" or null.',
      };
    change.birthdate = b.birthdate;
  }
  if (!change.name && !change.picture && change.birthdate === undefined)
    return { ok: false, message: "Nothing to change." };
  return { ok: true, change };
}

async function view(db: Db, accountId: string): Promise<Response> {
  const profile = await profileView(db, accountId);
  return profile ? portalJson({ profile }) : notFound();
}

async function handlePatch(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalProfileEdit",
    now,
    PROFILE_EDITS_PER_MINUTE,
  );
  if (limited) return limited;
  const raw = await readBodyCapped(req.body, PATCH_MAX_BYTES);
  if (raw === "too-large")
    return portalJson(UPLOAD_REFUSALS.patchTooLarge, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return err(400, "bad_request", "Send a JSON object.");
  }
  const parsed = parseProfileChange(body);
  if (!parsed.ok) return err(400, "bad_request", parsed.message);
  const done = await updateProfile(
    env,
    db,
    session.accountId,
    parsed.change,
    now,
  );
  if (!done.ok) {
    const refusal = CHANGE_REFUSALS[done.reason];
    return portalJson(refusal.body, refusal.status);
  }
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.profile.update",
    targetKind: "account",
    // Which values changed, never what they are (a birth date is never audited, I-33).
    summary: [
      parsed.change.name ? "name" : null,
      parsed.change.picture ? "picture" : null,
      parsed.change.birthdate !== undefined ? "birth date" : null,
    ]
      .filter(Boolean)
      .join(" and "),
    now,
  });
  return view(db, session.accountId);
}

async function handleUpload(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  if (!env.BLOBS || !env.IMAGES)
    return err(
      503,
      "unavailable",
      "Picture uploads aren't available right now.",
    );
  // Per ACCOUNT, before a byte is read: the bound on what one account can make us store.
  const allowed = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalAvatarUpload",
      id: session.accountId,
      limit: AVATAR_UPLOADS_PER_HOUR,
      windowSec: 3600,
    },
    now,
  );
  if (!allowed) return err(429, "rate_limited", "too many attempts");
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > AVATAR_UPLOAD_MAX_BYTES) {
    await req.body?.cancel().catch(() => undefined);
    return portalJson(UPLOAD_REFUSALS.tooLarge, 413);
  }
  const bytes = await readBodyCapped(req.body, AVATAR_UPLOAD_MAX_BYTES);
  if (bytes === "too-large") return portalJson(UPLOAD_REFUSALS.tooLarge, 413);
  if (bytes.byteLength === 0)
    return err(400, "bad_request", "No picture was sent.");
  // The bytes decide, never the declared type.
  if (!UPLOAD_TYPES.has(sniffContentType(bytes.subarray(0, SNIFF_BYTES))))
    return portalJson(UPLOAD_REFUSALS.unsupported, 415);
  const stored = await storeAvatar(
    env,
    db,
    { accountId: session.accountId, bytes, origin: "upload" },
    now,
  );
  if (!stored.ok) {
    if (stored.reason === "unreadable")
      return portalJson(UPLOAD_REFUSALS.unreadable, 422);
    return err(
      503,
      "unavailable",
      "Picture uploads aren't available right now.",
    );
  }
  await prunePendingUploads(env, db, session.accountId, stored.asset);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.profile.picture_upload",
    targetKind: "account",
    summary: "Uploaded a picture",
    now,
  });
  return portalJson({ upload: avatarView(stored.asset) }, 201);
}

/** `/api/me/profile[/picture]`, with `rest` the segments after `me`. */
export async function handleProfileApi(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 1) {
    if (req.method === "GET") return view(db, session.accountId);
    if (req.method === "PATCH") return handlePatch(req, env, db, session, now);
    return err(405, "method_not_allowed");
  }
  if (rest.length === 2 && rest[1] === "picture") {
    if (req.method === "POST") return handleUpload(req, env, db, session, now);
    return err(405, "method_not_allowed");
  }
  return notFound();
}
