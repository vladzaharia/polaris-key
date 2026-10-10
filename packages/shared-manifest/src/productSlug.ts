/**
 * The one product slug rule (P0-14). Every path that names or creates a product applies it:
 * `validateManifestDocuments` (so `pkey validate`, link-repo and resync), the Worker's slug check
 * (`GET /manage/api/products/slug-check`) and manual create (`POST /manage/api/products`). A slug
 * one path accepts, every path accepts; a slug one path refuses, every path refuses with the
 * same code (`invalid_slug` for the shape, `reserved_slug` for a reservation).
 *
 * Paths that only READ an existing product (a release descriptor's `product`, the CLI's
 * `--product`) take the shape but not the reservations.
 */
import { SYSTEM_PRODUCT_SLUG } from "./packages.js";

/** A product slug's maximum length. */
export const PRODUCT_SLUG_MAX = 64;

/**
 * The product slug shape: lowercase ASCII letters, digits and hyphens, 1–64 characters, starting
 * with a letter or digit. Mirrored as `$defs.slug.pattern` in `product.schema.json` and as the
 * descriptor's `product` pattern in `release-descriptor.schema.json`.
 */
export const PRODUCT_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** {@link PRODUCT_SLUG_PATTERN} as a RegExp. */
export const PRODUCT_SLUG_RE = new RegExp(PRODUCT_SLUG_PATTERN);

/**
 * Product slugs the platform router reserves ahead of tenant routing. Every one of these is
 * (or fronts) a root path the worker matches before `/<product>/…` — a product registered
 * under such a slug would be permanently shadowed. `validateManifestDocuments` refuses them
 * (`reserved_slug`), and the worker's manual-create admin path checks the same list.
 */
export const RESERVED_PRODUCT_SLUGS: readonly string[] = [
  "docs",
  "manage",
  "api",
  "assets",
  "login",
  "logout",
  "callback",
  "magic",
  "download",
  "webhooks",
  "well-known",
  // PX-W1: the customer portal's same-origin media proxy, `/media/<product>/<asset>`.
  "media",
  // PX-01: the portal's `/activate#key=` deep link.
  "activate",
  // PX-W16 (G33): avatars will be served at `/media/avatar/<asset>`, which the media proxy's
  // `/media/<product>/<asset>` would read as a product slugged `avatar`; reserved now.
  "avatar",
];

/**
 * One-segment admin actions under `/manage/api/products/`, matched before the segment is read
 * as a product slug (`packages/worker/src/console/handlers/products.ts`): a product slugged like
 * one would have its console record shadowed. The manifest validator (`reserved_slug`), the slug
 * check and both create paths refuse them.
 *
 * **One list.** A new admin action under `/manage/api/products/<segment>` adds its segment here,
 * which reserves it everywhere at once (and in `product.schema.json`'s `$defs.slug.not.enum`).
 */
export const PRODUCT_ROUTE_ACTIONS: readonly string[] = [
  "kek",
  "link-repo",
  "slug-check",
];

/**
 * True for a slug no NEW product may take: a router path ({@link RESERVED_PRODUCT_SLUGS}), an
 * admin action ({@link PRODUCT_ROUTE_ACTIONS}) or the system product (`SYSTEM_PRODUCT_SLUG`).
 *
 * The manifest validator does not use this for the system product: the system product's own
 * manifest carries that slug, and only manual create and the slug check refuse it.
 */
export function isReservedProductSlug(slug: string): boolean {
  return (
    slug === SYSTEM_PRODUCT_SLUG ||
    RESERVED_PRODUCT_SLUGS.includes(slug) ||
    PRODUCT_ROUTE_ACTIONS.includes(slug)
  );
}
