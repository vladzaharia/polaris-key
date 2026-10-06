// The error copy catalog (SDK parity pass §3.2, proposed id `core.copy`): one human sentence and
// one short title per registry code, gate status and activation kind, so a CLI, an Electron
// renderer and a server log describe the same refusal the same way.
//
// The English base below is this SDK's copy of the shared base the parity pass plans as
// `conformance/parity/copy.en.json` (SP-00/SP-03, a conformance change still in plan mode). When
// that file lands, `gen:constants` emits it and this table is replaced by the generated one; the
// API does not change. More locales are content: `registerCopy("fr", {...})` adds one, and a code
// a locale lacks falls back to English, then to a generic sentence that names the code. A raw
// response body is never used as copy.

/** One entry: a short title and the sentence a host shows. `{detail}` is replaced. */
export interface CopyEntry {
  title: string;
  message: string;
}

const EN: Record<string, CopyEntry> = {
  // ── Activation kinds (§3.1) and their wire codes ──────────────────────────────────────
  device_limit: {
    title: "Device limit reached",
    message:
      "This licence is already in use on its maximum number of devices{detail}. Free a device from your account, then try again.",
  },
  fingerprint_required: {
    title: "Hardware check needed",
    message:
      "This licence needs a hardware fingerprint, and this device could not produce one.",
  },
  hardware_mismatch: {
    title: "Hardware changed",
    message:
      "This device's hardware changed{detail}, so its previous activation was released. Activate again to re-bind it.",
  },
  enroll_claimed: {
    title: "Sign in to continue",
    message:
      "This device's free licence now belongs to an account. Sign in to use it.",
  },
  enroll_disabled: {
    title: "Free tier unavailable",
    message: "This product does not offer a free licence without a key.",
  },
  license_disabled: {
    title: "Licence disabled",
    message: "This licence was disabled. Contact the seller for help.",
  },
  license_expired: {
    title: "Licence expired",
    message: "This licence has expired. Renew it to keep using the product.",
  },
  attestation_required: {
    title: "Device check required",
    message:
      "This product only runs on devices that can prove their integrity, and this device cannot.",
  },
  rate_limited: {
    title: "Too many attempts",
    message: "Too many attempts. Wait a moment, then try again{detail}.",
  },
  unauthorized: {
    title: "Key not accepted",
    message: "That licence key is not valid, or it was revoked.",
  },
  registration_closed: {
    title: "Activation needed",
    message:
      "This product does not register devices without a licence. Enter a key or sign in.",
  },
  not_entitled: {
    title: "Not included",
    message: "Your licence does not include this.",
  },
  forbidden: {
    title: "Not allowed",
    message: "The server refused this request.",
  },
  not_found: {
    title: "Not found",
    message: "The server does not know this product or resource.",
  },
  bad_request: {
    title: "Request refused",
    message: "The server could not read this request.",
  },
  managed_by_admin: {
    title: "Managed setting",
    message:
      "An administrator manages this setting, so it cannot be changed here.",
  },
  version_blocked: {
    title: "Update required",
    message:
      "This version can no longer be used. Install an update to continue.",
  },
  channel_not_allowed: {
    title: "Channel not included",
    message: "Your licence does not include this release channel.",
  },
  download_auth_required: {
    title: "Licence needed",
    message: "This download needs an active licence on this device.",
  },
  license_owned: {
    title: "Licence owned by another account",
    message:
      "This licence belongs to another account. Sign in with that account to use it.",
  },
  network: {
    title: "No connection",
    message:
      "The server could not be reached. Check the connection and try again.",
  },
  "network-error": {
    title: "No connection",
    message:
      "The server could not be reached. Check the connection and try again.",
  },
  server: {
    title: "Server problem",
    message: "The server had a problem. Try again in a moment.",
  },
  "server-error": {
    title: "Server problem",
    message: "The server had a problem. Try again in a moment.",
  },
  "service-unavailable": {
    title: "Not available",
    message: "This product does not offer that feature.",
  },
  unsupported: {
    title: "Not supported here",
    message: "This feature is not supported on this device{detail}.",
  },
  "local-only": {
    title: "Offline build",
    message: "This build never connects to the server.",
  },
  "payload-mismatch": {
    title: "Download damaged",
    message:
      "The downloaded file did not match its signed record, so it was discarded.",
  },
  "sign-in-expired": {
    title: "Code expired",
    message: "The sign-in code expired. Start again for a new code.",
  },
  "sign-in-denied": {
    title: "Sign-in failed",
    message: "The sign-in was refused or did not complete.",
  },
  // ── Gate statuses (client-core `licenseState`) ────────────────────────────────────────
  ok: { title: "Licensed", message: "This device is licensed." },
  grace: {
    title: "Working offline",
    message:
      "The licence could not be checked recently. It keeps working offline{detail}.",
  },
  expired: {
    title: "Licence expired",
    message: "This licence has expired. Renew it to keep using the product.",
  },
  revoked: {
    title: "Licence revoked",
    message:
      "This licence was revoked on this device. Activate again to continue.",
  },
  "needs-activation": {
    title: "Activation needed",
    message: "Enter a licence key, sign in, or continue with the free tier.",
  },
  "version-too-old": {
    title: "Update required",
    message:
      "This version is too old for your licence. Install an update to continue.",
  },
  "version-too-new": {
    title: "Version not available",
    message: "This version is newer than your licence allows.",
  },
  "channel-not-entitled": {
    title: "Channel not included",
    message: "Your licence does not include this build's release channel.",
  },
  "not-applicable": {
    title: "No licence needed",
    message: "This product does not need a licence.",
  },
};

/** The §3.1 kinds, mapped onto the code their copy lives under. */
const KIND_ALIASES: Record<string, string> = {
  "device-limit": "device_limit",
  "fingerprint-required": "fingerprint_required",
  "hardware-mismatch": "hardware_mismatch",
  "enroll-claimed": "enroll_claimed",
  "enroll-disabled": "enroll_disabled",
  "license-disabled": "license_disabled",
  "license-expired": "license_expired",
  "attestation-required": "attestation_required",
  "rate-limited": "rate_limited",
  deviceLimit: "device_limit",
  fingerprintRequired: "fingerprint_required",
  hardwareMismatch: "hardware_mismatch",
  enrollClaimed: "enroll_claimed",
  enrollDisabled: "enroll_disabled",
  licenseDisabled: "license_disabled",
  licenseExpired: "license_expired",
  attestationRequired: "attestation_required",
  rateLimited: "rate_limited",
};

const LOCALES = new Map<string, Record<string, CopyEntry>>([["en", EN]]);
let defaultLocale = "en";

function lookup(code: string, locale?: string): CopyEntry | null {
  const key = KIND_ALIASES[code] ?? code;
  const tag = locale ?? defaultLocale;
  // `fr-CA` falls back to `fr`, then to English.
  for (const l of [tag, tag.split("-")[0]!, "en"]) {
    const entry = LOCALES.get(l)?.[key];
    if (entry) return entry;
  }
  return null;
}

function fill(template: string, detail?: string): string {
  return template.replace("{detail}", detail ? ` (${detail})` : "");
}

/** The copy catalog. `copy.message("device_limit", "3/3")`. */
export const copy = {
  /** The sentence for `code` (a registry code, a gate status or an activation kind). An
   *  unknown code gives a generic sentence that names it, never a raw body. */
  message(code: string, detail?: string, locale?: string): string {
    const entry = lookup(code, locale);
    if (entry) return fill(entry.message, detail);
    return `Something went wrong (${code}).`;
  },
  /** The short title for `code`. */
  title(code: string, locale?: string): string {
    return lookup(code, locale)?.title ?? "Something went wrong";
  },
  /** Whether a locale has its own entry for `code` (no fallback). */
  has(code: string, locale = "en"): boolean {
    return LOCALES.get(locale)?.[KIND_ALIASES[code] ?? code] !== undefined;
  },
  /** Every code the English base covers. */
  codes(): string[] {
    return Object.keys(EN);
  },
};

/** Add or extend a locale. Entries a locale lacks fall back to English. */
export function registerCopy(
  locale: string,
  entries: Record<string, CopyEntry>,
): void {
  LOCALES.set(locale, { ...(LOCALES.get(locale) ?? {}), ...entries });
}

/** The locale `copy` uses when a call names none (default `en`). */
export function setCopyLocale(locale: string): void {
  defaultLocale = locale;
}
