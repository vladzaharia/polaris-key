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
import type { TokenManager } from "../core/token.js";
import { MintCache, mintToken, type MintedToken } from "./mint.js";

export type { ConfigSource, ProductCatalog, UserConfigEntry, MintedToken };

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
  private readonly minted = new MintCache();

  constructor(
    private readonly ctx: CoreContext,
    private readonly cache: CacheManager,
    opts: ConfigClientOptions = {},
    /** The device credential edge-mint authenticates with. Without it `mintToken` has nothing
     *  to present and refuses with `unauthorized`, as a client holding no token does. */
    private readonly tokens?: TokenManager,
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
   * `unauthorized` (no token, or still 401 after the re-acquire), or the Worker's code —
   * `not_found` for an unknown or unapproved recipe, `rate_limited`, `misconfigured`.
   */
  async mintToken(recipeId: string): Promise<MintedToken> {
    return mintToken(this.ctx, this.tokens, this.minted, recipeId);
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
