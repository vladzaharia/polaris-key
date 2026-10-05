// `electronUpdaterDriver` (SDK parity pass SP-N09): hand a signed `binary` decision to
// electron-updater's `autoUpdater`, which the host configured with its own provider.
//
// The SDK's decision stays the authority: the driver installs only when electron-updater's feed
// offers exactly the version the verified decision names, and (by default) only when the file
// electron-updater downloaded hashes to an artifact of that build in the signed release record.
// electron-updater's own checks (sha512, the Windows publisher) still run; this adds the
// product's signature on top.
//
//   import { autoUpdater } from "electron-updater";
//   client.update.useDriver(electronUpdaterDriver({ autoUpdater }));

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../../constants.generated.js";
import {
  unsupported,
  type InstallContext,
  type InstallDriver,
  type InstallOutcome,
  type InstallableDecision,
} from "./types.js";

/** The part of electron-updater's `AppUpdater` the driver uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit?: boolean;
  checkForUpdates(): Promise<{
    updateInfo?: { version?: string } | null;
  } | null>;
  downloadUpdate(): Promise<string[] | unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(
    event: "download-progress",
    listener: (p: { transferred: number; total: number }) => void,
  ): unknown;
  removeListener(
    event: "download-progress",
    listener: (p: { transferred: number; total: number }) => void,
  ): unknown;
}

export interface ElectronUpdaterDriverOptions {
  autoUpdater: AutoUpdaterLike;
  /** Hash the downloaded file against the signed release record. Default true. */
  verifyAgainstRecord?: boolean;
  /** `quitAndInstall(isSilent, isForceRunAfter)`. Default `(false, true)`. */
  silent?: boolean;
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

interface RecordBuild {
  id: string;
  artifacts?: { sha256?: string }[];
}

export function electronUpdaterDriver(
  opts: ElectronUpdaterDriverOptions,
): InstallDriver {
  const up = opts.autoUpdater;
  return {
    name: "electron-updater",
    async install(
      decision: InstallableDecision,
      ctx: InstallContext,
    ): Promise<InstallOutcome> {
      if (decision.action !== "binary")
        return unsupported(
          "outlet",
          "electron-updater installs direct builds; a store decision opens the listing.",
        );
      const version = decision.release.version;
      up.autoDownload = false;
      const found = await up.checkForUpdates();
      const offered = found?.updateInfo?.version ?? null;
      if (offered !== version)
        return unsupported(
          "version",
          `electron-updater's feed offers ${offered ?? "nothing"}, the signed decision ${version}.`,
        );
      const progress = (p: { transferred: number; total: number }): void =>
        ctx.onProgress?.(p.transferred, p.total);
      up.on("download-progress", progress);
      let files: unknown;
      try {
        files = await up.downloadUpdate();
      } finally {
        up.removeListener("download-progress", progress);
      }
      if (opts.verifyAgainstRecord !== false) {
        const path = Array.isArray(files)
          ? files.find((f): f is string => typeof f === "string")
          : undefined;
        if (!path || !decision.release.sha256)
          throw new PolarisError(
            ErrorCode.payloadMismatch,
            "electron-updater reported no file to verify against the release record.",
          );
        const record = await ctx.record(decision.release.sha256);
        const builds =
          (record as unknown as { builds?: RecordBuild[] }).builds ?? [];
        const build = builds.find((b) => b.id === decision.build);
        const hash = await sha256Of(path);
        if (!build?.artifacts?.some((a) => a.sha256 === hash))
          throw new PolarisError(
            ErrorCode.payloadMismatch,
            `the file electron-updater downloaded is not an artifact of release ${version}'s signed record.`,
          );
      }
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
          up.quitAndInstall(opts.silent ?? false, true);
        },
      };
    },
  };
}
