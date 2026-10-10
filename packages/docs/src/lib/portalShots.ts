/**
 * `<PortalShot id>`: the portal's committed visual baselines, by state (docs plan §7.3).
 *
 * Nothing is captured by hand or committed under `packages/docs`. A baseline is
 * `<id>-<viewport>-<theme>.png` in the portal's e2e baseline directory; a shot is the dark and
 * light pair for one viewport, swapped by the reader's theme.
 */

import type { ImageMetadata } from "astro";

export const PORTAL_VIEWPORTS = ["desktop", "mobile"] as const;
export type PortalViewport = (typeof PORTAL_VIEWPORTS)[number];

// Every file a glob matches is emitted into the site, shown or not, so the pattern names the
// states the Help articles use (docs plan section 7.1) and nothing else. A new article adds its
// state here; `portalShots.test.ts` fails when a listed state has no committed baseline.
export const PORTAL_SHOT_IDS = [
  "activate-enter",
  "activate-confirm",
  "activate-done",
  "activate-entries",
  "activate-error-owned",
  "activate-error-email",
  "activate-error-steam",
  "product",
  "product-origin-key",
  "product-expired",
  "product-remove-device",
  "product-remove-license",
  "product-package",
  "product-token",
  "signin",
  "signin-providers",
  "signin-sent",
  "signin-rate-limited",
  "account",
  "account-profile",
  "account-disconnect",
  "account-last-method",
  "account-delete",
  "library-3",
  "library-empty",
  "library-entry-remove",
  "discover",
  "discover-added",
  "storefront-page",
  "device-limit",
  "device-limit-done",
  "download-flow",
] as const;
export type PortalShotId = (typeof PORTAL_SHOT_IDS)[number];

const files = import.meta.glob<{ default: ImageMetadata }>(
  "../../../admin/e2e/__baselines__/portal/linux/{activate-enter,activate-confirm,activate-done,activate-entries,activate-error-owned,activate-error-email,activate-error-steam,product,product-origin-key,product-expired,product-remove-device,product-remove-license,product-package,product-token,signin,signin-providers,signin-sent,signin-rate-limited,account,account-profile,account-disconnect,account-last-method,account-delete,library-3,library-empty,library-entry-remove,discover,discover-added,storefront-page,device-limit,device-limit-done,download-flow}-{desktop,mobile}-{dark,light}.png",
  { eager: true },
);

export interface PortalShotPair {
  dark: ImageMetadata;
  light: ImageMetadata;
}

/** The dark and light baselines for a state and viewport, or null when none is committed. */
export function portalShot(
  id: PortalShotId,
  viewport: PortalViewport,
): PortalShotPair | null {
  const find = (theme: "dark" | "light"): ImageMetadata | undefined => {
    const name = `${id}-${viewport}-${theme}.png`;
    const key = Object.keys(files).find((k) => k.endsWith(`/${name}`));
    return key === undefined ? undefined : files[key]!.default;
  };
  const dark = find("dark");
  const light = find("light");
  return dark && light ? { dark, light } : null;
}
