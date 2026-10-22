// Device-local config overrides (`config.local`, SDK-PARITY-PASS §3.11, S-17 §5.11's names):
// `config.set(key, value)`, `config.clear(key)`, `config.clearAll()`, `config.setting(key)` and
// `config.onConfigChange(key | "*", listener)`, the same surface `@polaris-key/node`'s
// `client.config` has.
//
// One engine serves both adapters; they differ only in the BACKEND that keeps the values:
//
//   * browser — `localStorage`, keyed per product, every access in try/catch. A store that
//     cannot be read or written (a private window, blocked site data, a server render) falls
//     back to memory, and `persistent()` says so rather than pretending the value will survive
//     a reload;
//   * desktop — the host's `client.config` over the bridge (`invoke("config", "set" | "clear")`,
//     its stored values on `BridgeState.localConfig`), so the renderer never writes to disk. A v3
//     host has no such verbs and the write is refused with the typed `UnsupportedError` (reason
//     `version`).
//
// The rules are Node's: a key the operator locked (`enforced`/`hidden`) is refused with
// `managed_by_admin`, and a value the catalog's schema refuses is refused with `bad_request`
// (the catalog is the host's, or fetched once on the first write; offline, the value is kept
// unvalidated and the signed document stays authoritative). Change events come from diffing
// the resolved config map whenever the adapter's state moves, so a local write and a sync that
// changed a resolved value report the same way. Device-local only: Cloud Sync (U-06/U-20) adds
// sync state under this API later.

import type { JSONValue } from "@polaris-key/protocol/core";
import { Catalog, type ProductCatalog } from "@polaris-key/catalog";
import type { ConfigSource } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import { PolarisError, type PolarisState } from "./types.js";
import { configSource } from "./adapter.js";

/** One config change, as `onConfigChange` reports it (`@polaris-key/node`'s `ConfigChange`). */
export interface ConfigChange {
  key: string;
  value: JSONValue | undefined;
  previous: JSONValue | undefined;
  source: ConfigSource;
}

/** A reactive handle on one key (`config.setting(key)`). */
export interface ConfigSetting<T = JSONValue> {
  readonly key: string;
  get(fallback: T): T;
  source(): ConfigSource;
  /** Whether the operator locked the key (`enforced` or `hidden`). */
  locked(): boolean;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
  /** Subscribe to this key's changes; returns the unsubscribe function. */
  on(listener: (change: ConfigChange) => void): () => void;
}

/** The device-local override API every adapter exposes as `adapter.config`. */
export interface LocalConfig {
  /** Set a local override and persist it. Throws `managed_by_admin` for a locked key and
   *  `bad_request` for a value the catalog refuses. */
  set(key: string, value: JSONValue): Promise<void>;
  /** Remove one local override (the key falls back to the remote default or the fallback). */
  clear(key: string): Promise<void>;
  /** Remove every local override. */
  clearAll(): Promise<void>;
  /** A reactive handle on one key. */
  setting<T = JSONValue>(key: string): ConfigSetting<T>;
  /** Subscribe to one key's changes, or every key's with `"*"`. Fired for a local write and for
   *  a sync that changed a resolved value. Returns the unsubscribe function. */
  onConfigChange(
    key: string,
    listener: (change: ConfigChange) => void,
  ): () => void;
  /** The persisted local overrides (not the host's `localOverrides` option). */
  localValues(): Record<string, JSONValue>;
  /** Whether the operator locked `key`. */
  isLocked(key: string): boolean;
  /** Give the engine the product catalog so `set()` validates against it without a fetch. */
  useCatalog(catalog: ProductCatalog | null): void;
  /** False when the values live in memory only (no usable browser storage): they are lost on
   *  reload. True for the desktop bridge, where the host persists them. */
  persistent(): boolean;
}

/** Where an adapter keeps the overrides. `write` gets the whole next map plus what changed, so a
 *  backend may store a snapshot (browser) or forward one verb (desktop). */
export interface LocalConfigBackend {
  /** The stored values now (synchronous: the browser seeds its first snapshot with them). */
  read(): Record<string, JSONValue>;
  write(
    next: Record<string, JSONValue>,
    change: { key: string; value: JSONValue | undefined },
  ): Promise<void>;
  persistent(): boolean;
}

export interface LocalConfigDeps {
  backend: LocalConfigBackend;
  /** The host's `localOverrides` option; the persisted layer sits over it. */
  hostOverrides: Record<string, JSONValue>;
  snapshot(): PolarisState;
  subscribe(cb: (s: PolarisState) => void): () => void;
  /** Re-project the state with the merged override map (host, then persisted). */
  applyOverrides(merged: Record<string, JSONValue>): void;
  fetchSchema(): Promise<ProductCatalog | null>;
  catalog?: ProductCatalog | null;
}

const isLockedIn = (s: PolarisState, key: string): boolean => {
  const e = Object.prototype.hasOwnProperty.call(s.configEntries, key)
    ? s.configEntries[key]
    : undefined;
  return e?.state === "enforced" || e?.state === "hidden";
};

export class LocalConfigEngine implements LocalConfig {
  private persisted: Record<string, JSONValue>;
  private catalog: Catalog | null = null;
  private catalogTried = false;
  private readonly listeners = new Map<
    string,
    Set<(c: ConfigChange) => void>
  >();
  private last: PolarisState;
  private readonly off: () => void;

  constructor(private readonly deps: LocalConfigDeps) {
    this.persisted = { ...deps.backend.read() };
    if (deps.catalog !== undefined) this.useCatalog(deps.catalog);
    this.last = deps.snapshot();
    this.off = deps.subscribe((s) => this.observe(s));
  }

  /** The override map the adapter projects with: the host's, then the persisted values. */
  merged(): Record<string, JSONValue> {
    return { ...this.deps.hostOverrides, ...this.persisted };
  }

  /** Take the persisted layer from the backend's owner (the desktop host's reported values).
   *  The caller projects the state with `merged()` afterwards. */
  adopt(values: Record<string, JSONValue>): void {
    this.persisted = { ...values };
  }

  isLocked(key: string): boolean {
    return isLockedIn(this.deps.snapshot(), key);
  }

  useCatalog(catalog: ProductCatalog | null): void {
    this.catalog = catalog ? new Catalog(catalog) : null;
    this.catalogTried = true;
  }

  persistent(): boolean {
    return this.deps.backend.persistent();
  }

  localValues(): Record<string, JSONValue> {
    return { ...this.persisted };
  }

  async set(key: string, value: JSONValue): Promise<void> {
    if (this.isLocked(key))
      throw new PolarisError(
        ErrorCode.managedByAdmin,
        `${key} is managed by an administrator.`,
        ErrorCode.managedByAdmin,
      );
    if (!this.catalogTried) {
      this.catalogTried = true;
      const fetched = await this.deps.fetchSchema().catch(() => null);
      if (fetched) this.catalog = new Catalog(fetched);
    }
    const entry = this.catalog?.entryByKey(key);
    if (entry) {
      const r = this.catalog!.validateEntryValue(entry, value);
      if (!r.ok)
        throw new PolarisError(
          ErrorCode.badRequest,
          `${key}: ${r.errors.join("; ")}`,
          ErrorCode.badRequest,
        );
    }
    await this.write(key, value);
  }

  async clear(key: string): Promise<void> {
    await this.write(key, undefined);
  }

  async clearAll(): Promise<void> {
    for (const key of Object.keys(this.persisted))
      await this.write(key, undefined);
  }

  setting<T = JSONValue>(key: string): ConfigSetting<T> {
    return {
      key,
      get: (fallback: T) => {
        const v = this.deps.snapshot().config[key];
        return v === undefined ? fallback : (v as unknown as T);
      },
      source: () => configSource(this.deps.snapshot(), key),
      locked: () => this.isLocked(key),
      set: (value: T) => this.set(key, value as unknown as JSONValue),
      clear: () => this.clear(key),
      on: (listener) => this.onConfigChange(key, listener),
    };
  }

  onConfigChange(
    key: string,
    listener: (change: ConfigChange) => void,
  ): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  dispose(): void {
    this.off();
    this.listeners.clear();
  }

  private async write(
    key: string,
    value: JSONValue | undefined,
  ): Promise<void> {
    const next = { ...this.persisted };
    if (value === undefined) delete next[key];
    else next[key] = value;
    // The backend first: a refused write (a v3 bridge, a host-side refusal) changes nothing.
    await this.deps.backend.write(next, { key, value });
    this.persisted = next;
    this.deps.applyOverrides(this.merged());
  }

  /** Emit one change per key whose resolved value moved since the last state. */
  private observe(s: PolarisState): void {
    const prev = this.last;
    this.last = s;
    if (prev.config === s.config) return;
    for (const key of new Set([
      ...Object.keys(prev.config),
      ...Object.keys(s.config),
    ])) {
      const before = own(prev.config, key);
      const after = own(s.config, key);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      this.emit({
        key,
        value: after,
        previous: before,
        source: configSource(s, key),
      });
    }
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
}

function own(
  map: Record<string, JSONValue>,
  key: string,
): JSONValue | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The subset of the Web Storage API the browser backend uses (injectable for tests). */
export type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The `localStorage` key one product's overrides live under. */
export function localConfigStorageKey(product: string): string {
  return `pkey:${product}:config.local`;
}

/**
 * The browser backend: one JSON object per product in `localStorage` (or the injected storage),
 * every access in try/catch. `null` storage, or one that throws, keeps the values in memory and
 * reports `persistent() === false`.
 */
export function browserLocalConfigBackend(
  product: string,
  storage?: ConfigStorage | null,
): LocalConfigBackend {
  const key = localConfigStorageKey(product);
  let store: ConfigStorage | null = null;
  try {
    store =
      storage === undefined
        ? typeof globalThis.localStorage === "undefined"
          ? null
          : globalThis.localStorage
        : storage;
  } catch {
    store = null; // the accessor itself throws where site data is blocked
  }
  let initial: Record<string, JSONValue> = {};
  if (store) {
    try {
      const raw = store.getItem(key);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        initial = parsed as Record<string, JSONValue>;
    } catch (e) {
      // An unreadable store is memory-only; a corrupt value is simply no overrides.
      if (!(e instanceof SyntaxError)) store = null;
    }
  }
  return {
    read: () => initial,
    persistent: () => store !== null,
    async write(next) {
      if (!store) return;
      try {
        if (Object.keys(next).length === 0) store.removeItem(key);
        else store.setItem(key, JSON.stringify(next));
      } catch {
        // Quota or blocked storage mid-session: keep going in memory, and say so.
        store = null;
      }
    },
  };
}
