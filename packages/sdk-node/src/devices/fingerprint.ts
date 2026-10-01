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
import { win32 } from "node:path";
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

// ── The pure derivation rules (WIRE-CONTRACT-V3 §6.1), pinned by fingerprint.json ──────────

/** The one Windows CIM call (rule 1), byte-for-byte what `fingerprint.json`'s
 *  `windowsCimCommand` pins. One line with no double quotes, so Windows argument quoting cannot
 *  mangle it, and pure-ASCII output, so neither a console code page nor a missing console can
 *  corrupt a value. `program` is resolved by `windowsPowerShellPath()`; stdin is the null
 *  device, because Windows PowerShell 5.1 reads a redirected stdin as pipeline input and would
 *  otherwise wait out the timeout under a parent whose stdin is an open pipe. */
export const WINDOWS_CIM_COMMAND = Object.freeze({
  program: "powershell.exe",
  args: Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='Stop';$b=$null;$m=$null;" +
      "try{$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};" +
      "try{$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};" +
      "$j=ConvertTo-Json -Compress -InputObject @{boardSerial=$b;machineModel=$m};" +
      "$o='';foreach($c in $j.ToCharArray()){$n=[int]$c;if($n -gt 126){$o+='\\u'+$n.ToString('x4')}else{$o+=$c}};$o",
  ] as const),
  stdin: "null",
  timeoutMs: 10_000,
} as const);

/** Rules 1 and 2 trim exactly U+0009–U+000D and U+0020 — never a language's default trim,
 *  which also drops U+00A0 (JS `trim()`) or U+001F (others). */
function isAsciiSpace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20;
}

export function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiSpace(value.charCodeAt(start))) start++;
  while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

export interface WindowsCimComponents {
  boardSerial?: string;
  machineModel?: string;
}

/**
 * Rule 1: parse what `WINDOWS_CIM_COMMAND` printed. Strips one leading U+FEFF, requires a JSON
 * object, and keeps `boardSerial` / `machineModel` only when each is a string that is non-empty
 * after trimming ASCII whitespace. Vendor placeholders are kept verbatim (they are what `wmic`
 * returned, so Windows 10 sees no drift); other keys are ignored; anything else yields `{}`.
 */
export function parseWindowsCim(stdout: string | null): WindowsCimComponents {
  if (!stdout) return {};
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  const out: WindowsCimComponents = {};
  for (const key of ["boardSerial", "machineModel"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const trimmed = trimAsciiWhitespace(value);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** Rule 2's sources, in order. No DMI file is ever read: `product_uuid` and `board_serial` are
 *  root-only, so reading them made the fingerprint depend on the process's privilege. */
export const LINUX_ANCHOR_PATHS = Object.freeze([
  "/etc/machine-id",
  "/var/lib/dbus/machine-id",
] as const);

export interface AnchorSource {
  source: string;
  value: string;
}

/**
 * Rule 2: the first of `/etc/machine-id` and `/var/lib/dbus/machine-id` whose content, trimmed
 * of ASCII whitespace, is non-empty and not systemd's `uninitialized` marker. `files` maps each
 * READABLE path to its raw content; an absent (or null) path is unreadable. `null` means the
 * host has no anchor. The same value is the Linux device id's raw input.
 */
export function linuxAnchorSource(
  files: Readonly<Record<string, string | null | undefined>>,
): AnchorSource | null {
  for (const source of LINUX_ANCHOR_PATHS) {
    const content = files[source];
    if (typeof content !== "string") continue;
    const value = trimAsciiWhitespace(content);
    if (value && value !== "uninitialized") return { source, value };
  }
  return null;
}

const GIB = 2 ** 30;

/**
 * Rule 3: `g = floor(bytes / 2^30)`; omitted (`null`) when `g = 0`, otherwise the largest power
 * of two not above `g`, in decimal. Integer arithmetic, dividing BEFORE any logarithm: a float
 * `log2` rounds a total just below a power of two up to the next bucket from 1 PiB.
 *
 * What the bucket buys is stability while the reported total stays between two powers of two
 * (a 16 GB machine reporting 15.4 GiB buckets to 8, and keeps doing so).
 */
export function ramBucket(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < GIB) return null;
  const g = Math.floor(bytes / GIB);
  let p = 1;
  while (p * 2 <= g) p *= 2;
  return String(p);
}

// ── The platform reads ───────────────────────────────────────────────────────────────────

/** The two side effects a reader performs, injectable so tests can drive any OS's branch on
 *  any host. `run` returns stdout or null on any failure; `read` returns a file's raw content or
 *  null when it is unreadable. */
export interface FingerprintIo {
  run(cmd: string, args: readonly string[], timeoutMs?: number): string | null;
  read(path: string): string | null;
}

/** Run a command, returning null on any failure (missing binary, non-zero exit, timeout).
 *  stdin is the null device and no console window is shown (an Electron app on Windows would
 *  otherwise flash one per call). */
function run(
  cmd: string,
  args: readonly string[],
  timeoutMs = 2000,
): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export const defaultFingerprintIo: FingerprintIo = Object.freeze({
  run,
  read,
});

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` when `SystemRoot` is an
 *  absolute path, else the bare name. */
export function windowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (root && win32.isAbsolute(root) && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root))
    return win32.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      WINDOWS_CIM_COMMAND.program,
    );
  return WINDOWS_CIM_COMMAND.program;
}

function readTrimmed(io: FingerprintIo, path: string): string | null {
  const content = io.read(path);
  return content === null ? null : trimAsciiWhitespace(content) || null;
}

function firstMatch(text: string | null, re: RegExp): string | null {
  if (!text) return null;
  return text.match(re)?.[1]?.trim() || null;
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

function darwinComponents(io: FingerprintIo): RawComponents {
  const ioreg = io.run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
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
        io.run("diskutil", ["info", "-plist", "/"]),
        /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/,
      ),
    ),
    ...opt(
      "machineModel",
      io.run("sysctl", ["-n", "hw.model"])?.trim() || null,
    ),
  };
}

function win32Components(
  io: FingerprintIo,
  env: NodeJS.ProcessEnv,
): RawComponents {
  const reg = io.run("reg", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]);
  const cim = parseWindowsCim(
    io.run(
      windowsPowerShellPath(env),
      WINDOWS_CIM_COMMAND.args,
      WINDOWS_CIM_COMMAND.timeoutMs,
    ),
  );
  return {
    ...opt(
      "machineUuid",
      firstMatch(reg, /MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/),
    ),
    ...opt("boardSerial", cim.boardSerial ?? null),
    ...opt(
      "bootVolumeUuid",
      firstMatch(
        io.run("cmd", ["/c", "vol", "C:"]),
        /Volume Serial Number is ([A-Za-z0-9-]+)/,
      ),
    ),
    ...opt("machineModel", cim.machineModel ?? null),
  };
}

/** Read only rule 2's two files, and hand their raw contents to `linuxAnchorSource`. */
export function readLinuxAnchor(
  io: FingerprintIo = defaultFingerprintIo,
): AnchorSource | null {
  const files: Record<string, string | null> = {};
  for (const path of LINUX_ANCHOR_PATHS) files[path] = io.read(path);
  return linuxAnchorSource(files);
}

function linuxComponents(io: FingerprintIo): RawComponents {
  return {
    // Rule 2: machine-id only, never product_uuid or board_serial, so root and non-root
    // agree. A host with neither file (most container images) has no anchor.
    ...opt("machineUuid", readLinuxAnchor(io)?.value ?? null),
    ...opt(
      "bootVolumeUuid",
      firstMatch(io.run("findmnt", ["-no", "UUID", "/"]), /^(\S+)/),
    ),
    ...opt("machineModel", readTrimmed(io, "/sys/class/dmi/id/product_name")),
  };
}

/** Include a key only when it has a value — the omission rule, in one place. */
function opt(key: FingerprintComponent, value: string | null): RawComponents {
  return value ? ({ [key]: value } as RawComponents) : {};
}

export interface RawComponentsOptions {
  platform?: NodeJS.Platform;
  io?: FingerprintIo;
  env?: NodeJS.ProcessEnv;
  /** Total RAM in bytes; defaults to `os.totalmem()`. */
  totalBytes?: number;
}

/** Read the platform-specific raw component values. Exported for tests. */
export function rawComponents(
  options: RawComponentsOptions = {},
): RawComponents {
  const platform = options.platform ?? process.platform;
  const io = options.io ?? defaultFingerprintIo;
  const platformSpecific =
    platform === "darwin"
      ? darwinComponents(io)
      : platform === "win32"
        ? win32Components(io, options.env ?? process.env)
        : linuxComponents(io);
  return {
    ...platformSpecific,
    ...opt("cpuModel", cpuModel()),
    ...opt("primaryMac", primaryMac()),
    ...opt("ramBucket", ramBucket(options.totalBytes ?? totalmem())),
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
