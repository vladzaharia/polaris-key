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
// offer exactly the decided version.

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
      // Velopack's HTTP source takes the directory and appends releases.<channel>.json itself.
      const base = feed.url.replace(/\/releases\.[^/]+\.json(\?.*)?$/, "");
      const manager = opts.createManager(base, opts.velopackChannel);
      const version = decision.release.version;
      const info = await manager.checkForUpdatesAsync();
      const offered = info?.TargetFullRelease?.Version ?? null;
      if (!info || offered !== version)
        return unsupported(
          "version",
          `the Velopack feed offers ${offered ?? "nothing"}, the signed decision ${version}.`,
        );
      await manager.downloadUpdateAsync(info, (percent) =>
        ctx.onProgress?.(percent, 100),
      );
      await ctx.journal("update_downloaded", {
        release: version,
        fromRelease: ctx.currentVersion,
      });
      return {
        kind: "restartRequired",
        version,
        restart: async () => {
          await ctx.journal("update_applied", {
            release: version,
            fromRelease: ctx.currentVersion,
          });
          manager.waitExitThenApplyUpdate(
            info,
            false,
            true,
            opts.restartArgs ?? [],
          );
          (opts.exit ?? (() => process.exit(0)))();
        },
      };
    },
  };
}
