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
 *   page     "Choose a license for this device": one row per candidate, rank-first preselected
 *            (no expiry first, then the latest expiry, then the oldest; I-09 §2.4), full rows
 *            as labelled groups with no radio, offering **Replace a device** (the shared
 *            `freeAccountDevice`) and a
 *            **Free a device** link to the portal's focused flow (PX-10), and **Create a new
 *            free license** only when the policy would auto-issue and every row is full.
 *            Copy and row anatomy: docs/design/SIGN-IN.md §3.6, §3.7 and O-17 (`signin.choice.*`,
 *            `signin.replace.*`).
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
  listVisibleKeys,
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

/** Whether the chooser's account is still active and still holds the `oidc` link for `sub`. */
export async function choiceAccountStillLinked(
  db: Db,
  accountId: string,
  sub: string,
): Promise<boolean> {
  const account = await getAccountRow(db, accountId);
  if (!account || account.status !== "active") return false;
  const link = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM account_links
      WHERE account_id = ? AND subject = ? AND kind = 'oidc' AND tenant_scope = ''`,
    accountId,
    sub,
  );
  return link !== null;
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
  /**
   * How the licence came to be, in plain words: "From signing in", "Steam key", "From Steam",
   * "Added with a key", "Free", "From the developer". Display only; never authorises anything.
   * Every licence is account-bound, so none is labelled by type (owner decision, 2026-10-05).
   */
  origin: string;
  /** A licence created by signing in (origin `oidc`). Display only: beside one, the other rows
   *  hide their device counter (O-17). */
  fromSignIn: boolean;
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
  create: { tierName: string | null; limit: number } | null;
}

/** "Active now": seen in the last 10 minutes (owner decision §B). */
export const ACTIVE_NOW_SECONDS = 600;

const STORE_NAMES: Record<string, string> = {
  "app-store": "App Store",
  play: "Google Play",
  steam: "Steam",
};

/**
 * The row's origin (owner, 2026-10-05): a key bought on a store names the store with the key
 * ("Steam key"), a store-bound licence with no key reads "From Steam", any other key "Added with
 * a key". Only the store's name is shown, never an order id or purchase key. The key's last
 * characters aren't kept (G7), so "ending 3WPLDA" waits for them.
 */
export function originLabel(
  kind: PurchaseSourceKind,
  store: string | null,
  hasKey: boolean,
): string {
  const storeLabel =
    kind === "store" ? (store ? (STORE_NAMES[store] ?? store) : null) : null;
  if (hasKey) return storeLabel ? `${storeLabel} key` : "Added with a key";
  switch (kind) {
    case "store":
      // "From the App Store", "From Steam", "From Google Play".
      return `From ${store === "app-store" ? "the App Store" : (storeLabel ?? "a store")}`;
    case "sign_in":
      return "From signing in";
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
    const kind = source ? source.kind : originKind(l.origin);
    const hasKey = (await listVisibleKeys(db, product.slug, l.id)).length > 0;
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
      tierName: tier?.label ?? (l.tier_id ? l.tier_id : "License"),
      origin: originLabel(kind, source?.store ?? null, hasKey),
      fromSignIn: kind === "sign_in",
      seats: { used, limit },
      expiresAt: l.expires_at,
      activatedAt: l.activated_at,
      state,
      ...(strict
        ? {
            blockedReason:
              "This license needs a device check that this sign-in can't do.",
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
    // The limit the new licence would get: its tier resolved like any licence's, read-only.
    const limit = await licenseDeviceLimit(
      db,
      product,
      {
        product: product.slug,
        id: "",
        status: "active",
        sub: null,
        name: null,
        email: null,
        groups_json: null,
        tier_id: input.grantTierId ?? null,
        activated_at: now,
        expires_at: null,
        max_offline_days: null,
        overrides_json: null,
        channels_json: null,
        min_version: null,
        max_version: null,
        modified_by: null,
        modified_at: now,
      } satisfies LicenseRow,
      now,
    );
    create = { tierName: tier?.label ?? null, limit };
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

/** `signin.choice.devices`: "{used} of {limit} devices". */
function devicesText(seats: { used: number; limit: number }): string {
  return `${seats.used} of ${seats.limit} device${seats.limit === 1 ? "" : "s"}`;
}

/** `signin.replace.meta`'s "last used {when}". */
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
  | { kind: "unavailable" };

function noticeHtml(notice: ChoiceNotice | null | undefined): string {
  if (!notice) return "";
  switch (notice.kind) {
    case "rate_limited": {
      // signin.replace.rateLimited
      const wait = Math.max(1, Math.floor(notice.retryAfter));
      return `<p class="alert" role="alert">Too many device changes. Try again in ${wait} second${wait === 1 ? "" : "s"}.</p>`;
    }
    case "unavailable":
      // signin.choice.raced
      return `<p class="alert" role="alert">That seat was just taken. Choose again.</p>`;
  }
}

function meta(parts: string[], id?: string): string {
  return `<span class="choice-meta"${id ? ` id="${escapeHtml(id)}"` : ""}>${parts.map(escapeHtml).join(" · ")}</span>`;
}

/** An id fragment safe in an attribute and unique per row. */
function domId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * One licence row (SIGN-IN.md §3.6, O-17): the title (the product name) and its tag, the tier
 * pill with "{used} of {limit} devices", and the meta "{origin} · {term}". A free row is a native
 * radio; a full or blocked row has no radio and is a labelled `role="group"` described by its tag
 * or reason, never `aria-disabled`, so its **Replace a device** stays operable (§3.14, D-94).
 */
function rowHtml(
  row: LegacyChoiceRow,
  checked: boolean,
  now: number,
  ctx: { productName: string; hideCounter: boolean; thisDevice: string },
): string {
  const term =
    row.expiresAt === null
      ? "Lifetime" // signin.term.lifetime
      : `Until ${formatDay(row.expiresAt)}`; // signin.term.until
  const selectable = row.state === "free";
  const titleId = domId("lic", row.id);
  const noteId = domId("lic-note", row.id);
  const note =
    row.state === "full"
      ? `<span class="tag" id="${noteId}">No free devices</span>` // signin.choice.tag.full
      : "";
  const reason =
    row.state === "blocked"
      ? `<span class="choice-note" id="${noteId}">${escapeHtml(row.blockedReason ?? "Not available for this sign-in")}</span>`
      : "";
  // A key or store licence hides its counter beside a sign-in licence (O-17); a full one keeps
  // its "No free devices" tag.
  const counter =
    ctx.hideCounter && !row.fromSignIn
      ? ""
      : `<span class="choice-seats">${escapeHtml(devicesText(row.seats))}</span>`;
  const body =
    `<span class="choice-body">` +
    `<span class="choice-title"><span id="${titleId}">${escapeHtml(ctx.productName)}</span>${note}</span>` +
    `<span class="choice-title tiered"><span class="tag">${escapeHtml(row.tierName)}</span>${counter}</span>` +
    meta([row.origin, term]) + // signin.choice.meta
    reason +
    `</span>`;
  if (selectable) {
    const radio = `<input type="radio" name="license" value="${escapeHtml(row.id)}"${checked ? " checked" : ""}>`;
    return `<li><label class="choice">${radio}${body}</label></li>`;
  }
  const head = `<div class="choice is-disabled">${body}</div>`;
  let replace = "";
  if (row.state === "full" && row.replace && row.replace.length > 0) {
    const devices = row.replace
      .map((d) => {
        const tags = [
          d.leastRecent ? "Least recent" : null, // signin.replace.leastRecent
          d.activeNow ? "Active now" : null, // signin.replace.activeNow
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
      `<details class="replace"><summary>Replace a device</summary>` + // signin.replace.open
      `<p class="muted small">Choose a device to sign out. ${escapeHtml(ctx.thisDevice)} takes its seat.</p>` + // signin.replace.lede
      devices +
      `<button class="button secondary" type="submit" name="action" value="replace:${escapeHtml(row.id)}">Replace…</button>` + // signin.replace.openSystem
      `</details>`;
  }
  const free = row.freeDeviceUrl
    ? `<p class="small"><a href="${escapeHtml(row.freeDeviceUrl)}" target="_blank" rel="noopener noreferrer">Free a device</a></p>` // signin.choice.freeDevice
    : "";
  return `<li><div role="group" aria-labelledby="${titleId}" aria-describedby="${noteId}">${head}${replace}${free}</div></li>`;
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
  /** The label is client-supplied (`deviceName`), so the page says where it came from. Only the
   *  device-code flow has one; the browser flow signs in "this browser". */
  namedByDevice?: boolean;
  /** The developer's name from the product's listing, when it has one (§5.2 `{developer}`). */
  developerName?: string | null;
}): string {
  const { view } = input;
  // signin.choice.noneReplaceable
  const dev = input.developerName?.trim() || null;
  const noneReplaceable = `<p class="notice">${escapeHtml(
    `${dev ?? "The developer"} manages devices for these licenses. Ask ${dev ?? "the developer"} to free one, or use another license.`,
  )}</p>`;
  const ctx = {
    productName: input.productName,
    hideCounter: view.rows.some((r) => r.fromSignIn),
    thisDevice: input.namedByDevice ? input.deviceLabel : "This browser",
  };
  const rows = view.rows
    .map((r) => rowHtml(r, view.preselected === r.id, input.now, ctx))
    .join("");
  const create = view.create
    ? `<li><label class="choice"><input type="radio" name="license" value="create"${view.preselected === "create" ? " checked" : ""}>` +
      `<span class="choice-body">` +
      // signin.choice.create, signin.choice.tag.new
      `<span class="choice-title">Create a new free license<span class="tag">New</span></span>` +
      `<span class="choice-title tiered">${view.create.tierName ? `<span class="tag">${escapeHtml(view.create.tierName)}</span>` : ""}<span class="choice-seats">${escapeHtml(devicesText({ used: 1, limit: view.create.limit }))}</span></span>` +
      meta(["A separate license", "created when you continue"]) + // signin.choice.createMeta
      `</span></label></li>`
    : "";
  const canContinue = view.preselected !== null;
  const allFull =
    view.rows.length > 0 && view.rows.every((r) => r.state === "full");
  const replaceable = view.rows.some((r) => r.replace && r.replace.length > 0);
  // signin.choice.allFull / allFullCreate, or noneReplaceable when no row offers Replace.
  const fullNotice = !allFull
    ? ""
    : replaceable
      ? `<p class="notice">${
          view.create
            ? "Your licenses are on all their devices. Replace a device, or create a new free license."
            : "Your licenses are on all their devices. Replace a device to use one here."
        }</p>`
      : view.create
        ? ""
        : noneReplaceable;
  const empty = view.rows.length === 0 && !view.create ? noneReplaceable : "";
  // signin.choice.lede / signin.choice.ledeBrowser
  const lede = input.namedByDevice
    ? `${input.productName} will use it on ${input.deviceLabel}.`
    : `${input.productName} will use it in this browser.`;
  return (
    `<p class="muted">${escapeHtml(lede)}</p>` +
    (input.namedByDevice
      ? `<dl><dt>Device</dt><dd>${escapeHtml(input.deviceLabel)}<span class="hint">Named by the device</span></dd></dl>`
      : "") +
    noticeHtml(input.notice) +
    fullNotice +
    `<form method="post" action="${escapeHtml(input.action)}">` +
    `<input type="hidden" name="choice" value="${escapeHtml(input.token)}">` +
    // signin.choice.group
    `<fieldset class="choices"><legend class="sr-only">Licenses for ${escapeHtml(input.productName)}</legend><ul class="choices">${rows}${create}</ul></fieldset>` +
    empty +
    `<div class="actions stack">` +
    (canContinue
      ? `<button class="button" type="submit" name="action" value="use">Use this license and continue</button>` // signin.choice.continue
      : "") +
    `<button class="button secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>` +
    `</div></form>`
  );
}

/**
 * The Replace confirmation (SIGN-IN.md §3.7): one device, one consequence naming both devices,
 * the in-use warning when it is Active now, **Replace and continue** (the primary, not a danger
 * button) or **Back**.
 */
export function replaceConfirmBody(input: {
  action: string;
  token: string;
  device: string;
  productName: string;
  /** This installation, as the sentence names it ("this browser", "Steam Deck"). */
  thisDevice: string;
  activeNow: boolean;
}): string {
  const d = escapeHtml(input.device);
  return (
    // signin.replace.consequence
    `<p>${d} signs out of ${escapeHtml(input.productName)} and ${escapeHtml(input.thisDevice)} takes its seat. ${d} can sign in again later if a seat is free. We'll email you about it.</p>` +
    (input.activeNow
      ? `<p class="alert" role="alert">${d} is in use right now.</p>` // signin.replace.inUse
      : "") +
    `<form method="post" action="${escapeHtml(input.action)}">` +
    `<input type="hidden" name="choice" value="${escapeHtml(input.token)}">` +
    `<div class="actions stack">` +
    `<button class="button" type="submit" name="action" value="replace">Replace and continue</button>` + // signin.replace.confirm
    `<button class="button secondary" type="submit" name="action" value="back">Back</button>` + // signin.replace.back
    `</div></form>`
  );
}
