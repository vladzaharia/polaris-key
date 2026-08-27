// Layered config resolution. The signed remote config document carries, per key, a
// `ManagedEntry` with a management `state`. The client honors that state and otherwise layers
// local + environment overrides on top of the remote default:
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// `enforced`/`hidden` always win (the value is locked to the server); a `default` (or an
// absent entry) can be overridden locally or via an env var. See docs/CONCEPTS.md.
//
// Isomorphic: the environment is an injected lookup table, never `process.env` read here, so
// this module runs unchanged in a browser bundle.

import type { JSONValue, ManagedEntry } from "@plrs/protocol/core";

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
  /** Environment lookup table (the host supplies `process.env` or an equivalent). */
  env: Record<string, string | undefined>;
  /** Env-var prefix; a key's env var is `${envPrefix}${key.replaceAll(".", "__")}`. */
  envPrefix: string;
}

/** `run.concurrency` → `PLRS_CONFIG_run__concurrency` (dots become double underscores). The
 *  prefix itself is the HOST's (`@plrs/node` defaults it to `PLRS_CONFIG_`); this module only
 *  owns the dot→`__` mapping, which every SDK must agree on. */
function envVarName(envPrefix: string, key: string): string {
  return envPrefix + key.replaceAll(".", "__");
}

/** Read a key from the environment, JSON-parsing when the value looks like JSON, else
 *  returning the raw string. Returns `undefined` when the var is unset. */
function readEnvValue(ctx: ResolveContext, key: string): JSONValue | undefined {
  const raw = ctx.env[envVarName(ctx.envPrefix, key)];
  if (raw === undefined) return undefined;
  return looksLikeJson(raw) ? safeJsonParse(raw) : raw;
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  if (t === "true" || t === "false" || t === "null") return true;
  if (/^-?\d/.test(t) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return true;
  const first = t[0];
  return first === "{" || first === "[" || first === '"';
}

function safeJsonParse(s: string): JSONValue {
  try {
    return JSON.parse(s) as JSONValue;
  } catch {
    return s; // malformed JSON-looking value: fall back to the raw string
  }
}

/** Resolve the effective source for a key (provenance), honoring management state. */
export function resolveSource(ctx: ResolveContext, key: string): ConfigSource {
  const entry = ctx.remote?.[key];
  if (entry && entry.state === "enforced") return "enforced";
  if (entry && entry.state === "hidden") return "hidden";
  // `default` or absent → layered overrides.
  if (Object.prototype.hasOwnProperty.call(ctx.localOverrides, key))
    return "local";
  if (readEnvValue(ctx, key) !== undefined) return "env";
  if (entry) return "remote-default";
  return "fallback";
}

/** Resolve the effective value for a key, honoring management state + the override layers.
 *  Returns `undefined` only when nothing matched (the caller substitutes its fallback). */
export function resolveValue(
  ctx: ResolveContext,
  key: string,
): JSONValue | undefined {
  const entry = ctx.remote?.[key];
  // enforced | hidden → the remote value is locked; local/env are ignored.
  if (entry && (entry.state === "enforced" || entry.state === "hidden"))
    return entry.value;
  // default | absent → local > env > remote-default > (caller's fallback).
  if (Object.prototype.hasOwnProperty.call(ctx.localOverrides, key))
    return ctx.localOverrides[key];
  const envValue = readEnvValue(ctx, key);
  if (envValue !== undefined) return envValue;
  if (entry) return entry.value;
  return undefined;
}

/** Build the user-facing catalog list (for settings UIs): every remote entry MINUS the
 *  `hidden` ones, each marked with whether it is `enforced` (read-only in the UI). */
export function listUserEntries(
  remote: Record<string, ManagedEntry> | undefined,
): UserConfigEntry[] {
  const out: UserConfigEntry[] = [];
  for (const [key, entry] of Object.entries(remote ?? {})) {
    if (entry.state === "hidden") continue;
    out.push({ key, value: entry.value, enforced: entry.state === "enforced" });
  }
  return out;
}
