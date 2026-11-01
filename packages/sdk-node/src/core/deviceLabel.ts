// The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1): the human name of this device
// the sign-in page shows ("Living room TV"), sent as `deviceName` on device-code sign-in, license
// activation and registration. Display data only: no server decision reads it.
//
// Precedence: a per-call `deviceName`, else the client's `deviceName` option, else the platform
// default (`defaultDeviceName`, SIGN-IN D-73: the computer's own name). An empty string
// at either level opts out: no label is sent. Every candidate goes through client-core's
// `normalizeDeviceLabel`, so what is sent is exactly what the Worker stores.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { normalizeDeviceLabel } from "@polaris-key/client-core";

/** The trailing mDNS and home-router suffixes a hostname carries but a person never typed. */
const HOST_SUFFIX = /\.(local|lan|home)$/i;
/** The names Windows generates at setup (SIGN-IN D-73): a person never chose them. */
const WINDOWS_DESKTOP = /^DESKTOP-[A-Z0-9]+$/i;
const WINDOWS_LAPTOP = /^LAPTOP-[A-Z0-9]+$/i;

/** Where the computer's name comes from; a test supplies its own. */
export interface NameSources {
  platform: NodeJS.Platform;
  hostname: () => string;
  /** macOS: the Sharing name (`scutil --get ComputerName`), or null. */
  macComputerName: () => string | null;
  /** Linux: `PRETTY_HOSTNAME` of `/etc/machine-info`, or null. */
  linuxPrettyHostname: () => string | null;
}

const realSources: NameSources = {
  platform: platform(),
  hostname: () => hostname(),
  macComputerName: () => {
    try {
      return execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
  linuxPrettyHostname: () => {
    try {
      const m = /^PRETTY_HOSTNAME=(.*)$/m.exec(
        readFileSync("/etc/machine-info", "utf8"),
      );
      if (!m) return null;
      return m[1]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    } catch {
      return null;
    }
  },
};

/**
 * The user-visible name of this computer (SIGN-IN D-73): macOS the computer name, Linux
 * `PRETTY_HOSTNAME` else the host name, Windows the host name unless Windows generated it
 * (`DESKTOP-…`, `LAPTOP-…`), then "Windows PC" or "Windows laptop". Null when none is known.
 */
export function defaultDeviceName(
  src: NameSources = realSources,
): string | null {
  try {
    const host = src.hostname().replace(HOST_SUFFIX, "");
    if (src.platform === "darwin") return src.macComputerName() || host || null;
    if (src.platform === "linux")
      return src.linuxPrettyHostname() || host || null;
    if (src.platform === "win32") {
      if (WINDOWS_LAPTOP.test(host)) return "Windows laptop";
      if (WINDOWS_DESKTOP.test(host)) return "Windows PC";
    }
    return host || null;
  } catch {
    return null;
  }
}

/**
 * The label to send: `override` (a per-call value) wins, then `configured` (the client option),
 * then `platformDefault()`. `""` at either level means "send none".
 */
export function resolveDeviceLabel(
  override: string | undefined,
  configured: string | undefined,
  platformDefault: () => string | null = defaultDeviceName,
): string | null {
  if (override !== undefined) return normalizeDeviceLabel(override);
  if (configured !== undefined) return normalizeDeviceLabel(configured);
  return normalizeDeviceLabel(platformDefault());
}
