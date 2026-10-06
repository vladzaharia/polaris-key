// Version autoload (SDK parity pass §2.1, SP-N17): when the host passes no `version`, the SDK finds
// the HOST APPLICATION's version itself — Electron's `app.getVersion()` in a main process, else
// the `version` of the nearest `package.json` above the entry script — and warns once when it can
// find neither (then `0.0.0`, which a build gate treats as the oldest build).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Where to look; injectable for tests. */
export interface AppVersionHost {
  electron?: string | undefined;
  entry?: string | undefined;
  cwd?: string;
  loadElectron?: () => { app?: { getVersion?: () => string } } | null;
  readText?: (path: string) => string | null;
  warn?: (message: string) => void;
}

const SEMVERISH = /^\d+\.\d+\.\d+/;

function nearestPackageVersion(
  start: string,
  read: (p: string) => string | null,
): string | null {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    const text = read(join(dir, "package.json"));
    if (text !== null) {
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        if (typeof v === "string" && SEMVERISH.test(v)) return v;
      } catch {
        // Not JSON: keep walking.
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The host application's version (see the file header). */
export function resolveAppVersion(host: AppVersionHost = {}): string {
  const electron =
    "electron" in host ? host.electron : process.versions.electron;
  if (electron) {
    try {
      const load =
        host.loadElectron ??
        (() =>
          createRequire(import.meta.url)("electron") as {
            app?: { getVersion?: () => string };
          });
      const v = load()?.app?.getVersion?.();
      if (typeof v === "string" && v) return v;
    } catch {
      // A renderer or a utility process has no `app`: fall through to package.json.
    }
  }
  const read =
    host.readText ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const entry = "entry" in host ? host.entry : process.argv[1];
  for (const start of [
    entry ? dirname(entry) : null,
    host.cwd ?? process.cwd(),
  ]) {
    if (!start) continue;
    const v = nearestPackageVersion(start, read);
    if (v) return v;
  }
  (host.warn ?? ((m: string) => process.emitWarning(m, "PolarisKeyWarning")))(
    "Polaris Key: no `version` was given and none could be found (app.getVersion(), package.json); using 0.0.0.",
  );
  return "0.0.0";
}
