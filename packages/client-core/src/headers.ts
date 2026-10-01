// Client metadata header values (WIRE-CONTRACT-V3 §5.2), pinned by `headers.json`.
//
// A host reads its runtime's own report (Node `os.platform()` / `os.arch()`; a browser has no
// arch) and maps it here. The lookup folds ASCII A–Z only (never a locale-dependent lowercase),
// does not trim, and reads the table's own entries only, so `constructor` and `__proto__` map
// to nothing. A spelling with no value returns `null`, and the host omits the header rather than
// inventing one.

import {
  ARCH_SPELLINGS,
  PLATFORM_SPELLINGS,
  type ClientArch,
  type ClientPlatform,
} from "@polaris-key/protocol/core";

import { hasOwn } from "./own.js";

/** ASCII case folding: A–Z become a–z, every other code unit is unchanged. */
function foldAscii(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : raw[i];
  }
  return out;
}

function lookup<T extends string>(
  table: Readonly<Record<string, T>>,
  raw: string,
): T | null {
  const key = foldAscii(raw);
  return hasOwn(table, key) ? table[key]! : null;
}

/** `darwin` → `macos`, `Windows` → `windows`, `freebsd` → `null`. */
export function canonicalPlatform(raw: string): ClientPlatform | null {
  return lookup<ClientPlatform>(PLATFORM_SPELLINGS, raw);
}

/** `x64` → `x86_64`, `aarch64` → `arm64`, `ia32` → `null`. */
export function canonicalArch(raw: string): ClientArch | null {
  return lookup<ClientArch>(ARCH_SPELLINGS, raw);
}
