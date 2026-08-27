// Hardware fingerprint collection. Each component is hashed HERE, on the device, so the raw
// serial/UUID/MAC never crosses the wire — the server only ever compares opaque digests. This
// mirrors the device-id construction in `./deviceId.ts` (`pkey-device:…`) so both formulas are
// recognisably the same shape, and both are pinned by conformance/corpus/v2/fingerprint.json —
// which is why `@polaris-key/node/devices` exports the pair together.
//
// Every read is best-effort. A component that cannot be read is OMITTED, never substituted:
// a partial fingerprint degrades match precision, whereas a placeholder would make every
// partial reader collide with every other one.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, networkInterfaces, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import {
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_COMPONENT_LENGTH,
  FINGERPRINT_HASH_PREFIX,
  FINGERPRINT_HWID_LENGTH,
  type FingerprintComponent,
  type HardwareFingerprint,
} from "@polaris-key/protocol/core";

type RawComponents = Partial<Record<FingerprintComponent, string>>;

function sha256B64url(input: string, length: number): string {
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, length);
}

/** Run a command, returning null on any failure (missing binary, non-zero exit, timeout). */
function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function firstMatch(text: string | null, re: RegExp): string | null {
  if (!text) return null;
  return text.match(re)?.[1]?.trim() || null;
}

/** Total RAM rounded down to a power of two in GiB, so a BIOS/OS reporting 15.9 vs 16.0 GiB
 *  doesn't read as a hardware change. */
function ramBucket(): string | null {
  const gib = totalmem() / 1024 ** 3;
  if (!Number.isFinite(gib) || gib <= 0) return null;
  return String(2 ** Math.floor(Math.log2(gib)));
}

/** CPU brand plus core count — one component, since they change together. */
function cpuModel(): string | null {
  const list = cpus();
  const model = list[0]?.model?.trim();
  return model ? `${model}:${list.length}` : null;
}

/** The lowest non-internal, non-zero MAC.
 *
 *  Selected by ADDRESS rather than by interface name deliberately: interface naming is
 *  unstable across reboots and OS upgrades (en0 vs eth0 vs enp3s0), so sorting by name would
 *  make a rename look like a hardware change. Sorting by the address is stable while the NIC
 *  set is. */
function primaryMac(): string | null {
  const macs = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      if (!addr.mac || addr.mac === "00:00:00:00:00:00") continue;
      macs.add(addr.mac.toLowerCase());
    }
  }
  if (macs.size === 0) return null;
  return [...macs].sort()[0]!;
}

function darwinComponents(): RawComponents {
  const ioreg = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  return {
    ...opt(
      "machineUuid",
      firstMatch(ioreg, /"IOPlatformUUID"\s*=\s*"([^"]+)"/),
    ),
    ...opt(
      "boardSerial",
      firstMatch(ioreg, /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/),
    ),
    ...opt(
      "bootVolumeUuid",
      firstMatch(
        run("diskutil", ["info", "-plist", "/"]),
        /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/,
      ),
    ),
    ...opt("machineModel", run("sysctl", ["-n", "hw.model"])?.trim() || null),
  };
}

function win32Components(): RawComponents {
  const reg = run("reg", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]);
  return {
    ...opt(
      "machineUuid",
      firstMatch(reg, /MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/),
    ),
    ...opt(
      "boardSerial",
      csvValue(
        run("wmic", ["baseboard", "get", "serialnumber", "/format:csv"]),
      ),
    ),
    ...opt(
      "bootVolumeUuid",
      firstMatch(
        run("cmd", ["/c", "vol", "C:"]),
        /Volume Serial Number is ([A-Za-z0-9-]+)/,
      ),
    ),
    ...opt(
      "machineModel",
      csvValue(run("wmic", ["computersystem", "get", "model", "/format:csv"])),
    ),
  };
}

/** `wmic … /format:csv` emits a blank line, a header row, then `Node,<value>`. */
function csvValue(out: string | null): string | null {
  if (!out) return null;
  const rows = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = rows[rows.length - 1];
  if (!last || !last.includes(",")) return null;
  return last.slice(last.indexOf(",") + 1).trim() || null;
}

function linuxComponents(): RawComponents {
  return {
    // product_uuid is genuinely hardware-scoped; machine-id is per OS INSTALL and changes on
    // a container/VM clone, so it is only the fallback.
    ...opt(
      "machineUuid",
      readText("/sys/class/dmi/id/product_uuid") ??
        readText("/etc/machine-id") ??
        readText("/var/lib/dbus/machine-id"),
    ),
    ...opt("boardSerial", readText("/sys/class/dmi/id/board_serial")),
    ...opt(
      "bootVolumeUuid",
      firstMatch(run("findmnt", ["-no", "UUID", "/"]), /^(\S+)/),
    ),
    ...opt("machineModel", readText("/sys/class/dmi/id/product_name")),
  };
}

/** Include a key only when it has a value — the omission rule, in one place. */
function opt(key: FingerprintComponent, value: string | null): RawComponents {
  return value ? ({ [key]: value } as RawComponents) : {};
}

/** Read the platform-specific raw component values. Exported for tests. */
export function rawComponents(): RawComponents {
  const platformSpecific =
    process.platform === "darwin"
      ? darwinComponents()
      : process.platform === "win32"
        ? win32Components()
        : linuxComponents();
  return {
    ...platformSpecific,
    ...opt("cpuModel", cpuModel()),
    ...opt("primaryMac", primaryMac()),
    ...opt("ramBucket", ramBucket()),
  };
}

/** Hash raw component values into the wire form. Pure — the unit under conformance test. */
export function hashComponents(
  productSlug: string,
  raw: RawComponents,
): HardwareFingerprint {
  const components: RawComponents = {};
  const parts: string[] = [];
  // Iterate the CANONICAL order, never the map's insertion order, so the hwid is stable
  // regardless of how components were discovered.
  for (const component of FINGERPRINT_COMPONENTS) {
    const value = raw[component];
    if (value === undefined) continue;
    const digest = sha256B64url(
      `${FINGERPRINT_HASH_PREFIX}:${productSlug}:${component}:${value}`,
      FINGERPRINT_COMPONENT_LENGTH,
    );
    components[component] = digest;
    parts.push(`${component}=${digest}`);
  }
  return {
    components,
    hwid: sha256B64url(parts.join("\n"), FINGERPRINT_HWID_LENGTH),
  };
}

/** Collect and hash this machine's fingerprint. Returns null if nothing could be read. */
export function collectFingerprint(
  productSlug: string,
): HardwareFingerprint | null {
  const raw = rawComponents();
  if (Object.keys(raw).length === 0) return null;
  return hashComponents(productSlug, raw);
}
