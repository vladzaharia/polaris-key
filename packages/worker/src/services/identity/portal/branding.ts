/**
 * The Polaris Locker branding of a product (ST-14, notes/S-18 §4.10): ONE store, the
 * `branding_json` of the product's `portal_product_settings` row. The Locker reads it into
 * `productBranding` on every library item; `products.branding_json` (always NULL in production)
 * is no longer read, and the migration folded any value it held into this column.
 *
 * The blob also carries `passthroughName` (I-12, the sign-in header name `signInSettings.ts`
 * writes). It is never part of the Locker's branding: the editor neither shows nor clears it, and
 * the Locker never receives it.
 */

import { parseJsonColumn } from "../../../platform/json.js";

/** The fields the console edits and the Locker reads, in editor order. */
export const PORTAL_BRANDING_FIELDS = [
  "developerName",
  "tintColor",
  "tintColorDark",
  "website",
  "supportUrl",
  "supportEmail",
] as const;
export type PortalBrandingField = (typeof PORTAL_BRANDING_FIELDS)[number];

export type PortalBranding = Partial<Record<PortalBrandingField, string>>;

export const DEVELOPER_NAME_MAX = 60;
export const URL_MAX = 300;
export const EMAIL_MAX = 254;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HTTPS_URL = /^https:\/\/[^\s<>"']+$/;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f<>"]/;

function canParseUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/** Why one field was refused; the console words each. */
export type BrandingFieldReason = "type" | "too_long" | "format";

/**
 * The same rules as a JSON Schema (draft-07 subset), published for the editor's docs and pinned
 * against {@link parsePortalBranding} by `test/services/identity/portalSettings.test.ts`.
 */
export const PORTAL_BRANDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    developerName: {
      type: "string",
      minLength: 1,
      maxLength: DEVELOPER_NAME_MAX,
    },
    tintColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    tintColorDark: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    website: { type: "string", maxLength: URL_MAX, pattern: "^https://" },
    supportUrl: { type: "string", maxLength: URL_MAX, pattern: "^https://" },
    supportEmail: { type: "string", maxLength: EMAIL_MAX },
  },
} as const;

export type BrandingParse =
  | { ok: true; branding: PortalBranding }
  | { ok: false; fields: Record<string, BrandingFieldReason> };

/**
 * Validate an editor value: an object of the known fields. An empty string clears a field; any
 * other key is refused (`passthroughName` included, because it is not the editor's to write).
 */
export function parsePortalBranding(value: unknown): BrandingParse {
  if (value === null) return { ok: true, branding: {} };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, fields: { branding: "type" } };
  const fields: Record<string, BrandingFieldReason> = {};
  const out: PortalBranding = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!(PORTAL_BRANDING_FIELDS as readonly string[]).includes(key)) {
      fields[key] = "format";
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") {
      fields[key] = "type";
      continue;
    }
    const v = raw.trim();
    if (v === "") continue;
    const reason = fieldReason(key as PortalBrandingField, v);
    if (reason) fields[key] = reason;
    else out[key as PortalBrandingField] = v;
  }
  return Object.keys(fields).length > 0
    ? { ok: false, fields }
    : { ok: true, branding: out };
}

function fieldReason(
  key: PortalBrandingField,
  v: string,
): BrandingFieldReason | null {
  switch (key) {
    case "developerName":
      if (v.length > DEVELOPER_NAME_MAX) return "too_long";
      return CONTROL.test(v) ? "format" : null;
    case "tintColor":
    case "tintColorDark":
      return HEX_COLOR.test(v) ? null : "format";
    case "website":
    case "supportUrl":
      if (v.length > URL_MAX) return "too_long";
      return HTTPS_URL.test(v) && canParseUrl(v) ? null : "format";
    case "supportEmail":
      if (v.length > EMAIL_MAX) return "too_long";
      return EMAIL.test(v) ? null : "format";
  }
}

/** The stored blob without the sign-in header name: what the Locker and the editor see. */
export function publicBranding(raw: unknown): PortalBranding | null {
  const stored = typeof raw === "string" ? parseJsonColumn(raw) : raw;
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored))
    if (k !== "passthroughName") out[k] = v;
  return Object.keys(out).length > 0 ? (out as PortalBranding) : null;
}

/**
 * The blob to store for an edited branding: the validated fields plus the stored
 * `passthroughName`, which the editor does not touch. `null` when nothing is left to store.
 */
export function storedBranding(
  edited: PortalBranding,
  currentJson: string | null,
): Record<string, unknown> | null {
  const current = parseJsonColumn(currentJson);
  const passthrough =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>).passthroughName
      : undefined;
  const next: Record<string, unknown> = { ...edited };
  if (passthrough !== undefined) next.passthroughName = passthrough;
  return Object.keys(next).length > 0 ? next : null;
}
