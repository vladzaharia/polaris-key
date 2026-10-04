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
 * - A 401 from any other request means the session ended mid-visit: the session is set to null
 *   (the login card takes over, keeping the URL as the way back) and `onSignedOut` runs.
 * - No silent retries; a failed read shows its error and a Retry.
 */
export const portalKeys = {
  me: ["portal", "me"] as const,
  capabilities: (product?: string | null) =>
    ["portal", "capabilities", product ?? null] as const,
  licenses: ["portal", "licenses"] as const,
  license: (product: string, id: string) =>
    ["portal", "license", product, id] as const,
  releases: ["portal", "releases"] as const,
};

export function createPortalQueryClient(onSignedOut?: () => void): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (query.queryKey[1] === "me") return;
        if (isSignedOut(err)) {
          client.setQueryData(portalKeys.me, null);
          onSignedOut?.();
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        if (isSignedOut(err)) {
          client.setQueryData(portalKeys.me, null);
          onSignedOut?.();
        }
      },
    }),
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
    queryKey: portalKeys.me,
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
    queryKey: portalKeys.capabilities(product),
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
    queryKey: portalKeys.licenses,
    queryFn: async () => (await portalApi.licenses()).licenses,
    enabled,
  });
}

export function useLicense(
  product: string,
  id: string | null,
): UseQueryResult<PortalLicenseDetail> {
  return useQuery({
    queryKey: portalKeys.license(product, id ?? ""),
    queryFn: () => portalApi.license(product, id!),
    enabled: id != null,
  });
}

/** Releases are optional data: when the module is off the query never runs. */
export function useReleases(enabled: boolean): UseQueryResult<PortalRelease[]> {
  return useQuery({
    queryKey: portalKeys.releases,
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
