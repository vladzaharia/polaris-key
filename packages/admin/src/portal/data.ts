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
  type PortalMethods,
  type PortalMintTokenInput,
  type PortalPackageAccess,
  type PortalProduct,
  type PortalProfile,
  type PortalProfileChange,
  type PortalRelease,
  type PortalSession,
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
  portalProfile: () => ["portal", "profile"] as const,
  portalMethods: () => ["portal", "methods"] as const,
  portalSessions: () => ["portal", "sessions"] as const,
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
  profile: qk.portalProfile(),
  methods: qk.portalMethods(),
  sessions: qk.portalSessions(),
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

/**
 * Account → Profile (PX-W16, `GET /api/me/profile`), or `null` when this Worker has no such route
 * (404): the card then shows the session's name and initials without an editor (G32's fallback).
 */
export function useProfile(): UseQueryResult<PortalProfile | null> {
  return useQuery({
    queryKey: qk.portalProfile(),
    queryFn: async () => {
      try {
        return (await portalApi.profile()).profile;
      } catch (err) {
        if (err instanceof PortalApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

/**
 * Save an explicit choice. The answer is the whole profile: it replaces the cached one, and the
 * session's name and picture (the header chip, the account menu) follow from it at once, exactly
 * as `GET /api/me` derives them (`display_name`, else the name it had; the picture's URL).
 */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: PortalProfileChange) =>
      portalApi.updateProfile(change),
    onSuccess: ({ profile }) => {
      qc.setQueryData(qk.portalProfile(), profile);
      qc.setQueryData<PortalMe | null>(qk.portalMe(), (me) =>
        me
          ? {
              ...me,
              account: {
                ...me.account,
                name: profile.displayName ?? me.account.name,
                avatarUrl: profile.picture?.url ?? null,
              },
            }
          : me,
      );
    },
    onError: (err) => {
      // The profile changed under the editor (a method removed, an upload collected): re-read it
      // so the chips and tiles offer what is there now.
      if (
        err instanceof PortalApiError &&
        err.reason &&
        STALE_PROFILE_REASONS.has(err.reason)
      )
        void qc.invalidateQueries({ queryKey: portalKeys.profile });
    },
  });
}

const STALE_PROFILE_REASONS = new Set([
  "unknown_source",
  "no_name",
  "no_picture",
  "unknown_upload",
]);

/** Upload a picture: it is kept unused (for a day) until `useUpdateProfile` picks it. */
export function useUploadPicture() {
  return useMutation({
    mutationFn: (file: Blob) => portalApi.uploadPicture(file),
  });
}

/**
 * PX-23: Remove from my library. Every view that lists the licence refreshes. A 404 means it is
 * not in this account any more (removed from another tab, or moved by the developer): the same
 * outcome, so it resolves as removed rather than as an error over a stale page. A refusal
 * (`409 not_removable`) refreshes the licences too, so the page stops offering Remove.
 */
export function useRemoveLicense(product: string) {
  const qc = useQueryClient();
  const refresh = (licenseId: string): void => {
    qc.removeQueries({ queryKey: portalKeys.license(product, licenseId) });
    void qc.invalidateQueries({ queryKey: portalKeys.licenses });
    void qc.invalidateQueries({ queryKey: portalKeys.library });
    void qc.invalidateQueries({ queryKey: portalKeys.product(product) });
    void qc.invalidateQueries({ queryKey: portalKeys.releases });
    void qc.invalidateQueries({ queryKey: portalKeys.discover });
  };
  return useMutation({
    mutationFn: async (licenseId: string) => {
      try {
        return await portalApi.removeLicense(product, licenseId);
      } catch (err) {
        if (err instanceof PortalApiError && err.status === 404)
          return { ok: true as const, product, licenseId };
        throw err;
      }
    },
    onSuccess: (_res, licenseId) => refresh(licenseId),
    onError: (err, licenseId) => {
      if (err instanceof PortalApiError && err.status === 409)
        refresh(licenseId);
    },
  });
}

export function useDeleteAccount() {
  return useMutation({ mutationFn: () => portalApi.deleteMe() });
}

/**
 * Account → Sign-in methods (PX-W12, `GET /api/me/methods`), or `null` when this Worker has no
 * such route (404): the section then lists the session's email alone (G27's fallback).
 */
export function useMethods(): UseQueryResult<PortalMethods | null> {
  return useQuery({
    queryKey: qk.portalMethods(),
    queryFn: fetchMethods,
  });
}

async function fetchMethods(): Promise<PortalMethods | null> {
  try {
    return await portalApi.methods();
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Where you're signed in (I-07, `GET /api/sessions`), or `null` when this Worker has no such
 * route (404): the section is left out rather than shown empty.
 */
export function useSessions(): UseQueryResult<PortalSession[] | null> {
  return useQuery({
    queryKey: qk.portalSessions(),
    queryFn: fetchSessions,
  });
}

async function fetchSessions(): Promise<PortalSession[] | null> {
  try {
    return (await portalApi.sessions()).sessions;
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * After a sign-in method changed: the methods, the session (its email follows the primary), the
 * profile's sources and the library (a verified address brings the licences waiting on it).
 */
export function refreshAfterMethodChange(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: portalKeys.methods });
  void client.invalidateQueries({ queryKey: portalKeys.me });
  void client.invalidateQueries({ queryKey: portalKeys.profile });
  void client.invalidateQueries({ queryKey: portalKeys.library });
  void client.invalidateQueries({ queryKey: portalKeys.licenses });
}

/** Disconnect a sign-in method (step-up first; never the last one). */
export function useRemoveMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => portalApi.removeMethod(id),
    onSuccess: () => refreshAfterMethodChange(qc),
    onError: (err) => {
      // Refused for the account's state (`last_link`, `only_email`) or gone already: re-read it,
      // so the page stops offering what the Worker refuses.
      if (
        err instanceof PortalApiError &&
        (err.status === 409 || err.status === 403 || err.status === 404)
      )
        void qc.invalidateQueries({ queryKey: portalKeys.methods });
    },
  });
}

/**
 * The session again, now (`GET /api/me`): after a step-up sign-in the browser holds a new
 * session, with a new CSRF token, which every later change must carry.
 */
export function refreshSession(client: QueryClient): Promise<PortalMe | null> {
  return client.fetchQuery({
    queryKey: qk.portalMe(),
    queryFn: fetchSession,
    staleTime: 0,
  });
}

/** End one other session (a browser or app signed in to this account). */
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => portalApi.endSession(id),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: portalKeys.sessions }),
  });
}

/** Sign out everywhere: every session and app of the account, this browser's included. */
export function useSignOutEverywhere() {
  return useMutation({ mutationFn: () => portalApi.signOutEverywhere() });
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
