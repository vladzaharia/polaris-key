/**
 * The identity the customer site wears (LK-06, plans/LK-00.md D1): Polaris Locker while the
 * Worker's `customer.host` switch is on, Polaris Key while it is off. The Worker says so in the
 * shell (`data-brand="locker"` on `<html>`, services/identity/portal/lockerShell.ts); the SPA only
 * reads it, so brand and host can never disagree. A dev server or a test has no attribute: Key.
 */
export type PortalBrand = "key" | "locker";

export const portalBrand = (): PortalBrand =>
  typeof document !== "undefined" &&
  document.documentElement.getAttribute("data-brand") === "locker"
    ? "locker"
    : "key";

/** The name copy uses for the site: "Polaris Locker" or "Polaris Key" (D8). */
export const brandName = (): string =>
  portalBrand() === "locker" ? "Polaris Locker" : "Polaris Key";
