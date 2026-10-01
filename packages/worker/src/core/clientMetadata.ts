/**
 * Client metadata header values (WIRE-CONTRACT-V3 §5.2 rule 3), as the Worker stores them.
 *
 * SDKs built before §5.2 sent their runtime's own spellings (`darwin`, `win32`, `x64`, `AMD64`,
 * `browser`) and their package names (`@polaris-key/node`, `PolarisKeySwift`), so the device
 * summary split one machine type across several chips. Every write now stores:
 *
 *   - the canonical value of any listed spelling (`PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` from
 *     `@polaris-key/protocol/core`, after ASCII case folding, own keys only — `headers.json` pins
 *     both tables, and `test/headersCorpus.test.ts` runs every row through here);
 *   - the short SDK id for each pre-§5.2 SDK name, matched exactly;
 *   - any other value as sent (a 16 KiB unknown value included: capping is R10-11's);
 *   - nothing for an empty value, so `?? existing` keeps the stored value instead of blanking it.
 *
 * No server decision reads these values. `0040_canonical_client_metadata.sql` converges the rows
 * stored before this mapping existed.
 */

import { ARCH_SPELLINGS, PLATFORM_SPELLINGS } from "@polaris-key/protocol/core";

/** The pre-§5.2 `X-PKey-SDK` values and the id each SDK sends now. */
export const LEGACY_SDK_NAMES: Readonly<Record<string, string>> = {
  "@polaris-key/node": "node",
  "@polaris-key/react": "react",
  "polaris-key-python": "python",
  PolarisKeySwift: "swift",
  "polaris-key-godot": "godot",
};

const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** A–Z become a–z; every other code unit is unchanged (never a locale lowercase). */
function foldAscii(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : raw[i];
  }
  return out;
}

function viaTable(
  table: Readonly<Record<string, string>>,
  raw: string | null,
): string | null {
  if (raw === null || raw === "") return null;
  const key = foldAscii(raw);
  return hasOwn(table, key) ? table[key]! : raw;
}

/** `darwin` → `macos`; `freebsd` stays `freebsd`; `""` and null are absent. */
export function normalizePlatformHeader(raw: string | null): string | null {
  return viaTable(PLATFORM_SPELLINGS, raw);
}

/** `x64` → `x86_64`; `ia32` stays `ia32`; `""` and null are absent. */
export function normalizeArchHeader(raw: string | null): string | null {
  return viaTable(ARCH_SPELLINGS, raw);
}

/** `@polaris-key/node` → `node` (exact match); anything else as sent; `""` and null are absent. */
export function normalizeSdkHeader(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  return hasOwn(LEGACY_SDK_NAMES, raw) ? LEGACY_SDK_NAMES[raw]! : raw;
}
