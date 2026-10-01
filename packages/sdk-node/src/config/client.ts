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

import type { JSONValue } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { ProductCatalog } from "@polaris-key/catalog";
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

export type { ConfigSource, ProductCatalog, UserConfigEntry };

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
}

export class ConfigClient {
  private readonly localOverrides: Record<string, JSONValue>;
  private readonly envPrefix: string;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly ctx: CoreContext,
    private readonly cache: CacheManager,
    opts: ConfigClientOptions = {},
  ) {
    this.localOverrides = opts.localOverrides ?? {};
    this.envPrefix = opts.envPrefix ?? DEFAULT_ENV_PREFIX;
    this.env = opts.env ?? process.env;
  }

  private get doc(): ConfigDoc | null {
    return this.cache.state.config?.doc ?? null;
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
  getConfig<T = JSONValue>(key: string, fallback: T): T {
    const v = resolveValue(this.context(), key);
    return v === undefined ? fallback : (v as unknown as T);
  }

  /** Where `getConfig(key)` would source its value from (for diagnostics/settings UIs). */
  getConfigSource(key: string): ConfigSource {
    return resolveSource(this.context(), key);
  }

  /** The catalog entries for a settings UI: every remote entry MINUS the `hidden` ones, each
   *  marked `{ key, value, enforced }`. (`hidden` keys are still APPLIED by `getConfig`; they
   *  are merely withheld from this enumeration.) */
  listUserConfig(): UserConfigEntry[] {
    return listUserEntries(this.doc?.config).map((entry) => ({
      ...entry,
      value: this.getConfig(entry.key, entry.value),
    }));
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
      const body: unknown = await res.json();
      return isCatalog(body) ? body : null;
    } catch {
      return null;
    }
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
