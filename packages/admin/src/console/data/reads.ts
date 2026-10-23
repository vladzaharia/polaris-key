/**
 * The console's shared reads (components.md §7): one `queryOptions` factory per key family that
 * more than one section, or the shell, uses. A hook or a page calls `useQuery(reads.x(...))`,
 * spreads it to add `enabled`, `select` or `placeholderData`, or reads imperatively with
 * `queryClient.fetchQuery(reads.x(...))`. A section's own reads are factories in its `data.ts`;
 * `test/queryFactories.test.ts` holds the rule.
 */

import { queryOptions } from "@tanstack/react-query";
import {
  api,
  setCsrf,
  type AreaId,
  type AttentionItemDto,
  type Me,
  type PlatformIdentity,
  type ProductDetail,
  type ProductDeviceDetail,
  type ProductSecretDto,
} from "../../api.js";
import { noteIdentity } from "../shell/endedState.js";
import { mutate } from "./mutations.js";
import { qk } from "./queries.js";

/** Fetch the session and arm the CSRF token every write echoes. */
export async function fetchMe(): Promise<Me> {
  const me = await api.me();
  setCsrf(me.csrf);
  // A session that loads again ends "Your session ended" (a sign-in in another tab, or a blip),
  // unless a different person signed in: then held writes are dropped, never sent as them.
  noteIdentity(me.sub, me.name || me.email);
  return me;
}

/**
 * The registry list, as cached under `qk.products()`. Every reader of that key must fetch through
 * this function: the cache holds one shape per key, and a view that stored the raw response
 * (`{ products }`) under the same key broke the shell's switcher and the Products page in turn.
 */
export function fetchProducts(): Promise<ProductDetail[]> {
  // The system product (F-03) is the platform's own (the package-feeds owner of our SDKs): it is
  // reached from Platform, never listed beside registered products or offered by the switcher.
  return api.products().then((r) => r.products.filter((p) => !p.system));
}

export function fetchAttention(): Promise<AttentionItemDto[]> {
  return api.attention().then((r) => r?.items ?? []);
}

export function fetchProduct(slug: string): Promise<ProductDetail> {
  return api.product(slug).then((r) => r.product);
}

export function fetchPlatformVersion(): Promise<PlatformIdentity> {
  return api.platformVersion();
}

/** The product's secrets inventory, as cached under `qk.secrets(slug)` (Keys and secrets, mint recipes). */
export function fetchSecrets(slug: string): Promise<ProductSecretDto[]> {
  return api.productSecrets(slug).then((r) => r.secrets);
}

/** Read one device through the product route: it reaches licensed and license-free devices. */
export function fetchDevice(
  slug: string,
  deviceId: string,
): Promise<ProductDeviceDetail> {
  return api.productDevice(slug, deviceId);
}

export function fetchPlatformConnections() {
  return api.platformConnections();
}

export const reads = {
  me: () => queryOptions({ queryKey: qk.me(), queryFn: fetchMe }),
  products: () =>
    queryOptions({ queryKey: qk.products(), queryFn: fetchProducts }),
  product: (slug: string) =>
    queryOptions({
      queryKey: qk.product(slug),
      queryFn: () => fetchProduct(slug),
    }),
  attention: () =>
    queryOptions({
      queryKey: qk.attention(),
      queryFn: fetchAttention,
      retry: 1,
    }),
  platformReady: () =>
    queryOptions({
      queryKey: qk.platformReady(),
      queryFn: () => api.platformReady(),
      retry: 1,
    }),
  platformVersion: () =>
    queryOptions({
      queryKey: qk.platformVersion(),
      queryFn: fetchPlatformVersion,
      staleTime: 5 * 60_000,
      retry: false,
    }),
  secrets: (slug: string) =>
    queryOptions({
      queryKey: qk.secrets(slug),
      queryFn: () => fetchSecrets(slug),
    }),
  device: (slug: string, deviceId: string) =>
    queryOptions({
      queryKey: qk.device(slug, deviceId),
      queryFn: () => fetchDevice(slug, deviceId),
    }),
  /** ST-29: who can give access to an area in a scope (NoAccessPage). */
  accessAdmins: (scope: string, area: AreaId) =>
    queryOptions({
      queryKey: qk.accessAdmins(scope, area),
      queryFn: () => api.accessAdmins(scope, area),
      staleTime: 60_000,
    }),
  /** I-41: a support code resolved to its product and user. */
  supportCode: (code: string) =>
    queryOptions({
      queryKey: qk.supportCode(code),
      queryFn: () => api.supportCode(code),
      retry: false,
      staleTime: 60_000,
    }),
  /** ST-52: the palette's entity search. A read sent as POST (the key stays out of the URL): it declares no invalidation. */
  search: (q: string) =>
    queryOptions({
      queryKey: qk.search(q),
      queryFn: () => mutate("search", q),
      retry: false,
      staleTime: 30_000,
    }),
  /** One product setting area (the setup flags; the settings sections). */
  productSettings: (slug: string, area: string) =>
    queryOptions({
      queryKey: qk.productSettings(slug, area),
      queryFn: () => api.productSettings(slug, area),
    }),
  settingsDrift: (slug: string) =>
    queryOptions({
      queryKey: qk.settingsDrift(slug),
      queryFn: () => api.settingsDrift(slug),
    }),
  /** The product's services view (Services, the Commerce tile, sign-in, enrollment). */
  services: (slug: string) =>
    queryOptions({
      queryKey: qk.services(slug),
      queryFn: () => api.services(slug),
    }),
  /** The platform settings view (Platform settings, Home's pause banner, Cloud Sync setup). */
  platformSettings: () =>
    queryOptions({
      queryKey: qk.platformSettings(),
      queryFn: () => api.platformSettings(),
    }),
  /** The operations probes (Platform status, the invite drawer's email probe). */
  platformOperations: () =>
    queryOptions({
      queryKey: qk.platformOperations(),
      queryFn: () => api.platformOperations(),
    }),
  /** The sign-in connections (Platform connections, the identity sign-in sections). */
  platformConnections: () =>
    queryOptions({
      queryKey: qk.platformConnections(),
      queryFn: fetchPlatformConnections,
    }),
};
