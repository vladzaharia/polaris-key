// The Node runtime's outlet signals (plans/P3-01.md §2.9 and §4.7; notes/S-06 §§2–9; notes/E9
// §1.2). Pure Node: environment variables, executable path conventions, `node:sea`'s `isSea()`,
// Electron's `process.mas` and `process.windowsStore`, and a few product-named files. No native
// code, no child process.
//
// The MAPPING from these signals to an outlet is client-core's `detectOutlet`, shared with every
// SDK and pinned by `outlet-matrix.json`. This file only READS, and reads only markers: it never
// enumerates installed applications (AGENTS rule 7). A file that belongs to a launcher is read
// only when it is named by the product's own identity (`appmanifest_<steamAppId>.acf`,
// `Caskroom/<caskToken>/`), and raw values never leave the device.
//
//   signal                    read from
//   ────────────────────────  ──────────────────────────────────────────────────────────────────
//   macos.masReceipt          <bundle>/Contents/_MASReceipt/receipt exists (an .app bundle only)
//   macos.receiptSandbox      that receipt contains the ASCII `ProductionSandbox` (TestFlight)
//   macos.homebrewCask        <prefix>/Caskroom/<caskToken>/<version>/<App>.app links to this bundle
//   macos.homebrewFormula     the app's realpath is under …/Cellar/<formula>/
//   windows.packageIdentity   Electron `process.windowsStore`: the family name in the WindowsApps path
//   windows.pathConvention    the app path is under WinGet/Packages, scoop/apps or chocolatey/lib
//   linux.flatpakInfo         /.flatpak-info's [Application] name (written by Flatpak, read-only)
//   linux.snapEnv             SNAP_NAME, SNAP_REVISION
//   linux.appImageEnv         APPIMAGE, APPDIR and the executable path
//   steam.libraryManifest     <library>/steamapps/appmanifest_<steamAppId>.acf names this install
//   steam.appIdEnv            SteamAppId, SteamClientLaunch
//   itch.receipt              the nearest .itch/receipt.json.gz above the app: game.id
//   itch.appEnv               ITCHIO_APP=1 (diagnostic only; it names no product)
//   node.packageManager       npm_config_user_agent's first token, an `_npx` or pnpm-store path,
//                             and whether the script path is inside node_modules/<packageName>/
//
// `steam_appid.txt` is not read: S-06 refuted it as a dev-mode signal, and it names nothing.
//   windows.signatureKind     the host's `windowsSignatureKind` (`readWindowsSignatureKind()`, async,
//                             through PowerShell's WinRT projection; update/stamp.ts)
// The App Installer URI and external location need a native reader: absent here, so such an
// install keeps its stamp.

import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { OutletIds, OutletSignals } from "@polaris-key/client-core";

/** The file-system calls the readers make, so a test can fake a whole install. */
export interface OutletFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  lstatSync(path: string): { isSymbolicLink(): boolean };
  readlinkSync(path: string): string;
}

/** What the readers look at. Every member is optional; the defaults are this process's. */
export interface OutletReaderEnvironment {
  env?: Record<string, string | undefined>;
  /** `process.platform`. */
  platform?: string;
  /** `process.execPath`: the Node binary, a SEA, or an Electron app's executable. */
  execPath?: string;
  /** `process.argv[1]`: the script a plain Node process runs. */
  scriptPath?: string | null;
  /** `node:sea`'s `isSea()`. */
  isSea?: boolean;
  /** Electron's process flags, when present. */
  electron?: { mas?: boolean; windowsStore?: boolean } | null;
  fs?: OutletFs;
  /** The product's npm package name: `node.packageManager` counts only when the script path is
   *  inside `node_modules/<packageName>/`. */
  packageName?: string | null;
  /** The product's outlet identities (the stamp's `outletIds`): which launcher files to read. */
  outletIds?: OutletIds | null;
  /** `Package.Current.SignatureKind` on a packaged Windows app (`readWindowsSignatureKind()`). */
  windowsSignatureKind?: string | null;
}

const realFs: OutletFs = {
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p),
  realpathSync: (p) => nodeFs.realpathSync(p),
  readdirSync: (p) => nodeFs.readdirSync(p),
  lstatSync: (p) => nodeFs.lstatSync(p),
  readlinkSync: (p) => nodeFs.readlinkSync(p),
};

function processIsSea(): boolean {
  try {
    const get = (
      process as unknown as {
        getBuiltinModule?: (
          id: string,
        ) => { isSea?: () => boolean } | undefined;
      }
    ).getBuiltinModule;
    return get?.("node:sea")?.isSea?.() === true;
  } catch {
    return false;
  }
}

/** This process's environment for the readers. */
export function processOutletEnvironment(): OutletReaderEnvironment {
  const p = process as NodeJS.Process & {
    mas?: boolean;
    windowsStore?: boolean;
  };
  const electron =
    typeof process.versions.electron === "string"
      ? { mas: p.mas === true, windowsStore: p.windowsStore === true }
      : null;
  return {
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? null,
    isSea: processIsSea(),
    electron,
    fs: realFs,
  };
}

/** Forward slashes, for matching path conventions on every platform. */
const slashed = (p: string): string => p.replace(/\\/g, "/");

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** The `.app` bundle an executable lives in (`/Applications/X.app/Contents/MacOS/x`), or null. */
function appBundle(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(slashed(execPath));
  return m ? m[1]! : null;
}

/** The leading bytes of a file hold an ASCII marker. */
function containsAscii(bytes: Uint8Array, marker: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(marker, "latin1"));
}

/** `"key" "value"` from a Valve KeyValues (ACF) file, top level or not. */
function acfValue(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s+"([^"]*)"`, "i").exec(text);
  return m ? m[1]! : null;
}

/** `[Application] name=…` from `/.flatpak-info`. */
function flatpakAppName(text: string): string | null {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) section = line;
    else if (section === "[Application]" && line.startsWith("name="))
      return line.slice("name=".length).trim() || null;
  }
  return null;
}

/** The family name (`Name_PublisherId`) of the package an executable runs from, by the
 *  WindowsApps folder convention (`…\WindowsApps\Name_Version_Arch_ResourceId_PublisherId\…`). */
function windowsAppsFamily(execPath: string): string | null {
  const m = /\/WindowsApps\/([^/]+)\//i.exec(slashed(execPath));
  if (!m) return null;
  const parts = m[1]!.split("_");
  return parts.length === 5 ? `${parts[0]}_${parts[4]}` : null;
}

/** An integer `game.id` (a JSON number) as a decimal string, as the stamp's `itchGameId`. */
function decimalId(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return String(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  return null;
}

/**
 * Read this runtime's outlet signals. Every reader is independent and silent: one that cannot
 * read its marker records nothing. Never throws. Pass the result, with the stamp, to
 * client-core's `detectOutlet`.
 */
export function readOutletSignals(
  opts: OutletReaderEnvironment = {},
): OutletSignals {
  const base = processOutletEnvironment();
  const env = opts.env ?? base.env ?? {};
  const platform = opts.platform ?? base.platform ?? "";
  const execPath = opts.execPath ?? base.execPath ?? "";
  const scriptPath =
    opts.scriptPath !== undefined ? opts.scriptPath : (base.scriptPath ?? null);
  const isSea = opts.isSea ?? base.isSea ?? false;
  const electron =
    opts.electron !== undefined ? opts.electron : (base.electron ?? null);
  const fs = opts.fs ?? realFs;
  const ids: OutletIds = opts.outletIds ?? {};
  const signals: OutletSignals = {};

  // The app's own path: the executable for a SEA or an Electron app, else the script.
  const appPath =
    isSea || electron !== null ? execPath : (scriptPath ?? execPath);
  const appReal = safe(() => fs.realpathSync(appPath), appPath);

  // ── macOS ────────────────────────────────────────────────────────────────────────────────
  if (platform === "darwin") {
    const bundle = appBundle(execPath);
    if (bundle !== null) {
      const receipt = join(bundle, "Contents", "_MASReceipt", "receipt");
      const exists = safe(() => fs.existsSync(receipt), false);
      signals["macos.masReceipt"] = exists;
      if (exists)
        signals["macos.receiptSandbox"] = safe(
          () => containsAscii(fs.readFileSync(receipt), "ProductionSandbox"),
          false,
        );
      const token = ids.caskToken;
      if (typeof token === "string" && /^[a-z0-9][a-z0-9@._+-]*$/.test(token))
        for (const prefix of ["/opt/homebrew", "/usr/local"]) {
          const root = join(prefix, "Caskroom", token);
          const linked = safe(
            () =>
              fs.readdirSync(root).some((version) =>
                safe(
                  () =>
                    fs.readdirSync(join(root, version)).some((entry) => {
                      if (!entry.endsWith(".app")) return false;
                      const p = join(root, version, entry);
                      if (!fs.lstatSync(p).isSymbolicLink()) return false;
                      const target = fs.readlinkSync(p);
                      return (
                        target === bundle ||
                        safe(() => fs.realpathSync(p), "") === bundle
                      );
                    }),
                  false,
                ),
              ),
            false,
          );
          if (linked) {
            signals["macos.homebrewCask"] = token;
            break;
          }
        }
    }
    const formula = /\/Cellar\/([^/]+)\//.exec(slashed(appReal));
    if (formula) signals["macos.homebrewFormula"] = formula[1]!;
  }

  // ── Windows ──────────────────────────────────────────────────────────────────────────────
  if (platform === "win32") {
    if (electron?.windowsStore === true) {
      const family = windowsAppsFamily(execPath);
      if (family !== null) signals["windows.packageIdentity"] = family;
    }
    if (opts.windowsSignatureKind)
      signals["windows.signatureKind"] = opts.windowsSignatureKind;
    const p = slashed(appPath).toLowerCase();
    if (p.includes("/microsoft/winget/packages/"))
      signals["windows.pathConvention"] = "winget";
    else if (p.includes("/scoop/apps/"))
      signals["windows.pathConvention"] = "scoop";
    else if (p.includes("/chocolatey/lib/"))
      signals["windows.pathConvention"] = "chocolatey";
  }

  // ── Linux ────────────────────────────────────────────────────────────────────────────────
  if (platform === "linux") {
    const name = safe(
      () =>
        fs.existsSync("/.flatpak-info")
          ? flatpakAppName(
              Buffer.from(fs.readFileSync("/.flatpak-info")).toString("utf8"),
            )
          : null,
      null,
    );
    if (name !== null) signals["linux.flatpakInfo"] = name;
    if (env.SNAP_NAME)
      signals["linux.snapEnv"] = {
        name: env.SNAP_NAME,
        revision: env.SNAP_REVISION ?? null,
      };
    if (env.APPIMAGE && env.APPDIR)
      signals["linux.appImageEnv"] = {
        appImage: env.APPIMAGE,
        appDir: env.APPDIR,
        exePath: execPath,
      };
  }

  // ── Steam and itch (any desktop) ─────────────────────────────────────────────────────────
  const steamAppId = ids.steamAppId;
  if (typeof steamAppId === "string" && /^[0-9]+$/.test(steamAppId)) {
    const m = /^(.*)\/steamapps\/common\/([^/]+)\//i.exec(slashed(appReal));
    if (m) {
      const manifest = join(
        m[1]!,
        "steamapps",
        `appmanifest_${steamAppId}.acf`,
      );
      const text = safe(
        () => Buffer.from(fs.readFileSync(manifest)).toString("utf8"),
        null,
      );
      const appid = text === null ? null : acfValue(text, "appid");
      if (
        text !== null &&
        appid !== null &&
        acfValue(text, "installdir")?.toLowerCase() === m[2]!.toLowerCase()
      )
        signals["steam.libraryManifest"] = appid;
    }
  }
  if (env.SteamAppId)
    signals["steam.appIdEnv"] = {
      appId: env.SteamAppId,
      clientLaunch: env.SteamClientLaunch === "1",
    };
  for (let dir = dirname(appReal), i = 0; i < 12; i++) {
    const receipt = join(dir, ".itch", "receipt.json.gz");
    if (safe(() => fs.existsSync(receipt), false)) {
      const id = safe(() => {
        const doc = JSON.parse(
          gunzipSync(fs.readFileSync(receipt)).toString("utf8"),
        ) as { game?: { id?: unknown } };
        return decimalId(doc?.game?.id);
      }, null);
      if (id !== null) signals["itch.receipt"] = id;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (env.ITCHIO_APP === "1") signals["itch.appEnv"] = true;

  // ── Node package managers (not a SEA or an Electron app) ─────────────────────────────────
  if (!isSea && electron === null && scriptPath) {
    const script = slashed(appReal);
    const agent = (env.npm_config_user_agent ?? "").split(" ")[0] ?? "";
    const agentName = agent.split("/")[0];
    const manager = script.includes("/_npx/")
      ? "npx"
      : agentName === "pnpm" || /\/pnpm\/store\//.test(script)
        ? "pnpm"
        : agentName === "npm"
          ? "npm"
          : null;
    if (manager !== null) {
      const pkg = opts.packageName;
      signals["node.packageManager"] = {
        manager,
        packageMatch:
          typeof pkg === "string" &&
          pkg !== "" &&
          script.includes(`/node_modules/${pkg}/`),
      };
    }
  }
  return signals;
}
