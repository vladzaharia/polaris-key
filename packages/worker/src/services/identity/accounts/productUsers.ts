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
  isFloatingLicense,
  licenseAccountId,
  licenseEmail,
  resolveSubject,
} from "../../../core/accountSubjects.js";
import { associateLicenseHolder } from "../../../core/licenseHolders.js";
import {
  runSubjectDelete,
  runSubjectExport,
  subjectDataSize,
} from "../../../core/subjectHooks.js";
import { getLicense, getProduct, type LicenseRow } from "../../../repo.js";
import {
  b64urlDecodeBinary,
  b64urlEncodeBinary,
} from "../../../platform/bytes.js";
import { normalizeEmail } from "../../../platform/email.js";
import { randomId } from "../../../crypto.js";
import type { Db } from "../../../db/types.js";
import { sendNotice, sendSecurityNotice } from "../portal/email.js";
import {
  licenseAssignedToYouNotice,
  licenseMadeFloatingNotice,
  licenseReassignedAwayNotice,
  licenseRelinkUndoneNotice,
  licenseRelinkedAwayNotice,
  licenseRelinkedInNotice,
  type NoticeMessage,
} from "../portal/notices.js";
import { detachLicense, reassignLicense } from "./claim.js";
import type { AccountContext } from "./links.js";
import { getAccountRow, verifiedAccountEmails } from "./repo.js";
import { PRODUCT_SIGNIN_ACTION, signInKindOf } from "./signIn.js";
import { jsonList, jsonListArg } from "../../../core/sqlIn.js";

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
  return b64urlEncodeBinary(JSON.stringify([createdAt, subject]));
}

function decodeCursor(raw: string | null): [number, string] | null {
  if (!raw || raw.length > 256) return null;
  try {
    const v = JSON.parse(b64urlDecodeBinary(raw)) as unknown;
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
 * How many users each product's Users page lists (`listProductUsers` with Identity on: a subject
 * with a licence, a signed-in device or a sign-in through the product), for every product in ONE
 * grouped query. The console's summary read (`admin/lib/summary.ts`) puts it on Home's card.
 */
export async function countListedUsersByProduct(
  db: Db,
): Promise<Map<string, number>> {
  const rows = await db.all<{ product: string; n: number }>(
    `SELECT s.product AS product, COUNT(*) AS n
       FROM account_product_subjects s
      WHERE (${ROW_LICENSES} > 0 OR ${ROW_SIGNED_IN} > 0 OR ${ROW_LAST_SIGNIN} IS NOT NULL)
      GROUP BY s.product`,
  );
  return new Map(rows.map((r) => [r.product, Number(r.n)]));
}

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
    // A consent grant is product-user data (PX-W17 Q5): read only while Identity is on.
    const contact = contactOf(
      r.buyer_email,
      r.primary_email,
      opts.identityOn ? consentedClaims(r.claims_json) : new Set<string>(),
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

/**
 * What a `license_relinks` row records (LX-30): an I-12 relink between two subjects, or one of the
 * tool's two holder moves, **Make floating** (`floating`) and **Reassign…** (`reassign`).
 */
export type RelinkKind = "relink" | "floating" | "reassign";

export interface ProductUserRelink {
  id: string;
  /** LX-30: a relink, or a holder move (Make floating, Reassign…). */
  kind: RelinkKind;
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
        AND (subject IN ${jsonList()}
             ${licenseIds.length ? `OR license_id IN ${jsonList()}` : ""})
      ORDER BY last_seen DESC, device_id`,
    product,
    jsonListArg(subjects),
    ...(licenseIds.length ? [jsonListArg(licenseIds)] : []),
  );

  const grant = await db.first<{ claims_json: string | null }>(
    "SELECT claims_json FROM account_product_grants WHERE account_id = ? AND product = ?",
    accountId,
    product,
  );
  // A consent grant is product-user data (PX-W17 Q5): read only while Identity is on, so an
  // Identity-off row shows the buyer email and never a consented name or address.
  const claims = identityOn
    ? consentedClaims(grant?.claims_json)
    : new Set<string>();
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
        WHERE product = ? AND subject IN ${jsonList()}
        ORDER BY created_at DESC, id LIMIT 50`,
      product,
      jsonListArg(subjects),
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
        WHERE product = ? AND target_id IN ${jsonList()}
        ORDER BY at DESC, id LIMIT ?`,
      product,
      jsonListArg(targets),
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
      // A device bound to this licence by someone else is not this person's data.
      label:
        d.subject !== null && !subjects.includes(d.subject) ? null : d.label,
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
  /** LX-30: a holder move's before and after (`HolderSnapshot` as JSON); NULL for a relink. */
  holder_json?: string | null;
}

/** One side of a holder move: the licence's own name and email (never the account's). */
export interface HolderFacts {
  name: string | null;
  email: string | null;
}

/** What a holder move changed, kept on its row (`license_relinks.holder_json`) for the undo. */
interface HolderSnapshot {
  kind: "floating" | "reassign";
  from: HolderFacts;
  to: HolderFacts;
  devicesSignedOut: number;
}

/**
 * The subject a holder move left the licence with. `to_subject` is NOT NULL (migration 0082), so a
 * move that leaves the licence with no account (Make floating, or a reassignment to an address no
 * account has verified yet) writes `''`; every reader maps it back to "no subject" here.
 */
const NO_SUBJECT = "";

function subjectOrNull(subject: string | null): string | null {
  return subject === null || subject === NO_SUBJECT ? null : subject;
}

function facts(raw: unknown): HolderFacts {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : null,
    email: typeof o.email === "string" ? o.email : null,
  };
}

/** A row's holder snapshot, or `null` for an I-12 relink (or an unreadable value). */
function holderOf(r: Pick<RelinkRow, "holder_json">): HolderSnapshot | null {
  if (!r.holder_json) return null;
  try {
    const o = JSON.parse(r.holder_json) as Record<string, unknown>;
    if (o.kind !== "floating" && o.kind !== "reassign") return null;
    return {
      kind: o.kind,
      from: facts(o.from),
      to: facts(o.to),
      devicesSignedOut:
        typeof o.devicesSignedOut === "number" ? o.devicesSignedOut : 0,
    };
  } catch {
    return null;
  }
}

function kindOf(r: Pick<RelinkRow, "holder_json">): RelinkKind {
  return holderOf(r)?.kind ?? "relink";
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
        AND (from_subject IN ${jsonList()}
             OR to_subject IN ${jsonList()})
      ORDER BY created_at DESC, id LIMIT 50`,
    product,
    jsonListArg(subjects),
    jsonListArg(subjects),
  );
  const out: ProductUserRelink[] = [];
  for (const r of rows) {
    const incoming = subjects.includes(r.to_subject);
    out.push({
      id: r.id,
      kind: kindOf(r),
      licenseId: r.license_id,
      direction: incoming ? "in" : "out",
      otherSubject: subjectOrNull(incoming ? r.from_subject : r.to_subject),
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

/**
 * Can the move still be undone? Not undone, inside its 72 hours, and the licence still sits where
 * the move put it:
 *
 *   - a relink: still in the account it was moved to;
 *   - Make floating: still floating (no account, no email: nobody added the key to an account
 *     and nobody assigned it since);
 *   - Reassign…: still carrying the address the move set, and either in no account, in the
 *     account it joined at the move, or in an account that has verified that address (it joined
 *     through that address's own verification). A claim by key into another account, a later
 *     reassignment or an email edit closes the undo.
 */
async function relinkUndoable(
  db: Db,
  r: RelinkRow,
  now: number,
): Promise<boolean> {
  if (r.undone_at !== null || now >= r.undo_until) return false;
  const holder = holderOf(r);
  if (!holder) {
    const owner = await licenseAccountId(db, r.product, r.license_id);
    return owner !== null && owner === r.to_account_id;
  }
  const license = await getLicense(db, r.product, r.license_id);
  if (!license) return false;
  if (holder.kind === "floating") return isFloatingLicense(license);
  const email = licenseEmail(license);
  if (
    email === null ||
    holder.to.email === null ||
    normalizeEmail(email) !== normalizeEmail(holder.to.email)
  )
    return false;
  const owner = license.account_id ?? null;
  if (owner === null || owner === r.to_account_id) return true;
  const target = normalizeEmail(holder.to.email);
  return (await verifiedAccountEmails(db, owner)).some(
    (e) => normalizeEmail(e) === target,
  );
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
  | "undo_unavailable"
  /** LX-30: Make floating on a licence that is already floating. */
  | "already_floating"
  /** LX-30: Reassign… on a floating licence (a floating licence is given a holder by Assign). */
  | "license_floating"
  /** LX-30: Reassign… to the address the licence already carries. */
  | "same_holder"
  /** LX-30: the typed confirmation is not the licence's name or id. */
  | "confirm_required"
  /** LX-30: Reassign… without a usable email address. */
  | "email_invalid";

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
    expectedPreviousAccountId: args.from.accountId,
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
      /** The subject the licence returns to (`null` when that account was deleted, or when the
       *  move took the licence from an address with no account: floating or waiting). */
      toSubject: string | null;
      /** The subject the licence leaves (`null` when it had none: floating or waiting). */
      fromSubject: string | null;
      noticesSent: number;
    }
  | { ok: false; reason: RelinkRefusal };

/**
 * Undo a relink, or a holder move (LX-30), within 72 hours: the licence goes back to the account
 * it came from, provided it still sits where the move put it (a later relink, a detach, a claim or
 * a deletion closes the undo; `relinkUndoable`). A holder move's undo also puts the licence's own
 * `name` and `email` back. Moving it back into an account lifts that account's auto-attach block
 * (`reassignLicense`), which is how the block the move wrote goes. Same notices, same reason rule;
 * the caller has checked the step-up again.
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
  const holder = holderOf(r);
  if (holder) return undoHolderMove(ctx, r, holder, reason, args.actor);

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
    expectedPreviousAccountId: r.to_account_id,
  });
  if (!moved.ok || moved.previousAccountId !== r.to_account_id)
    return { ok: false, reason: "conflict" };
  await markUndone(db, r, args.actor.sub, reason, now);
  return {
    ok: true,
    licenseId: r.license_id,
    toSubject: await subjectOfAccount(db, r.from_account_id, args.product),
    fromSubject: subjectOrNull(r.to_subject),
    noticesSent,
  };
}

async function markUndone(
  db: Db,
  r: RelinkRow,
  actorSub: string,
  reason: string,
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE license_relinks SET undone_at = ?, undone_by = ?, undo_reason = ?
      WHERE product = ? AND id = ? AND undone_at IS NULL`,
    now,
    actorSub,
    reason,
    r.product,
    r.id,
  );
}

/** The account's pairwise subject for the product, or `null` (no account, or none yet). */
async function subjectOfAccount(
  db: Db,
  accountId: string | null,
  product: string,
): Promise<string | null> {
  if (!accountId) return null;
  const row = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
    accountId,
    product,
  );
  return row?.subject ?? null;
}

// ── Holder moves: Make floating and Reassign… (LX-30; notes/S-24 §5.5, D20) ─────────────────
//
// The relink tool's two moves keyed by the LICENCE rather than by a subject, so they also reach a
// licence that is waiting for its email (no account, so no subject). Both carry every control a
// relink carries (the caller's step-up, a reason, a notice before the change, the daily alert, a
// 72-hour undo) plus a typed confirmation the Worker checks: the licence's name, or its id.
//
//   - Make floating: the licence leaves its account through `reassignLicense(toAccountId: null)`
//     (which writes the auto-attach block for that account; nothing here writes one), and its
//     `name` and `email` are cleared. It keeps working on every device that has its key.
//   - Reassign…: the same move away, then the new `name` and `email` are set and Core's
//     `associateLicenseHolder` runs (S-24 D3): the licence joins the account that verified the new
//     address, if one did, or waits for it. The answer never says which (D4).
//
// Each writes one `license_relinks` row whose `holder_json` keeps the before and after for the
// undo (`undoRelink` → `undoHolderMove`).

/** The longest email address (RFC 5321's path limit). */
const EMAIL_MAX = 254;

/** A usable address: trimmed, one `@` with something either side, no whitespace. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > EMAIL_MAX) return null;
  return /^[^\s@]+@[^\s@]+$/.test(v) ? v : null;
}

/** The typed confirmation: the licence's id, or its trimmed non-empty name. */
export function holderConfirmMatches(
  license: Pick<LicenseRow, "id" | "name">,
  confirm: unknown,
): boolean {
  if (typeof confirm !== "string") return false;
  if (confirm === license.id) return true;
  const name = (license.name ?? "").trim();
  return name !== "" && confirm === name;
}

export type HolderMoveResult =
  | {
      ok: true;
      relinkId: string;
      undoUntil: number;
      noticesSent: number;
      /** This operator passed the daily relink count: an alert was raised. */
      alert: boolean;
      /** The licence's holder before the move, for the console audit row. */
      before: { subject: string | null } & HolderFacts;
      /** After: `null` for Make floating. */
      after: HolderFacts | null;
      devicesSignedOut: number;
    }
  | { ok: false; reason: RelinkRefusal };

/** Shared checks of both moves: the licence is this product's, the confirmation, the reason. */
async function holderMoveTarget(
  db: Db,
  args: {
    product: string;
    licenseId: string;
    confirm: unknown;
    reason: unknown;
  },
): Promise<
  | { ok: true; license: LicenseRow; reason: string }
  | { ok: false; reason: RelinkRefusal }
> {
  const license = await getLicense(db, args.product, args.licenseId);
  if (!license) return { ok: false, reason: "license_not_found" };
  if (!holderConfirmMatches(license, args.confirm))
    return { ok: false, reason: "confirm_required" };
  const reason = cleanReason(args.reason);
  if (!reason) return { ok: false, reason: "reason_required" };
  return { ok: true, license, reason };
}

/**
 * Tell the side a licence leaves: every verified email of the account it is in (plus the
 * licence's own address), or, when it is waiting, its address alone. Never throws.
 */
async function noticeLeavingSide(
  ctx: AccountContext,
  owner: string | null,
  address: string | null,
  build: (inAccount: boolean) => NoticeMessage,
): Promise<number> {
  const { db, env, now } = ctx;
  if (owner)
    return sendSecurityNotice(env, db, owner, address, build(true), now);
  if (!address) return 0;
  try {
    return (await sendNotice(env, db, address, build(false), now)) ? 1 : 0;
  } catch {
    // As `sendSecurityNotice`: a failed send never fails the change; the count says it.
    return 0;
  }
}

async function noticeAddress(
  ctx: AccountContext,
  address: string,
  message: NoticeMessage,
): Promise<number> {
  try {
    return (await sendNotice(ctx.env, ctx.db, address, message, ctx.now))
      ? 1
      : 0;
  } catch {
    return 0;
  }
}

/** Write a holder move's row; answers its id, its undo deadline and whether to alert. */
async function recordHolderMove(
  ctx: AccountContext,
  args: {
    product: string;
    licenseId: string;
    fromAccountId: string | null;
    fromSubject: string | null;
    toAccountId: string | null;
    toSubject: string | null;
    reason: string;
    actor: { sub: string; name: string | null };
    noticesSent: number;
    holder: HolderSnapshot;
  },
): Promise<{ relinkId: string; undoUntil: number; alert: boolean }> {
  const { db, now } = ctx;
  const prior = await operatorRelinksToday(db, args.actor.sub, now);
  const relinkId = randomId("rlk");
  const undoUntil = now + RELINK_UNDO_SECONDS;
  await db.run(
    `INSERT INTO license_relinks
       (product, id, license_id, from_account_id, to_account_id, from_subject, to_subject,
        reason, actor_sub, actor_name, notices_sent, created_at, undo_until, holder_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args.product,
    relinkId,
    args.licenseId,
    args.fromAccountId,
    args.toAccountId,
    args.fromSubject,
    args.toSubject ?? NO_SUBJECT,
    args.reason,
    args.actor.sub,
    args.actor.name,
    args.noticesSent,
    now,
    undoUntil,
    JSON.stringify(args.holder),
  );
  return {
    relinkId,
    undoUntil,
    alert: prior + 1 > RELINK_DAILY_ALERT_COUNT,
  };
}

/**
 * Make floating (S-24 §5.5): take the licence off its holder. The caller has checked the step-up
 * and writes the console audit row. Signing devices out is the CALLER's step, AFTER this returns:
 * the move, its relink row (the undo) and the caller's audit row are all written before any device
 * is touched, so a sign-out that fails partway leaves the move undoable and audited; the caller
 * then records how many it signed out (`recordDevicesSignedOut`, best effort).
 */
export async function makeLicenseFloating(
  ctx: AccountContext,
  args: {
    product: string;
    licenseId: string;
    reason: unknown;
    confirm: unknown;
    actor: { sub: string; name: string | null };
  },
): Promise<HolderMoveResult> {
  const { db, now } = ctx;
  const target = await holderMoveTarget(db, args);
  if (!target.ok) return target;
  const { license, reason } = target;
  if (isFloatingLicense(license))
    return { ok: false, reason: "already_floating" };
  const owner = license.account_id ?? null;
  const address = licenseEmail(license);
  const from: HolderFacts = { name: license.name ?? null, email: address };
  const fromSubject = await subjectOfAccount(db, owner, args.product);

  // The notice goes out first: "a notice before the change takes effect".
  const productRow = await getProduct(db, args.product);
  const noticesSent = await noticeLeavingSide(
    ctx,
    owner,
    address,
    (inAccount) =>
      licenseMadeFloatingNotice({
        productName: productRow?.name,
        inAccount,
        origin: ctx.origin,
      }),
  );

  if (owner) {
    const moved = await reassignLicense(ctx, {
      product: args.product,
      licenseId: args.licenseId,
      toAccountId: null,
      actor: `admin:${args.actor.sub}`,
      expectedPreviousAccountId: owner,
    });
    if (!moved.ok || moved.previousAccountId !== owner)
      return { ok: false, reason: "conflict" };
  }
  // Compare-and-set: still in no account and still carrying the address read above.
  const cleared = await db.runChanges(
    `UPDATE licenses SET name = NULL, email = NULL, modified_by = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS NULL AND COALESCE(email, '') = ?`,
    args.actor.sub,
    now,
    args.product,
    args.licenseId,
    license.email ?? "",
  );
  if (cleared !== 1) return { ok: false, reason: "conflict" };

  const recorded = await recordHolderMove(ctx, {
    product: args.product,
    licenseId: args.licenseId,
    fromAccountId: owner,
    fromSubject,
    toAccountId: null,
    toSubject: null,
    reason,
    actor: args.actor,
    noticesSent,
    holder: {
      kind: "floating",
      from,
      to: { name: null, email: null },
      devicesSignedOut: 0,
    },
  });
  return {
    ok: true,
    ...recorded,
    noticesSent,
    before: { subject: fromSubject, ...from },
    after: null,
    devicesSignedOut: 0,
  };
}

/**
 * After a Make floating's optional sign-out: put the count on its relink row (shown with the move).
 * Best effort: each device already has its own `device.deauthorize` audit row, so a failure here
 * loses only the summary, never the undo.
 */
export async function recordDevicesSignedOut(
  db: Db,
  product: string,
  relinkId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  try {
    await db.run(
      `UPDATE license_relinks
          SET holder_json = json_set(holder_json, '$.devicesSignedOut', ?)
        WHERE product = ? AND id = ? AND holder_json IS NOT NULL`,
      count,
      product,
      relinkId,
    );
  } catch {
    // Swallowed on purpose (see above); the Worker has no console logging (R12).
  }
}

/**
 * Reassign… (S-24 §5.5): give an assigned licence to another person, named by an email address
 * (and optionally a name). The old side and the new address are told before the change; the new
 * address's notice never says whether an account holds it (D4). The caller has checked the
 * step-up and the name's text rules, and writes the console audit row.
 */
export async function reassignLicenseHolder(
  ctx: AccountContext,
  args: {
    product: string;
    licenseId: string;
    email: unknown;
    name: unknown;
    reason: unknown;
    confirm: unknown;
    actor: { sub: string; name: string | null };
  },
): Promise<HolderMoveResult> {
  const { db, now } = ctx;
  const target = await holderMoveTarget(db, args);
  if (!target.ok) return target;
  const { license, reason } = target;
  if (isFloatingLicense(license))
    return { ok: false, reason: "license_floating" };
  const email = cleanEmail(args.email);
  if (!email) return { ok: false, reason: "email_invalid" };
  const current = licenseEmail(license);
  if (current !== null && normalizeEmail(current) === normalizeEmail(email))
    return { ok: false, reason: "same_holder" };
  const name =
    typeof args.name === "string" && args.name.trim() !== ""
      ? args.name.trim()
      : null;
  const owner = license.account_id ?? null;
  const from: HolderFacts = { name: license.name ?? null, email: current };
  const fromSubject = await subjectOfAccount(db, owner, args.product);

  const productRow = await getProduct(db, args.product);
  let noticesSent = await noticeLeavingSide(ctx, owner, current, (inAccount) =>
    licenseReassignedAwayNotice({
      productName: productRow?.name,
      inAccount,
      origin: ctx.origin,
    }),
  );
  noticesSent += await noticeAddress(
    ctx,
    email,
    licenseAssignedToYouNotice({
      productName: productRow?.name,
      productSlug: args.product,
      origin: ctx.origin,
    }),
  );

  if (owner) {
    const moved = await reassignLicense(ctx, {
      product: args.product,
      licenseId: args.licenseId,
      toAccountId: null,
      actor: `admin:${args.actor.sub}`,
      expectedPreviousAccountId: owner,
    });
    if (!moved.ok || moved.previousAccountId !== owner)
      return { ok: false, reason: "conflict" };
  }
  const set = await db.runChanges(
    `UPDATE licenses SET name = ?, email = ?, modified_by = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS NULL AND COALESCE(email, '') = ?`,
    name,
    email,
    args.actor.sub,
    now,
    args.product,
    args.licenseId,
    license.email ?? "",
  );
  if (set !== 1) return { ok: false, reason: "conflict" };
  // S-24 D3: the account that verified the new address, if one did and the pair is not blocked.
  await associateLicenseHolder(
    { db, env: ctx.env, now, origin: ctx.origin },
    args.product,
    args.licenseId,
  );
  const joined = await licenseAccountId(db, args.product, args.licenseId);
  const to: HolderFacts = { name, email };
  const recorded = await recordHolderMove(ctx, {
    product: args.product,
    licenseId: args.licenseId,
    fromAccountId: owner,
    fromSubject,
    toAccountId: joined,
    toSubject: await subjectOfAccount(db, joined, args.product),
    reason,
    actor: args.actor,
    noticesSent,
    holder: { kind: "reassign", from, to, devicesSignedOut: 0 },
  });
  return {
    ok: true,
    ...recorded,
    noticesSent,
    before: { subject: fromSubject, ...from },
    after: to,
    devicesSignedOut: 0,
  };
}

/**
 * A holder move's undo: tell both sides, move the owner back (lifting the restored account's
 * block), put the licence's own `name` and `email` back, and, when it returns to an address with
 * no account, let the account that has verified that address since take it (S-24 D3).
 */
async function undoHolderMove(
  ctx: AccountContext,
  r: RelinkRow,
  holder: HolderSnapshot,
  reason: string,
  actor: { sub: string; name: string | null },
): Promise<UndoResult> {
  const { db, now } = ctx;
  const license = await getLicense(db, r.product, r.license_id);
  if (!license) return { ok: false, reason: "undo_unavailable" };
  const owner = license.account_id ?? null;
  const productRow = await getProduct(db, r.product);
  const notice = (): NoticeMessage =>
    licenseRelinkUndoneNotice({
      productName: productRow?.name,
      origin: ctx.origin,
    });
  let noticesSent = await noticeLeavingSide(
    ctx,
    owner,
    licenseEmail(license),
    notice,
  );
  noticesSent += await noticeLeavingSide(
    ctx,
    r.from_account_id,
    holder.from.email,
    notice,
  );

  if (owner !== r.from_account_id) {
    const moved = await reassignLicense(ctx, {
      product: r.product,
      licenseId: r.license_id,
      toAccountId: r.from_account_id,
      actor: `admin:${actor.sub}`,
      expectedPreviousAccountId: owner,
    });
    if (!moved.ok || moved.previousAccountId !== owner)
      return { ok: false, reason: "conflict" };
  }
  const restored = await db.runChanges(
    `UPDATE licenses SET name = ?, email = ?, modified_by = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS ? AND COALESCE(email, '') = ?`,
    holder.from.name,
    holder.from.email,
    actor.sub,
    now,
    r.product,
    r.license_id,
    r.from_account_id,
    license.email ?? "",
  );
  if (restored !== 1) return { ok: false, reason: "conflict" };
  if (r.from_account_id === null && holder.from.email !== null)
    await associateLicenseHolder(
      { db, env: ctx.env, now, origin: ctx.origin },
      r.product,
      r.license_id,
    );
  await markUndone(db, r, actor.sub, reason, now);
  const back = await licenseAccountId(db, r.product, r.license_id);
  return {
    ok: true,
    licenseId: r.license_id,
    toSubject: await subjectOfAccount(db, back, r.product),
    fromSubject: subjectOrNull(r.to_subject),
    noticesSent,
  };
}

/** One move of a licence, as the licence record lists it (LX-30). */
export interface LicenseHolderMove {
  id: string;
  kind: RelinkKind;
  reason: string;
  actorName: string | null;
  createdAt: number;
  undoUntil: number;
  undoneAt: number | null;
  undoable: boolean;
  fromSubject: string | null;
  toSubject: string | null;
  /** The licence's own name and email before a holder move; `null` for a relink. */
  from: HolderFacts | null;
  /** After a holder move (both `null` for Make floating); `null` for a relink. */
  to: HolderFacts | null;
  devicesSignedOut: number;
}

/** The licence record's move history: this licence of this product, newest first, at most 20. */
export async function licenseHolderMoves(
  db: Db,
  product: string,
  licenseId: string,
  now: number,
): Promise<LicenseHolderMove[]> {
  const rows = await db.all<RelinkRow>(
    `SELECT * FROM license_relinks WHERE product = ? AND license_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 20`,
    product,
    licenseId,
  );
  const out: LicenseHolderMove[] = [];
  for (const r of rows) {
    const holder = holderOf(r);
    out.push({
      id: r.id,
      kind: holder?.kind ?? "relink",
      reason: r.reason,
      actorName: r.actor_name,
      createdAt: r.created_at,
      undoUntil: r.undo_until,
      undoneAt: r.undone_at,
      undoable: await relinkUndoable(db, r, now),
      fromSubject: subjectOrNull(r.from_subject),
      toSubject: subjectOrNull(r.to_subject),
      from: holder ? holder.from : null,
      to: holder ? holder.to : null,
      devicesSignedOut: holder?.devicesSignedOut ?? 0,
    });
  }
  return out;
}
