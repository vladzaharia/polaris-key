import * as React from "react";
import {
  capabilitiesOrNone,
  useCapabilities,
  useDownloadsFor,
  useLibraryView,
  useLicenses,
  useReleases,
} from "./data.js";
import {
  buildLibrary,
  detectDevice,
  type DeviceInHand,
  type LibraryProduct,
} from "./model/library.js";
import { discoverCountFrom } from "./model/owned.js";

/**
 * The library as products (PX-08): `GET /api/library` lists them, with their status, seats,
 * presentation and the Discover count; `GET /api/licenses` adds each product's licence summaries,
 * each product's downloads view (PX-W2) the store-aware quick action, and `GET /api/releases`
 * (when the Release module is on) the fallback and the product page's notes.
 */
export function useLibrary(): {
  products: LibraryProduct[] | undefined;
  /** Offers in Discover (G24), or `null` while the Worker can't list them. */
  discoverCount: number | null;
  isPending: boolean;
  error: unknown;
  retry: () => void;
  device: DeviceInHand;
} {
  const caps = useCapabilities();
  const releasesOn = capabilitiesOrNone(caps).modules.releases;
  const library = useLibraryView();
  const licenses = useLicenses();
  const releases = useReleases(releasesOn);
  const slugs = React.useMemo(
    () => library.data?.products.map((p) => p.product) ?? [],
    [library.data],
  );
  const downloads = useDownloadsFor(slugs, releasesOn);
  const [device] = React.useState(() => detectDevice());
  const products = React.useMemo(
    () =>
      library.data
        ? buildLibrary(
            library.data.products,
            licenses.data ?? [],
            releases.data ?? [],
            Math.floor(Date.now() / 1000),
            downloads.bySlug,
          )
        : undefined,
    [library.data, licenses.data, releases.data, downloads.bySlug],
  );
  // Licence summaries, releases and downloads views are extra detail: the library waits for a
  // first answer (so quick actions don't change under the pointer) but never fails for them.
  const releasesPending = releasesOn && releases.isPending;
  const licensesPending = licenses.isPending && licenses.fetchStatus !== "idle";
  return {
    products,
    discoverCount: discoverCountFrom(library.data?.discoverCount),
    isPending:
      library.isPending ||
      caps.isPending ||
      releasesPending ||
      licensesPending ||
      downloads.pending,
    error: library.error,
    retry: () => {
      void library.refetch();
      void licenses.refetch();
      if (releasesOn) void releases.refetch();
    },
    device,
  };
}
