// Layered config resolution (WIRE-CONTRACT-V3 §2.2.1), pinned by `config-matrix.json`. The
// signed remote config document carries, per key, a `ManagedEntry` with a management `state`.
// The client honors that state and otherwise layers local + environment overrides on top of the
// remote default:
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// `enforced`/`hidden` always win (the value is locked to the server); a `default` (or an
// absent entry) can be overridden locally or via an env var. A layer answers only for a key it
// holds itself, so a key named like a built-in (`constructor`, `toString`) is an ordinary key.
// See packages/docs/src/content/docs/start/concepts.md.
//
// Isomorphic: the environment is an injected lookup table, never `process.env` read here, so
// this module runs unchanged in a browser bundle. It also keeps that bundle's runtime floor: no
// regular-expression lookbehind, no `isWellFormed`, no `Object.hasOwn`
// (`tools/runtime-floor.test.ts`).

import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import { hasDuplicateKeys } from "@polaris-key/jws";

import { hasOwn } from "./own.js";

/** Where a resolved config value came from, for diagnostics + settings UIs. */
export type ConfigSource =
  | "enforced"
  | "hidden"
  | "local"
  | "env"
  | "remote-default"
  | "fallback";

/** One user-facing catalog entry, for building settings UIs. `hidden` keys are excluded
 *  from this list (they are still applied by `getConfig`). `enforced` keys are shown
 *  read-only. */
export interface UserConfigEntry {
  key: string;
  value: JSONValue;
  enforced: boolean;
}

export interface ResolveContext {
  /** The remote config map from the verified config document (may be undefined when
   *  doc-less — a product with the config service disabled, or a first run). */
  remote: Record<string, ManagedEntry> | undefined;
  /** User/local overrides (highest precedence for `default` keys). */
  localOverrides: Record<string, JSONValue>;
  /** Environment lookup table (the host supplies `process.env` or an equivalent). A host with
   *  no environment layer passes `{}` (§2.2.1 rule 3). */
  env: Record<string, string | undefined>;
  /** Env-var prefix; a key's env var is `${envPrefix}${key.replaceAll(".", "__")}`. */
  envPrefix: string;
}

/** §2.2.1 rule 2: at most this many arrays and objects open at any point. */
const MAX_ENV_DEPTH = 64;
/** §2.2.1 rule 2: the power of ten of a non-zero number's first non-zero digit is within ±307. */
const MAX_DECIMAL_EXPONENT = 307;
/** §2.2.1 rule 2: an exponent part has at most this many significant digits. */
const MAX_EXPONENT_DIGITS = 6;

/** `run.concurrency` → `PKEY_CONFIG_run__concurrency` (dots become double underscores; nothing
 *  else changes, case included — §2.2.1 rule 1). The prefix itself is the HOST's
 *  (`@polaris-key/node` defaults it to `PKEY_CONFIG_`); this module only owns the dot→`__`
 *  mapping, which every SDK must agree on. */
function envVarName(envPrefix: string, key: string): string {
  return envPrefix + key.replaceAll(".", "__");
}

/** Read a key from the environment (§2.2.1 rules 1–2). Returns `undefined` when the variable is
 *  unset (an empty value is set), else the parsed value when the raw string is one strict JSON
 *  text, else the raw string unchanged. Never throws. */
function readEnvValue(ctx: ResolveContext, key: string): JSONValue | undefined {
  const name = envVarName(ctx.envPrefix, key);
  if (!hasOwn(ctx.env, name)) return undefined;
  const raw = ctx.env[name];
  if (typeof raw !== "string") return undefined;
  return parseEnvValue(raw);
}

/** §2.2.1 rule 2. @internal Exported for client-core's tests; hosts call `resolveValue`. */
export function parseEnvValue(raw: string): JSONValue {
  // Step 1: two iterative scans, so neither the parser nor the walk meets a deeper text or an
  // out-of-range number.
  if (nestingExceeds(raw, MAX_ENV_DEPTH)) return raw;
  if (!numbersInRange(raw)) return raw;
  // Step 2: RFC 8259 (`JSON.parse` is strict: no trailing comma, NaN, leading zero, BOM or
  // non-JSON whitespace), then the duplicate rule, which compares names after unescaping.
  let parsed: JSONValue;
  try {
    parsed = JSON.parse(raw) as JSONValue;
  } catch {
    return raw;
  }
  if (hasDuplicateKeys(raw)) return raw;
  // Step 3: no lone surrogate in any string value or member name, and no U+0000 in a member
  // name. It reads the parsed strings, so a raw lone surrogate is refused as well as an escaped
  // one. Recursion is bounded by step 1.
  if (!charactersAllowed(parsed)) return raw;
  return parsed;
}

/** True when more than `max` arrays and objects are open at some point. String contents are
 *  skipped (a backslash skips the next code unit). Exact for every text `JSON.parse` accepts. */
export function nestingExceeds(raw: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > max) return true;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

function isNumberRunChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    c === 0x2e || // .
    c === 0x65 || // e
    c === 0x45 || // E
    c === 0x2b || // +
    c === 0x2d // -
  );
}

/** True when every number token outside a string is in §2.2.1 rule 2's range. A token is the
 *  run of digits, `.`, `e`, `E`, `+` and `-` at each `-` or digit. */
export function numbersInRange(raw: string): boolean {
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 2;
      else {
        if (c === 0x22) inString = false;
        i++;
      }
      continue;
    }
    if (c === 0x22) {
      inString = true;
      i++;
      continue;
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      const start = i;
      while (i < raw.length && isNumberRunChar(raw.charCodeAt(i))) i++;
      if (!numberTokenInRange(raw.slice(start, i))) return false;
      continue;
    }
    i++;
  }
  return true;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/**
 * Judge one number token from its decimal digits, with no floating point (§2.2.1 rule 2). In
 * range when its exponent part has at most six significant digits and the number is zero or
 * its first non-zero digit's power of ten, E, is from −307 to 307. A malformed run (`1e5-5`)
 * occurs only in a text `JSON.parse` refuses; the answer for it is unspecified, but this never
 * throws.
 */
export function numberTokenInRange(token: string): boolean {
  let i = 0;
  const n = token.length;
  if (i < n && token.charCodeAt(i) === 0x2d) i++;
  // Integer digits.
  let intDigits = 0;
  let leadingZeros = 0; // zeros before the first non-zero digit, integer and fraction alike
  let sawNonZero = false;
  while (i < n && isDigit(token.charCodeAt(i))) {
    if (!sawNonZero) {
      if (token.charCodeAt(i) === 0x30) leadingZeros++;
      else sawNonZero = true;
    }
    intDigits++;
    i++;
  }
  // Fraction digits.
  if (i < n && token.charCodeAt(i) === 0x2e) {
    i++;
    while (i < n && isDigit(token.charCodeAt(i))) {
      if (!sawNonZero) {
        if (token.charCodeAt(i) === 0x30) leadingZeros++;
        else sawNonZero = true;
      }
      i++;
    }
  }
  // Exponent part: at most six significant digits.
  let exponent = 0;
  const e = i < n ? token.charCodeAt(i) : -1;
  if (e === 0x65 || e === 0x45) {
    i++;
    let negative = false;
    const sign = i < n ? token.charCodeAt(i) : -1;
    if (sign === 0x2b || sign === 0x2d) {
      negative = sign === 0x2d;
      i++;
    }
    let significant = 0;
    while (i < n && isDigit(token.charCodeAt(i))) {
      const d = token.charCodeAt(i) - 0x30;
      if (significant > 0 || d !== 0) {
        significant++;
        if (significant > MAX_EXPONENT_DIGITS) return false;
        exponent = exponent * 10 + d;
      }
      i++;
    }
    if (negative) exponent = -exponent;
  }
  if (!sawNonZero) return true; // every digit is zero
  const power = intDigits - 1 - leadingZeros + exponent;
  return power >= -MAX_DECIMAL_EXPONENT && power <= MAX_DECIMAL_EXPONENT;
}

/** True when `s` holds a surrogate code unit that is not half of a high-then-low pair. A loop
 *  over code units, not `isWellFormed` or a regular expression (the runtime floor). */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    return true;
  }
  return false;
}

function charactersAllowed(value: JSONValue): boolean {
  if (typeof value === "string") return !hasLoneSurrogate(value);
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    for (const item of value) if (!charactersAllowed(item)) return false;
    return true;
  }
  for (const name of Object.keys(value)) {
    if (name.indexOf("\u0000") !== -1 || hasLoneSurrogate(name)) return false;
    if (!charactersAllowed(value[name] as JSONValue)) return false;
  }
  return true;
}

function remoteEntry(
  ctx: ResolveContext,
  key: string,
): ManagedEntry | undefined {
  const remote = ctx.remote;
  return remote !== undefined && hasOwn(remote, key) ? remote[key] : undefined;
}

/** Resolve the effective source for a key (provenance), honoring management state. */
export function resolveSource(ctx: ResolveContext, key: string): ConfigSource {
  const entry = remoteEntry(ctx, key);
  if (entry && entry.state === "enforced") return "enforced";
  if (entry && entry.state === "hidden") return "hidden";
  // `default` or absent → layered overrides.
  if (hasOwn(ctx.localOverrides, key)) return "local";
  if (readEnvValue(ctx, key) !== undefined) return "env";
  if (entry) return "remote-default";
  return "fallback";
}

/** Resolve the effective value for a key, honoring management state + the override layers.
 *  Returns `undefined` only when nothing matched (the caller substitutes its fallback); a layer
 *  holding JSON `null` answers `null`. */
export function resolveValue(
  ctx: ResolveContext,
  key: string,
): JSONValue | undefined {
  const entry = remoteEntry(ctx, key);
  // enforced | hidden → the remote value is locked; local/env are ignored.
  if (entry && (entry.state === "enforced" || entry.state === "hidden"))
    return entry.value;
  // default | absent → local > env > remote-default > (caller's fallback).
  if (hasOwn(ctx.localOverrides, key)) return ctx.localOverrides[key];
  const envValue = readEnvValue(ctx, key);
  if (envValue !== undefined) return envValue;
  if (entry) return entry.value;
  return undefined;
}

/** Build the user-facing catalog list (for settings UIs, §2.2.1 rule 4): every document entry
 *  MINUS the `hidden` ones, each with its resolved value and whether it is `enforced` (read-only
 *  in the UI). A key that only a local override or the environment supplies is not listed. The
 *  order is not specified. */
export function listUserEntries(ctx: ResolveContext): UserConfigEntry[] {
  const out: UserConfigEntry[] = [];
  const remote = ctx.remote ?? {};
  for (const key of Object.keys(remote)) {
    const entry = remote[key]!;
    if (entry.state === "hidden") continue;
    out.push({
      key,
      value: resolveValue(ctx, key) as JSONValue,
      enforced: entry.state === "enforced",
    });
  }
  return out;
}
