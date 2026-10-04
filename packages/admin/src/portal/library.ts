import * as React from "react";
import {
  capabilitiesOrNone,
  useCapabilities,
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
 * `GET /api/releases` for platforms and quick actions when the Release module is on.
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
  const [device] = React.useState(() => detectDevice());
  const products = React.useMemo(
    () =>
      licenses.data
        ? buildLibrary(
            licenses.data,
            releases.data ?? [],
            Math.floor(Date.now() / 1000),
          )
        : undefined,
    [licenses.data, releases.data],
  );
  // Releases are extra detail: the library shows without them, but waits for a first answer
  // so quick actions don't change under the pointer.
  const releasesPending = releasesOn && releases.isPending;
  return {
    products,
    isPending: licenses.isPending || caps.isPending || releasesPending,
    error: licenses.error,
    retry: () => {
      void licenses.refetch();
      if (releasesOn) void releases.refetch();
    },
    device,
  };
}
