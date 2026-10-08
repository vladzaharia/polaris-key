/**
 * The portal's library and product views (PX-W1, docs/design/PORTAL.md §10.2 G1, G5, G16):
 *
 *   GET /api/library         every product the signed-in account holds a licence for, ONE entry
 *                            per product: presentation, status, the best licence's summary with
 *                            seats, and the support links (`kind: "license"`); then every library
 *                            entry (PS-04, `kind: "entry"`): an open product added from the
 *                            storefront with no licence behind it, until a licence exists.
 *   GET /api/products/<p>    one of those products in full: presentation, `services`, the status,
 *                            and every linked licence with its seats and devices (dormancy
 *                            included), the best one first; an entry's product with no licences.
 *   DELETE /api/library/<p>  remove a library ENTRY (PS-04). A licence leaves the library only by
 *                            the existing detach (`accounts/claim.ts`), never here.
 *
 * ── WHERE EACH FACT COMES FROM ──────────────────────────────────────────────────────────────
 *
 *   presentation   the product's own store listing (`.pkey/distribution`'s root `listing`), read
 *                  through Distribution's `delivery` hook (rule 6: Identity never reads `dist_*`).
 *                  A product without Distribution, or without a listing, falls back to its
 *                  `products.name` and nulls — the portal's letter-and-tint fallback. The name,
 *                  developer and tint are discovery's `core.presentation` text half
 *                  (`core/presentation.ts` `presentationText`, HA-12), so the tint follows a
 *                  declared `.pkey/product` `presentation.accent` before the listing's
 *                  `tintColor`, as the SDK kits do (UI-KITS §1.2). The page
 *                  never holds a developer URL. Art is Polaris Key's hosted copy on the image host
 *                  (HA-07, `core/hostedImages.ts`): the icon of `presentation.icon`, else
 *                  `listing.icon`, and the header of `listing.header`, exactly as the image host's
 *                  `/icon` and `/header` aliases choose them, each at the ladder width its surface
 *                  draws at (`PRESENTATION_WIDTHS`). PER SLOT, a slot with no copy the image host
 *                  would serve (a product not resynced since HA-05, a first pull in flight) gets
 *                  what it got before HA-07: the same-origin `/media/…` proxy URL, and only when
 *                  the proxy would serve it (`mediaUrlFor`), so art never vanishes on deploy. With
 *                  hosting off or no image host (HA-10's rollback), every slot gets that.
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
import { presentationText } from "../../../core/presentation.js";
import { err, notFound, portalJson, type PortalHooksFor } from "./api.js";
import { entitlementView } from "./entitlements.js";
import { mediaUrlFor } from "./media.js";
import { purchasesFor } from "./purchase.js";
import {
  getPortalProductSettings,
  holdsProduct,
  listHeldProducts,
  listLibraryEntries,
  listPortalLicenses,
  listVisibleDevices,
  portalAudit,
  removeLibraryEntry,
  type LibraryEntryRow,
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
   * The hosted icon on the image host (`https://img…/<p>/a/<sha256>/<w>.webp`, or the original).
   * Without a copy (or with hosting off, HA-10's rollback) the same-origin `/media/<p>/icon?v=…`
   * proxy URL, or `null` when the proxy would not serve one either.
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

/** The product's own store listing, read through Distribution's `delivery` hook, or `null`. */
export async function productListing(
  product: ProductPublic,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Record<string, unknown> | null> {
  const delivery = hooksFor ? hooksFor(product, now).delivery() : null;
  return delivery
    ? ((await delivery.listing()) as Record<string, unknown> | null)
    : null;
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

/** The art of one surface: hosted copies, else per slot the proxy URLs (see the file comment). */
async function presentationArt(
  env: Env,
  db: Db,
  product: ProductPublic,
  listing: Record<string, unknown> | null,
  surface: PresentationSurface,
): Promise<{ iconUrl: string | null; headerUrl: string | null }> {
  if ((await hostedImageOrigin(env, db)) === null)
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
  // A slot without a copy keeps its pre-HA-07 art: the proxy URL (`media.ts` proxies it too).
  const proxied = (asset: "icon" | "header") =>
    mediaUrlFor(product.slug, asset, listing);
  if (surface === "client")
    return {
      // §12.7.2: the same-origin path; `v` moves with the copy, so a new icon is a new URL.
      iconUrl: icon
        ? `/media/${encodeURIComponent(product.slug)}/icon?v=${icon.sha256.slice(0, 16)}`
        : await proxied("icon"),
      headerUrl: null,
    };
  const widths = PRESENTATION_WIDTHS[surface];
  return {
    iconUrl:
      (icon && hostedImageUrl(env, product.slug, icon, widths.icon)) ||
      (await proxied("icon")),
    headerUrl:
      (header && hostedImageUrl(env, product.slug, header, widths.header)) ||
      (await proxied("header")),
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
  return presentationOf(
    env,
    db,
    product,
    await productListing(product, hooksFor, now),
    surface,
  );
}

/** The presentation from a listing already read (`productListing`), drawn for `surface`. */
export async function presentationOf(
  env: Env,
  db: Db,
  product: ProductPublic,
  listing: Record<string, unknown> | null,
  surface: PresentationSurface,
): Promise<Presentation> {
  const supportUrl = str(listing?.supportUrl);
  const supportEmail = str(listing?.supportEmail);
  const text = presentationText(product, listing);
  return {
    name: text.name,
    developerName: text.developerName,
    tintColor: text.accent,
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

/**
 * The account's library entries the library shows (PS-04, notes/S-21 §6.4), oldest first, with
 * their products: an entry is dropped once the account holds any licence for the product (the
 * licence is the library item then), and, like a licence, while the product is gone or the
 * developer has the portal off for it.
 */
async function shownEntries(
  db: Db,
  accountId: string,
  only?: string,
): Promise<Array<{ entry: LibraryEntryRow; product: ProductPublic }>> {
  const entries = await listLibraryEntries(db, accountId, only);
  if (entries.length === 0) return [];
  const licensed = await listHeldProducts(db, accountId);
  const out: Array<{ entry: LibraryEntryRow; product: ProductPublic }> = [];
  for (const entry of entries) {
    if (licensed.has(entry.product)) continue;
    const settings = await getPortalProductSettings(db, entry.product);
    if (settings.portal_enabled !== 1) continue;
    const product = await loadProductPublic(db, entry.product);
    if (product) out.push({ entry, product });
  }
  return out;
}

/**
 * The fields an entry's library item and product view carry in place of a licence's: it is
 * always `active` (there is nothing to expire, suspend or fill), holds no licence, and was added
 * when the entry was written.
 */
function entryFields(entry: LibraryEntryRow): Record<string, unknown> {
  return {
    kind: "entry",
    via: entry.via,
    status: "active" satisfies LibraryStatus,
    addedAt: entry.added_at,
  };
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
      kind: "license",
      ...(await presentationFor(env, db, product, hooksFor, now, "library")),
      status: best.status,
      license: licenseSummary(best),
      licenseCount: shaped.length,
      addedAt: await addedAt(db, accountId, slug),
    });
  }
  for (const { entry, product } of await shownEntries(db, accountId)) {
    products.push({
      product: product.slug,
      ...(await presentationFor(env, db, product, hooksFor, now, "library")),
      ...entryFields(entry),
      license: null,
      licenseCount: 0,
    });
  }
  return { products };
}

/**
 * `DELETE /api/library/<p>`: remove the account's library ENTRY for the product (PS-04). Entries
 * only: a licence-backed library item is never touched here (a licence leaves the library only by
 * the existing detach, `detachLicense`, which also writes its auto-attach block).
 *
 * The answer says whether the product is still in the library (`inLibrary`). An entry a licence
 * replaced meanwhile (the entry hides behind any licence the account holds, PS-05) is removed and
 * answers `inLibrary: true`: the licence keeps the product, so the portal does not say it left.
 * Asked again, or for a product only a licence holds, it answers the same, idempotently, and
 * writes nothing. `404` only when the account holds neither an entry nor a licence for it.
 */
export async function handleLibraryEntryRemove(
  req: Request,
  db: Db,
  accountId: string,
  slug: string,
  now: number,
): Promise<Response> {
  if (req.method !== "DELETE") return err(405, "method_not_allowed");
  const removed = await removeLibraryEntry(db, accountId, slug);
  const inLibrary = await holdsProduct(db, accountId, slug);
  if (!removed && !inLibrary) return notFound();
  if (removed)
    await portalAudit(db, {
      accountId,
      action: "portal.library.remove",
      product: slug,
      targetKind: "product",
      targetId: slug,
      summary: inLibrary
        ? "Removed a product's library entry; its license keeps it in the library (source: discover; path: open)"
        : "Removed a product from the library (source: discover; path: open)",
      now,
    });
  return portalJson({ ok: true, product: slug, inLibrary });
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
  if (!rows || rows.length === 0)
    return entryProductView(env, db, accountId, slug, hooksFor, now);
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
    kind: "license",
    ...(await presentationFor(env, db, product, hooksFor, now, "product")),
    services: serviceToggles(product),
    status: shaped[0]!.status,
    addedAt: await addedAt(db, accountId, slug),
    returnTo: returnTo(product),
    licenses,
  };
}

/** Each service's own toggle (§3.1): the product page shows a section only for a service that is on. */
function serviceToggles(product: ProductPublic): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(product.services).map(([s, v]) => [s, v.enabled]),
  );
}

/**
 * PX-10: where the portal's focused flows may send the person back to (`?return=`, §3.3): the
 * product's exact declared browser origins (`web.origins`, P0-05). App schemes join when the
 * manifest can declare them (S-16 I-15); until then a scheme return is refused and the flow ends
 * on the product page.
 */
function returnTo(product: ProductPublic): {
  origins: string[];
  schemes: string[];
} {
  return { origins: [...product.webOrigins], schemes: [] };
}

/** `GET /api/products/<p>` for a product the library holds as an entry only (PS-04), or `null`. */
async function entryProductView(
  env: Env,
  db: Db,
  accountId: string,
  slug: string,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Record<string, unknown> | null> {
  const [shown] = await shownEntries(db, accountId, slug);
  if (!shown) return null;
  const { entry, product } = shown;
  return {
    product: slug,
    ...(await presentationFor(env, db, product, hooksFor, now, "product")),
    services: serviceToggles(product),
    ...entryFields(entry),
    returnTo: returnTo(product),
    licenses: [],
  };
}
