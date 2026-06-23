// The Polaris Key client: a small, product-agnostic facade over enroll/fetch/verify/
// cache/gate. Offline-first — init() applies the cached doc with no network; refresh()
// re-pulls (with a single /token re-acquire on 401) and re-applies.

import { homedir } from "node:os";
import { join } from "node:path";
import type { TrustSet } from "@polaris-key/jws";
import type { DocProfile, JSONValue, ManagedConfigDoc } from "@polaris-key/protocol";
import { channelForVersion } from "./semver.js";
import { isUsable, licenseState, type LicenseState } from "./gate.js";
import { verifyDoc } from "./verify.js";
import { fetchManagedConfig } from "./fetch.js";
import { deauthorize, enrollWithKey, reacquireToken, reportSnapshot, type EnrollResult } from "./endpoints.js";
import { FileStore, type CacheRecord, type Store } from "./store.js";

export interface PolarisKeyOptions {
  productSlug: string;
  baseUrl?: string;
  version: string;
  channel?: string;
  /** Pinned trust set (kid -> raw Ed25519 pubkey base64url). JWKS discovery is layered later. */
  trust: { pinnedKeys: TrustSet };
  store?: Store;
  configDir?: string;
  fetchImpl?: typeof fetch;
}

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
  private readonly trust: TrustSet;
  private readonly store: Store;
  private readonly fetchImpl?: typeof fetch;

  private token: string | null = null;
  private deviceId = "";
  private cache: CacheRecord | null = null;

  constructor(opts: PolarisKeyOptions) {
    this.product = opts.productSlug;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.version = opts.version;
    this.channel = opts.channel ?? channelForVersion(opts.version);
    this.trust = opts.trust.pinnedKeys;
    this.store = opts.store ?? new FileStore(opts.productSlug, opts.configDir ?? defaultConfigDir());
    this.fetchImpl = opts.fetchImpl;
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

  getConfig<T = JSONValue>(key: string, fallback: T): T {
    const e = this.cache?.doc.payload.config[key];
    return e ? (e.value as unknown as T) : fallback;
  }

  getSecret(key: string): string | null {
    const e = this.cache?.doc.payload.secrets[key];
    return e && typeof e.value === "string" ? e.value : null;
  }

  isEntitled(name: string): boolean {
    const e = this.cache?.doc.payload.entitlements[name];
    return Boolean(e && e.value === true);
  }

  getEntitlements(): Record<string, JSONValue> {
    const out: Record<string, JSONValue> = {};
    const ents = this.cache?.doc.payload.entitlements ?? {};
    for (const [k, v] of Object.entries(ents)) out[k] = v.value;
    return out;
  }

  getProfile(): DocProfile | null {
    return this.cache?.doc.profile ?? null;
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
      await deauthorize({ baseUrl: this.baseUrl, product: this.product, token: this.token, fetchImpl: this.fetchImpl });
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
        await this.patchCache({ blocked: undefined, lastSyncUnauthorized: false });
        return { applied: false };
      case "unauthorized": {
        if (allowReacquire) {
          const re = await reacquireToken({
            baseUrl: this.baseUrl,
            product: this.product,
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
        await this.patchCache({ blocked: { reason: res.reason, allowedRange: res.allowedRange } });
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

  private async patchCache(patch: Partial<CacheRecord>): Promise<void> {
    if (!this.cache) {
      // No doc yet: remember only the bookkeeping (status() tolerates a doc-less cache).
      if (patch.blocked || patch.lastSyncUnauthorized) {
        this.cache = {
          doc: null as unknown as ManagedConfigDoc,
          lastAcceptedIssuedAt: 0,
          ...patch,
        };
      }
      return;
    }
    this.cache = { ...this.cache, ...patch };
    await this.store.writeCache(this.cache);
  }

  private reportSnapshotBody(): { config: Record<string, JSONValue>; entitlements: Record<string, JSONValue> } {
    const doc = this.cache?.doc;
    const config: Record<string, JSONValue> = {};
    const entitlements: Record<string, JSONValue> = {};
    if (doc) {
      for (const [k, v] of Object.entries(doc.payload.config)) config[k] = v.value;
      for (const [k, v] of Object.entries(doc.payload.entitlements)) entitlements[k] = v.value;
    }
    return { config, entitlements };
  }
}
