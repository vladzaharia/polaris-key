/**
 * The portal's library and product views (PX-W1, docs/design/PORTAL.md §10.2 G1, G5, G16):
 *
 *   GET /api/library         every product the signed-in account holds a licence for, ONE entry
 *                            per product: presentation, status, the best licence's summary with
 *                            seats, and the support links.
 *   GET /api/products/<p>    one of those products in full: presentation, `services`, the status,
 *                            and every linked licence with its seats and devices (dormancy
 *                            included), the best one first.
 *
 * ── WHERE EACH FACT COMES FROM ──────────────────────────────────────────────────────────────
 *
 *   presentation   the product's own store listing (`.pkey/distribution`'s root `listing`), read
 *                  through Distribution's `delivery` hook (rule 6: Identity never reads `dist_*`).
 *                  A product without Distribution, or without a listing, falls back to its
 *                  `products.name` and nulls — the portal's letter-and-tint fallback. Art is
 *                  handed out ONLY as a same-origin `/media/…` URL, and only when the media proxy
 *                  would serve it (`mediaUrlFor`), so the page never holds a developer URL.
 *   seats          `deviceLimit` is `licenseDeviceLimit`, the number `authorizeDevice` enforces;
 *                  `activeSeatCount` counts authorized devices seen inside the dormancy window
 *                  (`SEAT_DORMANCY_SECONDS`), the predicate `countActiveDevices` applies at
 *                  activation; a device past it is `dormant` and holds no seat.
 *   status         §5.3's precedence over what the Worker knows today: suspended (the developer
 *                  disabled the licence), expired, device limit reached, expires within 14 days,
 *                  active. The store-, Steam- and grace-dependent statuses arrive with the work
 *                  packages that own those facts (PX-W6, G8).
 *
 * A product the developer has the portal turned off for is absent from both, exactly as from
 * `GET /api/licenses`. Downloads, stores and feeds on the product view are PX-W2's (G2, G4).
 */

import type { Db } from "../../../core/platform.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { seatActiveSince } from "../../../core/data.js";
import type { DeviceRow } from "../../../core/data.js";
import type { PortalHooksFor } from "./api.js";
import { entitlementView } from "./entitlements.js";
import { mediaUrlFor } from "./media.js";
import {
  getPortalProductSettings,
  listPortalLicenses,
  listVisibleDevices,
  type PortalLicenseRow,
} from "./repo.js";

/** §5.3 "Expires soon": inside this many seconds of `expires_at`. */
export const EXPIRES_SOON_SECONDS = 14 * 86400;

/** One product's status, from its best licence (§5.3, the statuses the Worker can decide today). */
export type LibraryStatus =
  | "suspended"
  | "expired"
  | "device_limit"
  | "expires_soon"
  | "active";

/** Best first: the licence a product page opens on, and whose status the library shows. */
const STATUS_RANK: Record<LibraryStatus, number> = {
  active: 0,
  expires_soon: 1,
  device_limit: 2,
  expired: 3,
  suspended: 4,
};

export interface Presentation {
  name: string;
  developerName: string | null;
  tintColor: string | null;
  website: string | null;
  /** Same-origin `/media/<p>/icon?v=…`, or `null` (no art, or art the proxy would not serve). */
  iconUrl: string | null;
  headerUrl: string | null;
  /** G16. `null` when the listing declares neither. */
  support: { url: string | null; email: string | null } | null;
}

interface Seats {
  deviceLimit: number;
  activeSeatCount: number;
  deviceCount: number;
  dormantCount: number;
}

interface ShapedLicense {
  row: PortalLicenseRow;
  devices: DeviceRow[];
  seats: Seats;
  status: LibraryStatus;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The product's presentation, from its listing when Distribution has one (see file comment). */
export async function presentationFor(
  product: ProductPublic,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Presentation> {
  const delivery = hooksFor ? hooksFor(product, now).delivery() : null;
  const listing = delivery
    ? ((await delivery.listing()) as Record<string, unknown> | null)
    : null;
  const supportUrl = str(listing?.supportUrl);
  const supportEmail = str(listing?.supportEmail);
  return {
    name: str(listing?.name) ?? product.name,
    developerName: str(listing?.developerName),
    tintColor: str(listing?.tintColor),
    website: str(listing?.website),
    iconUrl: await mediaUrlFor(product.slug, "icon", listing),
    headerUrl: await mediaUrlFor(product.slug, "header", listing),
    support:
      supportUrl || supportEmail
        ? { url: supportUrl, email: supportEmail }
        : null,
  };
}

/** A device past the dormancy window holds no seat (`SEAT_DORMANCY_SECONDS`). */
function isDormant(device: DeviceRow, now: number): boolean {
  return (
    device.status === "authorized" && device.last_seen <= seatActiveSince(now)
  );
}

export function licenseStatus(
  row: Pick<PortalLicenseRow, "status" | "expires_at">,
  seats: Pick<Seats, "deviceLimit" | "activeSeatCount">,
  now: number,
): LibraryStatus {
  if (row.status !== "active") return "suspended";
  if (row.expires_at !== null && now > row.expires_at) return "expired";
  if (seats.activeSeatCount >= seats.deviceLimit) return "device_limit";
  if (row.expires_at !== null && row.expires_at - now <= EXPIRES_SOON_SECONDS)
    return "expires_soon";
  return "active";
}

async function shapeLicense(
  db: Db,
  product: ProductPublic,
  row: PortalLicenseRow,
  now: number,
): Promise<ShapedLicense> {
  const devices = await listVisibleDevices(db, product.slug, row.id);
  const authorized = devices.filter((d) => d.status === "authorized");
  const dormantCount = authorized.filter((d) => isDormant(d, now)).length;
  const seats: Seats = {
    deviceLimit: await licenseDeviceLimit(db, product, row, now),
    activeSeatCount: authorized.length - dormantCount,
    deviceCount: authorized.length,
    dormantCount,
  };
  return { row, devices, seats, status: licenseStatus(row, seats, now) };
}

/** Best first: status rank, then no expiry, then the later expiry, then the newer activation. */
function compareLicenses(a: ShapedLicense, b: ShapedLicense): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  const ea = a.row.expires_at ?? Number.POSITIVE_INFINITY;
  const eb = b.row.expires_at ?? Number.POSITIVE_INFINITY;
  if (ea !== eb) return eb > ea ? 1 : -1;
  return (b.row.activated_at ?? 0) - (a.row.activated_at ?? 0);
}

function licenseSummary(l: ShapedLicense): Record<string, unknown> {
  return {
    id: l.row.id,
    tier: l.row.tier_id,
    status: l.status,
    licenseStatus: l.row.status,
    activatedAt: l.row.activated_at,
    expiresAt: l.row.expires_at,
    maxOfflineDays: l.row.max_offline_days,
    ...l.seats,
  };
}

/** The account's licences grouped by product, portal-enabled products only, in name order. */
async function groupedLicenses(
  db: Db,
  accountId: string,
  only?: string,
): Promise<Map<string, PortalLicenseRow[]>> {
  const out = new Map<string, PortalLicenseRow[]>();
  for (const row of await listPortalLicenses(db, accountId)) {
    if (only !== undefined && row.product !== only) continue;
    const list = out.get(row.product);
    if (list) list.push(row);
    else out.set(row.product, [row]);
  }
  for (const product of [...out.keys()]) {
    const settings = await getPortalProductSettings(db, product);
    if (settings.portal_enabled !== 1) out.delete(product);
  }
  return out;
}

/**
 * When the account first got this product (for "Recently added"): its first contact with the
 * product, which is when the pairwise subject was created (I-05; a licence attach creates it).
 */
async function addedAt(
  db: Db,
  accountId: string,
  product: string,
): Promise<number | null> {
  const row = await db.first<{ at: number | null }>(
    `SELECT created_at AS at FROM account_product_subjects
      WHERE account_id = ? AND product = ?`,
    accountId,
    product,
  );
  return row?.at ?? null;
}

/** `GET /api/library`. */
export async function libraryView(
  db: Db,
  accountId: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<{ products: Array<Record<string, unknown>> }> {
  const products: Array<Record<string, unknown>> = [];
  for (const [slug, rows] of await groupedLicenses(db, accountId)) {
    const product = await loadProductPublic(db, slug);
    if (!product) continue;
    const shaped: ShapedLicense[] = [];
    for (const row of rows)
      shaped.push(await shapeLicense(db, product, row, now));
    shaped.sort(compareLicenses);
    const best = shaped[0]!;
    products.push({
      product: slug,
      ...(await presentationFor(product, hooksFor, now)),
      status: best.status,
      license: licenseSummary(best),
      licenseCount: shaped.length,
      addedAt: await addedAt(db, accountId, slug),
    });
  }
  return { products };
}

/** `GET /api/products/<p>`, or `null` when the account holds nothing here (a 404). */
export async function productView(
  db: Db,
  accountId: string,
  slug: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Record<string, unknown> | null> {
  const rows = (await groupedLicenses(db, accountId, slug)).get(slug);
  if (!rows || rows.length === 0) return null;
  const product = await loadProductPublic(db, slug);
  if (!product) return null;
  const shaped: ShapedLicense[] = [];
  for (const row of rows)
    shaped.push(await shapeLicense(db, product, row, now));
  shaped.sort(compareLicenses);
  const licenses = [];
  for (const l of shaped) {
    licenses.push({
      ...licenseSummary(l),
      entitlements: await entitlementView(db, l.row, now),
      devices: l.devices
        .filter((d) => d.status === "authorized")
        .map((d) => ({
          deviceId: d.device_id,
          label: d.label,
          platform: d.platform ?? null,
          arch: d.arch ?? null,
          appVersion: d.app_version ?? null,
          firstSeen: d.first_seen,
          lastSeen: d.last_seen,
          dormant: isDormant(d, now),
        })),
    });
  }
  return {
    product: slug,
    ...(await presentationFor(product, hooksFor, now)),
    // Each service's own toggle (§3.1): the product page shows a section only for a service
    // that is on — Cloud Sync and Identity among them as their work packages add them.
    services: Object.fromEntries(
      Object.entries(product.services).map(([s, v]) => [s, v.enabled]),
    ),
    status: shaped[0]!.status,
    addedAt: await addedAt(db, accountId, slug),
    licenses,
  };
}
