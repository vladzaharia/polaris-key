// The Polaris Key client: a small, product-agnostic facade over activate/fetch/verify/
// cache/gate. Offline-first — init() applies the cached doc with no network; refresh()
// re-pulls (with a single /token re-acquire on 401) and re-applies.
//
// SECURITY (wire contract v2): every security-relevant value this class holds is DERIVED
// from a signature it has just checked. The cache stores compact JWS strings and nothing
// else; the trust set is `{...manifestKeys, ...pinnedKeys}` with the pins terminal; the
// anti-replay floor, the monotonic clock floor and `lastVerifiedAt` are recomputed on every
// load. There is no unsigned field left for a local attacker to poison.

import { homedir } from "node:os";
import { join } from "node:path";
import type { TrustSet } from "@polaris-key/jws";
import type {
  DeviceFacts,
  DocProfile,
  HardwareFingerprint,
  JSONValue,
  ManagedConfigDoc,
  TrustManifestDoc,
} from "@polaris-key/protocol";
import { collectFingerprint } from "./fingerprint.js";
import { collectFacts, type ProbeDeclaration } from "./facts.js";
import { channelForVersion } from "./semver.js";
import { isUsable, licenseState, type LicenseState } from "./gate.js";
import { verifyDoc } from "./verify.js";
import { mergeTrust, verifyTrustManifest } from "./trust.js";
import { REFRESH_MARGIN_SECONDS } from "./claims.js";
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
import {
  CACHE_VERSION,
  KeyringStore,
  type CacheRecord,
  type Store,
} from "./store.js";
import {
  listUserEntries,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type ResolveContext,
  type UserConfigEntry,
} from "./config.js";

const DEFAULT_ENV_PREFIX = "PKEY_CONFIG_";

/** Node's `fetch` has NO default timeout, so every request needs an explicit deadline or a
 *  slowloris on any endpoint stalls `refresh()` forever (R4-08). */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface PolarisKeyOptions {
  productSlug: string;
  /** MUST be `https:` — or `http://localhost` / `http://127.0.0.1` for local development. */
  baseUrl?: string;
  version: string;
  channel?: string;
  /** Pinned trust set (kid -> raw Ed25519 pubkey base64url). This is the ONLY root: keys
   *  learned from a signed trust manifest can extend it but never shadow it. */
  trust: { pinnedKeys: TrustSet };
  /** Refresh signed trust manifests before config fetches. Defaults to true. */
  trustRefresh?: boolean;
  store?: Store;
  configDir?: string;
  fetchImpl?: typeof fetch;
  /** Per-request deadline in milliseconds (default 15000). `0` disables it. */
  requestTimeoutMs?: number;
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

/** Thrown at construction for a `baseUrl` that would carry the device bearer token in the
 *  clear. A plaintext control plane makes trust-set injection (R4-02) a coffee-shop attack
 *  rather than a local one. */
export class InsecureBaseUrlError extends Error {
  readonly code = "insecure-base-url";

  constructor(message: string) {
    super(message);
    this.name = "InsecureBaseUrlError";
  }
}

const DEFAULT_BASE = "https://key.plrs.im";
const nowSec = (): number => Math.floor(Date.now() / 1000);

function defaultConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/** Loopback hosts keep `http:` usable for `wrangler dev` / integration tests; nothing else
 *  may carry the bearer token unencrypted. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InsecureBaseUrlError(`baseUrl is not a valid URL: ${raw}`);
  }
  const loopback =
    url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) {
    throw new InsecureBaseUrlError(
      `baseUrl must be https: (got ${url.protocol}//${url.host}); ` +
        "plaintext http:// is only accepted for localhost/127.0.0.1.",
    );
  }
  return raw.replace(/\/+$/, "");
}

export class PolarisKeyClient {
  readonly product: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly channel: string;
  /** Tier 1 — compiled into the host application, never mutated at runtime. */
  private readonly pinnedTrust: TrustSet;
  /** Tier 2 — learned from a manifest verified against `pinnedTrust`. REPLACED, never
   *  merged into, on every successful refresh, so absence is revocation (§1.2). */
  private discoveredTrust: TrustSet = {};
  private readonly trustRefreshEnabled: boolean;
  private readonly store: Store;
  private readonly fetchImpl?: typeof fetch;
  private readonly requestTimeoutMs: number;
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

  // ── Derived state. Every field below is recomputed from a re-verified signature; none of
  //    it is ever read from disk (wire contract v2 §4.1/§4.2).
  private doc: ManagedConfigDoc | null = null;
  private trustDoc: TrustManifestDoc | null = null;
  private lastVerifiedAt?: number;
  /**
   * §4.3 monotonic time floor: `max` over the `issuedAt` of every signed artifact this client
   * has re-verified — the config document AND the trust manifest.
   *
   * Both sources are load-bearing. The document alone is inert (R4-04): with one cached
   * document the mark equals `doc.issuedAt`, which is below that same document's `graceUntil`
   * by construction, so it can never push `effectiveNow` past the end of grace and a clock
   * rollback still extends offline operation indefinitely. The manifest is the second,
   * independently-advancing signed clock — `trustRefresh` is on by default, so it moves even
   * while a content-stable config document sits behind an unchanged ETag.
   */
  private highWaterMark = 0;

  constructor(opts: PolarisKeyOptions) {
    this.product = opts.productSlug;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE);
    this.version = opts.version;
    this.channel = opts.channel ?? channelForVersion(opts.version);
    this.pinnedTrust = { ...opts.trust.pinnedKeys };
    this.trustRefreshEnabled = opts.trustRefresh !== false;
    this.store =
      opts.store ??
      new KeyringStore(opts.productSlug, opts.configDir ?? defaultConfigDir());
    this.fetchImpl = opts.fetchImpl;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.localOverrides = opts.localOverrides ?? {};
    this.envPrefix = opts.envPrefix ?? DEFAULT_ENV_PREFIX;
    this.env = opts.env ?? process.env;
    this.fingerprintEnabled = opts.fingerprint !== false;
    this.probes = opts.probes ?? [];
    this.refreshIntervalSeconds = opts.refreshIntervalSeconds;
    this.onChange = opts.onChange;
  }

  /** The effective trust set: manifest keys first, pins spread LAST so they are terminal. */
  private get trust(): TrustSet {
    return mergeTrust(this.pinnedTrust, this.discoveredTrust);
  }

  /**
   * Raise the §4.3 clock floor to `issuedAt`. Monotonic by construction — it only ever rises,
   * and only from content whose signature has just been checked against the pins, so there is
   * no unsigned field an attacker could edit to move it either way.
   */
  private raiseFloor(issuedAt: number): void {
    if (issuedAt > this.highWaterMark) this.highWaterMark = issuedAt;
  }

  /** A fresh deadline for one request. */
  private deadline(): AbortSignal | undefined {
    return this.requestTimeoutMs > 0
      ? AbortSignal.timeout(this.requestTimeoutMs)
      : undefined;
  }

  /** The current remote config map (or undefined when no doc is cached). */
  private resolveContext(): ResolveContext {
    return {
      remote: this.doc?.payload.config,
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
    await this.loadCache();
    this.startTimer();
  }

  /**
   * Re-verify the cache and DERIVE every counter from it (§4.2). Nothing here trusts a
   * stored value:
   *
   *   1. a record from another cache version is discarded, never migrated (§7.3);
   *   2. `trustJws` is re-verified against the PINNED keys only — on failure we fall back to
   *      the pins alone, never to whatever the file claimed;
   *   3. `configJws` is re-verified against the resulting trust set with the full claim set;
   *   4. `lastAcceptedIssuedAt` / `lastTrustIssuedAt` / `lastVerifiedAt` / `highWaterMark`
   *      are computed from the verified content;
   *   5. any failure means "no cache" — fail closed to `needs-activation`.
   */
  private async loadCache(): Promise<void> {
    this.discoveredTrust = {};
    this.trustDoc = null;
    this.doc = null;
    this.lastVerifiedAt = undefined;
    this.highWaterMark = 0;

    const rec = await this.store.readCache();
    if (!rec || rec.v !== CACHE_VERSION) {
      this.cache = null;
      return;
    }
    this.cache = rec;

    if (rec.trustJws) {
      // Freshness is not asserted on reload: a manifest is only minutes-fresh by design, and
      // refusing a stale one would strand every offline client that has rotated keys. Its
      // signature, `aud`/`iss`/`typ` binding and pinned-substitution guard all still apply.
      const manifest = await verifyTrustManifest(rec.trustJws, {
        pinned: this.pinnedTrust,
        expectedAud: this.product,
        checkFreshness: false,
      });
      if (manifest.doc) {
        this.trustDoc = manifest.doc;
        this.discoveredTrust = manifest.discovered;
        // A stale manifest's `issuedAt` is still a signed LOWER BOUND on real time — that is
        // independent of whether it is still fresh enough to publish keys, so the floor rises
        // here even though freshness was not asserted above.
        this.raiseFloor(manifest.doc.issuedAt);
      } else {
        this.cache = { ...this.cache, trustJws: undefined };
      }
    }

    if (rec.configJws) {
      const doc = await verifyDoc(rec.configJws, {
        trust: this.trust,
        expectedAud: this.product,
        deviceId: this.deviceId,
        // See VerifyOptions.checkFreshness — a cached doc is expected to be past `expiresAt`;
        // its signed outer bound is `graceUntil`, which the gate enforces against the
        // monotonic floor below.
        checkFreshness: false,
      });
      if (doc) {
        this.doc = doc;
        this.raiseFloor(doc.issuedAt);
        // Derived, not stored: the server's own statement of when this doc was minted is the
        // only trustworthy "last verified" signal available offline.
        this.lastVerifiedAt = doc.issuedAt * 1000;
      } else {
        this.cache = { ...this.cache, configJws: undefined, etag: undefined };
      }
    }
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
      doc: this.doc,
      now,
      highWaterMark: this.highWaterMark,
      lastSyncUnauthorized: this.cache?.lastSyncUnauthorized,
      blocked: this.cache?.blocked,
      lastVerifiedAt: this.lastVerifiedAt,
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
    return listUserEntries(this.doc?.payload.config).map((entry) => ({
      ...entry,
      value: this.getConfig(entry.key, entry.value),
    }));
  }

  getSecret(key: string): string | null {
    const doc = this.doc;
    if (!doc) return null;
    const e = doc.payload.secrets[key];
    return e && typeof e.value === "string" ? e.value : null;
  }

  isEntitled(name: string): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const e = doc.payload.entitlements[name];
    return Boolean(e && e.value === true);
  }

  getEntitlements(): Record<string, JSONValue> {
    const out: Record<string, JSONValue> = {};
    const doc = this.doc;
    if (!doc) return out;
    for (const [k, v] of Object.entries(doc.payload.entitlements))
      out[k] = v.value;
    return out;
  }

  getProfile(): DocProfile | null {
    return this.doc ? this.doc.profile : null;
  }

  getCurrentDevice(): DeviceInfo {
    const doc = this.doc;
    const out: DeviceInfo = {
      id: this.deviceId,
      current: true,
      status: this.status().status,
    };
    if (doc) {
      out.licenseId = doc.licenseId;
      out.profile = doc.profile;
    }
    if (this.lastVerifiedAt !== undefined)
      out.lastVerifiedAt = this.lastVerifiedAt;
    return out;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!this.token) return [this.getCurrentDevice()];
    const devices = await listRemoteDevices({
      baseUrl: this.baseUrl,
      product: this.product,
      token: this.token,
      fetchImpl: this.fetchImpl,
      signal: this.deadline(),
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
      signal: this.deadline(),
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
      signal: this.deadline(),
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
      signal: this.deadline(),
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
      signal: this.deadline(),
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
        signal: this.deadline(),
      });
    }
    this.token = null;
    this.cache = null;
    this.doc = null;
    this.trustDoc = null;
    this.discoveredTrust = {};
    this.lastVerifiedAt = undefined;
    this.highWaterMark = 0;
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
        signal: this.deadline(),
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
      signal: this.deadline(),
    });

    switch (res.kind) {
      case "not-modified": {
        // §5 — a 304 means "content unchanged, freshness RENEWED". computeETag() excludes the
        // time fields, so a content-stable config 304s forever; left alone, a continuously
        // online, continuously authenticated client coasts into `grace` at expiresAt and
        // `expired` at graceUntil (R2-11). Past the doc's half-life we re-ask unconditionally
        // so the server re-signs the validity window.
        if (
          !force &&
          this.doc !== null &&
          nowSec() > this.doc.expiresAt - REFRESH_MARGIN_SECONDS
        ) {
          return this.fetchAndApply(allowReacquire, true);
        }
        // A 304 IS a successful authenticated verification.
        this.lastVerifiedAt = Date.now();
        await this.patchCache({
          blocked: undefined,
          lastSyncUnauthorized: false,
        });
        return { applied: false };
      }
      case "unauthorized": {
        if (allowReacquire) {
          const re = await reacquireToken({
            baseUrl: this.baseUrl,
            product: this.product,
            token: this.token,
            deviceId: this.deviceId,
            fetchImpl: this.fetchImpl,
            signal: this.deadline(),
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
          // Derived from the doc we last verified — never from an on-disk counter.
          lastAcceptedIssuedAt: this.doc?.issuedAt,
        });
        if (!doc) return { applied: false };
        this.doc = doc;
        this.raiseFloor(doc.issuedAt);
        this.lastVerifiedAt = Date.now();
        // Persist the SIGNED artifact, verbatim — never the decoded document (§4.1).
        this.cache = {
          ...this.emptyCache(),
          ...this.cache,
          configJws: res.jws,
          etag: res.etag ?? undefined,
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

  /**
   * Fetch, verify and install a signed trust manifest.
   *
   * The manifest is verified against the PINNED keys only — never against the current trust
   * set. v1 verified it against `this.trust`, so a single planted key could sign a manifest
   * minting further keys and the poisoning became self-sustaining (R2-01's amplifier). It
   * also keeps the online and offline paths identical: anything installed here still verifies
   * after a restart, when only the pins are available.
   */
  private async refreshTrust(): Promise<boolean> {
    const f = this.fetchImpl ?? fetch;
    const url = `${this.baseUrl}/${this.product}/.well-known/polaris-trust.jws`;
    const res = await f(url, {
      headers: { accept: "application/jose" },
      signal: this.deadline(),
    });
    if (!res.ok) return false;
    const jws = await res.text();
    const manifest = await verifyTrustManifest(jws, {
      pinned: this.pinnedTrust,
      expectedAud: this.product,
      lastTrustIssuedAt: this.trustDoc?.issuedAt,
    });
    if (!manifest.doc) return false;
    this.trustDoc = manifest.doc;
    // §4.3 — the manifest is the floor's second source, and the one that actually advances:
    // `trustRefresh` is on by default, so this runs on every refresh even when the config
    // document is unchanged.
    this.raiseFloor(manifest.doc.issuedAt);
    // REPLACE, don't merge: the trust set becomes exactly `pinned ∪ non-revoked manifest
    // keys`, so a kid the server stopped publishing is dropped here and on disk (§1.2).
    this.discoveredTrust = manifest.discovered;
    await this.patchCache({ trustJws: jws });
    return true;
  }

  private emptyCache(): CacheRecord {
    return { v: CACHE_VERSION };
  }

  private async patchCache(patch: Partial<CacheRecord>): Promise<void> {
    this.cache = { ...this.emptyCache(), ...this.cache, ...patch };
    await this.store.writeCache(this.cache);
  }

  private reportSnapshotBody(): {
    config: Record<string, JSONValue>;
    entitlements: Record<string, JSONValue>;
  } & Partial<DeviceFacts> {
    const doc = this.doc;
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
