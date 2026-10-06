// `storeLinkDriver` (SDK parity pass SP-N09): the driver for an install that cannot update
// itself: open the store listing a `store` decision names, or, for a `binary` decision, the
// product's download page (the host's `downloadPage`, else the distribution install URL). The
// user finishes the update; the outcome says the page was opened.

import {
  unsupported,
  type InstallContext,
  type InstallDriver,
  type InstallOutcome,
  type InstallableDecision,
} from "./types.js";

export interface StoreLinkDriverOptions {
  /** The page a `binary` decision opens. Without one a `binary` decision is unsupported. */
  downloadPage?: string | ((version: string) => string | null);
}

export function storeLinkDriver(
  opts: StoreLinkDriverOptions = {},
): InstallDriver {
  return {
    name: "store-link",
    async install(
      decision: InstallableDecision,
      ctx: InstallContext,
    ): Promise<InstallOutcome> {
      const url =
        decision.action === "store"
          ? decision.listingUrl
          : typeof opts.downloadPage === "function"
            ? opts.downloadPage(decision.release.version)
            : (opts.downloadPage ?? null);
      if (!url)
        return unsupported(
          "product",
          decision.action === "store"
            ? "the store decision names no listing URL."
            : "no download page is configured for direct builds.",
        );
      if (!(await ctx.openUrl(url)))
        return unsupported("runtime", `no URL opener could open ${url}.`);
      return { kind: "storeOpened", url };
    },
  };
}
