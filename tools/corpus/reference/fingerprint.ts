// Reference: the fingerprint component derivations (WIRE-CONTRACT-V3 §6.1).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

/** Rules 1 and 2 trim exactly these: U+0009–U+000D and U+0020. Nothing else. */
const ASCII_WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function refTrimAscii(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WS.has(value.charCodeAt(start))) start++;
  while (end > start && ASCII_WS.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

export type WindowsCimExpected = {
  boardSerial?: string;
  machineModel?: string;
};

export function refParseWindowsCim(stdout: string): WindowsCimExpected {
  const text = stdout.startsWith("\uFEFF") ? stdout.slice(1) : stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  const out: WindowsCimExpected = {};
  for (const key of ["boardSerial", "machineModel"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const trimmed = refTrimAscii(value);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

const LINUX_ANCHOR_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

export type LinuxAnchorExpected = { source: string; value: string } | null;

export function refLinuxAnchor(
  files: Record<string, string>,
): LinuxAnchorExpected {
  for (const source of LINUX_ANCHOR_PATHS) {
    const content = files[source];
    if (content === undefined) continue;
    const value = refTrimAscii(content);
    if (value && value !== "uninitialized") return { source, value };
  }
  return null;
}

/** Integer-exact over BigInt: `g = floor(bytes / 2^30)`, then the largest power of two not
 *  above `g`; omitted when `g = 0`. Dividing BEFORE any logarithm is the whole point. */
export function refRamBucket(bytes: number): string | null {
  let g = BigInt(bytes) >> 30n;
  if (g === 0n) return null;
  let p = 1n;
  while (g > 1n) {
    g >>= 1n;
    p <<= 1n;
  }
  return p.toString();
}
