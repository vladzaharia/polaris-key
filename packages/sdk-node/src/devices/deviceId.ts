// The device identity formula — wire contract v3 §6, pinned by
// `conformance/corpus/v2/fingerprint.json` (`fingerprintVersion` 1, unchanged in v3).
//
// It lives under `devices/` because that is what it IS: the Device principal's name, the value
// that goes into `X-PKey-Device`, into every signed document's `deviceId` claim, and into
// the server's primary key. `core/store.ts` calls it to mint one on first run, which is a store
// USING an identity rather than a store defining one.
//
// The raw OS identifier is hashed here, on the device, so it never crosses the wire — the same
// discipline `fingerprint.ts` applies to every hardware component.
//
// NOTE the domain prefix is `pkey-device:` and is deliberately NOT rebranded: it is baked into
// every device id already enrolled, and changing it would orphan the fleet. §8 rebrands
// user-visible identifiers, not hash domains — `FINGERPRINT_HASH_PREFIX` is frozen for exactly
// the same reason.

import { createHash, randomUUID } from "node:crypto";
import {
  defaultFingerprintIo,
  readLinuxAnchor,
  type FingerprintIo,
} from "./fingerprint.js";

/**
 * The raw OS identifier the device id hashes, or null when none is readable. On Linux this is
 * rule 2 of WIRE-CONTRACT-V3 §6.1 — the same anchor the fingerprint's `machineUuid` uses: the
 * first of `/etc/machine-id` and `/var/lib/dbus/machine-id` that is non-empty after trimming
 * and not `uninitialized`. (Before P1b-09 a MISSING `/etc/machine-id` skipped the dbus file and
 * minted a random id, and two empty files hashed `""`, so every such host shared one id.)
 *
 * Exported for tests; `platform` and `io` are injectable so any OS's branch runs on any host.
 */
export function rawDeviceId(
  platform: NodeJS.Platform = process.platform,
  io: FingerprintIo = defaultFingerprintIo,
): string | null {
  if (platform === "darwin") {
    const out = io.run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    return out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  }
  if (platform === "win32") {
    const out = io.run("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    return out?.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/)?.[1] ?? null;
  }
  return readLinuxAnchor(io)?.value ?? null;
}

/** The device-id formula itself, split out from the hardware read so it can be pinned by the
 *  conformance corpus. Node, Python, and Swift must agree here exactly. */
export function deviceIdFromRaw(productSlug: string, raw: string): string {
  return createHash("sha256")
    .update(`pkey-device:${productSlug}:${raw}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

/** Derive a stable, hashed device id so the raw OS identifier never leaves the device. */
export function deriveDeviceId(
  productSlug: string,
  fallback?: string | null,
): string {
  return deviceIdFromRaw(
    productSlug,
    rawDeviceId() ?? fallback ?? randomUUID(),
  );
}
