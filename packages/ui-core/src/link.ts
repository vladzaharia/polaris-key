// DL14: QR codes and links fail closed (docs/design/UI-KITS.md, design language v2).
//
// A link is shown, encoded or opened only after it passes this one validating opener: an
// absolute `https:` URL the server or the integrator supplied (`verificationUri`, the product's
// `deviceCodeUrl`, a refusal's `manageUrl`, a license's `freeDeviceUrl`, a purchase or release
// URL), or `http:` to a loopback host, with no userinfo and no whitespace. The rule is
// client-core's (`isManageUrl`), which every SDK applies the same way. A missing or invalid link
// hides its control and its QR and leaves the rest of the screen working: a kit never makes up a
// URL. A QR appears only where the device cannot browse (a TV, a console, a pad-only screen) or
// for an offline-activation request.

import { isManageUrl } from "@polaris-key/client-core/manage";

import { canBrowse, platformClass, type Platform } from "./input.js";

/** Why a link is drawn: decides whether a QR may stand beside it (DL14 "Where"). */
export type LinkPurpose =
  | "sign-in"
  | "replace-device"
  | "manage"
  | "purchase"
  | "offline-request";

/** What a screen may do with one link. */
export interface LinkVerdict {
  purpose: LinkPurpose;
  /** The link to open, copy or encode; `null` when it is missing or fails validation. */
  url: string | null;
  /** The link as people read it: no scheme, no trailing slash. `null` with `url`. */
  display: string | null;
  /** True when this device may open it (it can browse and the link is valid). */
  open: boolean;
  /** True when a QR of it may be drawn here. */
  qr: boolean;
}

/**
 * The link to open for `raw`, or `null`. An integrator's `deviceCodeUrl` may be written without
 * a scheme (`driftkart.gg/tv`); it is read as `https://`, never as `http://`.
 */
export function validLink(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
    ? raw
    : `https://${raw}`;
  return isManageUrl(candidate) ? candidate : null;
}

/** The address as people read it: the scheme and a trailing slash dropped. */
export function displayLink(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** True when a QR may be drawn for `purpose` on `platform` (DL14 "Where"). */
export function qrAllowed(
  platform: Platform | null,
  purpose: LinkPurpose,
): boolean {
  if (purpose === "offline-request") return true;
  if (purpose === "purchase") return false;
  const c = platformClass(platform);
  return c === "tv" || c === "console";
}

/** The verdict for one link on one platform. */
export function linkVerdict(
  raw: string | null | undefined,
  platform: Platform | null,
  purpose: LinkPurpose,
): LinkVerdict {
  const url = validLink(raw);
  return {
    purpose,
    url,
    display: url === null ? null : displayLink(url),
    open: url !== null && canBrowse(platform),
    qr: url !== null && qrAllowed(platform, purpose),
  };
}

/** DL14 "Expiry": at 0:00 the code view switches to expired locally while any poll finishes. */
export function codeExpired(secondsLeft: number | undefined): boolean {
  return secondsLeft !== undefined && secondsLeft <= 0;
}

/** `m:ss` for a countdown (tabular figures in every kit). */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
