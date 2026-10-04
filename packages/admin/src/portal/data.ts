import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  portalApi,
  PortalApiError,
  setPortalCsrf,
  type PortalCapabilities,
  type PortalLicenseDetail,
  type PortalLicenseSummary,
  type PortalMe,
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
};

export const portalKeys = {
  me: qk.portalMe(),
  capabilities: qk.portalCapabilities,
  licenses: qk.portalLicenses(),
  license: qk.portalLicense,
  releases: qk.portalReleases(),
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
    if (err instanceof PortalApiError && err.status === 401) return null;
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

export function useClaimKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => portalApi.claimKey(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: portalKeys.licenses });
      void qc.invalidateQueries({ queryKey: portalKeys.releases });
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
