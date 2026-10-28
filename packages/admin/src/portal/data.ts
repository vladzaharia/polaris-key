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
  HttpError,
  setPortalCsrf,
  type PortalCapabilities,
  type PortalDiscoverOffer,
  type PortalDownloads,
  type PortalLibrary,
  type PortalLicenseDetail,
  type PortalLicenseSummary,
  type PortalMe,
  type PortalLinkView,
  type PortalMethods,
  type PortalMintTokenInput,
  type PortalPackageAccess,
  type PortalPersonalTokens,
  type PortalProduct,
  type PortalProfile,
  type PortalProfileChange,
  type PortalRelease,
  type PortalSession,
  type PortalStorefrontProduct,
} from "./api.js";
import { browser } from "./browser.js";
import { isSignedOut } from "./errors.js";
import {
  removeLibraryEntryOrGone,
  removeLicenseOrGone,
  useWrite,
} from "./mutations.js";
import { fetchSession, pq, qk } from "./queries.js";

/**
 * The customer site's data layer (PORTAL.md PX-01): TanStack Query over today's portal API.
 *
 * - `["me"]` is the session: `null` when signed out (401), an error only when the Worker could
 *   not be reached, so "Can't reach Polaris Key" is never shown as "signed out".
 * - A 401 from any other request re-checks the session; when it really ended mid-visit the
 *   login card takes over and says so.
 * - No silent retries; a failed read shows its error and a Retry.
 */
export function createPortalQueryClient(): QueryClient {
  // A 401 from a read or a write MAY mean the session ended (or, for the claim, that a key is
  // unknown): re-check the session instead of assuming. If it really ended, `["me"]` becomes
  // null and the login card takes over, keeping the URL as the way back.
  const recheck = (err: unknown): void => {
    if (isSignedOut(err)) void client.invalidateQueries({ queryKey: qk.me() });
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
  client.setQueryData(qk.me(), null);
}
export function consumeQuietSignOut(): boolean {
  const q = quietSignOut;
  quietSignOut = false;
  return q;
}

export function useSession(): UseQueryResult<PortalMe | null> {
  return useQuery(pq.me());
}

const NO_CAPABILITIES: PortalCapabilities = {
  auth: { oidc: false, magic: false },
  modules: { licensing: false, claim: false, releases: false },
};

export function useCapabilities(
  product?: string | null,
): UseQueryResult<PortalCapabilities> {
  return useQuery(pq.capabilities(product));
}

/** The signed-out card's product (name and icon), or `undefined` on any refusal or error. */
export function useStorefrontName(
  slug: string | null,
): { name: string; iconUrl: string | null } | undefined {
  return useQuery(pq.storefrontName(slug)).data;
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
  return useQuery(pq.licenses(enabled));
}

export function useLicense(
  product: string,
  id: string | null,
): UseQueryResult<PortalLicenseDetail> {
  return useQuery(pq.license(product, id));
}

/** Releases are optional data: when the module is off the query never runs. */
export function useReleases(enabled: boolean): UseQueryResult<PortalRelease[]> {
  return useQuery(pq.releases(enabled));
}

/**
 * The Library (PX-W1, PX-08): `GET /api/library` decides which products the account holds, each
 * one's status from its best licence, its presentation and art (G1), its seats (G5) and support
 * links (G16), and the Discover count once the Worker lists offers (G24).
 */
export function useLibraryView(enabled = true): UseQueryResult<PortalLibrary> {
  return useQuery(pq.library(enabled));
}

/**
 * Discover's offers (PX-W10, `GET /api/discover`): every product whose licence policy would
 * auto-issue to this account, evaluated without issuing, each with its terms and reason.
 */
export function useDiscover(
  enabled = true,
): UseQueryResult<PortalDiscoverOffer[]> {
  return useQuery(pq.discover(enabled));
}

/**
 * The storefront product page (PS-04, notes/S-21 §6.5; `GET /api/discover/<p>`): the listing,
 * every way to add it with its terms, and its store pages. Unknown, unlisted, ineligible and held
 * products all answer the same `404`, which the page shows as one not-found state.
 *
 * Opened from Discover, the offer the tile showed stands in until the page answers (its name,
 * art, reason and paths; no description or screenshots yet), so the page has its header from the
 * first frame and the tile's art, icon and name fly into it (MO-05).
 */
export function useStorefrontProduct(
  product: string,
): UseQueryResult<PortalStorefrontProduct> {
  const qc = useQueryClient();
  return useQuery(pq.storefront(product, qc));
}

/**
 * "Add to library" (G25, PS-04): through `path` (a kind the offer listed), or the offer's first
 * path. The Worker re-evaluates and creates once per account and product (a licence, or an open
 * product's library entry); the library (its count and Discover's), the licence summaries and
 * the storefront pages refresh after.
 */
export function useClaimDiscover() {
  return useWrite("claimDiscover", {
    toArgs: (v: { product: string; path?: string }) => [v.product, v.path],
  });
}

/**
 * Remove from library (PS-04): an open product's ENTRY only (`DELETE /api/library/<p>`); a
 * licence leaves only by its own removal. A 404 means it is gone already (another tab): the same
 * outcome, so it resolves as removed. `inLibrary: true` means a licence keeps the product (the
 * entry was replaced by one meanwhile, PS-05). The library, Discover (the product may be offered
 * again) and the product's views refresh.
 */
export function useRemoveLibraryEntry() {
  return useWrite("removeLibraryEntry", {
    toArgs: (product: string): [string] => [product],
    call: removeLibraryEntryOrGone,
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
  return useQuery(pq.downloads(product, enabled));
}

/**
 * The Package access card's state for one licence (F-21). `null` when this Worker has no such
 * route (404): the card stays hidden, as it does when no private feed exists.
 */
export function usePackageAccess(
  product: string,
  licenseId: string,
): UseQueryResult<PortalPackageAccess | null> {
  return useQuery(pq.registryTokens(product, licenseId));
}

/** Account → Packages: the person's `pkeyp_` tokens and the private feeds they reach. */
export function usePersonalTokens(): UseQueryResult<PortalPersonalTokens> {
  return useQuery(pq.personalTokens());
}

export function useMintPersonalToken() {
  return useWrite("mintPersonalToken", {
    gcTime: 0, // the answer carries the minted token
    toArgs: (input: {
      label: string;
      expiresInDays?: number;
    }): [typeof input] => [input],
  });
}

export function useRevokePersonalToken() {
  return useWrite("revokePersonalToken", {
    toArgs: (tokenId: string): [string] => [tokenId],
  });
}

export function useMintRegistryToken(product: string, licenseId: string) {
  return useWrite("mintRegistryToken", {
    gcTime: 0, // the answer carries the minted token
    toArgs: (
      input: PortalMintTokenInput,
    ): [string, string, PortalMintTokenInput] => [product, licenseId, input],
  });
}

/** Revoke a licence-bound token, from Account → Packages' per-app group (any licence). */
export function useRevokeRegistryToken() {
  return useWrite("revokeRegistryToken", {
    toArgs: (t: {
      product: string;
      licenseId: string;
      tokenId: string;
    }): [string, string, string] => [t.product, t.licenseId, t.tokenId],
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
  return useQuery(pq.product(product, opts.enabled ?? true));
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
    queries: products.map((p) => pq.downloads(p, enabled)),
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
  return useWrite("emailDownload", {
    toArgs: (v: { product: string; platform: string }): [string, string] => [
      v.product,
      v.platform,
    ],
  });
}

/** The activate preview (PX-W5, G22): what adding a key would do, before it is added. */
export function usePreviewKey() {
  return useWrite("previewKey", {
    gcTime: 0, // the key or minted token must not linger in the cache
    toArgs: (key: string): [string] => [key],
  });
}

export function useClaimKey() {
  return useWrite("claimKey", {
    gcTime: 0, // the key or minted token must not linger in the cache
    toArgs: (key: string): [string] => [key],
  });
}

export function useRemoveDevice(product: string, licenseId: string) {
  return useWrite("disconnectDevice", {
    toArgs: (deviceId: string): [string, string, string] => [
      product,
      licenseId,
      deviceId,
    ],
  });
}

/**
 * Account → Profile (PX-W16, `GET /api/me/profile`), or `null` when this Worker has no such route
 * (404): the card then shows the session's name and initials without an editor (G32's fallback).
 */
export function useProfile(): UseQueryResult<PortalProfile | null> {
  return useQuery(pq.profile());
}

/**
 * Save an explicit choice. The answer is the whole profile: it replaces the cached one, and the
 * session's name and picture (the header chip, the account menu) follow from it at once, exactly
 * as `GET /api/me` derives them (`display_name`, else the name it had; the picture's URL).
 */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useWrite("updateProfile", {
    toArgs: (change: PortalProfileChange): [PortalProfileChange] => [change],
    onSuccess: ({ profile }) => {
      qc.setQueryData(qk.profile(), profile);
      qc.setQueryData<PortalMe | null>(qk.me(), (me) =>
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
        err instanceof HttpError &&
        err.reason &&
        STALE_PROFILE_REASONS.has(err.reason)
      )
        void qc.invalidateQueries({ queryKey: qk.profile() });
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
  return useWrite("uploadPicture", {
    toArgs: (file: Blob): [Blob] => [file],
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
  return useWrite("removeLicense", {
    toArgs: (licenseId: string): [string, string] => [product, licenseId],
    call: removeLicenseOrGone,
    // A refusal (`409 not_removable`) means the licence is not removable: the views re-read, so
    // the page stops offering Remove.
    onError: (err, licenseId) => {
      if (err instanceof HttpError && err.status === 409) {
        qc.removeQueries({ queryKey: qk.license(product, licenseId) });
        void qc.invalidateQueries({ queryKey: qk.licenses() });
        void qc.invalidateQueries({ queryKey: qk.library() });
        void qc.invalidateQueries({ queryKey: qk.product(product) });
        void qc.invalidateQueries({ queryKey: qk.releases() });
        void qc.invalidateQueries({ queryKey: qk.discover() });
      }
    },
  });
}

export function useDeleteAccount() {
  return useWrite("deleteMe", { toArgs: (_v: void): [] => [] });
}

export function useCancelAccountDeletion() {
  return useWrite("cancelDeletion", { toArgs: (_v: void): [] => [] });
}

/**
 * I-11: Download my data (`GET /api/me/export`), the whole account as one JSON file the browser
 * saves. The person starts it with a press, never on load. It reads and changes nothing, so no
 * view refreshes.
 */
export function useExportAccountData() {
  return useMutation({ mutationFn: () => portalApi.exportAccountData() });
}

/**
 * I-11: a product page's copy of what that one product holds for the person
 * (`GET /api/products/<p>/export`). It is only ever the product the page is about: the account's
 * own data and every other product stay out of it.
 */
export function useExportProductData(product: string) {
  return useMutation({
    mutationFn: () => portalApi.exportProductData(product),
  });
}

/**
 * I-11: "Get a support code" (`POST /api/products/<p>/support-code`). The product view carries the
 * code once it exists, so a success reads that view again.
 */
export function useCreateSupportCode(product: string) {
  return useWrite("createSupportCode", {
    toArgs: (_v: void): [string] => [product],
  });
}

/**
 * I-11: Remove my data from <Product> (`DELETE /api/products/<p>/data`). `alsoRemoveLicense` is the
 * person's explicit choice to take the product's licenses out of the library too; without it they
 * stay. `licenseIds` are the licenses the page holds in this product, so the views that show them
 * refresh by their own keys.
 *
 * Views refresh only once the Worker has answered: a refusal (`409 not_removable`, nothing written)
 * or any other error leaves the library and the product as they were. After a success the devices
 * have lost their binding and a license may have left, so the licenses, the library, the product,
 * the releases and Discover (the product may be offered again) are read again.
 */
export function useRemoveProductData(
  product: string,
  licenseIds: readonly string[],
) {
  const qc = useQueryClient();
  return useWrite("removeProductData", {
    toArgs: (alsoRemoveLicense: boolean): [string, boolean] => [
      product,
      alsoRemoveLicense,
    ],
    // A licence that left is dropped; the table refreshes the rest.
    onSuccess: (res) => {
      for (const id of licenseIds)
        if (res.detachedLicenses.includes(id))
          qc.removeQueries({ queryKey: qk.license(product, id) });
    },
  });
}

/**
 * Account → Sign-in methods (PX-W12, `GET /api/me/methods`), or `null` when this Worker has no
 * such route (404): the section then lists the session's email alone (G27's fallback).
 */
export function useMethods(): UseQueryResult<PortalMethods | null> {
  return useQuery(pq.methods());
}

/**
 * `GET /api/me/link` (PX-W12): the join screen and the joins still undoable; `null` when this
 * Worker has no such route (404), which hides every way in. Always read fresh: the answer depends
 * on this browser's link flow.
 */
export function useLinkView(): UseQueryResult<PortalLinkView | null> {
  return useQuery(pq.link());
}

/**
 * Where you're signed in (I-07, `GET /api/sessions`), or `null` when this Worker has no such
 * route (404): the section is left out rather than shown empty.
 */
export function useSessions(): UseQueryResult<PortalSession[] | null> {
  return useQuery(pq.sessions());
}

/** Disconnect a sign-in method (step-up first; never the last one). */
export function useRemoveMethod() {
  const qc = useQueryClient();
  return useWrite("removeMethod", {
    toArgs: (id: string): [string] => [id],
    onError: (err) => {
      // Refused for the account's state (`last_link`, `only_email`) or gone already: re-read it,
      // so the page stops offering what the Worker refuses.
      if (
        err instanceof HttpError &&
        (err.status === 409 || err.status === 403 || err.status === 404)
      )
        void qc.invalidateQueries({ queryKey: qk.methods() });
    },
  });
}

/** Make a verified email the primary (step-up first). The answer is the methods list. */
export function useMakePrimary() {
  const qc = useQueryClient();
  return useWrite("makePrimary", {
    toArgs: (methodId: string): [string] => [methodId],
    onSuccess: (view) => {
      qc.setQueryData(qk.methods(), view);
    },
    onError: (err) => {
      if (err instanceof HttpError && err.status === 404)
        void qc.invalidateQueries({ queryKey: qk.methods() });
    },
  });
}

/** Name a passkey, or clear its name (step-up first). */
export function useRenamePasskey() {
  const qc = useQueryClient();
  return useWrite("renamePasskey", {
    toArgs: (v: {
      id: string;
      name: string | null;
    }): [string, string | null] => [v.id, v.name],
    onError: (err) => {
      if (err instanceof HttpError && err.status === 404)
        void qc.invalidateQueries({ queryKey: qk.methods() });
    },
  });
}

/**
 * The session again, now (`GET /api/me`): after a step-up sign-in the browser holds a new
 * session, with a new CSRF token, which every later change must carry.
 */
export async function refreshSession(
  client: QueryClient,
): Promise<PortalMe | null> {
  // Not `fetchQuery`: it would join a `/api/me` already in flight, sent with the old cookie,
  // whose answer would put the old CSRF token back. A request of its own, sent now, and its
  // answer is the session (`fetchSession` sets the token).
  await client.cancelQueries({ queryKey: qk.me() });
  const me = await fetchSession();
  client.setQueryData(qk.me(), me);
  return me;
}

/** End one other session (a browser or app signed in to this account). */
export function useEndSession() {
  const qc = useQueryClient();
  return useWrite("endSession", {
    toArgs: (id: string): [string] => [id],
    // The list is re-read whether or not the session was still there to end.
    onError: () => void qc.invalidateQueries({ queryKey: qk.sessions() }),
  });
}

/** Sign out everywhere: every session and app of the account, this browser's included. */
export function useSignOutEverywhere() {
  return useWrite("signOutEverywhere", { toArgs: (_v: void): [] => [] });
}

/**
 * Start a download: mint a fresh link (`POST …/token`, "Download links are made fresh when you
 * click") and follow it.
 */
export function useStartDownload() {
  return useWrite("downloadToken", {
    toArgs: (v: {
      product: string;
      releaseId: string;
      artifactId: string;
    }): [string, string, string] => [v.product, v.releaseId, v.artifactId],
    // `p` names the product, so a link that no longer works lands back on its page (HA-09F).
    onSuccess: (res, v) =>
      browser.go(`${res.url}?p=${encodeURIComponent(v.product)}`),
  });
}
