// The Polaris Key client: a small, product-agnostic facade over activate/fetch/verify/
// cache/gate. Offline-first — init() applies the cached doc with no network; refresh()
// re-pulls (with a single /token re-acquire on 401) and re-applies.

import { homedir } from "node:os";
import { join } from "node:path";
import type { TrustSet } from "@polaris-key/jws";
import { verifyJws } from "@polaris-key/jws";
import type {
  DeviceFacts,
  DocProfile,
  HardwareFingerprint,
  JSONValue,
} from "@polaris-key/protocol";
import { ISSUER, type TrustManifestDoc } from "@polaris-key/protocol";
import { collectFingerprint } from "./fingerprint.js";
import { collectFacts, type ProbeDeclaration } from "./facts.js";
import { channelForVersion } from "./semver.js";
import { isUsable, licenseState, type LicenseState } from "./gate.js";
import { verifyDoc } from "./verify.js";
import { fetchManagedConfig } from "./fetch.js";
import {
  deauthorize,
  deauthorizeDevice as deauthorizeRemoteDevice,
  activateWithKey,
  enroll,
  listDevices as listRemoteDevices,
  reacquireToken,
  renameDevice as renameRemoteDevice,
  reportSnapshot,
  type ActivationResult,
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
  /** Collect a hardware fingerprint at activation. Defaults to true; set false to opt out
   *  entirely (the server then records this device as `unverified`). */
  fingerprint?: boolean;
  /** Product-declared companion-app probes answered in the report snapshot. */
  probes?: ProbeDeclaration[];
  /** Poll `/config` on this interval (seconds). OFF by default — enabling it would silently
   *  add network traffic and background wakeups to every already-shipped integration. Set it
   *  to make a remote tier change land without a restart. Call `close()` to stop the timer. */
  refreshIntervalSeconds?: number;
  /** Fired after a refresh that actually changed the managed config. */
  onChange?: (state: LicenseState) => void;
}

export type { ConfigSource, UserConfigEntry };

export interface RefreshResult {
  applied: boolean;
  unauthorized?: boolean;
  blocked?: boolean;
  deviceCap?: boolean;
}

export interface DeviceInfo {
  id: string;
  current: boolean;
  status: LicenseState["status"];
  licenseId?: string;
  profile?: DocProfile;
  lastVerifiedAt?: number;
  label?: string | null;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

export class DeviceManagementUnsupportedError extends Error {
  readonly code = "device-management-unsupported";

  constructor(
    message = "Remote device management is not supported by this backend.",
  ) {
    super(message);
    this.name = "DeviceManagementUnsupportedError";
  }
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
  private readonly fingerprintEnabled: boolean;
  private readonly probes: ProbeDeclaration[];
  private readonly refreshIntervalSeconds?: number;
  private readonly onChange?: (state: LicenseState) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

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
    this.fingerprintEnabled = opts.fingerprint !== false;
    this.probes = opts.probes ?? [];
    this.refreshIntervalSeconds = opts.refreshIntervalSeconds;
    this.onChange = opts.onChange;
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
    this.startTimer();
  }

  private startTimer(): void {
    const seconds = this.refreshIntervalSeconds;
    if (!seconds || seconds <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, seconds * 1000);
    // Don't hold a CLI or short-lived process open just to poll.
    this.timer.unref?.();
  }

  /** Stop the refresh timer. Safe to call more than once. */
  close(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
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
    return listUserEntries(this.cache?.doc?.payload.config).map((entry) => ({
      ...entry,
      value: this.getConfig(entry.key, entry.value),
    }));
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

  getCurrentDevice(): DeviceInfo {
    const doc = this.cache?.doc;
    const out: DeviceInfo = {
      id: this.deviceId,
      current: true,
      status: this.status().status,
    };
    if (doc) {
      out.licenseId = doc.licenseId;
      out.profile = doc.profile;
    }
    if (this.cache?.lastVerifiedAt !== undefined)
      out.lastVerifiedAt = this.cache.lastVerifiedAt;
    return out;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!this.token) return [this.getCurrentDevice()];
    const devices = await listRemoteDevices({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      fetchImpl: this.fetchImpl,
    });
    const current = this.getCurrentDevice();
    return devices.map((device) => ({
      id: device.id,
      current: device.current,
      status: device.current ? current.status : "ok",
      licenseId: device.licenseId ?? current.licenseId,
      profile: device.current ? current.profile : undefined,
      lastVerifiedAt: device.current ? current.lastVerifiedAt : undefined,
      label: device.label,
      platform: device.platform,
      arch: device.arch,
      appVersion: device.appVersion,
      sdkName: device.sdkName,
      sdkVersion: device.sdkVersion,
    }));
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.deviceId) {
      await this.deactivate();
      return;
    }
    if (!this.token)
      throw new DeviceManagementUnsupportedError(
        "Activate before managing devices.",
      );
    await deauthorizeRemoteDevice({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      deviceId,
      fetchImpl: this.fetchImpl,
    });
  }

  async renameDevice(deviceId: string, label: string | null): Promise<void> {
    if (!this.token)
      throw new DeviceManagementUnsupportedError(
        "Activate before managing devices.",
      );
    await renameRemoteDevice({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      deviceId,
      label,
      fetchImpl: this.fetchImpl,
    });
  }

  // ── Activation ──────────────────────────────────────────────────────────────
  /** This machine's hashed hardware components, or null when collection is disabled or
   *  nothing could be read. Raw hardware values never leave the device. */
  private fingerprint(): HardwareFingerprint | null {
    if (!this.fingerprintEnabled) return null;
    try {
      return collectFingerprint(this.product);
    } catch {
      // Fingerprinting is best-effort: a host that refuses every probe still activates,
      // and the server records it as unverified.
      return null;
    }
  }

  /** Obtain a license with no key and no sign-in, when the product offers a free tier. */
  async enroll(): Promise<ActivationResult> {
    const r = await enroll({
      baseUrl: this.baseUrl,
      product: this.product,
      deviceId: this.deviceId,
      fetchImpl: this.fetchImpl,
      fingerprint: this.fingerprint(),
    });
    if (r.kind === "ok") {
      this.token = r.token;
      await this.store.setToken(r.token);
      await this.refresh({ force: true });
    }
    return r;
  }

  async activateWithKey(key: string): Promise<ActivationResult> {
    const r = await activateWithKey({
      baseUrl: this.baseUrl,
      product: this.product,
      key,
      deviceId: this.deviceId,
      fetchImpl: this.fetchImpl,
      fingerprint: this.fingerprint(),
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
  async refresh(opts: { force?: boolean } = {}): Promise<RefreshResult> {
    if (!this.token) return { applied: false };
    // computeETag() deliberately excludes issuedAt/expiresAt/graceUntil, so the tag is stable
    // across a pure re-sign and differs if and only if the CONTENT changed. That makes it the
    // change signal — no payload diffing, no new wire field.
    const beforeEtag = this.cache?.etag;
    const result = await this.fetchAndApply(true, opts.force === true);
    if (
      this.onChange &&
      result.applied &&
      this.cache?.etag !== undefined &&
      this.cache.etag !== beforeEtag
    ) {
      this.onChange(this.status());
    }
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

  private async fetchAndApply(
    allowReacquire: boolean,
    force = false,
  ): Promise<RefreshResult> {
    if (!this.token) return { applied: false };
    if (this.trustRefreshEnabled) await this.refreshTrust().catch(() => false);
    const res = await fetchManagedConfig({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      deviceId: this.deviceId,
      version: this.version,
      channel: this.channel,
      etag: force ? undefined : this.cache?.etag,
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
            return this.fetchAndApply(false, force);
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
  } & Partial<DeviceFacts> {
    const doc = this.cache?.doc;
    const config: Record<string, JSONValue> = {};
    const entitlements: Record<string, JSONValue> = {};
    if (doc) {
      for (const [k, v] of Object.entries(doc.payload.config))
        config[k] = v.value;
      for (const [k, v] of Object.entries(doc.payload.entitlements))
        entitlements[k] = v.value;
    }
    // Software facts ride alongside the config/entitlement snapshot on the SAME report call —
    // no extra round trip, and the Worker's allowlist keeps the payload bounded.
    let facts: DeviceFacts | Record<string, never> = {};
    try {
      facts = collectFacts({ probes: this.probes });
    } catch {
      // Facts are diagnostic; failing to gather them must never break a refresh.
    }
    return { ...facts, config, entitlements };
  }
}
