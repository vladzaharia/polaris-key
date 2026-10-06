// `seaSelfReplaceDriver` (SDK parity pass SP-N09): update a Node single-executable build (or any
// one-file CLI binary) in place.
//
//   1. `release.fetch` downloads the decided build next to the executable (`<exe>.new`) and
//      verifies its size and SHA-256 against the signed release record, so nothing unverified is
//      ever executed;
//   2. the running executable is renamed to `<exe>.previous` (POSIX and Windows both allow
//      renaming a running image), and `<exe>.new` takes its name;
//   3. `restartRequired`: the new build runs from the next launch, or now through `restart()`.
//
// `<exe>.previous` (and `<exe>.previous.json`, naming its version) is the rollback (§3.15): after `MAX_FAILED_BOOTS` unconfirmed launches the
// boot guard calls `rollback()`, which puts it back. A payload that is an archive or an
// installer is refused (`product`): only a bare executable can replace itself.

import { spawn } from "node:child_process";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { readJson, writeJson } from "../../core/jsonFile.js";
import {
  unsupported,
  type InstallContext,
  type InstallDriver,
  type InstallOutcome,
  type InstallableDecision,
} from "./types.js";

export interface SeaSelfReplaceDriverOptions {
  /** The executable to replace. Default `process.execPath`. */
  executablePath?: string;
  /** Whether this process is a single-executable build. Default `node:sea`'s `isSea()`; a host
   *  that ships another one-file binary (pkg, bun, deno compile) passes `() => true`. */
  isSea?: () => boolean | Promise<boolean>;
  /** Default `process.platform` (decides the executable bit). */
  platform?: NodeJS.Platform;
  /** Start the new build and quit (default: spawn it detached with this process's arguments,
   *  then `process.exit(0)`). */
  relaunch?: (executablePath: string) => void | Promise<void>;
}

const ARCHIVE =
  /\.(zip|tar|tgz|gz|xz|bz2|zst|dmg|pkg|msi|msix|appx|deb|rpm|appimage|exe\.zip)$/i;

async function defaultIsSea(): Promise<boolean> {
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

interface RecordBuild {
  id: string;
  artifacts?: { name?: string; role?: string }[];
}

export function seaSelfReplaceDriver(
  opts: SeaSelfReplaceDriverOptions = {},
): InstallDriver {
  const exe = opts.executablePath ?? process.execPath;
  const next = `${exe}.new`;
  const previous = `${exe}.previous`;
  const platform = opts.platform ?? process.platform;
  /** Which version `<exe>.previous` is, so a rollback never restores the wrong build. */
  const marker = `${previous}.json`;

  return {
    name: "sea",
    async install(
      decision: InstallableDecision,
      ctx: InstallContext,
    ): Promise<InstallOutcome> {
      if (decision.action !== "binary")
        return unsupported(
          "outlet",
          "a single-executable build updates from direct builds only.",
        );
      if (!(await Promise.resolve((opts.isSea ?? defaultIsSea)())))
        return unsupported(
          "runtime",
          "this process is not a single-executable build; replacing process.execPath would replace Node itself.",
        );
      if (!decision.release.sha256)
        return unsupported("product", "the decision names no release record.");
      const record = await ctx.record(decision.release.sha256);
      const build = (
        (record as unknown as { builds?: RecordBuild[] }).builds ?? []
      ).find((b) => b.id === decision.build);
      const payload =
        build?.artifacts?.find((a) => a.role === "payload") ??
        build?.artifacts?.[0];
      if (payload?.name && ARCHIVE.test(payload.name))
        return unsupported(
          "product",
          `build ${decision.build}'s payload (${payload.name}) is a package, not a bare executable.`,
        );
      const version = decision.release.version;
      await ctx.fetch(decision, {
        to: next,
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (platform !== "win32") await chmod(next, 0o755);
      await rm(previous, { force: true });
      await rename(exe, previous);
      try {
        await rename(next, exe);
      } catch (e) {
        await rename(previous, exe).catch(() => undefined);
        throw e;
      }
      await writeJson(marker, {
        previousVersion: ctx.currentVersion,
        installed: version,
      });
      await ctx.journal("update_applied", {
        release: version,
        fromRelease: ctx.currentVersion,
      });
      return {
        kind: "restartRequired",
        version,
        restart: async () => {
          if (opts.relaunch) return opts.relaunch(exe);
          spawn(exe, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
          }).unref();
          process.exit(0);
        },
      };
    },
    async rollback(previousVersion: string): Promise<boolean> {
      if (!(await exists(previous))) return false;
      const s = await readJson<{ previousVersion?: string }>(marker, {});
      if (s.previousVersion !== previousVersion) return false;
      await rm(next, { force: true });
      await rename(exe, next);
      try {
        await rename(previous, exe);
      } catch {
        await rename(next, exe).catch(() => undefined);
        return false;
      }
      await rm(next, { force: true }).catch(() => undefined);
      await rm(marker, { force: true }).catch(() => undefined);
      return true;
    },
  };
}
