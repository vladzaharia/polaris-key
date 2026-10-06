import * as React from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  portalApi,
  PortalApiError,
  setPortalCsrf,
  type PortalCapabilities,
  type PortalDiscoverOffer,
  type PortalDownloads,
  type PortalLibrary,
  type PortalLicenseDetail,
  type PortalLicenseSummary,
  type PortalMe,
  type PortalMintTokenInput,
  type PortalPackageAccess,
  type PortalProduct,
  type PortalRelease,
} from "./api.js";
import { browser } from "./browser.js";
import { isSignedOut } from "./errors.js";

/**
 * The customer site's data layer (PORTAL.md PX-01): TanStack Query over today's portal API.
 *
 * - `["me"]` is the session: `null` when signed out (401), an error only when the Worker could
 *   not be reached, so "Can't reach Polaris Key" is never shown as "signed out".
 * - A 401 from any other request re-checks the session; when it really ended mid-visit the
 *   login card takes over and says so.
 * - No silent retries; a failed read shows its error and a Retry.
 */
// Named `qk` like the console's (test/queryKeyShapes.test.ts polices `qk.X(…)` keys); the
// portal has its own QueryClient, and every family here starts with "portal".
const qk = {
  portalMe: () => ["portal", "me"] as const,
  portalCapabilities: (product?: string | null) =>
    ["portal", "capabilities", product ?? null] as const,
  portalLicenses: () => ["portal", "licenses"] as const,
  portalLicense: (product: string, id: string) =>
    ["portal", "license", product, id] as const,
  portalReleases: () => ["portal", "releases"] as const,
  portalLibrary: () => ["portal", "library"] as const,
  portalDiscover: () => ["portal", "discover"] as const,
  portalDownloads: (product: string) =>
    ["portal", "downloads", product] as const,
  portalProduct: (product: string) => ["portal", "product", product] as const,
  portalRegistryTokens: (product: string, license: string) =>
    ["portal", "registryTokens", product, license] as const,
};

export const portalKeys = {
  me: qk.portalMe(),
  capabilities: qk.portalCapabilities,
  licenses: qk.portalLicenses(),
  license: qk.portalLicense,
  releases: qk.portalReleases(),
  library: qk.portalLibrary(),
  discover: qk.portalDiscover(),
  downloads: qk.portalDownloads,
  product: qk.portalProduct,
};

export function createPortalQueryClient(): QueryClient {
  // A 401 from a read or a write MAY mean the session ended (or, for the claim, that a key is
  // unknown): re-check the session instead of assuming. If it really ended, `["me"]` becomes
  // null and the login card takes over, keeping the URL as the way back.
  const recheck = (err: unknown): void => {
    if (isSignedOut(err))
      void client.invalidateQueries({ queryKey: portalKeys.me });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (query.queryKey[1] !== "me") recheck(err);
      },
    }),
    mutationCache: new MutationCache({ onError: recheck }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: false,
      },
      mutations: { retry: false },
    },
  });
  return client;
}

/** Signing out on purpose (account deleted): no "You were signed out" toast. */
let quietSignOut = false;
export function signOutQuietly(client: QueryClient): void {
  quietSignOut = true;
  client.setQueryData(portalKeys.me, null);
}
export function consumeQuietSignOut(): boolean {
  const q = quietSignOut;
  quietSignOut = false;
  return q;
}

async function fetchSession(): Promise<PortalMe | null> {
  try {
    const me = await portalApi.me();
    setPortalCsrf(me.csrf);
    return me;
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 401) {
      // The link was confirmed on another device: this tab signs in now (I-07).
      if (await portalApi.finishPendingSignIn()) return fetchSession();
      return null;
    }
    throw err;
  }
}

export function useSession(): UseQueryResult<PortalMe | null> {
  return useQuery({
    queryKey: qk.portalMe(),
    queryFn: fetchSession,
    // The session is re-checked on focus (the magic-link tab, POR-1) but never kept stale.
    staleTime: 0,
  });
}

const NO_CAPABILITIES: PortalCapabilities = {
  auth: { oidc: false, magic: false },
  modules: { licensing: false, claim: false, releases: false },
};

export function useCapabilities(
  product?: string | null,
): UseQueryResult<PortalCapabilities> {
  return useQuery({
    queryKey: qk.portalCapabilities(product),
    queryFn: () => portalApi.capabilities(product),
    staleTime: 5 * 60_000,
  });
}

/** Capabilities, or the "nothing enabled" answer while loading or on error. */
export function capabilitiesOrNone(
  q: UseQueryResult<PortalCapabilities>,
): PortalCapabilities {
  return q.data ?? NO_CAPABILITIES;
}

export function useLicenses(
  enabled = true,
): UseQueryResult<PortalLicenseSummary[]> {
  return useQuery({
    queryKey: qk.portalLicenses(),
    queryFn: async () => (await portalApi.licenses()).licenses,
    enabled,
  });
}

export function useLicense(
  product: string,
  id: string | null,
): UseQueryResult<PortalLicenseDetail> {
  return useQuery({
    queryKey: qk.portalLicense(product, id ?? ""),
    queryFn: () => portalApi.license(product, id!),
    enabled: id != null,
  });
}

/** Releases are optional data: when the module is off the query never runs. */
export function useReleases(enabled: boolean): UseQueryResult<PortalRelease[]> {
  return useQuery({
    queryKey: qk.portalReleases(),
    queryFn: async () => (await portalApi.releases()).releases,
    enabled,
  });
}

/**
 * The Library (PX-W1, PX-08): `GET /api/library` decides which products the account holds, each
 * one's status from its best licence, its presentation and art (G1), its seats (G5) and support
 * links (G16), and the Discover count once the Worker lists offers (G24).
 */
export function useLibraryView(enabled = true): UseQueryResult<PortalLibrary> {
  return useQuery({
    queryKey: qk.portalLibrary(),
    queryFn: () => portalApi.library(),
    enabled,
  });
}

/**
 * Discover's offers (PX-W10, `GET /api/discover`): every product whose licence policy would
 * auto-issue to this account, evaluated without issuing, each with its terms and reason.
 */
export function useDiscover(
  enabled = true,
): UseQueryResult<PortalDiscoverOffer[]> {
  return useQuery({
    queryKey: qk.portalDiscover(),
    queryFn: async () => {
      try {
        return (await portalApi.discover()).offers;
      } catch (err) {
        // A Worker without Discover (404) has nothing to offer: the honest empty state.
        if (err instanceof PortalApiError && err.status === 404) return [];
        throw err;
      }
    },
    enabled,
  });
}

/**
 * "Add to library" (G25). The Worker re-evaluates and mints once per account and product; the
 * library (its count and Discover's) and the licence summaries refresh after.
 */
export function useClaimDiscover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (product: string) => portalApi.claimDiscover(product),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: portalKeys.library });
      void qc.invalidateQueries({ queryKey: portalKeys.licenses });
      void qc.invalidateQueries({ queryKey: portalKeys.discover });
    },
  });
}

/**
 * One product's downloads and store links (PX-W2, `GET /api/products/<p>/downloads`), or `null`
 * when this Worker has no such route (404): Get it then falls back to `GET /api/releases`.
 */
export function useProductDownloads(
  product: string,
  enabled: boolean,
): UseQueryResult<PortalDownloads | null> {
  return useQuery({
    queryKey: qk.portalDownloads(product),
    queryFn: () => fetchDownloads(product),
    staleTime: DOWNLOADS_STALE_MS,
    enabled,
  });
}

/**
 * The Package access card's state for one licence (F-21). `null` when this Worker has no such
 * route (404): the card stays hidden, as it does when no private feed exists.
 */
export function usePackageAccess(
  product: string,
  licenseId: string,
): UseQueryResult<PortalPackageAccess | null> {
  return useQuery({
    queryKey: qk.portalRegistryTokens(product, licenseId),
    queryFn: async () => {
      try {
        return await portalApi.packageAccess(product, licenseId);
      } catch (err) {
        if (err instanceof PortalApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useMintRegistryToken(product: string, licenseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PortalMintTokenInput) =>
      portalApi.mintRegistryToken(product, licenseId, input),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.portalRegistryTokens(product, licenseId),
      }),
  });
}

export function useRevokeRegistryToken(product: string, licenseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      portalApi.revokeRegistryToken(product, licenseId, tokenId),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: qk.portalRegistryTokens(product, licenseId),
      }),
  });
}

/**
 * One product in full (PX-W1, `GET /api/products/<p>`): seats, devices, `returnTo`. `enabled:
 * false` waits (the Activate dialog asks only when a link's `return=` needs checking).
 */
export function useProduct(
  product: string,
  opts: { enabled?: boolean } = {},
): UseQueryResult<PortalProduct> {
  return useQuery({
    queryKey: qk.portalProduct(product),
    queryFn: () => portalApi.product(product),
    enabled: opts.enabled ?? true,
  });
}

/** The downloads query for one product, shared by the Library and the product page. */
const DOWNLOADS_STALE_MS = 5 * 60_000;

async function fetchDownloads(
  product: string,
): Promise<PortalDownloads | null> {
  try {
    return await portalApi.downloads(product);
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Every listed product's downloads view (PX-08: store-aware quick actions, §5.4), by slug, and
 * whether any is still on its first load. A product whose view failed is absent from the map:
 * its quick action falls back to `GET /api/releases`, never to a guess.
 */
export function useDownloadsFor(
  products: readonly string[],
  enabled: boolean,
): { bySlug: ReadonlyMap<string, PortalDownloads | null>; pending: boolean } {
  const results = useQueries({
    queries: products.map((p) => ({
      queryKey: qk.portalDownloads(p),
      queryFn: () => fetchDownloads(p),
      staleTime: DOWNLOADS_STALE_MS,
      enabled,
    })),
  });
  const key = results.map((r) => r.dataUpdatedAt).join(",");
  const bySlug = React.useMemo(() => {
    const out = new Map<string, PortalDownloads | null>();
    results.forEach((r, i) => {
      if (r.data !== undefined) out.set(products[i]!, r.data);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.join(","), key]);
  const pending = results.some((r) => r.isPending && r.fetchStatus !== "idle");
  return { bySlug, pending };
}

/** G23: email the account's own address this product's download link for `platform`. */
export function useEmailDownload() {
  return useMutation({
    mutationFn: (v: { product: string; platform: string }) =>
      portalApi.emailDownload(v.product, v.platform),
  });
}

/** The activate preview (PX-W5, G22): what adding a key would do, before it is added. */
export function usePreviewKey() {
  return useMutation({
    mutationFn: (key: string) => portalApi.previewKey(key),
  });
}

export function useClaimKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => portalApi.claimKey(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: portalKeys.licenses });
      void qc.invalidateQueries({ queryKey: portalKeys.releases });
      void qc.invalidateQueries({ queryKey: portalKeys.library });
      // A key for a product Discover offered takes it off the shelf.
      void qc.invalidateQueries({ queryKey: portalKeys.discover });
    },
  });
}

export function useRemoveDevice(product: string, licenseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      portalApi.disconnectDevice(product, licenseId, deviceId),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: portalKeys.license(product, licenseId),
      });
      void qc.invalidateQueries({ queryKey: portalKeys.licenses });
      void qc.invalidateQueries({ queryKey: portalKeys.library });
      void qc.invalidateQueries({ queryKey: portalKeys.product(product) });
    },
  });
}

/** PX-23: Remove from my library. Every view that lists the licence refreshes. */
export function useRemoveLicense(product: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (licenseId: string) =>
      portalApi.removeLicense(product, licenseId),
    onSuccess: (_res, licenseId) => {
      qc.removeQueries({ queryKey: portalKeys.license(product, licenseId) });
      void qc.invalidateQueries({ queryKey: portalKeys.licenses });
      void qc.invalidateQueries({ queryKey: portalKeys.library });
      void qc.invalidateQueries({ queryKey: portalKeys.product(product) });
      void qc.invalidateQueries({ queryKey: portalKeys.releases });
      void qc.invalidateQueries({ queryKey: portalKeys.discover });
    },
  });
}

export function useDeleteAccount() {
  return useMutation({ mutationFn: () => portalApi.deleteMe() });
}

/**
 * Start a download: mint a fresh link (`POST …/token`, "Download links are made fresh when you
 * click") and follow it.
 */
export function useStartDownload() {
  return useMutation({
    mutationFn: (v: {
      product: string;
      releaseId: string;
      artifactId: string;
    }) => portalApi.downloadToken(v.product, v.releaseId, v.artifactId),
    onSuccess: (res) => browser.go(res.url),
  });
}
