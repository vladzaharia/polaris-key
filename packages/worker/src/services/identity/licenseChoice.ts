/// <reference types="@cloudflare/workers-types" />

/**
 * The legacy product-OIDC sign-in's licence chooser (I-26; plans/I-04.md, "Owner decision
 * (2026-10-05): licence choice at sign-in", delegated decisions 1, 2 and 13).
 *
 * The in-app sign-in (`/<p>/identity/auth/*`: device code, its QR and the browser flow, shown in
 * the console as "Signed-in app") used to mint a `sub`-keyed licence for every identity the
 * product's policy entitled, even when the person's Polaris Key account already owned a usable
 * licence for the product. On `provider: platform` products it now asks instead:
 *
 *   trigger  the product's provider is `platform`, auto-linking resolves on
 *            (`autoLinkEnabled`, the R5-01/R5-02 rule), the verified `sub` is linked to an
 *            active account (`account_links`, kind `oidc`, the platform issuer), and that account
 *            owns at least one usable licence for the product (`licenses.account_id`,
 *            `licenseUsable`). Anything else signs in exactly as before.
 *   page     "Choose a licence for this device": one row per candidate, rank-first preselected
 *            (no expiry first, then the latest expiry, then the oldest; I-09 §2.4), full rows
 *            disabled with **Replace a device** (the shared `freeAccountDevice`) and a
 *            **Free a device** link to the portal's focused flow (PX-10), and **Create a new
 *            free licence** only when the policy would auto-issue and every row is full.
 *   binder   the page answers only in the browser that started (`/auth/start`) or confirmed
 *            (the device page's POST) the flow: that browser holds `__Host-pk_lcb`, and the
 *            flow stores the cookie's hash. Without it the callback refuses and never falls
 *            back to minting (R1-07: a forwarded authorize URL must not bind the victim's
 *            purchased licence to the phisher's device).
 *
 * Nothing on the device wire changes: the poll answers `pending` until the choice is recorded.
 * I-08 deletes this page when the login card's LicenseChoiceStep (PX-14) takes over, and keeps
 * the rule.
 *
 * This module is the read side and the markup. The handlers that write (`handleAuthChoose`, the
 * callback's hand-off) live in `oidc.ts`, beside the flow record they change.
 */

import {
  countActiveDevices,
  getLicenseBySub,
  getTier,
  seatActiveSince,
  type DeviceRow,
  type LicenseRow,
} from "../../core/data.js";
import { licenseUsable } from "../../core/devices.js";
import { licenseDeviceLimit, tierFingerprintMode } from "../../core/authz.js";
import type { Db } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import type { PurchaseSourceKind, ServiceHooks } from "../../core/hooks.js";
import { escapeHtml } from "../../core/brandHtml.js";
import {
  findLink,
  getAccountRow,
  LEGACY_OIDC_ISSUER,
} from "./accounts/repo.js";
import {
  autoLinkEnabled,
  getPortalProductSettings,
  listVisibleDevices,
  portalIdentityIssuerKey,
} from "./portal/repo.js";

// ── the browser binder ──────────────────────────────────────────────────────────────────────

/** The binder cookie (delegated decision 13). `__Host-`: Secure, Path=/, no Domain. */
export const LICENSE_CHOICE_BINDER_COOKIE = "__Host-pk_lcb";

/** `Set-Cookie` for a fresh binder, living as long as the flow it binds. */
export function binderSetCookie(value: string, maxAge: number): string {
  return `${LICENSE_CHOICE_BINDER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** `Set-Cookie` that drops the binder once its flow is finished. */
export function binderClearCookie(): string {
  return `${LICENSE_CHOICE_BINDER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** The binder the request carries, or `null`. Only the base64url alphabet is accepted. */
export function readBinder(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LICENSE_CHOICE_BINDER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }
  return null;
}

// ── the trigger ─────────────────────────────────────────────────────────────────────────────

/**
 * The account the chooser is for, or `null` when the legacy sign-in must behave exactly as
 * before: not a `platform` product, auto-linking off, the `sub` linked to no account (or to an
 * account that is not active), or the account owns no usable licence for the product. Read-only.
 */
export async function legacyChoiceAccount(
  db: Db,
  product: string,
  provider: string | null,
  issuer: string,
  sub: string,
  now: number,
): Promise<string | null> {
  if ((provider ?? "platform") !== "platform") return null;
  if (!(await autoLinkEnabled(db, product))) return null;
  // The portal keys platform links by the issuer (S-16 G14); a link the portal has not re-keyed
  // yet still carries the pre-I-01 literal. Both name the same IdP, so both count. Read-only:
  // the re-key itself stays the portal callback's.
  const link =
    (await findLink(db, {
      issuerKey: portalIdentityIssuerKey(issuer),
      tenantScope: "",
      subject: sub,
    })) ??
    (await findLink(db, {
      issuerKey: LEGACY_OIDC_ISSUER,
      tenantScope: "",
      subject: sub,
    }));
  if (!link || link.kind !== "oidc") return null;
  const account = await getAccountRow(db, link.account_id);
  if (!account || account.status !== "active") return null;
  const owned = await accountProductLicenses(db, account.id, product);
  return owned.some((l) => licenseUsable(l, now)) ? account.id : null;
}

async function accountProductLicenses(
  db: Db,
  accountId: string,
  product: string,
): Promise<LicenseRow[]> {
  return db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE account_id = ? AND product = ? ORDER BY id",
    accountId,
    product,
  );
}

// ── the view ────────────────────────────────────────────────────────────────────────────────

/** A device that holds a seat, as Replace lists it. */
export interface ReplaceDevice {
  id: string;
  label: string;
  platform: string | null;
  lastSeen: number;
  leastRecent: boolean;
  activeNow: boolean;
}

export interface LegacyChoiceRow {
  id: string;
  tierName: string;
  /** Display only; never authorises anything. */
  origin: string;
  seats: { used: number; limit: number };
  expiresAt: number | null;
  activatedAt: number;
  state: "free" | "full" | "blocked";
  blockedReason?: string;
  /** The identity's own `sub`-keyed licence: choosing it runs today's activation. */
  own: boolean;
  /** Full rows the account owns, with the portal on: the seat-holding devices Replace offers. */
  replace: ReplaceDevice[] | null;
  /** The portal's focused flow for this licence (PX-10), on full rows. */
  freeDeviceUrl: string | null;
}

export interface LegacyChoiceView {
  rows: LegacyChoiceRow[];
  /** A row id, `"create"`, or `null` when nothing can be chosen. */
  preselected: string | null;
  /** Offered only when the policy auto-issues to this person and every row is full. */
  create: { tierName: string } | null;
}

/** "Active now": seen in the last 10 minutes (owner decision §B). */
export const ACTIVE_NOW_SECONDS = 600;

const STORE_NAMES: Record<string, string> = {
  "app-store": "App Store",
  play: "Google Play",
  steam: "Steam",
};

function originLabel(kind: PurchaseSourceKind, store: string | null): string {
  switch (kind) {
    case "store":
      return `Bought on ${store ? (STORE_NAMES[store] ?? store) : "a store"}`;
    case "sign_in":
      return "Signed-in app";
    case "free":
      return "Free";
    default:
      return "From the developer";
  }
}

function originKind(origin: string | undefined): PurchaseSourceKind {
  if (origin === "oidc") return "sign_in";
  if (origin === "enroll") return "free";
  return "developer";
}

/** I-09 §2.4's rank-first order: no expiry first, then the latest expiry, then the oldest. */
export function compareCandidates(
  a: Pick<LegacyChoiceRow, "expiresAt" | "activatedAt" | "id">,
  b: Pick<LegacyChoiceRow, "expiresAt" | "activatedAt" | "id">,
): number {
  if (a.expiresAt === null && b.expiresAt !== null) return -1;
  if (b.expiresAt === null && a.expiresAt !== null) return 1;
  if (
    a.expiresAt !== null &&
    b.expiresAt !== null &&
    a.expiresAt !== b.expiresAt
  )
    return b.expiresAt - a.expiresAt;
  if (a.activatedAt !== b.activatedAt) return a.activatedAt - b.activatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every licence this person may bind the device to, read-only: the account's usable licences
 * for the product, plus the identity's own `sub`-keyed licence when it is usable and not
 * attached yet (it is provably theirs, by the same rule the portal's link sweep attaches it).
 *
 * `deviceId` is the installation being signed in (`browser:<licence>` for the browser flow): a
 * licence it already holds a seat on is free for it whatever its count. Every candidate is
 * blocked when its tier's fingerprint mode is `strict`, because this sign-in presents no
 * fingerprint and the mint would refuse (`fingerprint_required`).
 */
export async function legacyLicenseChoices(
  db: Db,
  product: Product,
  input: {
    accountId: string;
    sub: string;
    /** The device-code flow's device, or `null` for the browser flow. */
    deviceId: string | null;
    /** What the auto-issue policy grants this identity (`identityTier`), or `null`. */
    grantTierId: string | null | undefined;
    hooks?: ServiceHooks;
    origin: string;
    deviceLabel: string;
    now: number;
  },
): Promise<LegacyChoiceView> {
  const { now } = input;
  const candidates = (
    await accountProductLicenses(db, input.accountId, product.slug)
  ).filter((l) => licenseUsable(l, now));
  const own = await getLicenseBySub(db, product.slug, input.sub);
  if (
    own &&
    own.account_id == null &&
    licenseUsable(own, now) &&
    !candidates.some((c) => c.id === own.id)
  )
    candidates.push(own);

  const provenance =
    candidates.length > 0 ? (input.hooks?.licenseProvenance() ?? null) : null;
  const sources = new Map(
    provenance
      ? (await provenance.purchaseSources(candidates.map((c) => c.id))).map(
          (s) => [s.licenseId, s] as const,
        )
      : [],
  );
  const portalOn =
    (await getPortalProductSettings(db, product.slug)).portal_enabled === 1;
  const since = seatActiveSince(now);

  const rows: LegacyChoiceRow[] = [];
  for (const l of candidates) {
    const tier = l.tier_id ? await getTier(db, product.slug, l.tier_id) : null;
    const limit = await licenseDeviceLimit(db, product, l, now);
    const used = await countActiveDevices(db, product.slug, l.id, since);
    const deviceId = input.deviceId ?? `browser:${l.id}`;
    const holds = await db.first<{ one: number }>(
      `SELECT 1 AS one FROM devices
        WHERE product = ? AND device_id = ? AND license_id = ? AND status = 'authorized'`,
      product.slug,
      deviceId,
      l.id,
    );
    const strict =
      (await tierFingerprintMode(db, product, l.tier_id)) === "strict";
    const state: LegacyChoiceRow["state"] = strict
      ? "blocked"
      : holds || (limit > 0 && used < limit)
        ? "free"
        : "full";
    const source = sources.get(l.id);
    const owned = l.account_id === input.accountId;
    let replace: ReplaceDevice[] | null = null;
    if (state === "full" && owned && portalOn) {
      const seated = (await listVisibleDevices(db, product.slug, l.id))
        .filter(
          (d: DeviceRow) => d.status === "authorized" && d.last_seen > since,
        )
        .sort((a, b) => a.last_seen - b.last_seen);
      replace = seated.map((d, i) => ({
        id: d.device_id,
        label: d.label?.trim() || "Unnamed device",
        platform: d.platform ?? null,
        lastSeen: d.last_seen,
        leastRecent: i === 0,
        activeNow: now - d.last_seen <= ACTIVE_NOW_SECONDS,
      }));
    }
    rows.push({
      id: l.id,
      tierName: tier?.label ?? (l.tier_id ? l.tier_id : "Licence"),
      origin: source
        ? originLabel(source.kind, source.store)
        : originLabel(originKind(l.origin), null),
      seats: { used, limit },
      expiresAt: l.expires_at,
      activatedAt: l.activated_at,
      state,
      ...(strict
        ? {
            blockedReason:
              "This licence needs a device check that this sign-in can't do.",
          }
        : {}),
      own: own?.id === l.id,
      replace,
      freeDeviceUrl:
        state === "full" && owned
          ? `${input.origin}/#/p/${encodeURIComponent(product.slug)}/free-device?license=${encodeURIComponent(l.id)}&for=${encodeURIComponent(input.deviceLabel)}`
          : null,
    });
  }
  rows.sort(compareCandidates);

  // Delegated decision 1: a second free licence only when the policy would auto-issue AND every
  // candidate is full. Never while the identity already has its own licence (`activateFromIdentity`
  // is idempotent on the subject, so it could not create a second one anyway).
  let create: LegacyChoiceView["create"] = null;
  if (
    input.grantTierId !== undefined &&
    !own &&
    rows.every((r) => r.state === "full")
  ) {
    const tier = input.grantTierId
      ? await getTier(db, product.slug, input.grantTierId)
      : null;
    create = { tierName: tier?.label ?? "free" };
  }
  const firstFree = rows.find((r) => r.state === "free");
  return {
    rows,
    preselected: firstFree ? firstFree.id : create ? "create" : null,
    create,
  };
}

// ── markup ──────────────────────────────────────────────────────────────────────────────────

function formatDay(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function devicesText(seats: { used: number; limit: number }): string {
  return `${seats.used} of ${seats.limit} device${seats.limit === 1 ? "" : "s"}`;
}

function lastUsedText(at: number, now: number): string {
  if (now - at <= ACTIVE_NOW_SECONDS) return "active now";
  const days = Math.floor((now - at) / 86_400);
  if (days < 1) return "last used today";
  if (days === 1) return "last used yesterday";
  return `last used ${days} days ago`;
}

/** A one-line notice above the rows, set by the previous POST. */
export type ChoiceNotice =
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "unavailable" }
  | { kind: "replaced"; device: string };

function noticeHtml(notice: ChoiceNotice | null | undefined): string {
  if (!notice) return "";
  switch (notice.kind) {
    case "rate_limited":
      return `<p class="alert" role="alert">Too many device changes. Try again in ${Math.max(1, Math.floor(notice.retryAfter))} seconds.</p>`;
    case "unavailable":
      return `<p class="alert" role="alert">That licence can't take this device any more. Choose again.</p>`;
    case "replaced":
      return `<p class="notice" role="status">${escapeHtml(notice.device)} was signed out.</p>`;
  }
}

function meta(parts: string[]): string {
  return `<span class="choice-meta">${parts.map(escapeHtml).join(" · ")}</span>`;
}

function rowHtml(row: LegacyChoiceRow, checked: boolean, now: number): string {
  const expiry =
    row.expiresAt === null
      ? "No expiry"
      : `Expires ${formatDay(row.expiresAt)}`;
  const disabled = row.state !== "free";
  const radio = `<input type="radio" name="license" value="${escapeHtml(row.id)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>`;
  const note =
    row.state === "full"
      ? `<span class="choice-note">No free devices</span>`
      : row.state === "blocked"
        ? `<span class="choice-note">${escapeHtml(row.blockedReason ?? "Not available for this sign-in")}</span>`
        : "";
  const head =
    `<label class="choice${disabled ? " is-disabled" : ""}">${radio}` +
    `<span class="choice-body"><span class="choice-title">${escapeHtml(row.tierName)}</span>` +
    meta([row.origin, devicesText(row.seats), expiry]) +
    note +
    `</span></label>`;
  if (row.state !== "full") return `<li>${head}</li>`;
  let replace = "";
  if (row.replace && row.replace.length > 0) {
    const devices = row.replace
      .map((d) => {
        const tags = [
          d.leastRecent ? "Least recent" : null,
          d.activeNow ? "Active now" : null,
        ]
          .filter((t): t is string => t !== null)
          .map((t) => `<span class="tag">${t}</span>`)
          .join("");
        return (
          `<label class="choice compact"><input type="radio" name="device:${escapeHtml(row.id)}" value="${escapeHtml(d.id)}"${d.leastRecent ? " checked" : ""}>` +
          `<span class="choice-body"><span class="choice-title">${escapeHtml(d.label)}${tags}</span>` +
          meta([
            ...(d.platform ? [d.platform] : []),
            lastUsedText(d.lastSeen, now),
          ]) +
          `</span></label>`
        );
      })
      .join("");
    replace =
      `<details class="replace"><summary>Replace a device</summary>` +
      `<p class="muted small">Sign out one of this licence's devices to make room for this one.</p>` +
      devices +
      `<button class="button secondary" type="submit" name="action" value="replace:${escapeHtml(row.id)}">Replace</button>` +
      `</details>`;
  }
  const free = row.freeDeviceUrl
    ? `<p class="small"><a href="${escapeHtml(row.freeDeviceUrl)}" target="_blank" rel="noopener noreferrer">Free a device</a> <span class="muted">in your account, then reload this page.</span></p>`
    : "";
  return `<li>${head}${replace}${free}</li>`;
}

/** The chooser's card body: the rows, the create row, the primary and Cancel. */
export function chooserBody(input: {
  productName: string;
  deviceLabel: string;
  action: string;
  token: string;
  view: LegacyChoiceView;
  notice?: ChoiceNotice | null;
  now: number;
}): string {
  const { view } = input;
  const rows = view.rows
    .map((r) => rowHtml(r, view.preselected === r.id, input.now))
    .join("");
  const create = view.create
    ? `<li><label class="choice"><input type="radio" name="license" value="create"${view.preselected === "create" ? " checked" : ""}>` +
      `<span class="choice-body"><span class="choice-title">Create a new free licence</span>` +
      meta([`A free ${view.create.tierName} licence for this device`]) +
      `</span></label></li>`
    : "";
  const canContinue = view.preselected !== null;
  const empty =
    view.rows.length === 0 && !view.create
      ? `<p class="muted">None of your licences can be used right now.</p>`
      : "";
  return (
    `<p class="muted">Your account already has a ${escapeHtml(input.productName)} licence. Choose the one this device should use.</p>` +
    `<dl><dt>Device</dt><dd>${escapeHtml(input.deviceLabel)}</dd></dl>` +
    noticeHtml(input.notice) +
    `<form method="post" action="${escapeHtml(input.action)}">` +
    `<input type="hidden" name="choice" value="${escapeHtml(input.token)}">` +
    `<fieldset class="choices"><legend class="sr-only">Licences</legend><ul class="choices">${rows}${create}</ul></fieldset>` +
    empty +
    `<div class="actions stack">` +
    (canContinue
      ? `<button class="button" type="submit" name="action" value="use">Use this licence</button>`
      : "") +
    `<button class="button secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>` +
    `</div></form>`
  );
}

/** The Replace confirmation: one device, one consequence, Replace and continue or Back. */
export function replaceConfirmBody(input: {
  action: string;
  token: string;
  device: string;
  tierName: string;
}): string {
  return (
    `<p>${escapeHtml(input.device)} will need to sign in again. This device takes its place on your ${escapeHtml(input.tierName)} licence.</p>` +
    `<form method="post" action="${escapeHtml(input.action)}">` +
    `<input type="hidden" name="choice" value="${escapeHtml(input.token)}">` +
    `<div class="actions stack">` +
    `<button class="button danger" type="submit" name="action" value="replace">Replace and continue</button>` +
    `<button class="button secondary" type="submit" name="action" value="back">Back</button>` +
    `</div></form>`
  );
}
