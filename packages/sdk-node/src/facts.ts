// Software facts: the OS/runtime/hardware summary and the product-declared probe results the
// client reports through POST /<product>/config/report.
//
// Deliberately narrow. There is no installed-application enumeration — a product declares the
// companion apps it cares about and the client answers only those, so the payload stays small
// and the privacy story stays defensible (see docs/PRIVACY.md).

import { execFileSync } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem, type } from "node:os";
import type { DeviceFacts, DeviceProbeResult } from "@polaris-key/protocol";

/** A product-declared companion-application check, delivered in the product's policy. */
export interface ProbeDeclaration {
  id: string;
  label?: string;
  /** Absolute path or bundle directory to test for. */
  macos?: string;
  /** Registry path or executable path to test for. */
  windows?: string;
  /** Executable or package path to test for. */
  linux?: string;
}

function exists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/** macOS apps carry their version in Info.plist; read it best-effort for the probe result. */
function macAppVersion(bundlePath: string): string | undefined {
  try {
    const plist = readFileSync(`${bundlePath}/Contents/Info.plist`, "utf8");
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function osBuild(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("sw_vers", ["-buildVersion"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Run the product's declared probes for this platform. */
export function runProbes(
  declarations: ProbeDeclaration[],
): Record<string, DeviceProbeResult> {
  const out: Record<string, DeviceProbeResult> = {};
  for (const probe of declarations) {
    const target =
      process.platform === "darwin"
        ? probe.macos
        : process.platform === "win32"
          ? probe.windows
          : probe.linux;
    // A probe with no target for this platform is simply not applicable — reporting it as
    // `present: false` would be a lie the admin UI can't distinguish from "not installed".
    if (!target) continue;
    const present = exists(target);
    const version =
      present && process.platform === "darwin"
        ? macAppVersion(target)
        : undefined;
    out[probe.id] = { present, ...(version ? { version } : {}) };
  }
  return out;
}

/** Collect this device's software facts. `appVersion` belongs to the host app, not the SDK. */
export function collectFacts(
  opts: { probes?: ProbeDeclaration[] } = {},
): DeviceFacts {
  const cpuList = cpus();
  const build = osBuild();
  const probes = opts.probes?.length ? runProbes(opts.probes) : undefined;
  return {
    os: {
      // Short family (`darwin`/`win32`/`linux`), matching X-PKey-Platform. The detailed
      // version lives here rather than being crammed into that header.
      name: platform(),
      version: release(),
      ...(build ? { build } : {}),
      kernel: type(),
    },
    hardware: {
      ...(cpuList[0]?.model ? { cpuModel: cpuList[0].model.trim() } : {}),
      cpuCores: cpuList.length,
      ramMb: Math.round(totalmem() / 1024 ** 2),
      machineModel: arch(),
    },
    runtime: { name: "node", version: process.versions.node },
    ...(Intl.DateTimeFormat().resolvedOptions().locale
      ? { locale: Intl.DateTimeFormat().resolvedOptions().locale }
      : {}),
    ...(Intl.DateTimeFormat().resolvedOptions().timeZone
      ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      : {}),
    ...(probes ? { probes } : {}),
  };
}
