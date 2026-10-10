// The Core substrate's shared state and transport primitives — wire contract v3 §4–§6.
//
// Polaris Key is a suite of opt-in services over an always-on Core. On the client that division is
// the same one the Worker makes: Core owns the device principal, the credential, the trust set,
// the verified cache, the monotonic clock floor and the sync loop; a service module owns its
// own routes and the reads they feed. `CoreContext` is the object every one of them is handed.
//
// ── WHY THE OPTIONS SPLIT ───────────────────────────────────────────────────────────────────
//
// `CoreOptions` carries what Core needs and ONLY that. The pinned trust set lives here rather
// than in the license module because it verifies config documents, trust manifests and offline
// bundles too — a product that has disabled License still needs pins. Conversely `envPrefix` /
// `env` / `localOverrides` are absent: they are inputs to config RESOLUTION, which is the config
// service's job, so they ride `ConfigClientOptions`. The pre-suite client fused all of these into
// one 20-field bag, which is exactly how `trust` ended up looking like a licensing concern.
//
// ── WHY THE TRANSPORT LIVES HERE ────────────────────────────────────────────────────────────
//
// Every product-scoped request carries the same seven `X-PKey-*` headers and the same
// deadline, and gets the same treatment when the network simply fails. Putting that in one
// place is what keeps a new service from shipping a call with no timeout on it (R4-08).

import { resolveDeviceLabel } from "./deviceLabel.js";
import { arch, platform } from "node:os";
import type { TrustSet } from "@polaris-key/jws";
import {
  HEADER_ARCH,
  HEADER_CHANNEL,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol/core";
import type { AllowedRange, BlockReason } from "@polaris-key/protocol/license";
import {
  PolarisError,
  UnsupportedError,
  canonicalArch,
  canonicalPlatform,
  channelForVersion,
  effectiveNow,
  type Store,
} from "@polaris-key/client-core";
import { ErrorCode, Feature, SdkId } from "../constants.generated.js";
import { SDK_VERSION } from "../version.js";
import { KeyringStore } from "./store.js";
import { withRedirectPolicy } from "./redirect.js";
import { assertProductSlug } from "./slug.js";
import { resolveAppVersion } from "./appVersion.js";
import { bindDeviceId } from "./deviceBinding.js";
import { classifyResponse, transportError } from "./http.js";
import { defaultDirBases, resolveDirs, type ProductDirs } from "./dirs.js";
import {
  DEFAULT_SERVICES,
  copyServices,
  servicesFromList,
  type ServiceSlug,
  type ServicesMap,
} from "../discovery.js";

/** Where the SDK talks to when the host does not say. */
export const DEFAULT_BASE = "https://key.plrs.im";

/** Node's `fetch` has NO default timeout, so every request needs an explicit deadline or a
 *  slowloris on any endpoint stalls `sync()` forever (R4-08). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Thrown at construction for a `baseUrl` that would carry the device bearer token in the
 *  clear. A plaintext control plane makes trust-set injection (R4-02) a coffee-shop attack
 *  rather than a local one. A `PolarisError` with code `insecure-base-url`. */
export class InsecureBaseUrlError extends PolarisError {
  constructor(message: string) {
    super(ErrorCode.insecureBaseUrl, message);
    this.name = "InsecureBaseUrlError";
  }
}

/** Loopback hosts keep `http:` usable for `wrangler dev` / integration tests; nothing else
 *  may carry the bearer token unencrypted. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeBaseUrl(raw: string): string {
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
  // The origin only: a path, query, fragment or userinfo would ride into every URL.
  return url.origin;
}

/** What Core needs. Per-service inputs live in that service's own option bag. */
export interface CoreOptions {
  productSlug: string;
  /** MUST be `https:` — or `http://localhost` / `http://127.0.0.1` for local development. */
  baseUrl?: string;
  /** The HOST APPLICATION's version, sent as `X-PKey-Version` and gated on by the server.
   *  Omitted: Electron's `app.getVersion()`, else the nearest `package.json` above the entry
   *  script, with a warning when neither is found (SDK parity pass, SP-N17). */
  version?: string;
  /** Release channel; derived from `version` when omitted. */
  channel?: string;
  /** Pinned trust set (kid → raw Ed25519 pubkey base64url). The ONLY root: keys learned from
   *  a signed trust manifest extend it but never shadow it. Core-owned because it verifies
   *  license documents, config documents, trust manifests and offline bundles alike. */
  trust: { pinnedKeys: TrustSet };
  /** Refresh the signed trust manifest on Core's own cadence inside `sync()`. Defaults to
   *  true. §4.2 forbids riding a service's document fetch: a product with ANY service enabled
   *  must still advance the independent signed clock. */
  trustRefresh?: boolean;
  store?: Store;
  /** Config BASE; `<product>` is appended. Default `$XDG_CONFIG_HOME` or `~/.config` on every
   *  OS (unchanged). Holds the token, the device id and `managed.json`. */
  configDir?: string;
  /** Data BASE; `<product>` is appended. Default: XDG data on Linux,
   *  `~/Library/Application Support/polaris-key/data` on macOS,
   *  `%LOCALAPPDATA%\polaris-key\data` on Windows. Nothing is created until a consumer uses it. */
  dataDir?: string;
  /** Cache BASE; `<product>` is appended (XDG cache, `~/Library/Caches/polaris-key`,
   *  `%LOCALAPPDATA%\polaris-key\cache`). */
  cacheDir?: string;
  /** State BASE; `<product>` is appended (XDG state,
   *  `~/Library/Application Support/polaris-key/state`, `%LOCALAPPDATA%\polaris-key\state`). */
  stateDir?: string;
  fetchImpl?: typeof fetch;
  /** Per-request deadline in milliseconds (default 15000). `0` disables it. */
  requestTimeoutMs?: number;
  /**
   * What this build was compiled expecting the product to run — the D-21 fallback.
   *
   * Capability resolution is: a discovery document fetched this session, else this list, else
   * `DEFAULT_SERVICES` (license + config). It exists because discovery is a NETWORK read and
   * an offline-first client must not be told it has no license service simply because the
   * control plane is unreachable. Naming the expectation here is how a config-only or
   * release-enabled product gets the right answer with no round trip at all.
   */
  expectedServices?: ServiceSlug[];
  /**
   * This device's label (WIRE-CONTRACT-V4 §12.7.1): what the sign-in page and the customer's
   * device list call it. Omitted, the platform default (the hostname, without `.local`, `.lan` or
   * `.home`); `""` sends none. Sent on device-code sign-in, activation and registration.
   */
  deviceName?: string;
}

/** The status taxonomy every signed-document GET collapses to (§5). One shape for both
 *  documents so `sync()` can drive them through identical machinery. */
export type DocumentResult =
  | { kind: "ok"; jws: string; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "unauthorized" }
  | { kind: "device-cap"; limit?: number; deviceCount?: number }
  | { kind: "blocked"; reason: BlockReason; allowedRange?: AllowedRange }
  /** Everything else, in the one taxonomy (`./http.ts`): `network-error` with status 0 when no
   *  answer arrived, `server-error` for a 5xx, else the server's code or the status's. */
  | { kind: "error"; code: string; status: number; message: string };

/**
 * Core's live state: identity, credentials-adjacent wiring, transport, and the clock floor.
 *
 * Constructed once per client. `init()` reads the device id off the store; nothing in the
 * constructor touches the disk or the network, so a `new PolarisKeyClient(...)` that throws
 * `InsecureBaseUrlError` has done nothing else first.
 */
export class CoreContext {
  readonly product: string;
  readonly baseUrl: string;
  readonly version: string;
  readonly channel: string;
  /** Tier 1 — compiled into the host application, never mutated at runtime. */
  readonly pinnedTrust: TrustSet;
  readonly trustRefreshEnabled: boolean;
  readonly store: Store;
  /** This product's config, data, cache and state directories (P1b-09). Resolved, not
   *  created. */
  readonly dirs: ProductDirs;
  readonly requestTimeoutMs: number;
  /** Set by `./local` — every network-requiring call refuses instead of dialling out. */
  readonly localOnly: boolean;

  private readonly fetchImpl?: typeof fetch;
  private readonly expectedServices?: ServiceSlug[];
  private readonly deviceNameOption?: string;
  private discovered: ServicesMap | null = null;
  private deviceIdValue = "";

  /**
   * §4.2 monotonic time floor: `max(issuedAt)` over EVERY artifact this client has
   * re-VERIFIED — both documents AND the trust manifest. Recomputed from the cached JWSs at
   * load, never read from an unsigned field, so there is nothing on disk to edit in either
   * direction (R4-04).
   */
  private floor = 0;

  constructor(opts: CoreOptions & { localOnly?: boolean }) {
    assertProductSlug(opts.productSlug);
    this.product = opts.productSlug;
    this.deviceNameOption = opts.deviceName;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE);
    this.version = opts.version ?? resolveAppVersion();
    this.channel = opts.channel ?? channelForVersion(this.version);
    this.pinnedTrust = { ...opts.trust.pinnedKeys };
    this.trustRefreshEnabled = opts.trustRefresh !== false;
    this.dirs = resolveDirs(opts.productSlug, opts);
    this.store =
      opts.store ??
      new KeyringStore(
        opts.productSlug,
        opts.configDir ?? defaultDirBases().config,
      );
    this.fetchImpl = opts.fetchImpl;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.expectedServices = opts.expectedServices;
    this.localOnly = opts.localOnly === true;
  }

  async init(): Promise<void> {
    // The desktop file store's id is re-derived from the hardware anchor at every start;
    // a stored id that disagrees is discarded with the token and the grant slices.
    this.deviceIdValue = (
      await bindDeviceId(this.product, this.store)
    ).deviceId;
  }

  /** The label to send (§12.7.1): `override`, else the `deviceName` option, else the platform
   *  default; `null` sends none. */
  deviceLabel(override?: string): string | null {
    return resolveDeviceLabel(override, this.deviceNameOption);
  }

  get deviceId(): string {
    return this.deviceIdValue;
  }

  get highWaterMark(): number {
    return this.floor;
  }

  /** The time every gate comparison runs at: `max(systemClock, floor)`. */
  now(systemNow = nowSec()): number {
    return effectiveNow(systemNow, this.floor);
  }

  /**
   * Raise the §4.2 floor. Monotonic by construction — it only ever rises, and only from
   * content whose signature has just been checked against the pins.
   */
  raiseFloor(issuedAt: number): void {
    if (issuedAt > this.floor) this.floor = issuedAt;
  }

  /** Drop the floor to zero. Only `deactivate()` does this, and only alongside wiping every
   *  artifact the floor was derived from — a floor without its sources is a bare counter. */
  resetFloor(): void {
    this.floor = 0;
  }

  // ── Capabilities (D-21) ───────────────────────────────────────────────────────────────
  /**
   * Which services this product runs, resolved WITHOUT a network call.
   *
   * Precedence: a discovery document loaded this session > `expectedServices` > the suite
   * default (license + config). Release, Update and Identity are OFF in that default, so a
   * client that has never seen discovery and named no expectation refuses their sub-clients —
   * that is the fail-closed half of D-21. License and Config are ON, because every product has
   * run them since before the suite existed and an offline-first client must not lose its
   * license gate to an unreachable control plane.
   */
  services(): ServicesMap {
    // A fresh map every call: the exported `DEFAULT_SERVICES` is a shared constant, and a
    // caller that mutated a slice of it would silently change every client in the process.
    if (this.discovered) return copyServices(this.discovered);
    if (this.expectedServices) return servicesFromList(this.expectedServices);
    return copyServices(DEFAULT_SERVICES);
  }

  /** Install a discovery-derived capability map. Once set it wins over every fallback. */
  setServices(services: ServicesMap): void {
    this.discovered = services;
  }

  /**
   * The license GATE's input — deliberately NOT `enabled("license")`.
   *
   * `enabled()` answers "may this product call the license sub-client", and discovery wins
   * there. The gate is a security decision, and discovery is an UNSIGNED network read: a
   * network attacker answering `services.license.enabled: false` must not be able to turn a
   * licensed build into `not-applicable`. So the gate is ON when the BUILD declares the
   * license service (`expectedServices`, default license + config) OR a discovery loaded this
   * session says it is on. Unsigned discovery can switch the gate on, never off. A config-only
   * product names `expectedServices` without `license`.
   */
  licenseGateEnabled(): boolean {
    const declared = this.expectedServices
      ? this.expectedServices.includes("license")
      : DEFAULT_SERVICES.license.enabled;
    return declared || this.discovered?.license.enabled === true;
  }

  enabled(slug: ServiceSlug): boolean {
    return this.services()[slug].enabled;
  }

  /**
   * Refuse a sub-client whose service this product does not run (D-21). The refusal is the
   * typed `product` N/A (PARITY §2.2, P1b-10): an `UnsupportedError` with `feature`, `reason:
   * "product"` and `detail`, as `client.supports(feature)` reports it, keeping the code
   * `service-unavailable` that callers already match on.
   */
  requireService(slug: ServiceSlug, feature: Feature): void {
    if (!this.enabled(slug)) {
      throw new UnsupportedError(
        {
          supported: false,
          feature,
          reason: "product",
          detail: `the product does not run the ${slug} service`,
        },
        ErrorCode.serviceUnavailable,
      );
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────────────────
  /**
   * The fetch implementation, or a refusal in local-only mode.
   *
   * Refusing HERE rather than at each call site is deliberate: a transportless client must
   * fail on the attempt to dial, before a URL is built or a header is assembled, so there is
   * no path by which a local-only build performs a request its operator did not sanction.
   */
  fetcher(): typeof fetch {
    if (this.localOnly) {
      throw new PolarisError(
        "local-only",
        "This client is in local-only mode; network calls are refused.",
      );
    }
    // Every product-scoped call follows the §5 redirect rule.
    return withRedirectPolicy(this.fetchImpl ?? ((...a) => fetch(...a)));
  }

  /**
   * The bare transport, with no redirect policy: for the one public request that must follow no
   * redirect at all (the presentation icon, plans/HA-13.md §3). It refuses in local-only mode
   * exactly as `fetcher()` does.
   */
  plainFetcher(): typeof fetch {
    if (this.localOnly) {
      throw new PolarisError(
        "local-only",
        "This client is in local-only mode; network calls are refused.",
      );
    }
    return this.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** A fresh deadline for one request. */
  deadline(): AbortSignal | undefined {
    return this.requestTimeoutMs > 0
      ? AbortSignal.timeout(this.requestTimeoutMs)
      : undefined;
  }

  /**
   * One request under the taxonomy's transport rule (SP-46, `./http.ts`): a request that gets
   * no answer (refused, reset, DNS, the deadline) throws `PolarisError("network-error")` with
   * the failure as its `cause`, never a raw `TypeError`. `fetcher()`'s local-only refusal
   * propagates unchanged, before anything is sent.
   *
   * The deadline applies unless `init` names its own `signal` (a download passes the caller's,
   * or `undefined` for none). When that caller's signal aborted, its reason is rethrown as is:
   * a cancellation is the caller's own doing, not a network failure.
   */
  async request(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Response> {
    const f = this.fetcher();
    const own = "signal" in init;
    try {
      return await f(url, own ? init : { ...init, signal: this.deadline() });
    } catch (e) {
      if (own && init.signal?.aborted) throw e;
      throw transportError(e, what);
    }
  }

  /** The `X-PKey-*` client metadata every product-scoped call carries (§5). Platform and arch
   *  are the canonical values of WIRE-CONTRACT-V3 §5.2, mapped from `os.platform()` and
   *  `os.arch()`; a spelling with no value omits its header rather than inventing one. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const platformValue = canonicalPlatform(platform());
    const archValue = canonicalArch(arch());
    return {
      [HEADER_DEVICE]: this.deviceIdValue,
      [HEADER_VERSION]: this.version,
      [HEADER_CHANNEL]: this.channel,
      ...(platformValue !== null ? { [HEADER_PLATFORM]: platformValue } : {}),
      ...(archValue !== null ? { [HEADER_ARCH]: archValue } : {}),
      [HEADER_SDK_NAME]: SdkId.node,
      [HEADER_SDK_VERSION]: SDK_VERSION,
      ...extra,
    };
  }

  /** `<baseUrl>/<product>/<path>`. */
  url(path: string): string {
    return `${this.baseUrl}/${this.product}/${path}`;
  }

  /**
   * GET one signed document with conditional-request support, mapping the whole §5 status
   * taxonomy. Shared verbatim by `/license/document` and `/config/document`, so the two can
   * never drift on what a 403, a 429 or a dropped connection means — and so that adding a
   * third signed document later is a route string, not another status ladder.
   *
   * Verification is emphatically NOT here: this returns the raw compact JWS and lets `sync()`
   * hand it to client-core with the right trust set and anti-replay floor. An HTTP layer that
   * verified would be an HTTP layer that could be talked into not verifying.
   */
  async getDocument(
    path: string,
    token: string,
    etag?: string,
  ): Promise<DocumentResult> {
    const f = this.fetcher();
    const headers = this.headers({ authorization: `Bearer ${token}` });
    if (etag) headers["if-none-match"] = etag;

    let res: Response;
    try {
      res = await f(this.url(path), { headers, signal: this.deadline() });
    } catch (e) {
      return {
        kind: "error",
        code: e instanceof PolarisError ? e.code : ErrorCode.networkError,
        status: 0,
        message: transportError(e, path).message,
      };
    }

    switch (res.status) {
      case 304:
        return { kind: "not-modified" };
      case 401:
        return { kind: "unauthorized" };
      case 429: {
        const body = (await res.json().catch(() => ({}))) as {
          limit?: number;
          deviceCount?: number;
        };
        return {
          kind: "device-cap",
          limit: body.limit,
          deviceCount: body.deviceCount,
        };
      }
      case 403: {
        // v3 nests the machine-readable code and keeps `allowedRange` at the top level
        // (§5/R4). `reason` rides inside the error object so a client can still tell too-old
        // from too-new; a body that predates the nesting is read at the top level too, and a
        // body that says nothing at all falls back to the stricter of the two.
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; reason?: BlockReason };
          reason?: BlockReason;
          allowedRange?: AllowedRange;
        };
        const reason =
          body.error?.reason ??
          body.reason ??
          (body.error?.code === "channel_not_allowed"
            ? "channel-not-entitled"
            : "version-too-old");
        return { kind: "blocked", reason, allowedRange: body.allowedRange };
      }
      case 200: {
        let jws: string;
        try {
          jws = await res.text();
        } catch (e) {
          return {
            kind: "error",
            code: ErrorCode.networkError,
            status: 0,
            message: transportError(e, path).message,
          };
        }
        return { kind: "ok", jws, etag: res.headers.get("etag") };
      }
      default: {
        const c = await classifyResponse(res);
        return {
          kind: "error",
          code: c.code,
          status: res.status,
          message: c.message ?? `${path} failed with status ${res.status}.`,
        };
      }
    }
  }
}
