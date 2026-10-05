/**
 * The console's per-product Users page (I-12; S-16 §5.2, §5.4 items 9 and 12, §5.5).
 *
 * Every product has a Users page, whatever its Identity toggle says: licences of any product
 * attach to accounts, so a developer needs to see who holds them. Each row is one PAIRWISE SUBJECT
 * of this product (`ps_…`), never the account. What a row may show, and the only things this
 * module ever reads for a developer:
 *
 *   - this product's licences attached to the subject's account (with the developer's own buyer
 *     email), this product's devices on those licences or signed in with the subject, the
 *     subject's account × product data size, and this product's audit trail for those targets;
 *   - with Identity on: the devices signed in with the subject ("sessions") and this product's
 *     sign-in history, as the method KIND only ("Signed in with Steam"), never the account's
 *     list of sign-in methods;
 *   - a contact email: the licence's buyer email; the account's primary email only when the person
 *     consented to share it with this product (D19); a name only when consented too;
 *   - a merged subject's aliases ("merged from", D21) and the `subject.*` feed (§8 Q8).
 *
 * Never: the global account id (it never leaves the Worker's Identity and Core code), another
 * product's licences, sessions or data, the rest of the Library, the account's links. Every shaper
 * below names the fields it emits; no row is spread into a response.
 *
 * The developer's actions live here too: export the subject's product data (JSON), delete it
 * (through Core's subject-store registry), detach a licence, and RELINK a licence to another
 * subject of this product with a 72-hour undo. The admin layer (`admin/handlers/users.ts`) owns
 * the step-up check; this module owns the rules of the move.
 */

import {
  PAIRWISE_SUBJECT_PATTERN,
  accountForSubject,
  licenseAccountId,
  resolveSubject,
} from "../../../core/accountSubjects.js";
import {
  runSubjectDelete,
  runSubjectExport,
  subjectDataSize,
} from "../../../core/subjectHooks.js";
import { getProduct } from "../../../core/data.js";
import { randomId, type Db } from "../../../core/platform.js";
import { sendSecurityNotice } from "../portal/email.js";
import {
  licenseRelinkUndoneNotice,
  licenseRelinkedAwayNotice,
  licenseRelinkedInNotice,
} from "../portal/notices.js";
import { detachLicense, reassignLicense } from "./claim.js";
import type { AccountContext } from "./links.js";
import { getAccountRow } from "./repo.js";
import { PRODUCT_SIGNIN_ACTION, signInKindOf } from "./signIn.js";

/** How long a relink can be undone (S-16 §5.4 item 9: 72 hours). */
export const RELINK_UNDO_SECONDS = 72 * 60 * 60;
/** Relinks by one operator in 24 hours above which every further one raises an alert. */
export const RELINK_DAILY_ALERT_COUNT = 5;
/** The longest reason an operator may give for a relink or its undo. */
export const RELINK_REASON_MAX = 500;
export const USERS_PAGE_DEFAULT = 50;
export const USERS_PAGE_MAX = 200;
/** How much of the product's audit trail a row shows. */
const USER_AUDIT_LIMIT = 100;
const USER_SIGNIN_LIMIT = 50;
const SEARCH_MAX = 128;

// ── Consent ──────────────────────────────────────────────────────────────────────────────────

/**
 * The profile claims an account consented to share with one product on "Continue to <App>"
 * (`account_product_grants.claims_json`, written by I-07/I-08). Read leniently, because the writer
 * lands after this reader: a JSON array of claim names, an object of `claim: true`, or
 * `{ "claims": [...] }`. Anything else is no consent.
 */
export function consentedClaims(json: string | null | undefined): Set<string> {
  if (!json) return new Set();
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return new Set();
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.claims)) v = o.claims;
    else
      return new Set(
        Object.entries(o)
          .filter(([, on]) => on === true)
          .map(([k]) => k),
      );
  }
  return Array.isArray(v)
    ? new Set(v.filter((c): c is string => typeof c === "string"))
    : new Set();
}

/** The row's contact: the buyer email first, the consented primary email otherwise. */
function contactOf(
  buyerEmail: string | null,
  primaryEmail: string | null,
  claims: Set<string>,
): { email: string | null; source: "license" | "consented" | null } {
  if (buyerEmail) return { email: buyerEmail, source: "license" };
  if (primaryEmail && claims.has("email"))
    return { email: primaryEmail, source: "consented" };
  return { email: null, source: null };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────

export interface ProductUserSummary {
  subject: string;
  createdAt: number;
  contactEmail: string | null;
  contactSource: "license" | "consented" | null;
  licenses: number;
  devices: number;
  /** Identity on only (otherwise absent): devices signed in with the subject. */
  signedInDevices?: number;
  /** Identity on only (otherwise absent): the last sign-in through this product. */
  lastSignInAt?: number | null;
  /** How many absorbed subjects resolve to this one (D21). */
  mergedFrom: number;
}

export interface ProductUsersPage {
  users: ProductUserSummary[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: number, subject: string): string {
  return btoa(JSON.stringify([createdAt, subject]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(raw: string | null): [number, string] | null {
  if (!raw || raw.length > 256) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const v = JSON.parse(
      atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
    ) as unknown;
    if (
      Array.isArray(v) &&
      typeof v[0] === "number" &&
      typeof v[1] === "string" &&
      PAIRWISE_SUBJECT_PATTERN.test(v[1])
    )
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  return null;
}

/** Devices of the product that belong to a subject row: on its licences, or signed in with it. */
const ROW_DEVICES = `
  (SELECT COUNT(*) FROM devices d
    WHERE d.product = s.product AND d.status = 'authorized'
      AND (d.subject = s.subject
           OR d.subject IN (SELECT alias FROM account_product_subject_aliases x
                             WHERE x.product = s.product AND x.subject = s.subject)
           OR (d.license_id != '' AND d.license_id IN (SELECT id FROM licenses l
                             WHERE l.product = s.product AND l.account_id = s.account_id))))`;

const ROW_SIGNED_IN = `
  (SELECT COUNT(*) FROM devices d
    WHERE d.product = s.product AND d.status = 'authorized'
      AND (d.subject = s.subject
           OR d.subject IN (SELECT alias FROM account_product_subject_aliases x
                             WHERE x.product = s.product AND x.subject = s.subject)))`;

const ROW_LICENSES = `
  (SELECT COUNT(*) FROM licenses l WHERE l.product = s.product AND l.account_id = s.account_id)`;

const ROW_LAST_SIGNIN = `
  (SELECT MAX(pa.at) FROM portal_audit pa
    WHERE pa.account_id = s.account_id AND pa.product = s.product AND pa.action = '${PRODUCT_SIGNIN_ACTION}')`;

/**
 * One page of the product's users, newest subject first. A subject is listed once it holds a
 * licence of the product, a device signed in with it, or a sign-in through the product: a
 * subject minted only for a support code stays unlisted, so that action cannot flood a console
 * (S-16 §5.2). `q` matches a subject prefix, a licence id, or a buyer email (the developer's own
 * records), never the account's own email.
 */
export async function listProductUsers(
  db: Db,
  product: string,
  opts: {
    identityOn: boolean;
    q?: string | null;
    cursor?: string | null;
    limit?: number;
  },
): Promise<ProductUsersPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? USERS_PAGE_DEFAULT)),
    USERS_PAGE_MAX,
  );
  const where: string[] = ["s.product = ?"];
  const params: Array<string | number> = [product];
  const cursor = decodeCursor(opts.cursor ?? null);
  if (cursor) {
    where.push("(s.created_at < ? OR (s.created_at = ? AND s.subject > ?))");
    params.push(cursor[0], cursor[0], cursor[1]);
  }
  const q = (opts.q ?? "").trim().slice(0, SEARCH_MAX);
  if (q) {
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(s.subject LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM licenses l WHERE l.product = s.product AND l.account_id = s.account_id
                     AND (l.id = ? OR lower(l.email) LIKE lower(?) ESCAPE '\\')))`,
    );
    params.push(like, q, like);
  }
  const listed = opts.identityOn
    ? `(${ROW_LICENSES} > 0 OR ${ROW_SIGNED_IN} > 0 OR ${ROW_LAST_SIGNIN} IS NOT NULL)`
    : `(${ROW_LICENSES} > 0 OR ${ROW_SIGNED_IN} > 0)`;
  where.push(listed);

  const rows = await db.all<{
    subject: string;
    created_at: number;
    licenses: number;
    devices: number;
    signed_in: number;
    last_signin: number | null;
    merged: number;
    buyer_email: string | null;
    primary_email: string | null;
    claims_json: string | null;
  }>(
    `SELECT s.subject, s.created_at,
            ${ROW_LICENSES} AS licenses,
            ${ROW_DEVICES} AS devices,
            ${ROW_SIGNED_IN} AS signed_in,
            ${ROW_LAST_SIGNIN} AS last_signin,
            (SELECT COUNT(*) FROM account_product_subject_aliases x
              WHERE x.product = s.product AND x.subject = s.subject) AS merged,
            (SELECT l.email FROM licenses l
              WHERE l.product = s.product AND l.account_id = s.account_id AND l.email IS NOT NULL
              ORDER BY l.activated_at, l.id LIMIT 1) AS buyer_email,
            a.primary_email AS primary_email,
            g.claims_json AS claims_json
       FROM account_product_subjects s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN account_product_grants g ON g.account_id = s.account_id AND g.product = s.product
      WHERE ${where.join(" AND ")}
      ORDER BY s.created_at DESC, s.subject ASC
      LIMIT ?`,
    ...params,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const users = page.map((r): ProductUserSummary => {
    const contact = contactOf(
      r.buyer_email,
      r.primary_email,
      consentedClaims(r.claims_json),
    );
    return {
      subject: r.subject,
      createdAt: r.created_at,
      contactEmail: contact.email,
      contactSource: contact.source,
      licenses: r.licenses,
      devices: r.devices,
      ...(opts.identityOn
        ? { signedInDevices: r.signed_in, lastSignInAt: r.last_signin }
        : {}),
      mergedFrom: r.merged,
    };
  });
  const last = page[page.length - 1];
  return {
    users,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(last.created_at, last.subject)
        : null,
  };
}

// ── One row ──────────────────────────────────────────────────────────────────────────────────

export interface ProductUserLicense {
  id: string;
  name: string | null;
  email: string | null;
  tierId: string | null;
  status: string;
  activatedAt: number;
  expiresAt: number | null;
}

export interface ProductUserDevice {
  deviceId: string;
  label: string | null;
  status: string;
  platform: string | null;
  appVersion: string | null;
  licenseId: string | null;
  lastSeen: number;
  /** Identity on only: the device is signed in with this subject (a session). */
  signedIn?: boolean;
}

export interface ProductUserRelink {
  id: string;
  licenseId: string;
  direction: "in" | "out";
  /** The other side of the move, as a subject of this product (`null` after a deletion). */
  otherSubject: string | null;
  reason: string;
  actorName: string | null;
  createdAt: number;
  undoUntil: number;
  undoneAt: number | null;
  /** True while the undo is still possible (window open, not undone, licence where it was put). */
  undoable: boolean;
}

export interface ProductUserDetail {
  subject: string;
  createdAt: number;
  identityOn: boolean;
  contact: { email: string | null; source: "license" | "consented" | null };
  /** The consented name, when the person shared it with this product. */
  name: string | null;
  mergedFrom: Array<{ subject: string; mergedAt: number }>;
  licenses: ProductUserLicense[];
  devices: ProductUserDevice[];
  data: { bytes: number; stores: Array<{ name: string; bytes: number }> };
  /** Identity on only. */
  signIns?: Array<{ at: number; method: string | null }>;
  events: Array<{
    id: string;
    type: string;
    at: number;
    alias?: string;
    licenseIds?: string[];
  }>;
  relinks: ProductUserRelink[];
  audit: Array<{
    id: string;
    at: number;
    action: string;
    actorName: string | null;
    targetKind: string | null;
    targetId: string | null;
    summary: string | null;
  }>;
}

export type UserLookup =
  | { kind: "found"; subject: string; accountId: string }
  /** An absorbed subject: the console redirects to the survivor's row (D21). */
  | { kind: "alias"; subject: string }
  | { kind: "not_found" };

/**
 * A developer-held subject → the row it names. INTERNAL: `accountId` stays in the Worker. A
 * subject of ANOTHER product is not found here, whatever account it belongs to.
 */
export async function lookupProductUser(
  db: Db,
  product: string,
  subject: string,
): Promise<UserLookup> {
  if (!PAIRWISE_SUBJECT_PATTERN.test(subject)) return { kind: "not_found" };
  const canonical = await resolveSubject(db, product, subject);
  if (!canonical) return { kind: "not_found" };
  if (canonical !== subject) return { kind: "alias", subject: canonical };
  const accountId = await accountForSubject(db, product, canonical);
  if (!accountId) return { kind: "not_found" };
  return { kind: "found", subject: canonical, accountId };
}

async function subjectAliases(
  db: Db,
  product: string,
  subject: string,
): Promise<Array<{ alias: string; merged_at: number }>> {
  return db.all<{ alias: string; merged_at: number }>(
    `SELECT alias, merged_at FROM account_product_subject_aliases
      WHERE product = ? AND subject = ? ORDER BY merged_at, alias`,
    product,
    subject,
  );
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** The row: everything the page shows for one subject, for this product only. */
export async function productUserDetail(
  ctx: AccountContext,
  product: string,
  found: { subject: string; accountId: string },
  identityOn: boolean,
): Promise<ProductUserDetail> {
  const { db, env, now } = ctx;
  const { subject, accountId } = found;
  const subjectRow = await db.first<{ created_at: number }>(
    "SELECT created_at FROM account_product_subjects WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  const aliases = await subjectAliases(db, product, subject);
  const subjects = [subject, ...aliases.map((a) => a.alias)];

  const licenses = await db.all<{
    id: string;
    name: string | null;
    email: string | null;
    tier_id: string | null;
    status: string;
    activated_at: number;
    expires_at: number | null;
  }>(
    `SELECT id, name, email, tier_id, status, activated_at, expires_at
       FROM licenses WHERE product = ? AND account_id = ? ORDER BY activated_at, id`,
    product,
    accountId,
  );
  const licenseIds = licenses.map((l) => l.id);

  const devices = await db.all<{
    device_id: string;
    label: string | null;
    status: string;
    platform: string | null;
    app_version: string | null;
    license_id: string;
    last_seen: number;
    subject: string | null;
  }>(
    `SELECT device_id, label, status, platform, app_version, license_id, last_seen, subject
       FROM devices
      WHERE product = ?
        AND (subject IN (${placeholders(subjects.length)})
             ${licenseIds.length ? `OR license_id IN (${placeholders(licenseIds.length)})` : ""})
      ORDER BY last_seen DESC, device_id`,
    product,
    ...subjects,
    ...licenseIds,
  );

  const grant = await db.first<{ claims_json: string | null }>(
    "SELECT claims_json FROM account_product_grants WHERE account_id = ? AND product = ?",
    accountId,
    product,
  );
  const claims = consentedClaims(grant?.claims_json);
  const account = await getAccountRow(db, accountId);
  const buyer = licenses.find((l) => l.email)?.email ?? null;

  const data = await subjectDataSize({ db, env, now }, { product, subject });

  const signIns = identityOn
    ? (
        await db.all<{ at: number; summary: string | null }>(
          `SELECT at, summary FROM portal_audit
            WHERE account_id = ? AND product = ? AND action = ?
            ORDER BY at DESC LIMIT ?`,
          accountId,
          product,
          PRODUCT_SIGNIN_ACTION,
          USER_SIGNIN_LIMIT,
        )
      ).map((r) => ({ at: r.at, method: signInKindOf(r.summary) }))
    : undefined;

  const events = (
    await db.all<{
      id: string;
      type: string;
      created_at: number;
      payload_json: string | null;
    }>(
      `SELECT id, type, created_at, payload_json FROM subject_events
        WHERE product = ? AND subject IN (${placeholders(subjects.length)})
        ORDER BY created_at DESC, id LIMIT 50`,
      product,
      ...subjects,
    )
  ).map((e) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>;
    } catch {
      // an unreadable payload shows the event without detail
    }
    return {
      id: e.id,
      type: e.type,
      at: e.created_at,
      ...(typeof payload.alias === "string" ? { alias: payload.alias } : {}),
      ...(Array.isArray(payload.licenseIds)
        ? {
            licenseIds: payload.licenseIds.filter(
              (x): x is string => typeof x === "string",
            ),
          }
        : {}),
    };
  });

  const relinks = await relinksForSubjects(db, product, subjects, now);

  const deviceIds = devices.map((d) => d.device_id);
  const targets = [...subjects, ...licenseIds, ...deviceIds];
  const audit = (
    await db.all<{
      id: string;
      at: number;
      action: string;
      actor_name: string | null;
      target_kind: string | null;
      target_id: string | null;
      summary: string | null;
    }>(
      `SELECT id, at, action, actor_name, target_kind, target_id, summary FROM audit
        WHERE product = ? AND target_id IN (${placeholders(targets.length)})
        ORDER BY at DESC, id LIMIT ?`,
      product,
      ...targets,
      USER_AUDIT_LIMIT,
    )
  ).map((a) => ({
    id: a.id,
    at: a.at,
    action: a.action,
    actorName: a.actor_name,
    targetKind: a.target_kind,
    targetId: a.target_id,
    summary: a.summary,
  }));

  return {
    subject,
    createdAt: subjectRow?.created_at ?? 0,
    identityOn,
    contact: contactOf(buyer, account?.primary_email ?? null, claims),
    name: claims.has("name") ? (account?.display_name ?? null) : null,
    mergedFrom: aliases.map((a) => ({
      subject: a.alias,
      mergedAt: a.merged_at,
    })),
    licenses: licenses.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      tierId: l.tier_id,
      status: l.status,
      activatedAt: l.activated_at,
      expiresAt: l.expires_at,
    })),
    devices: devices.map((d) => ({
      deviceId: d.device_id,
      label: d.label,
      status: d.status,
      platform: d.platform,
      appVersion: d.app_version,
      licenseId: d.license_id === "" ? null : d.license_id,
      lastSeen: d.last_seen,
      ...(identityOn
        ? { signedIn: d.subject !== null && subjects.includes(d.subject) }
        : {}),
    })),
    data: { bytes: data.total, stores: data.stores },
    ...(signIns ? { signIns } : {}),
    events,
    relinks,
    audit,
  };
}

/**
 * The subject's product data, as one JSON document (the console's per-subject export). Carries
 * the row and every registered store's export; never the account id.
 */
export async function exportProductUser(
  ctx: AccountContext,
  product: string,
  found: { subject: string; accountId: string },
  identityOn: boolean,
): Promise<Record<string, unknown>> {
  const detail = await productUserDetail(ctx, product, found, identityOn);
  const stores = await runSubjectExport(
    { db: ctx.db, env: ctx.env, now: ctx.now },
    { product, subject: found.subject },
  );
  return {
    exportedAt: ctx.now,
    product,
    ...detail,
    stores,
  };
}

/**
 * Delete the subject's account × product data for this product: every registered store's
 * `delete` (managed config overrides, Cloud Sync). The subject, its licences and the account are
 * untouched: a developer can never delete the account (S-16 §5.2). Answers the stores it ran.
 */
export async function deleteProductUserData(
  ctx: AccountContext,
  product: string,
  subject: string,
): Promise<{ stores: string[] }> {
  const ran = await subjectDataSize(
    { db: ctx.db, env: ctx.env, now: ctx.now },
    { product, subject },
  );
  await runSubjectDelete(
    { db: ctx.db, env: ctx.env, now: ctx.now },
    { product, subject },
  );
  return { stores: ran.stores.map((s) => s.name) };
}

/** Detach one of the subject's licences of this product: it becomes floating. */
export async function detachProductUserLicense(
  ctx: AccountContext,
  product: string,
  found: { accountId: string },
  licenseId: string,
): Promise<{ ok: boolean }> {
  return detachLicense(ctx, {
    accountId: found.accountId,
    product,
    licenseId,
    byDeveloper: true,
  });
}

// ── Relink ───────────────────────────────────────────────────────────────────────────────────

interface RelinkRow {
  product: string;
  id: string;
  license_id: string;
  from_account_id: string | null;
  to_account_id: string | null;
  from_subject: string | null;
  to_subject: string;
  reason: string;
  actor_sub: string;
  actor_name: string | null;
  notices_sent: number;
  created_at: number;
  undo_until: number;
  undone_at: number | null;
  undone_by: string | null;
  undo_reason: string | null;
}

async function relinksForSubjects(
  db: Db,
  product: string,
  subjects: string[],
  now: number,
): Promise<ProductUserRelink[]> {
  const rows = await db.all<RelinkRow>(
    `SELECT * FROM license_relinks
      WHERE product = ?
        AND (from_subject IN (${placeholders(subjects.length)})
             OR to_subject IN (${placeholders(subjects.length)}))
      ORDER BY created_at DESC, id LIMIT 50`,
    product,
    ...subjects,
    ...subjects,
  );
  const out: ProductUserRelink[] = [];
  for (const r of rows) {
    const incoming = subjects.includes(r.to_subject);
    out.push({
      id: r.id,
      licenseId: r.license_id,
      direction: incoming ? "in" : "out",
      otherSubject: incoming ? r.from_subject : r.to_subject,
      reason: r.reason,
      actorName: r.actor_name,
      createdAt: r.created_at,
      undoUntil: r.undo_until,
      undoneAt: r.undone_at,
      undoable: await relinkUndoable(db, r, now),
    });
  }
  return out;
}

async function relinkUndoable(
  db: Db,
  r: RelinkRow,
  now: number,
): Promise<boolean> {
  if (r.undone_at !== null || now >= r.undo_until) return false;
  const owner = await licenseAccountId(db, r.product, r.license_id);
  return owner !== null && owner === r.to_account_id;
}

/** Why a relink or its undo was refused. Codes the admin layer maps to its error bodies. */
export type RelinkRefusal =
  /** The licence is not this product's, or not held by the row's subject. */
  | "license_not_found"
  /** The target is not a pairwise subject of this product (never a lookup across accounts). */
  | "target_not_found"
  /** The target is the subject that already holds the licence. */
  | "same_subject"
  /** The target account is disabled or being deleted. */
  | "target_unavailable"
  /** A reason is required (1–500 characters). */
  | "reason_required"
  /** Someone moved the licence in the meantime. */
  | "conflict"
  /** The relink does not exist for this product. */
  | "relink_not_found"
  /** Undone already, past the 72 hours, or the licence has moved on since. */
  | "undo_unavailable";

export type RelinkResult =
  | {
      ok: true;
      relinkId: string;
      fromSubject: string;
      toSubject: string;
      undoUntil: number;
      noticesSent: number;
      /** This operator passed the daily relink count: an alert was raised. */
      alert: boolean;
    }
  | { ok: false; reason: RelinkRefusal };

/** Trim, cap and validate a reason; `null` when it is missing or too long. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters become spaces: the reason is shown in the console and the audit trail.
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (v.length === 0 || v.length > RELINK_REASON_MAX) return null;
  return v;
}

/** How many relinks (not undos) this operator made in the last 24 hours, on every product. */
export async function operatorRelinksToday(
  db: Db,
  actorSub: string,
  now: number,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM license_relinks WHERE actor_sub = ? AND created_at > ?",
    actorSub,
    now - 24 * 60 * 60,
  );
  return row?.n ?? 0;
}

/**
 * Relink one of the row subject's licences to another subject of THIS product (S-16 §5.4 item 9).
 * The target is named only by its pairwise subject; it must already exist for this product (the
 * person signed in through the product, or asked for a support code on its portal page). Both
 * accounts are notified, at every verified email, BEFORE the move takes effect; the move is
 * recorded with its reason and actor, and can be undone for 72 hours. The caller has checked the
 * operator's step-up and writes the console audit row.
 */
export async function relinkLicense(
  ctx: AccountContext,
  args: {
    product: string;
    from: { subject: string; accountId: string };
    licenseId: string;
    target: string;
    reason: unknown;
    actor: { sub: string; name: string | null };
  },
): Promise<RelinkResult> {
  const { db, env, now } = ctx;
  const reason = cleanReason(args.reason);
  if (!reason) return { ok: false, reason: "reason_required" };
  if (
    (await licenseAccountId(db, args.product, args.licenseId)) !==
    args.from.accountId
  )
    return { ok: false, reason: "license_not_found" };
  const target = await lookupProductUser(db, args.product, args.target.trim());
  const toSubject =
    target.kind === "found"
      ? target.subject
      : target.kind === "alias"
        ? target.subject
        : null;
  if (!toSubject) return { ok: false, reason: "target_not_found" };
  const toAccountId = await accountForSubject(db, args.product, toSubject);
  if (!toAccountId) return { ok: false, reason: "target_not_found" };
  if (toAccountId === args.from.accountId)
    return { ok: false, reason: "same_subject" };
  const toAccount = await getAccountRow(db, toAccountId);
  if (!toAccount || toAccount.status !== "active")
    return { ok: false, reason: "target_unavailable" };

  // The notices go out first: "a notice to both accounts before the change takes effect".
  const productRow = await getProduct(db, args.product);
  const fromAccount = await getAccountRow(db, args.from.accountId);
  let noticesSent = 0;
  noticesSent += await sendSecurityNotice(
    env,
    db,
    args.from.accountId,
    fromAccount?.primary_email,
    licenseRelinkedAwayNotice({
      productName: productRow?.name,
      origin: ctx.origin,
    }),
    now,
  );
  noticesSent += await sendSecurityNotice(
    env,
    db,
    toAccountId,
    toAccount.primary_email,
    licenseRelinkedInNotice({
      productName: productRow?.name,
      productSlug: args.product,
      origin: ctx.origin,
    }),
    now,
  );

  const moved = await reassignLicense(ctx, {
    product: args.product,
    licenseId: args.licenseId,
    toAccountId,
    actor: `admin:${args.actor.sub}`,
  });
  if (!moved.ok || moved.previousAccountId !== args.from.accountId)
    return { ok: false, reason: "conflict" };

  const prior = await operatorRelinksToday(db, args.actor.sub, now);
  const relinkId = randomId("rlk");
  const undoUntil = now + RELINK_UNDO_SECONDS;
  await db.run(
    `INSERT INTO license_relinks
       (product, id, license_id, from_account_id, to_account_id, from_subject, to_subject,
        reason, actor_sub, actor_name, notices_sent, created_at, undo_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args.product,
    relinkId,
    args.licenseId,
    args.from.accountId,
    toAccountId,
    args.from.subject,
    toSubject,
    reason,
    args.actor.sub,
    args.actor.name,
    noticesSent,
    now,
    undoUntil,
  );
  return {
    ok: true,
    relinkId,
    fromSubject: args.from.subject,
    toSubject,
    undoUntil,
    noticesSent,
    alert: prior + 1 > RELINK_DAILY_ALERT_COUNT,
  };
}

export type UndoResult =
  | {
      ok: true;
      licenseId: string;
      /** The subject the licence returns to (`null` when that account was deleted: floating). */
      toSubject: string | null;
      fromSubject: string;
      noticesSent: number;
    }
  | { ok: false; reason: RelinkRefusal };

/**
 * Undo a relink within 72 hours: the licence goes back to the account it came from, provided it
 * still sits where the relink put it (a later relink, a detach or a deletion closes the undo).
 * Same notices, same reason rule; the caller has checked the step-up again.
 */
export async function undoRelink(
  ctx: AccountContext,
  args: {
    product: string;
    relinkId: string;
    reason: unknown;
    actor: { sub: string; name: string | null };
  },
): Promise<UndoResult> {
  const { db, env, now } = ctx;
  const reason = cleanReason(args.reason);
  if (!reason) return { ok: false, reason: "reason_required" };
  const r = await db.first<RelinkRow>(
    "SELECT * FROM license_relinks WHERE product = ? AND id = ?",
    args.product,
    args.relinkId,
  );
  if (!r) return { ok: false, reason: "relink_not_found" };
  if (!(await relinkUndoable(db, r, now)))
    return { ok: false, reason: "undo_unavailable" };

  const productRow = await getProduct(db, args.product);
  let noticesSent = 0;
  for (const accountId of [r.to_account_id, r.from_account_id]) {
    if (!accountId) continue;
    const account = await getAccountRow(db, accountId);
    noticesSent += await sendSecurityNotice(
      env,
      db,
      accountId,
      account?.primary_email,
      licenseRelinkUndoneNotice({
        productName: productRow?.name,
        origin: ctx.origin,
      }),
      now,
    );
  }

  const moved = await reassignLicense(ctx, {
    product: args.product,
    licenseId: r.license_id,
    toAccountId: r.from_account_id,
    actor: `admin:${args.actor.sub}`,
  });
  if (!moved.ok || moved.previousAccountId !== r.to_account_id)
    return { ok: false, reason: "conflict" };
  await db.run(
    `UPDATE license_relinks SET undone_at = ?, undone_by = ?, undo_reason = ?
      WHERE product = ? AND id = ? AND undone_at IS NULL`,
    now,
    args.actor.sub,
    reason,
    args.product,
    args.relinkId,
  );
  const back = r.from_account_id
    ? await db.first<{ subject: string }>(
        "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
        r.from_account_id,
        args.product,
      )
    : null;
  return {
    ok: true,
    licenseId: r.license_id,
    toSubject: back?.subject ?? null,
    fromSubject: r.to_subject,
    noticesSent,
  };
}
