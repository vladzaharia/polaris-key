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
 *                  `products.name` and nulls — the portal's letter-and-tint fallback. The page
 *                  never holds a developer URL. Art is Polaris Key's hosted copy on the image host
 *                  (HA-07, `core/hostedImages.ts`): the icon of `presentation.icon`, else
 *                  `listing.icon`, and the header of `listing.header`, exactly as the image host's
 *                  `/icon` and `/header` aliases choose them, each at the ladder width its surface
 *                  draws at (`PRESENTATION_WIDTHS`). With hosting off or no image host (HA-10's
 *                  rollback), art is the same-origin `/media/…` proxy URL, and only when the proxy
 *                  would serve it (`mediaUrlFor`), as before HA-07.
 *   seats          `deviceLimit` is `licenseDeviceLimit`, the number `authorizeDevice` enforces;
 *                  `activeSeatCount` counts authorized devices seen inside the dormancy window
 *                  (`SEAT_DORMANCY_SECONDS`), the predicate `countActiveDevices` applies at
 *                  activation; a device past it is `dormant` and holds no seat.
 *   status         §5.3's precedence over what the Worker knows today: suspended (the developer
 *                  disabled the licence), expired, device limit reached, expires within 14 days,
 *                  active. The Steam-key and grace-dependent statuses arrive with the work
 *                  packages that own those facts.
 *   purchase       per licence on the product view only: where it came from (a store purchase,
 *                  the developer, a sign-in, a free auto-issue) and its store grants, read through
 *                  License's `licenseProvenance` hook (`purchase.ts`, PX-W6, G8); `null` with
 *                  License off.
 *
 * A product the developer has the portal turned off for is absent from both, exactly as from
 * `GET /api/licenses`. Downloads, stores and feeds on the product view are PX-W2's (G2, G4).
 */

import type { Db, Env } from "../../../core/platform.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { seatActiveSince } from "../../../core/data.js";
import type { DeviceRow } from "../../../core/data.js";
import {
  PRESENTATION_HEADER_SLOTS,
  PRESENTATION_ICON_SLOTS,
  firstHostedImage,
  hostedImageOrigin,
  hostedImageUrl,
  hostedImages,
} from "../../../core/hostedImages.js";
import type { PortalHooksFor } from "./api.js";
import { entitlementView } from "./entitlements.js";
import { mediaUrlFor } from "./media.js";
import { purchasesFor } from "./purchase.js";
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
  /**
   * The hosted icon on the image host (`https://img…/<p>/a/<sha256>/<w>.webp`, or the original),
   * or `null` when there is no copy. With hosting off (HA-10's rollback) the same-origin
   * `/media/<p>/icon?v=…` proxy URL, or `null` when the proxy would not serve one.
   */
  iconUrl: string | null;
  /** The hosted header art, like `iconUrl`. */
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

/**
 * Where the portal draws a product's art, and so which ladder width it asks for (HA-07: the
 * variant chosen per surface, `core/hostedImages.ts`). The widths are the drawn size at 2x:
 *
 *   library    the tiles' 48 to 64 px icons and their header art (and the library's hero banner);
 *   product    the product page's 112 px icon and its full-width banner;
 *   discover   Discover's tiles, drawn like the library's.
 *
 * `client` is the sign-in request card (§12.7.2's client record): its icon stays the same-origin
 * `/media/<p>/icon` the contract names, which 302s to the hosted copy (`media.ts`).
 */
export type PresentationSurface = "library" | "product" | "discover" | "client";

export const PRESENTATION_WIDTHS: Record<
  Exclude<PresentationSurface, "client">,
  { icon: number; header: number }
> = {
  library: { icon: 128, header: 1280 },
  product: { icon: 256, header: 1920 },
  discover: { icon: 128, header: 1280 },
};

/** The art of one surface: hosted copies, or the rollback's proxy URLs (see the file comment). */
async function presentationArt(
  env: Env,
  db: Db,
  product: ProductPublic,
  listing: Record<string, unknown> | null,
  surface: PresentationSurface,
): Promise<{ iconUrl: string | null; headerUrl: string | null }> {
  if (hostedImageOrigin(env) === null)
    return {
      iconUrl: await mediaUrlFor(product.slug, "icon", listing),
      headerUrl:
        surface === "client"
          ? null
          : await mediaUrlFor(product.slug, "header", listing),
    };
  const images = await hostedImages(env, db, product.slug, [
    ...PRESENTATION_ICON_SLOTS,
    ...PRESENTATION_HEADER_SLOTS,
  ]);
  const icon = firstHostedImage(images, PRESENTATION_ICON_SLOTS);
  const header = firstHostedImage(images, PRESENTATION_HEADER_SLOTS);
  if (surface === "client")
    return {
      // §12.7.2: the same-origin path; `v` moves with the copy, so a new icon is a new URL.
      iconUrl: icon
        ? `/media/${encodeURIComponent(product.slug)}/icon?v=${icon.sha256.slice(0, 16)}`
        : null,
      headerUrl: null,
    };
  const widths = PRESENTATION_WIDTHS[surface];
  return {
    iconUrl: icon ? hostedImageUrl(env, product.slug, icon, widths.icon) : null,
    headerUrl: header
      ? hostedImageUrl(env, product.slug, header, widths.header)
      : null,
  };
}

/** The product's presentation, from its listing when Distribution has one (see file comment). */
export async function presentationFor(
  env: Env,
  db: Db,
  product: ProductPublic,
  hooksFor: PortalHooksFor | undefined,
  now: number,
  surface: PresentationSurface,
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
    ...(await presentationArt(env, db, product, listing, surface)),
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

/**
 * The account's licences for one product, best first (the order the product page uses), with
 * their seats and statuses; empty when it holds none or the portal is off for the product. The
 * passthrough consent view's dry-run anchor reads it (`passthrough/anchor.ts`).
 */
export async function rankedLicensesFor(
  db: Db,
  accountId: string,
  product: ProductPublic,
  now: number,
): Promise<
  Array<{
    row: PortalLicenseRow;
    seats: { deviceLimit: number; activeSeatCount: number };
    status: LibraryStatus;
  }>
> {
  const rows = (await groupedLicenses(db, accountId, product.slug)).get(
    product.slug,
  );
  if (!rows) return [];
  const shaped: ShapedLicense[] = [];
  for (const row of rows)
    shaped.push(await shapeLicense(db, product, row, now));
  return shaped.sort(compareLicenses);
}

/** `GET /api/library`. */
export async function libraryView(
  env: Env,
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
      ...(await presentationFor(env, db, product, hooksFor, now, "library")),
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
  env: Env,
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
  const purchases = await purchasesFor(
    db,
    product,
    shaped.map((l) => l.row.id),
    hooksFor,
    now,
  );
  const licenses = [];
  for (const l of shaped) {
    licenses.push({
      ...licenseSummary(l),
      purchase: purchases.get(l.row.id) ?? null,
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
    ...(await presentationFor(env, db, product, hooksFor, now, "product")),
    // Each service's own toggle (§3.1): the product page shows a section only for a service
    // that is on — Cloud Sync and Identity among them as their work packages add them.
    services: Object.fromEntries(
      Object.entries(product.services).map(([s, v]) => [s, v.enabled]),
    ),
    status: shaped[0]!.status,
    addedAt: await addedAt(db, accountId, slug),
    // PX-10: where the portal's focused flows may send the person back to (`?return=`, §3.3):
    // the product's exact declared browser origins (`web.origins`, P0-05). App schemes join
    // when the manifest can declare them (S-16 I-15); until then a scheme return is refused and
    // the flow ends on the product page.
    returnTo: { origins: [...product.webOrigins], schemes: [] },
    licenses,
  };
}
