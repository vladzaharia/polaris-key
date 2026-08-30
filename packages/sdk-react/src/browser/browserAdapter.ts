// The browser adapter: a cookie-session `PolarisAdapter` that talks to the control plane over
// `fetch(..., { credentials: "include" })`. There is NO token/keyring/loopback here — the
// browser is online-only and the session lives in a first-party HttpOnly cookie the Worker
// sets. OIDC sign-in is a full-page navigation (`window.location.assign`), so the page unloads
// and `signInWithOidc` never resolves by design.
//
// ── ROUTES (§R1) ────────────────────────────────────────────────────────────────────────────
//
// The browser session and the OIDC flow are the IDENTITY service, so they live under
// `/<product>/identity/…`. The response shapes are unchanged from the pre-suite surface; only
// the mount point moved.
//
// ── ACTIVATION (§5) ─────────────────────────────────────────────────────────────────────────
//
// The gate's `activation` input is `"token"` for an authenticated session: the session cookie
// IS the credential here, standing in for the per-device `pkeyt_` token a native client holds.
// A browser can never be `"bundle"`-activated — there is no local store to import one into.
//
// Mode-parity: the adapter reduces the authenticated session read to the SAME `client-core`
// `GateInput` the desktop bridge produces and runs the SAME `licenseState`, so a browser
// snapshot is shape-identical to a desktop one.
//
// ── THE TRUST MODEL (say it out loud) ───────────────────────────────────────────────────────
//
// This adapter runs NO signature verification, and that is a property of the SERVER, not a gap
// here: `GET /<p>/identity/session` deliberately answers with the fused document as PLAIN JSON
// inside the response body, never as a compact JWS. There is nothing to verify. The Worker
// mints that document for a page rather than for an SDK, and a page has no cache or disk
// boundary for a signature to survive across.
//
// So authenticity here rests on exactly two things:
//
//   1. TLS to the control-plane origin — enforced at construction by `normalizeBaseUrl` below
//      (`https:`, or `http:` on loopback for `wrangler dev`); and
//   2. a first-party `HttpOnly; Secure; SameSite=Lax` session cookie the Worker set on that
//      same origin.
//
// `SameSite=Lax` is not incidental: a browser does not attach a Lax cookie to a CROSS-SITE
// subresource request, so `fetch(..., { credentials: "include" })` from a page on some other
// origin carries no session at all. This adapter is therefore SAME-ORIGIN ONLY — it works from
// a page served by the control plane itself, and a third-party origin pointing `baseUrl` at
// `key.plrs.im` gets an unauthenticated session rather than a silently weaker one. A product
// that needs an offline-verifiable, cross-origin credential wants the signed document pair and
// `@polaris-key/node`, not this transport.

import type { ManagedEntry } from "@polaris-key/protocol/core";
import {
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol/core";
import { isBlockReason } from "@polaris-key/protocol/license";
import type {
  BlockReason,
  DocProfile,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import { compareSemver, highWaterMark } from "@polaris-key/client-core";
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
  isSecureTransportUrl,
  type ConfigSource,
  type DeviceInfo,
  type JSONValue,
  type PolarisAdapter,
  type PolarisDocs,
  type PolarisState,
  type UserConfigEntry,
  type VersionCheck,
} from "../core/index.js";
import {
  copyServices,
  defaultServices,
  noBusy,
  noErrors,
  withBusy,
  withError,
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
} from "../core/services.js";
import { discoverProduct } from "./discovery.js";

const DEFAULT_BASE = "https://key.plrs.im";

/**
 * Thrown at construction for a `baseUrl` that would carry the session cookie in the clear.
 * The other three SDKs refuse the same URLs with the same class name (`@polaris-key/node`'s
 * `InsecureBaseUrlError`); it extends `PolarisError` so this package's one
 * `e instanceof PolarisError` convention — and `.code` — keep working for callers.
 */
export class InsecureBaseUrlError extends PolarisError {
  constructor(message: string) {
    super("insecure-base-url", message);
    this.name = "InsecureBaseUrlError";
  }
}

/** Strip the trailing slash, but only after refusing a base URL the cookie cannot be sent to
 *  safely. A plaintext control plane makes session theft a coffee-shop attack rather than a
 *  local one, and `Secure` cookies are not even sent over `http:` off loopback — so an
 *  unenforced scheme is a silent, permanently-signed-out client at best. */
function normalizeBaseUrl(raw: string): string {
  if (!isSecureTransportUrl(raw)) {
    throw new InsecureBaseUrlError(
      `baseUrl must be https: (got ${raw}); ` +
        "plaintext http:// is only accepted for localhost/127.0.0.1.",
    );
  }
  return raw.replace(/\/+$/, "");
}

export interface BrowserAdapterOptions {
  /** The product slug — path-scopes every request (`/<product>/...`). */
  productSlug: string;
  /** The control-plane origin, and the origin the page itself must be served from (the session
   *  cookie is `SameSite=Lax`). MUST be `https:` — or `http://localhost` / `http://127.0.0.1`
   *  for local development. Defaults to `https://key.plrs.im`. */
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
   *  the same app-version metadata a native one does. Also the basis of `updateAvailable`. */
  version?: string;
  /** What the host EXPECTS this product to run, used only while discovery has not answered
   *  (D-21). Defaults to license + config; never all-true. */
  expectServices?: ServicesMap;
}

/** The JSON shape the Worker's authenticated session endpoint returns. Unchanged by §R1's
 *  route move — only the path did. The document is still the FUSED v2 artifact, which this
 *  adapter splits into the v3 license/config pair at its own edge. */
interface SessionResponse {
  /** Whether the session cookie is present + valid (drives `activation`). */
  authenticated: boolean;
  doc: FusedSessionDoc | null;
  /** A 403-equivalent block, surfaced inline rather than as an HTTP error. */
  blocked?: {
    reason: BlockReason;
    allowedRange?: { min?: string; max?: string };
  };
  /** A CSRF token to echo back on writes (sign-out). */
  csrfToken?: string;
}

/** The fused document the identity session still mints (license claims + config + entitlements
 *  in one artifact). Kept local rather than imported from `@polaris-key/protocol`'s legacy barrel:
 *  nothing new may depend on that module, and this is the last surface that speaks it. */
interface FusedSessionDoc {
  schemaVersion?: number;
  aud: string;
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
  profile?: DocProfile;
  payload: {
    config: Record<string, ManagedEntry>;
    secrets?: Record<string, ManagedEntry>;
    entitlements: Record<string, ManagedEntry>;
  };
}

/**
 * Split the fused session document into the v3 pair. Grants (`entitlements`) ride the license
 * document (D-20); settings ride the config document. The claims envelope is shared, so both
 * halves carry the same `issuedAt`/`expiresAt`/`graceUntil` and the gate sees exactly what it
 * saw before the split.
 */
export function splitSessionDoc(doc: FusedSessionDoc | null): PolarisDocs {
  if (!doc) return { license: null, config: {} };
  const license: LicenseDoc = {
    iss: doc.iss,
    aud: doc.aud,
    deviceId: doc.deviceId,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    graceUntil: doc.graceUntil,
    licenseId: doc.licenseId,
    entitlements: doc.payload.entitlements ?? {},
    ...(doc.profile ? { profile: doc.profile } : {}),
  };
  return { license, config: doc.payload.config ?? {} };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

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
  private capabilities: ServicesMap;

  constructor(opts: BrowserAdapterOptions) {
    this.product = opts.productSlug;
    // Throws before anything else is wired up: an insecure control plane is a construction
    // error, not a per-request one to discover on the first 4xx.
    // Throws before anything else is wired up: an insecure control plane is a construction
    // error, not a per-request one to discover on the first 4xx.
    this.base = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE);
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.navigate =
      opts.navigate ??
      ((url) => {
        if (typeof window !== "undefined") window.location.assign(url);
      });
    this.clock = opts.now ?? nowSec;
    this.localOverrides = opts.localOverrides ?? {};
    this.version = opts.version;
    // D-21: the pre-discovery belief. Never all-true.
    this.capabilities = copyServices(opts.expectServices ?? defaultServices());
    this.store = createStore<PolarisState>(
      initialState("browser", this.capabilities, this.localOverrides),
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
   * The same `X-PKey-*` metadata the native SDKs send, so a browser device row is not a
   * blank entry in the admin panel next to fully described native ones.
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

  private apply(
    s: SessionResponse,
    flags: { busy?: ServiceBusyMap; error?: ServiceErrorMap } = {},
  ): void {
    if (s.csrfToken) this.csrf = s.csrfToken;
    this.hadSession = s.authenticated;
    const docs = splitSessionDoc(s.doc);
    this.store.set(
      projectState(
        "browser",
        docs,
        {
          // The cookie session stands in for the per-device token (§5).
          activation: s.authenticated ? "token" : null,
          now: this.clock(),
          // §4.2 — the floor over what this client has verified. Online-only, so the only
          // dated artifact is the session document; a browser has no cached trust manifest to
          // fold in and no offline window for a rolled-back clock to buy time inside.
          highWaterMark: highWaterMark(docs.license ? [docs.license] : []),
          lastSyncUnauthorized: false,
          // The reason is lifted from the session JSON, which this adapter deliberately does
          // not verify (see the trust-model note above), and the gate returns it AS the
          // `LicenseStatus`. `isBlockReason` is the membership check the erased `BlockReason`
          // type could never perform: a response claiming `{"blocked":{"reason":"ok"}}` must
          // not license the client (A1-01). Out of vocabulary ⇒ no hint at all, which is the
          // weaker of the two states it could name.
          blocked: isBlockReason(s.blocked?.reason) ? s.blocked : null,
          lastVerifiedAt: docs.license ? this.clock() : null,
        },
        {
          ...flags,
          localOverrides: this.localOverrides,
          capabilities: this.capabilities,
        },
      ),
    );
  }

  /** Re-project the current snapshot with a new busy/error map (no transport round-trip). */
  private patch(mutate: (prev: PolarisState) => Partial<PolarisState>): void {
    this.store.set((prev) => {
      const next = mutate(prev);
      const changed = (Object.keys(next) as (keyof PolarisState)[]).some(
        (k) => prev[k] !== next[k],
      );
      return changed ? { ...prev, ...next } : prev;
    });
  }

  private setBusy(slug: Parameters<typeof withBusy>[1], busy: boolean): void {
    this.patch((prev) => ({ busy: withBusy(prev.busy, slug, busy) }));
  }

  private fail(
    slug: Parameters<typeof withError>[1],
    err: PolarisError,
  ): PolarisError {
    this.patch((prev) => ({
      busy: withBusy(prev.busy, slug, false),
      error: withError(prev.error, slug, err),
    }));
    return err;
  }

  /** Install the product's real capability map from discovery (D-21). A failed or rejected
   *  document leaves the constructor's `expectServices` belief in place. */
  private async loadCapabilities(): Promise<void> {
    const result = await discoverProduct({
      baseUrl: this.base,
      product: this.product,
      fetchImpl: this.fetchImpl,
    });
    if (result.kind === "ok") this.capabilities = result.services;
  }

  /** Read the authenticated session/config in one round-trip. */
  private async fetchSession(): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url("/identity/session"), {
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
    const capabilities = this.loadCapabilities().catch(() => undefined);
    try {
      const session = await sessionRequest;
      await capabilities;
      this.apply(session);
    } catch (e) {
      await capabilities;
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message);
      this.store.set(() =>
        projectState(
          "browser",
          { license: null, config: {} },
          { activation: null, now: this.clock(), highWaterMark: 0 },
          {
            error: withError(noErrors(), "identity", err),
            localOverrides: this.localOverrides,
            capabilities: this.capabilities,
          },
        ),
      );
    }
  }

  async refresh(): Promise<void> {
    this.setBusy("license", true);
    this.setBusy("config", true);
    try {
      const s = await this.fetchSession();
      // Distinguish "never had a session" from "session was revoked".
      if (!s.authenticated && this.hadSession) {
        this.store.set((prev) =>
          projectState(
            "browser",
            { license: null, config: {} },
            {
              activation: "token",
              now: this.clock(),
              highWaterMark: prev.highWaterMark,
              lastSyncUnauthorized: true,
            },
            {
              localOverrides: this.localOverrides,
              capabilities: this.capabilities,
            },
          ),
        );
        return;
      }
      this.apply(s, { busy: noBusy(), error: noErrors() });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
        error: withError(prev.error, "license", err),
      }));
      throw err;
    }
  }

  async signInWithOidc(): Promise<void> {
    if (!this.capabilities.identity.enabled) {
      throw this.fail(
        "identity",
        new PolarisError(
          "service-disabled",
          "OIDC login is not enabled for this product.",
        ),
      );
    }
    // Full-page redirect to the Worker's OIDC entrypoint; it round-trips back with a
    // set-cookie. The page unloads, so this Promise intentionally never resolves.
    const ret =
      typeof window !== "undefined" ? window.location.href : this.base;
    const target = `${this.url("/identity/auth/start")}?return_to=${encodeURIComponent(ret)}`;
    this.navigate(target);
  }

  async submitKey(key: string): Promise<void> {
    if (!this.capabilities.license.enabled) {
      throw this.fail(
        "license",
        new PolarisError(
          "key-entry-unsupported",
          "Key entry is not enabled for this product.",
        ),
      );
    }
    this.setBusy("license", true);
    try {
      const res = await this.fetchImpl(this.url("/identity/session/license"), {
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
            error?: string | { code?: string; message?: string };
            message?: string;
          };
          const code =
            typeof body.error === "string" ? body.error : body.error?.code;
          message =
            code === "device_limit"
              ? "This license has reached its device limit."
              : ((typeof body.error === "object"
                  ? body.error?.message
                  : undefined) ??
                body.message ??
                message);
        } catch {
          // Keep the generic message when the response is not JSON.
        }
        throw new PolarisError("sign-in-failed", message);
      }
      if (!res.ok) {
        throw new PolarisError("sign-in-failed", `activation ${res.status}`);
      }
      this.apply(await this.fetchSession(), {
        busy: noBusy(),
        error: noErrors(),
      });
    } catch (e) {
      throw this.fail(
        "license",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-in-failed", (e as Error).message),
      );
    }
  }

  async signOut(): Promise<void> {
    this.setBusy("identity", true);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.csrf) headers["x-csrf-token"] = this.csrf; // CSRF echo on the write.
      const res = await this.fetchImpl(this.url("/identity/auth/logout"), {
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
          { license: null, config: {} },
          { activation: null, now: this.clock(), highWaterMark: 0 },
          {
            localOverrides: this.localOverrides,
            capabilities: this.capabilities,
          },
        ),
      );
    } catch (e) {
      throw this.fail(
        "identity",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-out-failed", (e as Error).message),
      );
    }
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  /**
   * A cookie session holds no `pkeyt_` bearer token, and `/<p>/devices` authenticates with
   * one — so remote device management is genuinely unreachable from a browser rather than
   * merely unimplemented. `DeviceManager` renders this refusal as an explanation.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    throw new PolarisError(
      "device-management-unsupported",
      "Listing devices is not supported from a browser session.",
    );
  }

  async renameDevice(_deviceId: string, _label: string | null): Promise<void> {
    throw new PolarisError(
      "device-management-unsupported",
      "Renaming devices is not supported from a browser session.",
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
      "Disconnecting another device is not supported from a browser session.",
    );
  }

  /** `GET /<product>/update/version` — the newest build on a channel plus whether the HOST
   *  application (not the SDK) is behind it, computed with the same `compareSemver` the
   *  server's build gate uses. */
  async checkUpdate(opts: { channel?: string } = {}): Promise<VersionCheck> {
    if (!this.capabilities.update.enabled) {
      throw this.fail(
        "update",
        new PolarisError(
          "service-disabled",
          "This product does not publish updates.",
        ),
      );
    }
    this.setBusy("update", true);
    try {
      const url = new URL(this.url("/update/version"));
      if (opts.channel) url.searchParams.set("channel", opts.channel);
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json", ...this.metadataHeaders() },
      });
      if (!res.ok) {
        throw new PolarisError("network", `update/version ${res.status}`);
      }
      const body = (await res.json()) as {
        version: string;
        tag: string;
        url: string;
      };
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return {
        ...body,
        updateAvailable:
          compareSemver(this.version ?? "0.0.0", body.version) < 0,
      };
    } catch (e) {
      throw this.fail(
        "update",
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message),
      );
    }
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
