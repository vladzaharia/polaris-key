/**
 * New license (LX-29): the wizard's draft, its rules and the request bodies. Pure: no React.
 *
 * The draft lives in `sessionStorage` per product, so a refresh or a trip to Tiers resumes it;
 * the step lives in the URL. Nothing here knows whether an email has an account (S-24 D4).
 */

import type {
  CreateLicenseBatchBody,
  CreateLicenseBody,
} from "../../../../api.js";
import { toSeconds } from "../../../../lib/format.js";
import { versionRangeError } from "../../../../lib/version.js";
import {
  EMAIL_RE,
  MAX_OFFLINE_DAYS,
  MIN_OFFLINE_DAYS,
} from "../components/shared.js";

export type StepId = "tier" | "holder" | "limits" | "delivery" | "review";
export const STEP_IDS: readonly StepId[] = [
  "tier",
  "holder",
  "limits",
  "delivery",
  "review",
];

export type Who = "person" | "anyone";
export type Delivery = "email-show" | "email" | "show" | "csv";
export type ExpiryMode = "tier" | "none" | "date";

export const MAX_BATCH = 500;
export const MAX_DEVICE_LIMIT = 1000;

export interface Draft {
  tier: string | null;
  who: Who;
  name: string;
  email: string;
  /** Anyone with the key: how many keys (1 to 500). */
  count: number | null;
  /** More than one key: the batch's label. */
  label: string;
  devices: "inherit" | "set";
  deviceLimit: number | null;
  expiryMode: ExpiryMode;
  /** Epoch ms, the end of the chosen local day. */
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string;
  maxVersion: string;
  /** What the operator chose; `deliveryOf` falls back when it does not fit who and count. */
  delivery: Delivery | null;
}

export const EMPTY: Draft = {
  tier: null,
  who: "person",
  name: "",
  email: "",
  count: 1,
  label: "",
  devices: "inherit",
  deviceLimit: null,
  expiryMode: "tier",
  expiresAt: null,
  maxOfflineDays: null,
  channels: [],
  minVersion: "",
  maxVersion: "",
  delivery: null,
};

export type Errors = Partial<Record<keyof Draft, string>>;

export const isBatch = (d: Draft): boolean =>
  d.who === "anyone" && (d.count ?? 1) > 1;

/** The deliveries that fit, in the order they are offered; the first is the default. */
export function deliveriesFor(d: Draft): Delivery[] {
  if (d.who === "person") return ["email-show", "email", "show"];
  return isBatch(d) ? ["csv"] : ["show", "csv"];
}

export const deliveryOf = (d: Draft): Delivery => {
  const fits = deliveriesFor(d);
  return d.delivery && fits.includes(d.delivery) ? d.delivery : fits[0]!;
};

export const emailsKey = (d: Draft): boolean =>
  d.who === "person" &&
  (deliveryOf(d) === "email-show" || deliveryOf(d) === "email");

export function validateHolder(d: Draft): Errors {
  const e: Errors = {};
  if (d.who === "person") {
    if (!d.email.trim()) e.email = "Enter their email.";
    else if (!EMAIL_RE.test(d.email.trim()))
      e.email = "Enter a valid email address.";
    return e;
  }
  const n = d.count;
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_BATCH)
    e.count = `Use a whole number from 1 to ${MAX_BATCH}.`;
  else if (n > 1) {
    const label = d.label.trim();
    if (!label) e.label = "Name the batch.";
    else if (label.length > 80 || /[\r\n]/.test(label))
      e.label = "Use 80 characters or fewer, on one line.";
    if (!d.tier) e.tier = "A batch needs a tier. Go back and choose one.";
  }
  return e;
}

export function validateLimits(d: Draft): Errors {
  const e: Errors = {};
  if (
    d.devices === "set" &&
    (d.deviceLimit === null ||
      !Number.isInteger(d.deviceLimit) ||
      d.deviceLimit < 1 ||
      d.deviceLimit > MAX_DEVICE_LIMIT)
  )
    e.deviceLimit = `Use a whole number from 1 to ${MAX_DEVICE_LIMIT}.`;
  if (d.expiryMode === "date" && d.expiresAt === null)
    e.expiresAt = "Choose the expiry date.";
  if (
    d.maxOfflineDays !== null &&
    (!Number.isInteger(d.maxOfflineDays) ||
      d.maxOfflineDays < MIN_OFFLINE_DAYS ||
      d.maxOfflineDays > MAX_OFFLINE_DAYS)
  )
    e.maxOfflineDays = `Use a whole number of days from ${MIN_OFFLINE_DAYS} to ${MAX_OFFLINE_DAYS}.`;
  const range = versionRangeError(d.minVersion, d.maxVersion);
  if (range)
    e[range.field === "min" ? "minVersion" : "maxVersion"] = range.message;
  return e;
}

/** The first step with an error, for Review's Create (a draft restored from storage). */
export function firstInvalid(d: Draft): StepId | null {
  if (Object.keys(validateHolder(d)).length) return "holder";
  if (Object.keys(validateLimits(d)).length) return "limits";
  return null;
}

/** The terms every body shares: only what the operator stated. */
function terms(
  d: Draft,
): Omit<CreateLicenseBatchBody, "label" | "count" | "tier"> {
  const out: Omit<CreateLicenseBatchBody, "label" | "count" | "tier"> = {};
  // "The tier's term" without a tier is no expiry, said explicitly.
  const mode = d.expiryMode === "tier" && !d.tier ? "none" : d.expiryMode;
  if (mode === "none") out.expiresAt = null;
  else if (mode === "date" && d.expiresAt !== null)
    out.expiresAt = toSeconds(d.expiresAt);
  if (d.devices === "set" && d.deviceLimit !== null)
    out.deviceLimit = d.deviceLimit;
  if (d.maxOfflineDays !== null) out.maxOfflineDays = d.maxOfflineDays;
  if (d.channels.length) out.channels = d.channels;
  if (d.minVersion.trim()) out.minVersion = d.minVersion.trim();
  if (d.maxVersion.trim()) out.maxVersion = d.maxVersion.trim();
  return out;
}

/** `POST …/licenses`: assigned (an email, a name when given) or one floating key. */
export function createBody(d: Draft): CreateLicenseBody {
  const body: CreateLicenseBody = {};
  if (d.who === "person") {
    body.email = d.email.trim();
    if (d.name.trim()) body.name = d.name.trim();
    if (emailsKey(d)) body.delivery = { email: true };
  }
  if (d.tier) body.tier = d.tier;
  return Object.assign(body, terms(d));
}

/** `POST …/batches`: floating keys under one label (the tier is required; validated before). */
export function batchBody(d: Draft): CreateLicenseBatchBody {
  return {
    label: d.label.trim(),
    count: d.count ?? 1,
    tier: d.tier ?? "",
    ...terms(d),
  };
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  "key",
  "license_id",
  "product",
  "tier",
  "device_limit",
  "expires_at",
  "batch",
] as const;

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvRow {
  key: string;
  licenseId: string;
  product: string;
  tier: string;
  deviceLimit: number | null;
  /** Epoch seconds, or null for never. */
  expiresAt: number | null;
  batch: string;
}

/** Built in the browser from the one response; the Worker cannot answer the keys again. */
export function csvOf(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows)
    lines.push(
      [
        r.key,
        r.licenseId,
        r.product,
        r.tier,
        r.deviceLimit === null ? "" : String(r.deviceLimit),
        r.expiresAt === null ? "" : new Date(r.expiresAt * 1000).toISOString(),
        r.batch,
      ]
        .map(csvCell)
        .join(","),
    );
  return `${lines.join("\r\n")}\r\n`;
}

// ── Storage ────────────────────────────────────────────────────────────────────────────────────

const storeKey = (slug: string): string => `pk-new-license:${slug}`;

export function loadDraft(slug: string): Draft {
  try {
    const raw = sessionStorage.getItem(storeKey(slug));
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown, fallback: string): string =>
      typeof v === "string" ? v : fallback;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const pick = <T extends string>(
      v: unknown,
      allowed: readonly T[],
      fallback: T,
    ): T => (allowed.includes(v as T) ? (v as T) : fallback);
    return {
      tier: typeof p.tier === "string" ? p.tier : null,
      who: pick(p.who, ["person", "anyone"], "person"),
      name: str(p.name, ""),
      email: str(p.email, ""),
      count: p.count === null ? null : (num(p.count) ?? 1),
      label: str(p.label, ""),
      devices: pick(p.devices, ["inherit", "set"], "inherit"),
      deviceLimit: num(p.deviceLimit),
      expiryMode: pick(p.expiryMode, ["tier", "none", "date"], "tier"),
      expiresAt: num(p.expiresAt),
      maxOfflineDays: num(p.maxOfflineDays),
      channels: Array.isArray(p.channels)
        ? p.channels.filter((c): c is string => typeof c === "string")
        : [],
      minVersion: str(p.minVersion, ""),
      maxVersion: str(p.maxVersion, ""),
      delivery:
        p.delivery === null || p.delivery === undefined
          ? null
          : pick<Delivery>(
              p.delivery,
              ["email-show", "email", "show", "csv"],
              "show",
            ),
    };
  } catch {
    return EMPTY;
  }
}

export function saveDraft(slug: string, d: Draft): void {
  try {
    if (JSON.stringify(d) === JSON.stringify(EMPTY))
      sessionStorage.removeItem(storeKey(slug));
    else sessionStorage.setItem(storeKey(slug), JSON.stringify(d));
  } catch {
    // Storage is a convenience; a refused write only loses the resume.
  }
}

export const dirty = (d: Draft): boolean =>
  JSON.stringify(d) !== JSON.stringify(EMPTY);

/** The expiry in words, for Review. */
export function expiryWords(d: Draft, tierTerm: number | null): string {
  const mode = d.expiryMode === "tier" && !d.tier ? "none" : d.expiryMode;
  if (mode === "none") return "Never";
  if (mode === "date")
    return d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "—";
  return tierTerm !== null ? `${tierTerm} days from today` : "Never";
}
