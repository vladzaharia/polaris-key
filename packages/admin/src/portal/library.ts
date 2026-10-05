import * as React from "react";
import {
  capabilitiesOrNone,
  useCapabilities,
  useLibraryItems,
  useLicenses,
  useReleases,
} from "./data.js";
import {
  buildLibrary,
  detectDevice,
  type DeviceInHand,
  type LibraryProduct,
} from "./model/library.js";

/**
 * The library as products (PX-02): `GET /api/licenses` grouped client-side, with
 * `GET /api/releases` for platforms and quick actions when the Release module is on, and
 * `GET /api/library` (PX-W1) for presentation, art, seats and support links.
 */
export function useLibrary(): {
  products: LibraryProduct[] | undefined;
  isPending: boolean;
  error: unknown;
  retry: () => void;
  device: DeviceInHand;
} {
  const caps = useCapabilities();
  const releasesOn = capabilitiesOrNone(caps).modules.releases;
  const licenses = useLicenses();
  const releases = useReleases(releasesOn);
  const items = useLibraryItems();
  const [device] = React.useState(() => detectDevice());
  const products = React.useMemo(
    () =>
      licenses.data
        ? buildLibrary(
            licenses.data,
            releases.data ?? [],
            Math.floor(Date.now() / 1000),
            items.data,
          )
        : undefined,
    [licenses.data, releases.data, items.data],
  );
  // Releases are extra detail: the library shows without them, but waits for a first answer
  // so quick actions don't change under the pointer.
  const releasesPending = releasesOn && releases.isPending;
  // Same for the server-side library; a failed read keeps the fallbacks, never an error page.
  const itemsPending = items.isPending && items.fetchStatus !== "idle";
  return {
    products,
    isPending:
      licenses.isPending || caps.isPending || releasesPending || itemsPending,
    error: licenses.error,
    retry: () => {
      void licenses.refetch();
      void items.refetch();
      if (releasesOn) void releases.refetch();
    },
    device,
  };
}
