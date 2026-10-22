/**
 * Which catalogue channels a store connector and a credential kind serve (A-20.7), so the
 * Outlet credentials page can follow the product's scope. One place; the ids are the catalogue's.
 */

import { channelForOutlet } from "@polaris-key/manifest";
import { useProduct } from "../../../data/hooks.js";
import {
  channelInScope,
  navFeaturesOf,
  type NavFeatures,
} from "../../../nav.js";

/** The product's scope facts; `null` while it loads (everything shows). */
export const useScope = (slug: string): NavFeatures =>
  navFeaturesOf(useProduct(slug).data);

/** The product read is not in yet, so the scope is unknown: show a skeleton, not everything. */
export function useScopeLoading(slug: string): boolean {
  const product = useProduct(slug);
  return product.isPending || product.isPlaceholderData;
}

/** The kinds the drawer offers: none until the scope is known, so none appears and then vanishes. */
export function useScopedKinds<K extends { value: string }>(
  slug: string,
  kinds: readonly K[],
  held: readonly { kind: string }[],
): K[] {
  const scope = useScope(slug);
  return useScopeLoading(slug) ? [] : scopedKinds(scope, kinds, held);
}

/** The channels a credential kind signs in for. A kind that names none (Sentry) is never hidden. */
const KIND_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  "asc-api-key": ["app-store", "testflight"],
  "asc-webhook-secret": ["app-store", "testflight"],
  "app-store-server-key": ["app-store", "testflight"],
  "google-service-account": ["google-play", "play-testing"],
  "ms-partner-center": ["microsoft-store"],
  "steam-publisher-key": ["steam"],
};

/** A credential kind is in scope when one of its channels is, or when it names no channel. */
export function kindInScope(features: NavFeatures, kind: string): boolean {
  const ids = KIND_CHANNELS[kind];
  return !ids || ids.some((id) => channelInScope(features, id));
}

/** A connector is in scope when one of the outlet kinds it drives maps to a channel in scope. */
export function connectorInScope(
  features: NavFeatures,
  outletKinds: readonly string[],
): boolean {
  const ids = outletKinds.flatMap((k) => channelForOutlet(k)?.id ?? []);
  return ids.length === 0 || ids.some((id) => channelInScope(features, id));
}

/** The connectors the page lists: those in scope, and any that is already set up. */
export function scopedConnectors<
  C extends { configured: boolean; outletKinds: string[] },
>(features: NavFeatures, connectors: readonly C[]): C[] {
  return connectors.filter(
    (c) => c.configured || connectorInScope(features, c.outletKinds),
  );
}

/** The kinds the drawer offers: those in scope, and any the product already holds. */
export function scopedKinds<K extends { value: string }>(
  features: NavFeatures,
  kinds: readonly K[],
  held: readonly { kind: string }[],
): K[] {
  return kinds.filter(
    (k) =>
      kindInScope(features, k.value) || held.some((c) => c.kind === k.value),
  );
}
