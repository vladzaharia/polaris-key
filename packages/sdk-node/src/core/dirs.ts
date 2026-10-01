// Platform directories for one product: config (unchanged), data, cache and state (P1b-09 plan
// §5.4).
//
// Every option is a BASE and the SDK appends `<product>`, exactly as `configDir` has always
// worked. The config base does NOT move: it holds the token, the device id and `managed.json`,
// and a developer's Node, Python and Swift tools share it, so moving it without a migration in
// all three SDKs at once would lose tokens (plan D5). The three new bases live under a
// `polaris-key` vendor segment, so they cannot collide with the host application's own folder,
// which is usually named after the product (plan D6).
//
// Resolution is PURE: nothing here creates a directory, so nothing new appears on disk until a
// consumer (packs, P4-06) uses one. `excludeFromBackup` is the one helper with a side effect,
// and it never throws.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The four directories of one product. Each already ends in `<product>`. */
export interface ProductDirs {
  config: string;
  data: string;
  cache: string;
  state: string;
}

/** Host-provided base overrides. Each is a base; the product slug is appended. */
export interface DirOverrides {
  configDir?: string;
  dataDir?: string;
  cacheDir?: string;
  stateDir?: string;
}

/** What resolution reads from the process, injectable so every OS's table runs on any host. */
export interface DirsHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const VENDOR = "polaris-key";

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** An XDG variable counts only when set, non-empty and absolute (the XDG Base Directory
 *  spec). */
function xdg(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value && posix.isAbsolute(value) ? value : null;
}

/** The default BASES (before `<product>` is appended) for this host. */
export function defaultDirBases(host: DirsHost = {}): ProductDirs {
  const platform = host.platform ?? process.platform;
  const env = host.env ?? process.env;
  const home = host.home ?? homedir();
  const path = pathFor(platform);

  // The config base is today's, on every OS. The one change: an EMPTY `XDG_CONFIG_HOME` now
  // means `~/.config` (as in Python) rather than `./<product>` under the working directory.
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");

  if (platform === "darwin") {
    const support = path.join(home, "Library", "Application Support", VENDOR);
    return {
      config,
      data: path.join(support, "data"),
      cache: path.join(home, "Library", "Caches", VENDOR),
      state: path.join(support, "state"),
    };
  }
  if (platform === "win32") {
    const local =
      env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
        ? env.LOCALAPPDATA
        : win32.join(home, "AppData", "Local");
    const root = win32.join(local, VENDOR);
    return {
      config,
      data: win32.join(root, "data"),
      cache: win32.join(root, "cache"),
      state: win32.join(root, "state"),
    };
  }
  return {
    config,
    data: path.join(
      xdg(env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share"),
      VENDOR,
    ),
    cache: path.join(
      xdg(env, "XDG_CACHE_HOME") ?? path.join(home, ".cache"),
      VENDOR,
    ),
    state: path.join(
      xdg(env, "XDG_STATE_HOME") ?? path.join(home, ".local", "state"),
      VENDOR,
    ),
  };
}

/** Resolve a product's four directories: each override base, else the platform default,
 *  with `<product>` appended. Creates nothing. */
export function resolveDirs(
  productSlug: string,
  overrides: DirOverrides = {},
  host: DirsHost = {},
): ProductDirs {
  const path = pathFor(host.platform ?? process.platform);
  const bases = defaultDirBases(host);
  return {
    config: path.join(overrides.configDir ?? bases.config, productSlug),
    data: path.join(overrides.dataDir ?? bases.data, productSlug),
    cache: path.join(overrides.cacheDir ?? bases.cache, productSlug),
    state: path.join(overrides.stateDir ?? bases.state, productSlug),
  };
}

export type BackupExclusion = "excluded" | "not-applicable" | "failed";

/** The `CACHEDIR.TAG` signature line, which tar, borg and restic skip under
 *  `--exclude-caches` (https://bford.info/cachedir/). */
export const CACHEDIR_TAG_SIGNATURE =
  "Signature: 8a477f597d28d172789f06886806bc55";

const CACHEDIR_TAG =
  `${CACHEDIR_TAG_SIGNATURE}\n` +
  "# This file is a cache directory tag created by Polaris Key.\n" +
  "# For information about cache directory tags, see https://bford.info/cachedir/\n";

/** The side effects `excludeFromBackup` performs, injectable for tests. */
export interface BackupHost {
  platform?: NodeJS.Platform;
  /** Run a command; throw on failure. */
  run?: (cmd: string, args: string[]) => void;
  /** Create a file exclusively; throw on failure (EEXIST counts as success). */
  writeFile?: (path: string, data: string) => void;
}

function defaultRun(cmd: string, args: string[]): void {
  execFileSync(cmd, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10_000,
    windowsHide: true,
  });
}

function defaultWriteFile(path: string, data: string): void {
  writeFileSync(path, data, { flag: "wx", mode: 0o644 });
}

/**
 * Mark an EXISTING directory (the caller creates it first, at 0700) as excluded from backups.
 *
 * - Every POSIX host gets a `CACHEDIR.TAG`.
 * - macOS also runs `/usr/bin/tmutil addexclusion`, a sticky per-item Time Machine exclusion.
 * - Windows returns `not-applicable`: it has no per-directory exclusion convention, and
 *   `%LOCALAPPDATA%` neither roams nor sits in OneDrive's known folders.
 *
 * Never throws: `failed` when any step fails.
 */
export function excludeFromBackup(
  dir: string,
  host: BackupHost = {},
): BackupExclusion {
  const platform = host.platform ?? process.platform;
  if (platform === "win32") return "not-applicable";
  const run = host.run ?? defaultRun;
  const writeFile = host.writeFile ?? defaultWriteFile;
  try {
    try {
      writeFile(posix.join(dir, "CACHEDIR.TAG"), CACHEDIR_TAG);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    if (platform === "darwin") run("/usr/bin/tmutil", ["addexclusion", dir]);
    return "excluded";
  } catch {
    return "failed";
  }
}
