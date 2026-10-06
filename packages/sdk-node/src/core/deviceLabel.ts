// The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1): the human name of this device
// the sign-in page shows ("Living room TV"), sent as `deviceName` on device-code sign-in, licence
// activation and registration. Display data only: no server decision reads it.
//
// Precedence: a per-call `deviceName`, else the client's `deviceName` option, else the platform
// default (`os.hostname()` with a trailing `.local`, `.lan` or `.home` removed). An empty string
// at either level opts out: no label is sent. Every candidate goes through client-core's
// `normalizeDeviceLabel`, so what is sent is exactly what the Worker stores.

import { hostname } from "node:os";
import { normalizeDeviceLabel } from "@polaris-key/client-core";

/** The trailing mDNS and home-router suffixes a hostname carries but a person never typed. */
const HOST_SUFFIX = /\.(local|lan|home)$/i;

/** The platform's own name for this machine, or null when it reports none. */
export function defaultDeviceName(): string | null {
  try {
    return hostname().replace(HOST_SUFFIX, "") || null;
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
