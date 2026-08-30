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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function rawDeviceId(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync(
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8" },
      );
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m?.[1] ?? null;
    }
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
        ],
        { encoding: "utf8" },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/);
      return m?.[1] ?? null;
    }
    return linuxMachineId();
  } catch {
    return null;
  }
}

/** The Linux machine-id sources, in the order every SDK reads them: systemd's
 *  `/etc/machine-id` first, then the D-Bus file for hosts that never had systemd (and for
 *  images where `/etc/machine-id` is a deliberately empty first-boot marker).
 *
 *  Exported so the order is assertable rather than a comment. It matches
 *  `sdks/python/src/polaris_key/devices/deviceid.py`; Swift has no Linux branch at all
 *  (`DeviceID.rawDeviceId()` returns nil off macOS/iOS), so Python is the canonical spelling
 *  and this is Node catching back up to it. */
export const LINUX_MACHINE_ID_PATHS: readonly string[] = [
  "/etc/machine-id",
  "/var/lib/dbus/machine-id",
];

/** First non-empty machine-id file, or null.
 *
 *  Each source is tried INDEPENDENTLY. The previous spelling was
 *  `readFileSync("/etc/machine-id").trim() || readFileSync("/var/lib/dbus/machine-id")` under
 *  one `try`, so an ABSENT `/etc/machine-id` threw and the D-Bus fallback became unreachable on
 *  exactly the hosts that need it — `deriveDeviceId` then fell through to `randomUUID()` and
 *  minted a FRESH device id on EVERY call, burning a seat per run (the same failure Swift's
 *  R4-12 fixed from the other end).
 *
 *  `read` is injectable only so that regression is testable off a Linux host. */
export function linuxMachineId(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  for (const path of LINUX_MACHINE_ID_PATHS) {
    try {
      const id = read(path).trim();
      if (id) return id;
    } catch {
      // Absent or unreadable: try the next source, never abandon the ladder.
    }
  }
  return null;
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
