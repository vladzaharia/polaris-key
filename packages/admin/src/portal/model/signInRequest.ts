import type {
  AppConsentView,
  LicenseChoice,
  LicenseChoiceView,
  ReplaceView,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { t } from "../../lib/copy.js";

/**
 * The app sign-in card's data model (SIGN-IN.md §3.1, §3.6 to §3.8; PX-14a). Pure: the views the
 * Worker answers go in, the words and facts a step draws come out, so the LicenseChoice rows of
 * `ui-matrix.json` can run against it (test/portalSignInRequestModel.test.ts).
 */

/** §12.7.2: an opaque request handle. */
export const REQUEST_HANDLE_RE = /^rq_[A-Za-z0-9_-]{22}$/;

/** `?request=rq_…` of the card's address, or `null`. Anything else in the query is ignored. */
export function requestHandleFromUrl(
  search: string = window.location.search,
): string | null {
  const raw = new URLSearchParams(search).get("request");
  return raw && REQUEST_HANDLE_RE.test(raw) ? raw : null;
}

// ── The header ─────────────────────────────────────────────────────────────────────────────

export interface HeaderModel {
  variant: "app" | "device";
  /** Draws the neutral frame: the name did not pass the render-time check. */
  verified: boolean;
  /** The listing name; the product slug when it did not verify. Server data, never a query value. */
  name: string;
  developer: string | null;
  product: string;
  where:
    | { glyph: "globe"; text: string }
    | { glyph: "device" | "tv"; text: string }
    | null;
  /** The device-code panel's code. */
  code: string | null;
}

/** A registered origin as the person reads it: the host. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function headerModel(view: SignInRequestView): HeaderModel {
  const { client } = view;
  const label = view.deviceLabel;
  const where: HeaderModel["where"] =
    client.kind === "web"
      ? client.origins[0]
        ? { glyph: "globe", text: hostOf(client.origins[0]) }
        : null
      : label
        ? {
            glyph: client.kind === "device" ? "tv" : "device",
            text: t("signin.header.onDevice", { device: label }),
          }
        : null;
  return {
    variant: client.kind === "device" ? "device" : "app",
    verified: client.nameVerified,
    name: client.appName,
    developer: client.nameVerified ? client.developerName : null,
    product: client.product,
    where,
    code: client.kind === "device" ? view.userCode : null,
  };
}

/** "this browser" or the device's own label: what the seat goes to. */
export function thisDeviceName(view: SignInRequestView): string {
  return view.deviceLabel ?? t("signin.thisBrowser");
}

// ── Licence rows ───────────────────────────────────────────────────────────────────────────

/** ui-core's `LicenseChoiceState` for the states a `LicenseChoiceView` alone decides. */
export type ChoiceState =
  | "many"
  | "one"
  | "current"
  | "keep"
  | "new"
  | "create"
  | "all-full"
  | "mixed"
  | "none";

/**
 * Which card a view draws, in the order ui-core's `licenseChoiceView` decides it (so the matrix
 * rows agree): none, the automatic grant, a picked Create, every row full, Keep, the row the
 * device runs on, a sign-in beside a key licence, one row, many.
 */
export function classifyChoice(
  view: LicenseChoiceView,
  selected: string | null = view.preselected,
): ChoiceState {
  if (view.state === "none") return "none";
  if (view.state === "autoIssue") return "new";
  if (selected === "create" && view.create) return "create";
  const free = view.choices.filter((r) => r.state === "free");
  if (free.length === 0 && !view.keep) return "all-full";
  if (view.keep) return "keep";
  if (view.choices.some((r) => r.current)) return "current";
  const access = new Set(view.choices.map((r) => r.access));
  if (access.has("account") && access.has("seats")) return "mixed";
  return view.choices.length === 1 ? "one" : "many";
}

/** "Lifetime" or "Until 12 Jun 2027". */
export function termText(expiresAt: number | null): string {
  if (expiresAt === null) return t("signin.term.lifetime");
  const date = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(expiresAt * 1000));
  return t("signin.term.until", { date });
}

export interface RowModel {
  id: string;
  title: string;
  pill: string;
  /** "{used} of {limit} devices"; null when the licence has no limit or the mixed rule hides it. */
  devices: string | null;
  meter: { used: number; limit: number } | null;
  /** "{origin} · {term}". */
  meta: string;
  tag: "current" | "full" | null;
  /** A radio: only free rows are. */
  selectable: boolean;
  /** The Replace a device button is offered (a full row the person may replace on). */
  canReplace: boolean;
  /** The portal's Free a device flow, where Replace is not offered. */
  freeDeviceUrl: string | null;
}

/** The origin in plain words; a purchase or store row names none (the store's name is not on the row). */
function originText(row: LicenseChoice, developer: string): string | null {
  switch (row.origin) {
    case "signin":
      return t("signin.choice.origin.signIn");
    case "key":
      return t("signin.choice.origin.keyAdded");
    case "free":
      return t("signin.choice.origin.free");
    case "developer":
      return t("signin.choice.origin.developer", { developer });
    default:
      return null;
  }
}

export function rowModel(
  row: LicenseChoice,
  rows: readonly LicenseChoice[],
  ctx: { product: string; developer: string },
): RowModel {
  // D-54: with a sign-in licence in the list, key and seat licences hide the counter and meter.
  const hasSignIn = rows.some((r) => r.access === "account");
  const showSeats =
    row.seats.limit !== null && (row.access === "account" || !hasSignIn);
  const origin = originText(row, ctx.developer);
  const term = termText(row.expiresAt);
  const full = row.state === "full";
  return {
    id: row.id,
    title: row.name ?? ctx.product,
    pill: row.tierName,
    devices: showSeats
      ? t("signin.choice.devices", {
          used: row.seats.used,
          limit: row.seats.limit ?? 0,
        })
      : null,
    meter: showSeats
      ? { used: row.seats.used, limit: row.seats.limit ?? 0 }
      : null,
    meta: origin ? t("signin.choice.meta", { origin, term }) : term,
    tag: row.current ? "current" : full ? "full" : null,
    selectable: row.state === "free",
    canReplace: full && row.replace?.allowed === true,
    freeDeviceUrl: full && !row.replace?.allowed ? row.freeDeviceUrl : null,
  };
}

// ── Replace a device ───────────────────────────────────────────────────────────────────────

export interface DeviceRowModel {
  id: string;
  label: string;
  meta: string;
  activeNow: boolean;
  thisBrowser: boolean;
  leastRecent: boolean;
}

/** "3 days ago" in the person's language. */
export function whenText(
  epochSeconds: number,
  now: number = Date.now(),
): string {
  const diff = Math.round((epochSeconds * 1000 - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86_400 * 60) return rtf.format(Math.round(diff / 86_400), "day");
  return rtf.format(Math.round(diff / (86_400 * 30)), "month");
}

export function deviceRows(view: ReplaceView, now?: number): DeviceRowModel[] {
  return view.devices.map((d) => ({
    id: d.id,
    label: d.label ?? d.platform ?? d.id,
    meta: t("signin.replace.meta", {
      platform: d.platform ?? "",
      when: whenText(d.lastSeen, now),
    }).replace(/^ · /, ""),
    activeNow: d.activeNow,
    thisBrowser: d.thisBrowser,
    leastRecent: d.leastRecent,
  }));
}

// ── Consent ────────────────────────────────────────────────────────────────────────────────

/** What the person chose on the way to consent. */
export type Chosen =
  | { kind: "license"; row: LicenseChoice; replace: DeviceRowModel | null }
  | { kind: "create"; tierName: string }
  | { kind: "new"; tierName: string }
  | { kind: "app" }
  | { kind: "none" };

export function firstName(name: string | null, email: string | null): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/)[0]!;
  return (email ?? "").split("@")[0] ?? "";
}

/** The consent step's "License for this device" line. */
export function licenseLine(
  chosen: Chosen,
  ctx: { product: string; app: string; device: string },
): string | null {
  switch (chosen.kind) {
    case "none":
      return null;
    case "app":
      return t("signin.consent.licenseInApp", { app: ctx.app });
    case "new":
    case "create":
      return t("signin.consent.newLicense", { tier: chosen.tierName });
    case "license": {
      const license = `${chosen.row.name ?? ctx.product} ${chosen.row.tierName}`;
      if (chosen.replace)
        return t("signin.consent.replaces", {
          license,
          device: chosen.replace.label,
        });
      const term = termText(chosen.row.expiresAt);
      const { used, limit } = chosen.row.seats;
      if (limit === null) return `${license} · ${term}`;
      return t("signin.consent.licenseLine", {
        license,
        term,
        device: ctx.device,
        position: used + 1,
        limit,
      });
    }
  }
}

/** The "{app} will also get" lines: each fact once. */
export function consentLines(view: AppConsentView): string[] {
  const out: string[] = [];
  for (const item of view.items) {
    if (item.kind === "profile") out.push(t("signin.consent.profile"));
    if (item.kind === "cloudSync") out.push(t("signin.consent.cloudSync"));
  }
  return out;
}

/** A redirect the server built, as the page may navigate to it: never `javascript:` or `data:`. */
export function safeRedirect(raw: string): string | null {
  try {
    const u = new URL(raw, window.location.origin);
    return /^(javascript|data|vbscript|file|blob):$/i.test(u.protocol)
      ? null
      : u.href;
  } catch {
    return null;
  }
}
