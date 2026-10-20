/**
 * The refusal link (PX-W8, G15b; WIRE-CONTRACT-V4 §5.3): the `manageUrl` the Worker puts on a
 * seat refusal (`device_limit`) and, with Identity, on the key-entries refusal
 * (`key_entry_limit`, I-09), so an app can offer "Replace a device" instead of a dead end.
 *
 * It lives in Core because License (activate, enroll) and Identity (session/license, and I-09's
 * key-entry refusal) both build it, and services may not import one another (rule 6).
 *
 * ── WHAT THE LINK CARRIES, AND WHAT IT NEVER DOES ───────────────────────────────────────────
 *
 *   - an attached licence (`licenses.account_id` set):
 *       `<portal>/#/p/<slug>/free-device?license=<licenseId>[&for=<label>]`
 *   - a floating licence:
 *       `<portal>/activate?product=<slug>&next=free-device[&for=<label>]`
 *   - `key_entry_limit`: `<portal>/activate?product=<slug>`
 *
 * Never the key (a client may add `#key=` as a fragment; plans/PX-W8.md Q2), never an account
 * id, subject or holder hint (S-19: the portal session decides what the person can manage),
 * never a hostname, device id or IP. `for` is a coarse platform-and-arch label from the §5.2
 * metadata headers, display text only, sanitised and capped here and again by the portal.
 *
 * The link exists only while the product's customer portal is on; otherwise the member is
 * omitted (PORTAL §4.19). It sits outside every signed document, so `legacy` and `combined`
 * products alike get it with no document byte changing.
 *
 * I-09 adds two more links built from the same origin: `license_owned`'s `signInUrl`
 * (`<portal>/signin?product=<slug>`, the platform-level login card, so always present) and
 * discovery's `accountPortal` (`<portal>/#/p/<slug>`, while the product's portal is on). Neither
 * carries a key, an account or a holder hint.
 */

import {
  MANAGE_FOR_MAX_LENGTH,
  MANAGE_URL_MAX_LENGTH,
} from "@polaris-key/protocol/license";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  customerOrigin,
  customerHostname,
  type CustomerHostMode,
} from "../hosts.js";
import { platformSetting } from "../settings/platformRead.js";
import {
  normalizeArchHeader,
  normalizePlatformHeader,
} from "../clientMetadata.js";
import { HEADER_ARCH, HEADER_PLATFORM } from "@polaris-key/protocol/core";

export type ManageRefusal = "device_limit" | "key_entry_limit";

export interface ManageContext {
  /** The refusal the link rides on. */
  kind: ManageRefusal;
  /** The licence a `device_limit` names (the device's anchor licence, S-19). */
  license?: { id: string; account_id?: string | null } | null;
}

/** Display names for the canonical §5.2 platform values; any other value is shown as sent. */
const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  web: "Web",
  tvos: "tvOS",
  visionos: "visionOS",
};

/** Printable ASCII letters, digits and a few separators; anything else is dropped. */
function cleanLabelPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 ._+\-()]/g, "").trim();
}

/**
 * The coarse device label for `for`: `"<Platform> <arch>"` from the metadata headers (e.g.
 * `macOS arm64`), at most `MANAGE_FOR_MAX_LENGTH` characters, or `null` when the request
 * carries no usable metadata.
 *
 * The one place `for` is chosen. SIGN-IN.md D-49 asks for the PX-W13 device label when known;
 * PX-W13 (the SDK `deviceName`) has not shipped, so this label is the fallback today, and
 * PX-W13 swaps its sanitized label in here, ahead of the platform pair.
 */
export function manageForLabel(req: Request): string | null {
  const platform = normalizePlatformHeader(
    req.headers.get(HEADER_PLATFORM)?.slice(0, 256) ?? null,
  );
  const arch = normalizeArchHeader(
    req.headers.get(HEADER_ARCH)?.slice(0, 256) ?? null,
  );
  const parts: string[] = [];
  if (platform) {
    const named = Object.prototype.hasOwnProperty.call(
      PLATFORM_LABELS,
      platform,
    )
      ? PLATFORM_LABELS[platform]!
      : cleanLabelPart(platform);
    if (named) parts.push(named);
  }
  if (arch) {
    const a = cleanLabelPart(arch);
    if (a) parts.push(a);
  }
  const label = parts.join(" ").slice(0, MANAGE_FOR_MAX_LENGTH).trim();
  return label === "" ? null : label;
}

/**
 * The portal origin: `CONSOLE_ORIGIN` when it is a usable `https:` origin (or `http:` to a
 * loopback host, for local development), else the request's own origin, which serves the
 * root portal (`router.ts`).
 */
export function portalOriginOf(env: Env, req: Request): string | null {
  return portalOriginFor(env, req.url);
}

/**
 * {@link portalOriginOf} for a caller with no request in hand (discovery's fragments): the
 * configured origin, else `fallback` (an absolute URL or origin the Worker was reached on).
 */
export function portalOriginFor(env: Env, fallback: string): string | null {
  return customerOrigin(env, "off", fallback);
}

/**
 * The `customer.host` mode (LK-03): `off` without a read while there is no usable customer host,
 * so a deployment that never sets `CUSTOMER_ORIGIN` costs nothing and every URL is what it was.
 */
export async function customerHostMode(
  env: Env,
  db: Db,
): Promise<CustomerHostMode> {
  if (customerHostname(env) === null) return "off";
  try {
    return await platformSetting(env, db, "customer.host");
  } catch {
    return "off";
  }
}

/**
 * The one source for every customer-facing URL: {@link customerOrigin} with the switch read. The
 * origin of `customerOrigin()` while `customer.host` is on, else the portal origin of old
 * ({@link portalOriginOf}). `fallback` is the request, or an absolute URL the Worker was reached on.
 */
export async function customerOriginOf(
  env: Env,
  db: Db,
  fallback: Request | string,
): Promise<string | null> {
  return customerOrigin(env, await customerHostMode(env, db), fallback);
}

/**
 * Is the product's customer portal on? `portal_product_settings.portal_enabled`, defaulting ON
 * when the product has no row (the same default `getPortalProductSettings` applies). Read
 * here, not through Identity's repo, because Core may not import a service. Becomes the S-18
 * `portal.enabled` row through `resolveSetting()` once ST-14 lands.
 */
export async function portalEnabled(db: Db, product: string): Promise<boolean> {
  const row = await db.first<{ portal_enabled: number }>(
    "SELECT portal_enabled FROM portal_product_settings WHERE product = ?",
    product,
  );
  return row ? row.portal_enabled === 1 : true;
}

const encode = (v: string): string => encodeURIComponent(v);

/**
 * The `manageUrl` for a refusal, or `undefined` when the portal is off or no origin is usable.
 * The caller spreads it into the flat error body only when defined.
 */
export async function buildManageUrl(
  env: Env,
  db: Db,
  req: Request,
  product: { slug: string },
  ctx: ManageContext,
): Promise<string | undefined> {
  if (!(await portalEnabled(db, product.slug))) return undefined;
  const origin = await customerOriginOf(env, db, req);
  if (!origin) return undefined;
  const slug = encode(product.slug);

  let url: string;
  if (ctx.kind === "key_entry_limit") {
    url = `${origin}/activate?product=${slug}`;
  } else {
    const label = manageForLabel(req);
    const forPart = label ? `&for=${encode(label)}` : "";
    const lic = ctx.license;
    url =
      lic && lic.account_id
        ? `${origin}/#/p/${slug}/free-device?license=${encode(lic.id)}${forPart}`
        : `${origin}/activate?product=${slug}&next=free-device${forPart}`;
  }
  return url.length <= MANAGE_URL_MAX_LENGTH ? url : undefined;
}

/**
 * The `signInUrl` of `license_owned` (I-09, WIRE-CONTRACT-V4 §12.2 step 3): the root login card
 * for the product, `<portal>/signin?product=<slug>`. The card is platform-level (one account for
 * every product), so the link does not depend on the product's portal settings. It carries no
 * key, account or holder hint: the card explains how to sign in on the device.
 */
export async function buildSignInUrl(
  env: Env,
  db: Db,
  req: Request,
  product: { slug: string },
): Promise<string> {
  const origin =
    (await customerOriginOf(env, db, req)) ?? new URL(req.url).origin;
  return `${origin}/signin?product=${encode(product.slug)}`;
}

/**
 * The account portal's page for a product, `<portal>/#/p/<slug>` (I-09, §12.6 `accountPortal`):
 * where `openAccount()` sends the person. `null` when no usable origin exists.
 */
export async function accountPortalUrl(
  env: Env,
  db: Db,
  fallbackOrigin: string,
  product: { slug: string },
): Promise<string | null> {
  const origin = await customerOriginOf(env, db, fallbackOrigin);
  return origin ? `${origin}/#/p/${encode(product.slug)}` : null;
}
