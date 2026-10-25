import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  portalApi,
  HttpError,
  setPortalCsrf,
  type PortalDiscoverOffer,
  type PortalDownloads,
  type PortalMe,
  type PortalMethods,
  type PortalSession,
} from "./api.js";

/**
 * The customer site's reads: the one key module (`qk`) and one `queryOptions` factory per read
 * (`pq`). A hook calls `useQuery(pq.x(...))`; a write invalidates with `qk.x(...)`. This is the
 * only portal file that spells a `queryKey`/`queryFn` (`test/queryFactories.test.ts`).
 *
 * Every family starts with "portal" (the portal has its own QueryClient). Nothing retries
 * silently; a failed read shows its error and a Try again.
 */
export const qk = {
  me: () => ["portal", "me"] as const,
  capabilities: (product?: string | null) =>
    ["portal", "capabilities", product ?? null] as const,
  licenses: () => ["portal", "licenses"] as const,
  license: (product: string, id: string) =>
    ["portal", "license", product, id] as const,
  releases: () => ["portal", "releases"] as const,
  library: () => ["portal", "library"] as const,
  discover: () => ["portal", "discover"] as const,
  storefront: (product: string) => ["portal", "storefront", product] as const,
  downloads: (product: string) => ["portal", "downloads", product] as const,
  product: (product: string) => ["portal", "product", product] as const,
  registryTokens: (product: string, license: string) =>
    ["portal", "registryTokens", product, license] as const,
  personalTokens: () => ["portal", "personalTokens"] as const,
  profile: () => ["portal", "profile"] as const,
  methods: () => ["portal", "methods"] as const,
  sessions: () => ["portal", "sessions"] as const,
  link: () => ["portal", "link"] as const,
  // The app card's reads (PX-14a): under the request's handle, so a new request never shows the
  // last one's answer.
  signinRequest: (h: string) => ["portal", "signinRequest", h] as const,
  signinLicenses: (h: string) => ["portal", "signinLicenses", h] as const,
  signinDevices: (h: string, license: string) =>
    ["portal", "signinDevices", h, license] as const,
  signinConsent: (h: string) => ["portal", "signinConsent", h] as const,
};

/** Every portal query (the whole cache of this app). */
export const qkAll = () => ["portal"] as const;

/** Every query of one family, whatever its arguments (a prefix for `removeQueries`). */
export const qkFamily = (name: string) => ["portal", name] as const;

/** A route this Worker does not have (404) answers `null`: the section hides rather than fails. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Session reads started so far: only the newest one's answer sets the CSRF token, so a read sent
 * before a step-up sign-in (with the old cookie) that answers after one sent since can't put the
 * old token back.
 */
let sessionReads = 0;

export async function fetchSession(): Promise<PortalMe | null> {
  const read = ++sessionReads;
  try {
    const me = await portalApi.me();
    if (read === sessionReads) setPortalCsrf(me.csrf);
    return me;
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      // The link was confirmed on another device: this tab signs in now (I-07).
      if (await portalApi.finishPendingSignIn()) return fetchSession();
      return null;
    }
    throw err;
  }
}

/** The downloads query for one product, shared by the Library and the product page. */
const DOWNLOADS_STALE_MS = 5 * 60_000;

export const pq = {
  /** `["me"]` is the session: `null` when signed out (401), an error only when the Worker is unreachable. */
  me: () =>
    queryOptions({
      queryKey: qk.me(),
      queryFn: fetchSession,
      // Re-checked on focus (the magic-link tab, POR-1) but never kept stale.
      staleTime: 0,
    }),

  capabilities: (product?: string | null) =>
    queryOptions({
      queryKey: qk.capabilities(product),
      queryFn: () => portalApi.capabilities(product),
      staleTime: 5 * 60_000,
    }),

  licenses: (enabled = true) =>
    queryOptions({
      queryKey: qk.licenses(),
      queryFn: async () => (await portalApi.licenses()).licenses,
      enabled,
    }),

  license: (product: string, id: string | null) =>
    queryOptions({
      queryKey: qk.license(product, id ?? ""),
      queryFn: () => portalApi.license(product, id!),
      enabled: id != null,
    }),

  /** Optional data: when the module is off the query never runs. */
  releases: (enabled: boolean) =>
    queryOptions({
      queryKey: qk.releases(),
      queryFn: async () => (await portalApi.releases()).releases,
      enabled,
    }),

  /** The Library (PX-W1, PX-08): `GET /api/library`. */
  library: (enabled = true) =>
    queryOptions({
      queryKey: qk.library(),
      queryFn: () => portalApi.library(),
      enabled,
    }),

  /** Discover's offers (PX-W10); a Worker without Discover (404) has nothing to offer. */
  discover: (enabled = true) =>
    queryOptions({
      queryKey: qk.discover(),
      queryFn: async (): Promise<PortalDiscoverOffer[]> =>
        (await orNull(() => portalApi.discover()))?.offers ?? [],
      enabled,
    }),

  /**
   * The storefront product page (PS-04; `GET /api/discover/<p>`). Opened from Discover, the offer
   * the tile showed stands in until the page answers, so the page has its header from the first
   * frame (MO-05).
   */
  storefront: (product: string, client: QueryClient) =>
    queryOptions({
      queryKey: qk.storefront(product),
      queryFn: () => portalApi.storefrontProduct(product),
      placeholderData: () => {
        const offer = client
          .getQueryData<PortalDiscoverOffer[]>(qk.discover())
          ?.find((o) => o.product === product);
        return offer
          ? { ...offer, description: null, screenshots: [] }
          : undefined;
      },
    }),

  /**
   * One product's downloads and store links (PX-W2), or `null` when this Worker has no such route
   * (404). Get it mounts this beside the Library's observer of the same query; retrying a failed
   * read on mount would reset it to pending and loop the page through its skeleton, so a failed
   * read is retried only by Try again.
   */
  downloads: (product: string, enabled = true) =>
    queryOptions({
      queryKey: qk.downloads(product),
      queryFn: (): Promise<PortalDownloads | null> =>
        orNull(() => portalApi.downloads(product)),
      staleTime: DOWNLOADS_STALE_MS,
      enabled,
      retryOnMount: false,
    }),

  /** One product in full (PX-W1, `GET /api/products/<p>`). */
  product: (product: string, enabled = true) =>
    queryOptions({
      queryKey: qk.product(product),
      queryFn: () => portalApi.product(product),
      enabled,
    }),

  /** The Package access card's state for one licence (F-21); `null` on a Worker without the route. */
  registryTokens: (product: string, licenseId: string) =>
    queryOptions({
      queryKey: qk.registryTokens(product, licenseId),
      queryFn: () => orNull(() => portalApi.packageAccess(product, licenseId)),
    }),

  /** Account → Packages: the person's `pkeyp_` tokens and the private feeds they reach. */
  personalTokens: () =>
    queryOptions({
      queryKey: qk.personalTokens(),
      queryFn: () => portalApi.personalTokens(),
    }),

  /** Account → Profile (PX-W16), or `null` on a Worker without the route (G32's fallback). */
  profile: () =>
    queryOptions({
      queryKey: qk.profile(),
      queryFn: () => orNull(async () => (await portalApi.profile()).profile),
    }),

  /** Account → Sign-in methods (PX-W12), or `null` on a Worker without the route. */
  methods: () =>
    queryOptions({
      queryKey: qk.methods(),
      queryFn: (): Promise<PortalMethods | null> =>
        orNull(() => portalApi.methods()),
    }),

  /** `GET /api/me/link` (PX-W12): always read fresh, it depends on this browser's link flow. */
  link: () =>
    queryOptions({
      queryKey: qk.link(),
      queryFn: () => orNull(() => portalApi.linkView()),
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    }),

  /** Where you're signed in (I-07, `GET /api/sessions`), or `null` on a Worker without the route. */
  sessions: () =>
    queryOptions({
      queryKey: qk.sessions(),
      queryFn: (): Promise<PortalSession[] | null> =>
        orNull(async () => (await portalApi.sessions()).sessions),
    }),

  /** The app asking (works before sign-in: the binder cookie, not a session). */
  signinRequest: (handle: string | null) =>
    queryOptions({
      queryKey: qk.signinRequest(handle ?? ""),
      queryFn: () => portalApi.signinRequest(handle!),
      enabled: handle !== null,
      staleTime: 60_000,
    }),

  signinLicenses: (handle: string, enabled: boolean) =>
    queryOptions({
      queryKey: qk.signinLicenses(handle),
      queryFn: () => portalApi.signinLicenses(handle),
      enabled,
      staleTime: 0,
    }),

  signinDevices: (handle: string, licenseId: string) =>
    queryOptions({
      queryKey: qk.signinDevices(handle, licenseId),
      queryFn: () => portalApi.signinDevices(handle, licenseId),
      staleTime: 0,
    }),

  signinConsent: (handle: string, enabled: boolean) =>
    queryOptions({
      queryKey: qk.signinConsent(handle),
      queryFn: () => portalApi.signinConsent(handle),
      enabled,
      staleTime: 0,
    }),
};
