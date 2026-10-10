// `velopackDriver` (SDK parity pass SP-N09): install a signed `binary` decision through
// Velopack's `UpdateManager`, pointed at the product's Velopack feed from discovery
// (`update.feedUrl("velopack")`, P3-09). The host passes a factory over its own `velopack`
// dependency, so this package never installs the native module:
//
//   import { UpdateManager } from "velopack";
//   client.update.useDriver(velopackDriver({
//     velopackChannel: "win",
//     createManager: (url, channel) => new UpdateManager(url, { ExplicitChannel: channel }),
//   }));
//
// As with every driver, the SDK's verified decision is the authority: Velopack's feed must
// offer exactly the decided version. Installation is currently disabled because this
// manager API cannot expose the exact package bytes for release-record verification.

import {
  unsupported,
  type InstallContext,
  type InstallDriver,
  type InstallOutcome,
  type InstallableDecision,
} from "./types.js";

/** One Velopack `UpdateInfo` (only what the driver reads). */
export interface VelopackUpdateInfo {
  TargetFullRelease?: { Version?: string };
}

/** The part of Velopack's Node `UpdateManager` the driver uses. */
export interface VelopackManagerLike {
  checkForUpdatesAsync(): Promise<VelopackUpdateInfo | null>;
  downloadUpdateAsync(
    update: VelopackUpdateInfo,
    progress?: (percent: number) => void,
  ): Promise<void>;
  waitExitThenApplyUpdate(
    update: VelopackUpdateInfo,
    silent?: boolean,
    restart?: boolean,
    restartArgs?: string[],
  ): void;
}

export interface VelopackDriverOptions {
  /** The Velopack channel the app was packed for (`win`, `osx-arm64`, `linux-x64`, …). */
  velopackChannel: string;
  /** Build an `UpdateManager` for the feed's base URL and channel. */
  createManager: (baseUrl: string, channel: string) => VelopackManagerLike;
  /** Arguments for the restarted app. */
  restartArgs?: string[];
  /** Quit this process so Velopack can apply (default `process.exit(0)`; an Electron host
   *  passes `() => app.quit()`). */
  exit?: () => void;
}

export function velopackDriver(opts: VelopackDriverOptions): InstallDriver {
  return {
    name: "velopack",
    async install(
      decision: InstallableDecision,
      ctx: InstallContext,
    ): Promise<InstallOutcome> {
      if (decision.action !== "binary")
        return unsupported(
          "outlet",
          "Velopack installs direct builds; a store decision opens the listing.",
        );
      const feed = await ctx.feedUrl("velopack", {
        velopackChannel: opts.velopackChannel,
      });
      if (!feed.supported) return unsupported(feed.reason, feed.detail);
      // Feed versions/checksums share the distribution server's trust domain. They cannot
      // authorize executable bytes on behalf of the independently pinned release key.
      // Do not create a manager: an implementation may download automatically on check.
      return unsupported(
        "runtime",
        "Velopack installation is disabled until the exact applied package can be verified against the pinned-key-signed release record (version, size and SHA-256).",
      );
    },
  };
}
