/**
 * LK-17: an old portal bookmark (`key.plrs.im/#/library`, `#/p/<slug>/free-device`, `#/account`)
 * reaches the console as `/manage#/…` after the `/` redirect, and the console has no such route.
 * When the worker named a customer origin (`/api/me`), the person is sent to the same hash there.
 * A hash the console does know is never touched, so a product's own `#/p/<slug>` stays the
 * console's.
 */
import type { Route } from "./routes.js";

/** First segments only the old portal used. */
const PORTAL_HEADS = new Set([
  "library",
  "discover",
  "account",
  "licenses",
  "downloads",
  "profile",
]);
/** `#/p/<slug>/<word>` words only the portal's focused flows used. */
const PORTAL_FLOWS = new Set(["free-device", "download"]);

/** The customer-site URL for `hash`, or `null` when the console should render it. */
export function portalHandOff(
  route: Route,
  hash: string,
  customerOrigin: string | null | undefined,
): string | null {
  if (!customerOrigin || route.kind !== "not-found") return null;
  const head = hash.replace(/^#\/?/, "").split(/[/?]/, 1)[0] ?? "";
  const portalProduct =
    route.slug !== undefined &&
    PORTAL_FLOWS.has(route.path.split("/")[0] ?? "");
  if (!portalProduct && !PORTAL_HEADS.has(head)) return null;
  return `${customerOrigin}/${hash}`;
}
