// The error copy catalog (`core.copy`, SDK parity pass §3.2): one human sentence and one short
// title per registry code, gate status and activation result, so a CLI, an Electron renderer and
// a server log describe the same refusal the same way.
//
// ENGLISH IS GENERATED: `../copy.generated.ts` is written by `pnpm gen constants` from
// `conformance/parity/copy.en.json` (checked against errors.json and enums.json), as three
// tables — COPY_CODES (per error code), COPY_GATE (per licenseStatus) and COPY_ACTIVATION (per
// activationResult). `copy.message(code)` looks a code up in that order, after mapping a §3.1
// kind (`device-limit`, `deviceLimit`) to its wire code (`device_limit`); `copy.activation(kind)`
// reads the activation table only (the error code `unauthorized` reads "Not signed in", the
// activation result "Key not accepted"). A code with no entry gives COPY_FALLBACK with `{code}`
// filled in. A raw response body is never used as copy.
//
// More locales are content: `registerCopy("fr", {...})` adds one, keyed by error code, gate
// status or activation result, and a code a locale lacks falls back to the generated English.

import {
  COPY_ACTIVATION,
  COPY_CODES,
  COPY_FALLBACK,
  COPY_GATE,
} from "../copy.generated.js";

/** One entry: a short title and the sentence a host shows. */
export interface CopyEntry {
  title: string;
  message: string;
}

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

const LOCALES = new Map<string, Record<string, CopyEntry>>();
let defaultLocale = "en";

function own(
  table: Readonly<Record<string, CopyEntry>> | undefined,
  key: string,
): CopyEntry | undefined {
  return table && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/** A §3.1 kind in its activationResult spelling (`deviceLimit` → `device-limit`). */
function activationResult(kind: string): string {
  return kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The generated English entry: error code (a kind mapped to its wire code first), then gate
 *  status, then activation result. */
function english(code: string): CopyEntry | undefined {
  return (
    own(COPY_CODES, KIND_ALIASES[code] ?? code) ??
    own(COPY_GATE, code) ??
    own(COPY_ACTIVATION, activationResult(code))
  );
}

/** A registered locale's own entry (`fr-CA` falls back to `fr`); for `en` this is the host's
 *  override layer, never the generated English. */
function localised(code: string, locale?: string): CopyEntry | undefined {
  const tag = (locale ?? defaultLocale).toLowerCase();
  for (const l of [tag, tag.split("-")[0]!]) {
    const table = LOCALES.get(l);
    const entry = own(table, code) ?? own(table, KIND_ALIASES[code] ?? code);
    if (entry) return entry;
  }
  return undefined;
}

/** Fill `{code}` with the code and `{detail}` with ` (detail)`; any other placeholder (a value
 *  this call was not given) is dropped with the space before it, so a raw `{name}` never shows.
 *  A `detail` the sentence has no slot for is appended in parentheses. */
function fill(template: string, code: string, detail?: string): string {
  let used = false;
  const out = template.replace(
    /( ?)\{(\w+)\}/g,
    (_m, space: string, name: string) => {
      if (name === "code") return `${space}${code}`;
      if (name === "detail") {
        used = true;
        return detail ? ` (${detail})` : "";
      }
      return "";
    },
  );
  if (!detail || used) return out;
  return /[.!?]$/.test(out)
    ? `${out.slice(0, -1)} (${detail})${out.slice(-1)}`
    : `${out} (${detail})`;
}

/** The copy catalog. `copy.message("device_limit", "3/3")`. */
export const copy = {
  /** The sentence for `code` (a registry code, a gate status or an activation kind). An
   *  unknown code gives COPY_FALLBACK naming it, never a raw body. */
  message(code: string, detail?: string, locale?: string): string {
    const entry = localised(code, locale) ?? english(code);
    return fill((entry ?? COPY_FALLBACK).message, code, detail);
  },
  /** The short title for `code`. */
  title(code: string, locale?: string): string {
    return (localised(code, locale) ?? english(code) ?? COPY_FALLBACK).title;
  },
  /** The sentence for a typed activation result (`ActivationResult.kind`), from the activation
   *  table only; `code` fills `{code}` (a `refused` result names the server's code). */
  activation(
    kind: string,
    opts: { code?: string; detail?: string; locale?: string } = {},
  ): string {
    const result = activationResult(kind);
    const entry =
      localised(result, opts.locale) ?? own(COPY_ACTIVATION, result);
    if (!entry)
      return copy.message(opts.code ?? kind, opts.detail, opts.locale);
    return fill(entry.message, opts.code ?? kind, opts.detail);
  },
  /** Whether `code` has an entry in a locale (English: a host override or the generated
   *  tables; no fallback). */
  has(code: string, locale = "en"): boolean {
    return (
      localised(code, locale) !== undefined ||
      (locale === "en" && english(code) !== undefined)
    );
  },
  /** Every code the generated English error-code table covers. */
  codes(): string[] {
    return Object.keys(COPY_CODES);
  },
};

/** Add or extend a locale. Entries a locale lacks fall back to the generated English.
 *  `registerCopy("en", {...})` is the host's English override layer: its entries win per key
 *  over the generated text, which stays the default for every key the host does not name. */
export function registerCopy(
  locale: string,
  entries: Record<string, CopyEntry>,
): void {
  const tag = locale.toLowerCase();
  LOCALES.set(tag, { ...(LOCALES.get(tag) ?? {}), ...entries });
}

/** The locale `copy` uses when a call names none (default `en`). */
export function setCopyLocale(locale: string): void {
  defaultLocale = locale;
}
