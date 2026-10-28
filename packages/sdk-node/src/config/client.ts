// The Config sub-client — layered settings resolution over the signed config document.
//
// The resolution rules themselves are `@polaris-key/client-core`'s (`resolveValue`/`resolveSource`/
// `listUserEntries`), shared with React and mirrored in Python and Swift. What lives here is
// the OVERRIDE LAYERS, and they are config-side options rather than Core ones for a reason:
// `envPrefix`, `env` and `localOverrides` are inputs to this resolution and to nothing else,
// so a product that has disabled Config never has to think about them.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// An `enforced`/`hidden` key is LOCKED: overriding it via `localOverrides` or an env var has no
// effect, and the remote value still wins. That is the whole point of the management state —
// see packages/docs/src/content/docs/start/concepts.md.

import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import { readCappedText } from "../core/boundedBody.js";
import { Catalog, type ProductCatalog } from "@polaris-key/catalog";
import { join } from "node:path";
import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode, SettingVisibility } from "../constants.generated.js";
import { readJsonSync, writeJson } from "../core/jsonFile.js";
import {
  listUserEntries,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type ResolveContext,
  type UserConfigEntry,
} from "@polaris-key/client-core";
import type { CacheManager } from "../core/cache.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import { MintCache, mintToken, type MintedToken } from "./mint.js";

export type { ConfigSource, ProductCatalog, UserConfigEntry, MintedToken };

/** Where a change came from: this device (`local`), a sync (`remote`, `merge`), or the one-time
 *  import of `local-config.json` (`migration`). */
export type ChangeOrigin = "local" | "remote" | "merge" | "migration";

/** How a setting relates to Cloud Sync. */
export type SettingSync = "local" | "pending" | "synced";

type SyncCall = { ok: true } | { ok: false; error: string };

/** What the Cloud Sync host gives the config client (U-06.3). While `active()` is true `set` and
 *  `clear` go through the machine, which answers the refusals in its own order. */
export interface ConfigSyncPort {
  /** Cloud Sync is on and a principal is signed in. */
  active(): boolean;
  set(key: string, value: JSONValue): Promise<SyncCall>;
  clear(key: string): Promise<SyncCall>;
  /** The machine's effective value; `from: "document"` means the signed document decides. */
  get(key: string): { value: JSONValue; from: string };
  state(key: string): SettingSync;
}

/** Env-var prefix for config overrides. A key's env var is
 *  `${envPrefix}${key.replaceAll(".", "__")}` — `run.concurrency` →
 *  `PKEY_CONFIG_run__concurrency`. */
export const DEFAULT_ENV_PREFIX = "PKEY_CONFIG_";

export interface ConfigClientOptions {
  /** User/local config overrides — beat a remote `default` value, but NOT an `enforced`/
   *  `hidden` one (the server stays authoritative for those). */
  localOverrides?: Record<string, JSONValue>;
  /** Env-var prefix for config overrides (default `"PKEY_CONFIG_"`). */
  envPrefix?: string;
  /** Environment table to read overrides from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Persist `config.set()` values in `<stateDir>/local-config.json` (default true). With
   *  false they live for this process only. */
  persistLocal?: boolean;
}

/** One config change, as `onConfigChange` and `client.events` report it. */
export interface ConfigChange {
  key: string;
  value: JSONValue | undefined;
  previous: JSONValue | undefined;
  source: ConfigSource;
  /** What caused the change. */
  origin: ChangeOrigin;
}

/** A reactive handle on one key (`config.setting(key)`, SDK parity pass §3.11). */
export interface ConfigSetting<T = JSONValue> {
  readonly key: string;
  /** The effective value now; `null` when no layer supplies one. */
  readonly value: T | null;
  /** The layer the value comes from (`fallback` when none does). */
  readonly source: ConfigSource;
  /** Whether the key is locked by the operator (`enforced` or `hidden`). */
  readonly locked: boolean;
  /** How the setting appears: `editable` (`default`), `readonly` (`enforced`) or `hidden`. */
  readonly visibility: SettingVisibility;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
  /** `local` with Cloud Sync off, no principal or a `local` key; `pending` while an edit waits to
   *  be sent; `synced` otherwise. */
  sync(): SettingSync;
  /** Subscribe to this key's changes; returns the unsubscribe function. */
  on(listener: (change: ConfigChange) => void): () => void;
}

/** A document entry's state as a visibility: `enforced` is readonly; no entry is editable. */
function visibilityOfState(state: string | undefined): SettingVisibility {
  return state === "enforced"
    ? SettingVisibility.readonly
    : state === "hidden"
      ? SettingVisibility.hidden
      : SettingVisibility.editable;
}

export class ConfigClient {
  /** The host's `localOverrides`, then the persisted `config.set()` layer over them. */
  private localOverrides: Record<string, JSONValue>;
  private readonly hostOverrides: Record<string, JSONValue>;
  private persisted: Record<string, JSONValue>;
  private readonly localFile: string | null;
  private readonly listeners = new Map<
    string,
    Set<(c: ConfigChange) => void>
  >();
  private catalog: Catalog | null = null;
  private catalogTried = false;
  private readonly envPrefix: string;
  private readonly env: Record<string, string | undefined>;
  private readonly minted = new MintCache();
  private syncPort: ConfigSyncPort | null = null;
  /** The last value reported per synced key, so a change can say what it replaced. */
  private readonly syncSeen = new Map<string, JSONValue | undefined>();

  constructor(
    private readonly ctx: CoreContext,
    private readonly cache: CacheManager,
    opts: ConfigClientOptions = {},
    /** The device credential edge-mint authenticates with. Without it `mintToken` has nothing
     *  to present and refuses with `unauthorized`, as a client holding no token does. */
    private readonly tokens?: TokenManager,
  ) {
    this.hostOverrides = { ...(opts.localOverrides ?? {}) };
    this.localFile =
      opts.persistLocal === false
        ? null
        : join(ctx.dirs.state, "local-config.json");
    const stored = this.localFile
      ? readJsonSync<unknown>(this.localFile, {})
      : {};
    this.persisted =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, JSONValue>)
        : {};
    this.localOverrides = { ...this.hostOverrides, ...this.persisted };
    this.envPrefix = opts.envPrefix ?? DEFAULT_ENV_PREFIX;
    this.env = opts.env ?? process.env;
  }

  private get doc(): ConfigDoc | null {
    return this.cache.state.config?.doc ?? null;
  }

  /** The CONFIG document's managed entries as last verified (the desktop bridge's
   *  `BridgeState.config`), or null before any config document. */
  entries(): Record<string, ManagedEntry> | null {
    return this.doc?.config ?? null;
  }

  private context(): ResolveContext {
    return {
      remote: this.doc?.config,
      localOverrides: this.localOverrides,
      env: this.env,
      envPrefix: this.envPrefix,
    };
  }

  /** Resolve the effective value for a key, honouring management state + override layers. */
  get<T = JSONValue>(key: string, fallback: T): T {
    const synced = this.syncedValue(key);
    if (synced !== undefined) return synced as unknown as T;
    const v = resolveValue(this.context(), key);
    return v === undefined ? fallback : (v as unknown as T);
  }

  /** Where `get(key)` would source its value from (for diagnostics/settings UIs). */
  getConfigSource(key: string): ConfigSource {
    if (this.syncedValue(key) !== undefined) return "local";
    return resolveSource(this.context(), key);
  }

  /** The catalog entries for a settings UI (WIRE-CONTRACT-V3 §2.2.1 rule 4): every document
   *  entry MINUS the `hidden` ones, each marked `{ key, value, enforced }` with its resolved
   *  value. (`hidden` keys are still APPLIED by `get`; they are merely withheld from this
   *  enumeration.) A key only a local override or the environment supplies is not listed. */
  listUserConfig(): UserConfigEntry[] {
    return listUserEntries(this.context());
  }

  /** A managed secret's value, or null. Secrets are never enumerated. */
  getSecret(key: string): string | null {
    const e = this.doc?.secrets[key];
    return e && typeof e.value === "string" ? e.value : null;
  }

  /** The product's active catalog version, as the last verified document stated it. */
  schemaVersion(): number | null {
    return this.doc?.schemaVersion ?? null;
  }

  /**
   * `GET /<p>/config/schema` — the product's active config catalog, parsed.
   *
   * Unsigned, unauthenticated and DIAGNOSTIC: nothing security-relevant is ever read from it
   * (the values a client acts on arrive in the signed config document), so every failure — a
   * refusal, a network error, a body that is not a catalog, local-only mode, a product that
   * does not run Config (D-21: not even probed) — answers `null`. It never throws.
   */
  async fetchSchema(): Promise<ProductCatalog | null> {
    if (!this.ctx.enabled("config")) return null;
    try {
      const res = await this.ctx.fetcher()(this.ctx.url("config/schema"), {
        headers: this.ctx.headers({ accept: "application/json" }),
        signal: this.ctx.deadline(),
      });
      if (!res.ok) return null;
      const text = await readCappedText(res);
      if (text === null) return null;
      const body: unknown = JSON.parse(text);
      return isCatalog(body) ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Mint a third-party token through the product's edge-mint recipe `recipeId`
   * (`GET /<p>/config/mint/<recipeId>/token`, authenticated with the device token).
   *
   * Minted tokens are cached IN MEMORY ONLY, per recipe, and reused until 30 seconds before
   * `expiresAt`: they are short-lived secrets and never reach the cache file or the keyring. A
   * 401 gets the one re-acquire every authenticated call gets (§5), then one retry.
   *
   * Throws `PolarisError`: `service-unavailable` (no Config service, before any request),
   * `bad_request` (a recipe id the router could never match, before any request),
   * `unauthorized` (no token, or still 401 after the re-acquire), or the one taxonomy
   * (SP-46): `not_found` for an unknown or unapproved recipe, `rate_limited` with
   * `retryAfterSeconds`, `server-error` for a 5xx (a `misconfigured` recipe as its `wireCode`),
   * `network-error` when no answer arrived.
   */
  async mintToken(recipeId: string): Promise<MintedToken> {
    return mintToken(this.ctx, this.tokens, this.minted, recipeId);
  }

  // ── Local overrides (SDK parity pass §3.11, proposed id `config.local`) ───────────────

  /** Whether `key` is locked by the operator: an `enforced` or `hidden` document entry. */
  isLocked(key: string): boolean {
    const e = this.doc?.config[key];
    return e?.state === "enforced" || e?.state === "hidden";
  }

  /** Give the client the product catalog so `set()` validates values against it (the facade
   *  loads it from `fetchSchema()`; a host with a bundled catalog passes it here). */
  useCatalog(catalog: ProductCatalog | null): void {
    this.catalog = catalog ? new Catalog(catalog) : null;
    this.catalogTried = true;
  }

  /**
   * Set a local override and persist it. Refuses `managed_by_admin` for a key the operator
   * locked (the remote value would win anyway, and a settings screen must say so), and
   * `bad_request` for a value the catalog's schema refuses (when a catalog is known).
   */
  async set(key: string, value: JSONValue): Promise<void> {
    if (this.syncPort?.active()) {
      this.syncSeen.set(key, this.get<JSONValue | undefined>(key, undefined));
      return this.viaMachine(await this.syncPort.set(key, value), key);
    }
    if (this.isLocked(key))
      throw new PolarisError(
        ErrorCode.managedByAdmin,
        `${key} is managed by an administrator.`,
      );
    // The catalog is fetched once, on the first set, when the host gave none (best-effort:
    // offline, the value is stored unvalidated and the signed document stays authoritative).
    if (!this.catalogTried) {
      this.catalogTried = true;
      const fetched = await this.fetchSchema();
      if (fetched) this.catalog = new Catalog(fetched);
    }
    const entry = this.catalog?.entryByKey(key);
    if (entry) {
      const r = this.catalog!.validateEntryValue(entry, value);
      if (!r.ok)
        throw new PolarisError(
          ErrorCode.badRequest,
          `${key}: ${r.errors.join("; ")}`,
        );
    }
    await this.writeLocal(key, value);
  }

  /** Remove a local override (the key falls back to env, the remote default, the fallback). */
  async clear(key: string): Promise<void> {
    if (this.syncPort?.active()) {
      this.syncSeen.set(key, this.get<JSONValue | undefined>(key, undefined));
      return this.viaMachine(await this.syncPort.clear(key), key);
    }
    await this.writeLocal(key, undefined);
  }

  /** Drop every device-local override in one write (the keys fall back to env, the remote
   *  defaults, the fallbacks). Host overrides stay. Fires one change per key that moved. */
  async clearAll(): Promise<void> {
    await this.writeLocal(undefined, undefined);
  }

  /** The persisted local overrides. */
  localValues(): Record<string, JSONValue> {
    return { ...this.persisted };
  }

  /** A reactive handle on one key. */
  setting<T = JSONValue>(key: string): ConfigSetting<T> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      key,
      get value() {
        return self.get<T | null>(key, null);
      },
      get source() {
        return self.getConfigSource(key);
      },
      get locked() {
        return self.isLocked(key);
      },
      get visibility() {
        return visibilityOfState(self.doc?.config[key]?.state);
      },
      sync: () =>
        self.syncPort?.active() ? self.syncPort.state(key) : "local",
      set: (value: T) => this.set(key, value as unknown as JSONValue),
      clear: () => this.clear(key),
      on: (listener) => this.onConfigChange(key, listener),
    };
  }

  /** Subscribe to one key's changes, or every key's with `"*"`. Fired for a local set/clear
   *  and for a sync that changed a resolved value. Returns the unsubscribe function. */
  onConfigChange(
    key: string,
    listener: (change: ConfigChange) => void,
  ): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Every resolved value now (document keys plus local and host overrides). */
  snapshot(): Record<string, JSONValue | undefined> {
    const keys = new Set([
      ...Object.keys(this.doc?.config ?? {}),
      ...Object.keys(this.localOverrides),
    ]);
    const out: Record<string, JSONValue | undefined> = {};
    for (const k of keys) out[k] = resolveValue(this.context(), k);
    return out;
  }

  /** Cloud Sync's port (the facade sets it once the host runs). */
  useSync(port: ConfigSyncPort | null): void {
    this.syncPort = port;
  }

  /** The legacy local values, for the one-time import into Cloud Sync. */
  importable(): Record<string, JSONValue> {
    return { ...this.persisted };
  }

  /** A synced value the machine holds for `key`, or undefined (the signed document decides). */
  private syncedValue(key: string): JSONValue | undefined {
    if (!this.syncPort?.active()) return undefined;
    const e = this.syncPort.get(key);
    return e.from === "document" || e.value === null ? undefined : e.value;
  }

  private viaMachine(r: SyncCall, key: string): void {
    if (r.ok) return;
    throw new PolarisError(
      r.error === "managed_by_admin"
        ? ErrorCode.managedByAdmin
        : ErrorCode.badRequest,
      r.error === "managed_by_admin"
        ? `${key} is managed by an administrator.`
        : `${key}: the value is not accepted.`,
    );
  }

  /** The machine changed these keys: report each with its value now and what it replaced. */
  noteSyncChange(keys: readonly string[], origin: ChangeOrigin): void {
    for (const key of keys) {
      const value = this.get<JSONValue | undefined>(key, undefined);
      const previous = this.syncSeen.get(key);
      this.syncSeen.set(key, value);
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      this.emit({
        key,
        value,
        previous,
        source: this.getConfigSource(key),
        origin,
      });
    }
  }

  /** Emit a change for every key whose resolved value differs from `before` (the facade calls
   *  it after a sync). Returns the changes. */
  emitChanges(
    before: Record<string, JSONValue | undefined>,
    origin: ChangeOrigin = "remote",
  ): ConfigChange[] {
    const after = this.snapshot();
    const changes: ConfigChange[] = [];
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      changes.push({
        key,
        value: after[key],
        previous: before[key],
        source: this.getConfigSource(key),
        origin,
      });
    }
    for (const c of changes) this.emit(c);
    return changes;
  }

  private emit(change: ConfigChange): void {
    for (const k of [change.key, "*"])
      for (const l of this.listeners.get(k) ?? []) {
        try {
          l(change);
        } catch {
          // A listener's failure is its own.
        }
      }
  }

  private async writeLocal(
    key: string | undefined,
    value: JSONValue | undefined,
  ): Promise<void> {
    const before = this.snapshot();
    // `key === undefined` drops every local override (clearAll).
    const next: Record<string, JSONValue> =
      key === undefined ? {} : { ...this.persisted };
    if (key !== undefined) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    if (this.localFile) await writeJson(this.localFile, next);
    this.persisted = next;
    this.localOverrides = { ...this.hostOverrides, ...next };
    this.emitChanges(before, "local");
  }

  /** Whether the product runs Config at all — the config-side twin of the license gate's
   *  `not-applicable`. */
  get enabled(): boolean {
    return this.ctx.enabled("config");
  }
}

/** The catalog's outer shape — enough to hand it back typed. The entries are the product's own
 *  data; the client does not validate them, because nothing it decides depends on them. */
function isCatalog(v: unknown): v is ProductCatalog {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return typeof c.schemaVersion === "number" && Array.isArray(c.entries);
}
