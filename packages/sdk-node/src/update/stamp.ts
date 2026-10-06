// The build stamp and Windows SignatureKind (SDK parity pass SP-N15).
//
// **Build stamp.** The P1-11 stamp (`.polaris_key/build.json`, `pkeyBuild: 1`, the same file
// Godot's export plugin writes) says which outlet a build was made for. A packager writes it next
// to the app; the SDK loads it when the host passes no `update.stamp`, from the first of:
//
//   $PKEY_BUILD_STAMP (a path)
//   <Electron resourcesPath>/.polaris_key/build.json
//   <directory of the executable>/.polaris_key/build.json   (a single-executable build)
//   <directory of the entry script, and each parent>/.polaris_key/build.json
//
// It is unsigned local data: tampering only changes what the install reports about itself, and
// detection still prefers attested platform evidence over it.
//
// **SignatureKind.** An MSIX-packaged Windows app's `Package.Current.SignatureKind` (`Store`,
// `Developer`, `Enterprise`, `None`, `System`) is attested evidence for `ms-store`. Reading it
// needs WinRT, so it goes through the same Windows PowerShell path the fingerprint's CIM call
// uses; a child of a packaged process runs in its package context. It is async and opt-in:
// `await readWindowsSignatureKind()` and pass the answer as `outletEnvironment.windowsSignatureKind`.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { windowsPowerShellPath } from "../devices/fingerprint.js";

/** The stamp fields the SDK reads (`OutletStamp` plus the build facts). */
export interface BuildStamp {
  pkeyBuild: 1;
  product?: string;
  version?: string;
  build?: number;
  outlet?: string;
  outletKind?: string;
  outletSubkind?: string;
  format?: string;
  channel?: string;
  outletIds?: Record<string, string>;
  [key: string]: unknown;
}

export interface StampHost {
  env?: Record<string, string | undefined>;
  resourcesPath?: string | null;
  execPath?: string;
  scriptPath?: string | null;
  read?: (path: string) => string | null;
}

const STAMP = join(".polaris_key", "build.json");

/** The first readable `pkeyBuild: 1` stamp (see the file header), or null. */
export function loadBuildStamp(host: StampHost = {}): BuildStamp | null {
  const env = host.env ?? process.env;
  const read =
    host.read ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const candidates: string[] = [];
  if (env.PKEY_BUILD_STAMP) candidates.push(env.PKEY_BUILD_STAMP);
  const resources =
    "resourcesPath" in host
      ? host.resourcesPath
      : (process as { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(join(resources, STAMP));
  candidates.push(join(dirname(host.execPath ?? process.execPath), STAMP));
  const script = "scriptPath" in host ? host.scriptPath : process.argv[1];
  if (script) {
    let dir = dirname(script);
    for (let i = 0; i < 8; i += 1) {
      candidates.push(join(dir, STAMP));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const path of candidates) {
    const text = read(path);
    if (text === null) continue;
    try {
      const v = JSON.parse(text) as BuildStamp;
      if (v && typeof v === "object" && v.pkeyBuild === 1) return v;
    } catch {
      // Not a stamp: keep looking.
    }
  }
  return null;
}

/** The SignatureKind values WinRT reports. */
export const SIGNATURE_KINDS = [
  "None",
  "Developer",
  "Enterprise",
  "Store",
  "System",
] as const;

/** The one PowerShell line: prints the current package's SignatureKind, or nothing when the
 *  process has no package identity. ASCII output, no double quotes. */
export const WINDOWS_SIGNATURE_KIND_COMMAND = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference='Stop';try{$p=[Windows.ApplicationModel.Package,Windows.ApplicationModel,ContentType=WindowsRuntime]::Current;[string]$p.SignatureKind}catch{''}",
] as const);

/** This package's SignatureKind, or null (not Windows, not packaged, or PowerShell failed). */
export function readWindowsSignatureKind(
  opts: {
    platform?: string;
    run?: (program: string, args: readonly string[]) => Promise<string | null>;
  } = {},
): Promise<string | null> {
  if ((opts.platform ?? process.platform) !== "win32")
    return Promise.resolve(null);
  const run =
    opts.run ??
    ((program: string, args: readonly string[]) =>
      new Promise<string | null>((resolve) => {
        execFile(
          program,
          [...args],
          { timeout: 5000, windowsHide: true, encoding: "utf8" },
          (err, stdout) => resolve(err ? null : stdout),
        );
      }));
  return run(windowsPowerShellPath(), WINDOWS_SIGNATURE_KIND_COMMAND).then(
    (out) => {
      const v = (out ?? "").trim();
      return (SIGNATURE_KINDS as readonly string[]).includes(v) ? v : null;
    },
    () => null,
  );
}
