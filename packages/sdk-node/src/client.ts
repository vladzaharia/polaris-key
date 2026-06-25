// The Polaris Key client: a small, product-agnostic facade over enroll/fetch/verify/
// cache/gate. Offline-first — init() applies the cached doc with no network; refresh()
// re-pulls (with a single /token re-acquire on 401) and re-applies.

import { homedir } from "node:os";
import { join } from "node:path";
import type { TrustSet } from "@polaris-key/jws";
import { verifyJws } from "@polaris-key/jws";
import type { DocProfile, JSONValue } from "@polaris-key/protocol";
import { ISSUER, type TrustManifestDoc } from "@polaris-key/protocol";
import { channelForVersion } from "./semver.js";
import { isUsable, licenseState, type LicenseState } from "./gate.js";
import { verifyDoc } from "./verify.js";
import { fetchManagedConfig } from "./fetch.js";
import {
  deauthorize,
  enrollWithKey,
  reacquireToken,
  reportSnapshot,
  type EnrollResult,
} from "./endpoints.js";
import { KeyringStore, type CacheRecord, type Store } from "./store.js";
import {
  listUserEntries,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type ResolveContext,
  type UserConfigEntry,
} from "./config.js";

const DEFAULT_ENV_PREFIX = "PKEY_CONFIG_";

export interface PolarisKeyOptions {
  productSlug: string;
  baseUrl?: string;
  version: string;
  channel?: string;
  /** Pinned trust set (kid -> raw Ed25519 pubkey base64url). JWKS discovery is layered later. */
  trust: { pinnedKeys: TrustSet };
  /** Refresh signed trust manifests before config fetches. Defaults to true. */
  trustRefresh?: boolean;
  store?: Store;
  configDir?: string;
  fetchImpl?: typeof fetch;
  /** User/local config overrides — beat a remote `default` value, but NOT an `enforced`/
   *  `hidden` one (the server stays authoritative for those). */
  localOverrides?: Record<string, JSONValue>;
  /** Env-var prefix for config overrides (default `"PKEY_CONFIG_"`). A key's env var is
   *  `${envPrefix}${key.replaceAll(".", "__")}` (e.g. `run.concurrency` →
   *  `PKEY_CONFIG_run__concurrency`). */
  envPrefix?: string;
  /** Environment table to read overrides from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

export type { ConfigSource, UserConfigEntry };

export interface RefreshResult {
  applied: boolean;
  unauthorized?: boolean;
  blocked?: boolean;
  deviceCap?: boolean;
}

const DEFAULT_BASE = "https://key.plrs.im";
const nowSec = (): number => Math.floor(Date.now() / 1000);

function defaultConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export class PolarisKeyClient {
  readonly product: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly channel: string;
  private trust: TrustSet;
  private readonly trustRefreshEnabled: boolean;
  private readonly store: Store;
  private readonly fetchImpl?: typeof fetch;
  private readonly localOverrides: Record<string, JSONValue>;
  private readonly envPrefix: string;
  private readonly env: Record<string, string | undefined>;

  private token: string | null = null;
  private deviceId = "";
  private cache: CacheRecord | null = null;

  constructor(opts: PolarisKeyOptions) {
    this.product = opts.productSlug;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.version = opts.version;
    this.channel = opts.channel ?? channelForVersion(opts.version);
    this.trust = opts.trust.pinnedKeys;
    this.trustRefreshEnabled = opts.trustRefresh !== false;
    this.store =
      opts.store ??
      new KeyringStore(opts.productSlug, opts.configDir ?? defaultConfigDir());
    this.fetchImpl = opts.fetchImpl;
    this.localOverrides = opts.localOverrides ?? {};
    this.envPrefix = opts.envPrefix ?? DEFAULT_ENV_PREFIX;
    this.env = opts.env ?? process.env;
  }

  /** The current remote config map (or undefined when no doc is cached). */
  private resolveContext(): ResolveContext {
    return {
      remote: this.cache?.doc?.payload.config,
      localOverrides: this.localOverrides,
      env: this.env,
      envPrefix: this.envPrefix,
    };
  }

  static async create(opts: PolarisKeyOptions): Promise<PolarisKeyClient> {
    const c = new PolarisKeyClient(opts);
    await c.init();
    return c;
  }

  /** Load token + device id + cached doc (no network). */
  async init(): Promise<void> {
    this.deviceId = await this.store.getDeviceId();
    this.token = await this.store.getToken();
    this.cache = await this.store.readCache();
    if (this.cache?.trustedKeys) {
      this.trust = { ...this.trust, ...this.cache.trustedKeys };
    }
  }

  // ── Gate / reads ────────────────────────────────────────────────────────────
  status(now = nowSec()): LicenseState {
    return licenseState({
      hasToken: this.token !== null,
      doc: this.cache?.doc ?? null,
      now,
      lastSyncUnauthorized: this.cache?.lastSyncUnauthorized,
      blocked: this.cache?.blocked,
      lastVerifiedAt: this.cache?.lastVerifiedAt,
    });
  }

  isLicensed(now = nowSec()): boolean {
    return isUsable(this.status(now).status);
  }

  /**
   * Resolve the effective value for a config key, honoring management state + override
   * layers (precedence: `enforced`|`hidden` remote > local override > env > remote default
   * > `fallback`). Note: an `enforced`/`hidden` key is LOCKED — attempting to override it
   * via `localOverrides` or an env var has no effect; the remote value still wins.
   */
  getConfig<T = JSONValue>(key: string, fallback: T): T {
    const v = resolveValue(this.resolveContext(), key);
    return v === undefined ? fallback : (v as unknown as T);
  }

  /** Where `getConfig(key)` would source its value from (for diagnostics/settings UIs). */
  getConfigSource(key: string): ConfigSource {
    return resolveSource(this.resolveContext(), key);
  }

  /** The catalog config entries for a settings UI: every remote entry MINUS `hidden`
   *  ones, each marked `{ key, value, enforced }`. (`hidden` keys are still applied by
   *  `getConfig`; they are merely withheld from this enumeration.) */
  listUserConfig(): UserConfigEntry[] {
    return listUserEntries(this.cache?.doc?.payload.config);
  }

  getSecret(key: string): string | null {
    const doc = this.cache?.doc;
    if (!doc) return null;
    const e = doc.payload.secrets[key];
    return e && typeof e.value === "string" ? e.value : null;
  }

  isEntitled(name: string): boolean {
    const doc = this.cache?.doc;
    if (!doc) return false;
    const e = doc.payload.entitlements[name];
    return Boolean(e && e.value === true);
  }

  getEntitlements(): Record<string, JSONValue> {
    const out: Record<string, JSONValue> = {};
    const doc = this.cache?.doc;
    if (!doc) return out;
    for (const [k, v] of Object.entries(doc.payload.entitlements))
      out[k] = v.value;
    return out;
  }

  getProfile(): DocProfile | null {
    const doc = this.cache?.doc;
    return doc ? doc.profile : null;
  }

  // ── Enrollment ──────────────────────────────────────────────────────────────
  async activateWithKey(key: string): Promise<EnrollResult> {
    const r = await enrollWithKey({
      baseUrl: this.baseUrl,
      product: this.product,
      key,
      deviceId: this.deviceId,
      fetchImpl: this.fetchImpl,
    });
    if (r.kind === "ok") {
      this.token = r.token;
      await this.store.setToken(r.token);
      await this.refresh({ force: true });
    }
    return r;
  }

  async deactivate(): Promise<void> {
    if (this.token) {
      await deauthorize({
        baseUrl: this.baseUrl,
        product: this.product,
        token: this.token,
        fetchImpl: this.fetchImpl,
      });
    }
    this.token = null;
    this.cache = null;
    await this.store.clearToken();
    await this.store.clearCache();
  }

  // ── Refresh ─────────────────────────────────────────────────────────────────
  async refresh(_opts: { force?: boolean } = {}): Promise<RefreshResult> {
    if (!this.token) return { applied: false };
    const result = await this.fetchAndApply(true);
    if (result.applied || !result.unauthorized) {
      await reportSnapshot({
        baseUrl: this.baseUrl,
        product: this.product,
        token: this.token,
        snapshot: this.reportSnapshotBody(),
        fetchImpl: this.fetchImpl,
      }).catch(() => false);
    }
    return result;
  }

  private async fetchAndApply(allowReacquire: boolean): Promise<RefreshResult> {
    if (!this.token) return { applied: false };
    if (this.trustRefreshEnabled) await this.refreshTrust().catch(() => false);
    const res = await fetchManagedConfig({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      deviceId: this.deviceId,
      version: this.version,
      channel: this.channel,
      etag: this.cache?.etag,
      fetchImpl: this.fetchImpl,
    });

    switch (res.kind) {
      case "not-modified":
        await this.patchCache({
          blocked: undefined,
          lastSyncUnauthorized: false,
        });
        return { applied: false };
      case "unauthorized": {
        if (allowReacquire) {
          const re = await reacquireToken({
            baseUrl: this.baseUrl,
            product: this.product,
            token: this.token,
            deviceId: this.deviceId,
            fetchImpl: this.fetchImpl,
          });
          if (re.kind === "ok") {
            this.token = re.token;
            await this.store.setToken(re.token);
            return this.fetchAndApply(false);
          }
        }
        await this.patchCache({ lastSyncUnauthorized: true });
        return { applied: false, unauthorized: true };
      }
      case "device-cap":
        return { applied: false, deviceCap: true };
      case "blocked":
        await this.patchCache({
          blocked: { reason: res.reason, allowedRange: res.allowedRange },
        });
        return { applied: false, blocked: true };
      case "ok": {
        const doc = await verifyDoc(res.jws, {
          trust: this.trust,
          expectedAud: this.product,
          deviceId: this.deviceId,
          lastAcceptedIssuedAt: this.cache?.lastAcceptedIssuedAt,
        });
        if (!doc) return { applied: false };
        this.cache = {
          doc,
          etag: res.etag ?? undefined,
          lastAcceptedIssuedAt: doc.issuedAt,
          lastVerifiedAt: Date.now(),
          trustedKeys: this.cache?.trustedKeys,
          lastTrustIssuedAt: this.cache?.lastTrustIssuedAt,
          lastSyncUnauthorized: false,
          blocked: undefined,
        };
        await this.store.writeCache(this.cache);
        return { applied: true };
      }
      case "error":
        return { applied: false };
    }
  }

  private async refreshTrust(): Promise<boolean> {
    const f = this.fetchImpl ?? fetch;
    const url = `${this.baseUrl}/${this.product}/.well-known/polaris-trust.jws`;
    const res = await f(url, { headers: { accept: "application/jose" } });
    if (!res.ok) return false;
    const jws = await res.text();
    const verified = await verifyJws<TrustManifestDoc>(jws, this.trust);
    if (!verified) return false;
    const doc = verified.payload;
    const now = nowSec();
    if (doc.aud !== this.product || doc.iss !== ISSUER) return false;
    if (doc.expiresAt < now) return false;
    if (
      this.cache?.lastTrustIssuedAt !== undefined &&
      doc.issuedAt <= this.cache.lastTrustIssuedAt
    ) {
      return false;
    }
    const next: TrustSet = {};
    for (const key of doc.keys) {
      if (key.alg === "EdDSA" && key.kty === "OKP" && key.crv === "Ed25519") {
        next[key.kid] = key.publicKey;
      }
    }
    if (Object.keys(next).length === 0) return false;
    this.trust = { ...this.trust, ...next };
    await this.patchCache({
      trustedKeys: this.trust,
      lastTrustIssuedAt: doc.issuedAt,
    });
    return true;
  }

  private async patchCache(patch: Partial<CacheRecord>): Promise<void> {
    if (!this.cache) {
      // No doc yet: remember only the bookkeeping in a type-honest doc-less record
      // (status() + the getters all tolerate a doc-less cache).
      if (
        patch.blocked ||
        patch.lastSyncUnauthorized ||
        patch.trustedKeys ||
        patch.lastTrustIssuedAt
      ) {
        const next: CacheRecord = {
          doc: null,
          lastAcceptedIssuedAt: 0,
          ...patch,
        };
        this.cache = next;
        await this.store.writeCache(next);
      }
      return;
    }
    this.cache = { ...this.cache, ...patch };
    await this.store.writeCache(this.cache);
  }

  private reportSnapshotBody(): {
    config: Record<string, JSONValue>;
    entitlements: Record<string, JSONValue>;
  } {
    const doc = this.cache?.doc;
    const config: Record<string, JSONValue> = {};
    const entitlements: Record<string, JSONValue> = {};
    if (doc) {
      for (const [k, v] of Object.entries(doc.payload.config))
        config[k] = v.value;
      for (const [k, v] of Object.entries(doc.payload.entitlements))
        entitlements[k] = v.value;
    }
    return { config, entitlements };
  }
}
