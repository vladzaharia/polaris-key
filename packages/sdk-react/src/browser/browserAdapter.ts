// The browser adapter: a cookie-session `PolarisAdapter` that talks to key.plrs.im over
// `fetch(..., { credentials: "include" })`. There is NO token/keyring/loopback here —
// the browser is online-only and the session lives in a first-party HttpOnly cookie the
// Worker sets. OIDC sign-in is a full-page navigation (`window.location.assign`), so the
// page unloads and `signInWithOidc` never resolves by design. License-key entry exchanges
// a key for the same cookie session via `/<product>/session/license`.
//
// Mode-parity: it reduces the authenticated `/config` read to the SAME `GateInput` the
// desktop bridge produces and runs the SAME shared gateModel, so a browser snapshot is
// shape-identical to a desktop one.

import type { BlockReason, ManagedConfigDoc } from "@plrs/protocol";
import {
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@plrs/protocol";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import {
  configSource,
  currentDeviceFromState,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
} from "../core/adapter.js";
import { createStore, type Store } from "../core/store.js";
import {
  PolarisError,
  initialState,
  type ConfigSource,
  type DeviceInfo,
  type JSONValue,
  type PolarisAdapter,
  type PolarisState,
  type UserConfigEntry,
} from "../core/index.js";

const DEFAULT_BASE = "https://key.plrs.im";

export interface BrowserAdapterOptions {
  /** The product slug — path-scopes every request (`/<product>/...`). */
  productSlug: string;
  /** The control-plane origin. Defaults to `https://key.plrs.im`. */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable navigation (tests). Defaults to `window.location.assign`. */
  navigate?: (url: string) => void;
  /** Override the clock (seconds) — for tests. */
  now?: () => number;
  /** Client-supplied local/user overrides for `default`-state config keys. Never override
   *  `enforced`/`hidden` keys (server wins). */
  localOverrides?: Record<string, JSONValue>;
  /** The host app's version, reported as `X-PKey-Version` so a browser device row carries
   *  the same app-version metadata a native one does. */
  version?: string;
}

/** The JSON shape the Worker's authenticated session endpoint returns. */
interface SessionResponse {
  /** Whether the session cookie is present + valid (drives `hasToken`). */
  authenticated: boolean;
  /** The verified managed-config doc (already validated server-side for the session). */
  doc: ManagedConfigDoc | null;
  /** A 403-equivalent block, surfaced inline rather than as an HTTP error. */
  blocked?: {
    reason: BlockReason;
    allowedRange?: { min?: string; max?: string };
  };
  /** A CSRF token to echo back on writes (sign-out). */
  csrfToken?: string;
}

interface DiscoveryCapabilities {
  supportsOidcLogin: boolean;
  supportsKeyEntry: boolean;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class BrowserAdapter implements PolarisAdapter {
  readonly mode = "browser" as const;
  private readonly base: string;
  private readonly product: string;
  private readonly fetchImpl: typeof fetch;
  private readonly navigate: (url: string) => void;
  private readonly clock: () => number;
  private readonly store: Store<PolarisState>;
  private readonly localOverrides: Record<string, JSONValue>;
  private readonly version?: string;
  private csrf: string | null = null;
  private hadSession = false;
  private supportsOidcLogin = true;
  private supportsKeyEntry = true;

  constructor(opts: BrowserAdapterOptions) {
    this.product = opts.productSlug;
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.navigate =
      opts.navigate ??
      ((url) => {
        if (typeof window !== "undefined") window.location.assign(url);
      });
    this.clock = opts.now ?? nowSec;
    this.localOverrides = opts.localOverrides ?? {};
    this.version = opts.version;
    this.store = createStore<PolarisState>(
      initialState("browser", this.localOverrides),
    );
    void this.load();
  }

  snapshot(): PolarisState {
    return this.store.get();
  }

  subscribe(cb: (state: PolarisState) => void): () => void {
    return this.store.subscribe(cb);
  }

  private url(path: string): string {
    return `${this.base}/${this.product}${path}`;
  }

  /**
   * The same `X-PKey-*` metadata the native SDKs send, so a browser device row is not a blank
   * entry in the admin panel next to fully described native ones.
   *
   * Browsers send NO hardware fingerprint — canvas/WebGL-style fingerprinting is unreliable,
   * actively degraded by browsers, and privacy-hostile — so these headers plus the User-Agent
   * the browser adds itself are the entire honest signal available here.
   */
  private metadataHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      [HEADER_PLATFORM]: "browser",
      [HEADER_SDK_NAME]: SDK_NAME,
      [HEADER_SDK_VERSION]: SDK_VERSION,
    };
    if (this.version) headers[HEADER_VERSION] = this.version;
    return headers;
  }

  private stateFlags(
    flags: { busy?: boolean; error?: PolarisError | null } = {},
  ): {
    busy?: boolean;
    error?: PolarisError | null;
    localOverrides: Record<string, JSONValue>;
    supportsOidcLogin: boolean;
    supportsKeyEntry: boolean;
  } {
    return {
      ...flags,
      localOverrides: this.localOverrides,
      supportsOidcLogin: this.supportsOidcLogin,
      supportsKeyEntry: this.supportsKeyEntry,
    };
  }

  private applyCapabilities(capabilities: DiscoveryCapabilities | null): void {
    if (!capabilities) return;
    this.supportsOidcLogin = capabilities.supportsOidcLogin;
    this.supportsKeyEntry = capabilities.supportsKeyEntry;
  }

  private apply(
    s: SessionResponse,
    flags: { busy?: boolean; error?: PolarisError | null } = {},
  ): void {
    if (s.csrfToken) this.csrf = s.csrfToken;
    this.hadSession = s.authenticated;
    this.store.set(
      projectState(
        "browser",
        s.doc,
        {
          hasToken: s.authenticated,
          now: this.clock(),
          // A hard 401 after we previously had a session ⇒ revoked, mirroring the Node gate.
          lastSyncUnauthorized: false,
          blocked: s.blocked,
          lastVerifiedAt: s.doc ? Date.now() : undefined,
        },
        this.stateFlags(flags),
      ),
    );
  }

  /** Read generic SDK capabilities from discovery without exposing provider details. */
  private async fetchCapabilities(): Promise<DiscoveryCapabilities> {
    const res = await this.fetchImpl(this.url("/.well-known/polaris.json"), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new PolarisError("network", `discovery ${res.status}`);
    const body = (await res.json()) as unknown;
    const modules = isRecord(body) ? body.modules : undefined;
    const auth = isRecord(modules) ? modules.auth : undefined;
    const authRecord = isRecord(auth) ? auth : {};
    const oidc = authRecord.oidc;
    const supportsOidcLogin =
      oidc === false ? false : isRecord(oidc) ? oidc.enabled !== false : true;
    const supportsKeyEntry =
      "activateUrl" in authRecord ? Boolean(authRecord.activateUrl) : true;
    return { supportsOidcLogin, supportsKeyEntry };
  }

  /** Read the authenticated session/config in one round-trip. */
  private async fetchSession(): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url("/session"), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json", ...this.metadataHeaders() },
    });
    if (res.status === 401) {
      // Was authenticated, now isn't → revoked; never authenticated → needs-activation.
      return { authenticated: false, doc: null };
    }
    if (!res.ok) {
      throw new PolarisError("network", `session ${res.status}`);
    }
    return (await res.json()) as SessionResponse;
  }

  private async load(): Promise<void> {
    const sessionRequest = this.fetchSession();
    const capabilities = this.fetchCapabilities().catch(() => null);
    try {
      const session = await sessionRequest;
      this.applyCapabilities(await capabilities);
      this.apply(session);
    } catch (e) {
      this.applyCapabilities(await capabilities);
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message);
      this.store.set(() =>
        projectState(
          "browser",
          null,
          { hasToken: false, now: this.clock() },
          this.stateFlags({ error: err }),
        ),
      );
    }
  }

  private setBusy(busy: boolean): void {
    this.store.set((prev) => (prev.busy === busy ? prev : { ...prev, busy }));
  }

  async refresh(): Promise<void> {
    this.setBusy(true);
    try {
      const s = await this.fetchSession();
      // Distinguish "never had a session" from "session was revoked".
      if (!s.authenticated && this.hadSession) {
        this.store.set(() =>
          projectState(
            "browser",
            null,
            { hasToken: true, now: this.clock(), lastSyncUnauthorized: true },
            this.stateFlags(),
          ),
        );
        return;
      }
      this.apply(s);
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  async signInWithOidc(): Promise<void> {
    if (!this.supportsOidcLogin) {
      throw new PolarisError(
        "sign-in-failed",
        "OIDC login is not enabled for this product.",
      );
    }
    // Full-page redirect to the Worker's OIDC entrypoint; it round-trips back with a
    // set-cookie. The page unloads, so this Promise intentionally never resolves.
    const ret =
      typeof window !== "undefined" ? window.location.href : this.base;
    const target = `${this.url("/auth/login")}?return_to=${encodeURIComponent(ret)}`;
    this.navigate(target);
  }

  async submitKey(key: string): Promise<void> {
    if (!this.supportsKeyEntry) {
      throw new PolarisError(
        "key-entry-unsupported",
        "Key entry is not enabled for this product.",
      );
    }
    this.setBusy(true);
    try {
      const res = await this.fetchImpl(this.url("/session/license"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...this.metadataHeaders(),
        },
        body: JSON.stringify({ key }),
      });
      if (res.status === 401) {
        throw new PolarisError("sign-in-failed", "That key was not accepted.");
      }
      if (res.status === 403) {
        let message = `activation ${res.status}`;
        try {
          const body = (await res.json()) as {
            error?: string;
            message?: string;
          };
          message =
            body.error === "device_limit"
              ? "This license has reached its device limit."
              : (body.message ?? message);
        } catch {
          // Keep the generic message when the response is not JSON.
        }
        throw new PolarisError("sign-in-failed", message);
      }
      if (!res.ok) {
        throw new PolarisError("sign-in-failed", `activation ${res.status}`);
      }
      this.apply(await this.fetchSession(), { busy: false, error: null });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-in-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  async signOut(): Promise<void> {
    this.setBusy(true);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.csrf) headers["x-csrf-token"] = this.csrf; // CSRF echo on the write.
      const res = await this.fetchImpl(this.url("/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!res.ok && res.status !== 401) {
        throw new PolarisError("sign-out-failed", `logout ${res.status}`);
      }
      this.csrf = null;
      this.hadSession = false;
      this.store.set(() =>
        projectState(
          "browser",
          null,
          { hasToken: false, now: this.clock() },
          this.stateFlags(),
        ),
      );
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-out-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  async listDevices(): Promise<DeviceInfo[]> {
    throw new PolarisError(
      "device-management-unsupported",
      "Remote device management is not supported by this backend.",
    );
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    const current = this.currentDevice();
    if (current?.id === deviceId) {
      await this.signOut();
      return;
    }
    throw new PolarisError(
      "device-management-unsupported",
      "Remote device deauthorization is not supported by this backend.",
    );
  }

  getConfig<T = JSONValue>(key: string, fallback: T): T {
    return readConfig(this.store.get(), key, fallback);
  }

  listUserConfig(): UserConfigEntry[] {
    return listUserConfig(this.store.get());
  }

  getConfigSource(key: string): ConfigSource {
    return configSource(this.store.get(), key);
  }

  getSecret(_key: string): string | null {
    // Secrets are never delivered to a browser session — always null.
    return null;
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  dispose(): void {
    // No long-lived listeners/timers to clean up in browser mode.
  }
}

/** Construct a browser adapter (the canonical factory the Provider uses). */
export function browserAdapter(opts: BrowserAdapterOptions): PolarisAdapter {
  return new BrowserAdapter(opts);
}
