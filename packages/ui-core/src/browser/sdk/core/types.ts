// The shared, mode-agnostic surface. Every type here is identical across the browser
// and desktop adapters — this is what makes the hooks return the same shapes regardless
// of transport (mode-parity). The adapters differ only in HOW they fill a `PolarisState`.
//
// The GATE is not defined here any more: `@polaris-key/client-core` owns the one implementation every
// JS SDK runs (wire contract v3 §5), including the monotonic clock floor this package's old
// local port silently dropped. Both adapters reduce their transport to the same
// `client-core` `GateInput` and run the same `licenseState`.

import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import type { LinkClient } from "./link.js";
import type {
  ActivationSource,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@polaris-key/protocol/license";
import type {
  ConfigSource,
  LicenseState,
  Support,
  Unsupported,
} from "@polaris-key/client-core";
import type {
  StagedUpdate,
  UpdateCheck,
  UpdateDecision,
} from "@polaris-key/protocol/update";
import type { ProductCatalog } from "@polaris-key/catalog";
// `services.ts` imports only the `PolarisError` TYPE from this module, and `import type` is
// erased, so this value import creates no runtime cycle.
import { noBusy, noErrors } from "./services.js";
import type { ActivationOutcome, KeyEntries } from "./activation.js";
import type { BootAttempt } from "./bootGuard.js";
import type { ChoiceNamespace } from "./choice.js";
import type {
  AutoSignInOptions,
  AutoSignInResult,
  SignInNamespace,
} from "./signIn.js";
import type { BootResult, BootRunOptions } from "./boot.js";
import type { CrashTags, CrashTagsOptions } from "./crash.js";
import type { UpdateEvent } from "../constants.generated.js";
import type { UpdateEventEntry, UpdateEventInput } from "./updateEvents.js";
import type { InstallOptions, InstallOutcome } from "./install.js";
import type { BridgeHost, KitView } from "../desktop/bridge.js";
import type {
  FetchTarget,
  ReleaseFetchOptions,
  ReleaseFetchResult,
} from "../browser/releaseFetch.js";
import type { DownloadModel, ThisPlatform } from "../browser/distribution.js";
import type { ErrorCode } from "../constants.generated.js";
import type {
  ServiceBusyMap,
  ServiceErrorMap,
  ServiceSlug,
  ServicesMap,
} from "./services.js";

/** Which transport an adapter speaks. `auto` resolves at construction time. */
export type PolarisMode = "browser" | "desktop" | "local";

/** The phase of the very first load — distinct from a license `status`. Until the first
 *  snapshot resolves we render a loading screen, not a (misleading) `needs-activation`. */
export type PolarisPhase = "loading" | "ready";

/** Stable error codes surfaced by adapter operations. These describe what the UI should DO,
 *  which is why they are not `@polaris-key/protocol`'s wire codes: `device-management-unsupported`
 *  is a capability statement, not an HTTP status. */
export type PolarisErrorCode =
  | "key-entry-unsupported"
  | "device-management-unsupported"
  | "service-disabled"
  | "sign-in-failed"
  | "sign-out-failed"
  | "refresh-failed"
  | "network"
  | "bridge-missing"
  | "release-refused"
  | "bundle-rejected"
  | "bundle-import-unsupported"
  | "report-unsupported"
  /** The feature is not supported here (PARITY §2.2): an `UnsupportedError` carrying
   *  `feature`, `reason` and `detail`, as `supports()` reports it. */
  | "unsupported"
  // ── wire v4 update decisions (WIRE-CONTRACT-V4 §2.5's error map) ──
  /** Discovery lacks `update.endpoints.feed` or `release.endpoints.record` (an older Worker,
   *  or Update off): fall back to `checkUpdate()`. */
  | "service-unavailable"
  /** `decideUpdate()` without pinned release keys (or pinned product keys in a browser). */
  | "not-configured"
  /** A pinned release key that is also a trust pin, or a host outlet outside the vocabularies:
   *  raised when the adapter is constructed. */
  | "invalid-options"
  /** A fetched feed refused at steps 3–7 with nothing committed to decide from; `detail`. */
  | "feed-rejected"
  | "feed-rollback"
  | "record-rejected"
  | "record-mismatch"
  | "unknown"
  /** Any other registered code (conformance/parity/errors.json): bearer mode surfaces the
   *  server's code as-is when the registry holds it (`forbidden`, `rate_limited`, `not_found`,
   *  `no-token`, `store-failed`, …). Still closed over the registry. */
  | ErrorCode;

/** Loopback hosts keep `http:` usable for `wrangler dev` and integration tests; nothing else may
 *  carry a session cookie or a device bearer, or receive a user the SDK sent there. Mirrors
 *  `@polaris-key/node`'s `LOOPBACK_HOSTS`: four SDKs, one rule. A `Set`, not an object literal:
 *  a hostname is attacker-influenced text, and `{}["constructor"]` is truthy. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The one transport-security predicate this package enforces: `https:`, or `http:` on loopback.
 * Everything the SDK talks to (`BrowserAdapter`'s `baseUrl`) and every link it hands the browser
 * (`safeLink`) is checked against it, so a plaintext origin and a `javascript:` URL are refused
 * by the SAME rule rather than by two that can drift.
 *
 * A malformed URL is not secure: `new URL()` throwing is a refusal, not an exception to
 * propagate.
 */
export function isSecureTransportUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  );
}

/** One user-facing config row for a settings UI: `hidden` keys are excluded entirely, and
 *  `enforced` flags whether the row should render read-only (server value wins). */
export interface UserConfigEntry {
  key: string;
  value: JSONValue;
  enforced: boolean;
}

export interface DeviceInfo {
  id: string;
  current: boolean;
  status: LicenseStatus;
  licenseId?: string;
  profile?: DocProfile;
  /** When the device was last verified or seen, epoch SECONDS. */
  lastVerifiedAt?: number;
  /** Operator-set label, when the backend supports device management. */
  label?: string | null;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

/** The newest build on a channel, as `GET /<product>/update/version` reports it. Mirrors
 *  `@polaris-key/node`'s `VersionCheck` field for field. */
export interface VersionCheck {
  version: string;
  tag: string;
  url: string;
  /** Whether the HOST APPLICATION's version is older than `version` (never the SDK's — the
   *  SDK ships inside the thing being updated). */
  updateAvailable: boolean;
}

/** One published release, as `GET /<product>/release/changelog` reports it. Mirrors
 *  `@polaris-key/node`'s `ChangelogEntry` field for field. */
export interface ChangelogEntry {
  version: string;
  tag: string;
  /** ISO-8601 publication time, or null for an undated release. */
  date: string | null;
  /** The curated summary, or null when the release body yielded none. */
  summary: string | null;
  url: string;
}

/** Flags for `downloadUrl` — the same two `@polaris-key/node`'s `downloadUrl` takes. */
export interface DownloadUrlOptions {
  /** Ask for the artifact's sha256 digest instead of the artifact (`?checksum=sha256`). */
  checksum?: boolean;
  /** The `.dmg` variant of the artifact. */
  dmg?: boolean;
}

/** What an offline bundle import landed (wire contract v3 §7). Mirrors `@polaris-key/node`'s
 *  `ImportBundleResult`. `license` present ⇒ the gate is now activated by bundle. */
export interface ImportBundleResult {
  bundleId: string;
  imported: ("license" | "config")[];
}

/** A typed error every adapter throws so callers can branch on `.code` not on strings.
 *
 *  `code` is the UI vocabulary above. `wireCode`, when present, is the code the OTHER side
 *  named: the refusal body's own code for a `release-refused` release read (`unauthorized`,
 *  `channel_not_allowed`, …), the §7 step for a `bundle-rejected` import
 *  (`bundle-claims-rejected`, …). It is the value the other SDKs put in their own `code`. */
export class PolarisError extends Error {
  readonly code: PolarisErrorCode;
  readonly wireCode?: string;
  /** The refused step, for `feed-rejected` (`jws`, `claims`, `channel`, `selector`,
   *  `freshness`): the `detail` of WIRE-CONTRACT-V4 §2.5's error map. */
  readonly detail?: string;
  /** On a device-limit refusal (PX-W8): the customer-portal link that frees a seat, already
   *  validated (`readManageUrl`). Show it behind a user action; it is not an auth failure. */
  readonly manageUrl?: string;
  /** An activation or enrolment refusal, classified (SDK-PARITY-PASS §3.1): the kind, the
   *  server's code, and `limit`/`deviceCount`/`retryAfterSeconds` where the server sent them.
   *  Present on the `sign-in-failed` a key submission throws. */
  readonly activation?: ActivationOutcome;
  /** The HTTP status behind the refusal, when there was one. */
  readonly status?: number;
  /** On a `rate_limited` refusal: the seconds the Worker asked the caller to wait. */
  readonly retryAfterSeconds?: number;
  constructor(
    code: PolarisErrorCode,
    message?: string,
    wireCode?: string,
    detail?: string,
    extra: {
      activation?: ActivationOutcome;
      status?: number;
      manageUrl?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message ?? code);
    this.name = "PolarisError";
    this.code = code;
    if (wireCode !== undefined) this.wireCode = wireCode;
    if (detail !== undefined) this.detail = detail;
    if (extra.activation !== undefined) this.activation = extra.activation;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = extra.retryAfterSeconds;
    const manageUrl = extra.manageUrl ?? extra.activation?.manageUrl;
    if (manageUrl !== undefined) this.manageUrl = manageUrl;
  }
}

/** What a key activation answered on success (identity.keyentry): the licence's key entries,
 *  or `null` with Identity off. A refusal throws `sign-in-failed` whose `activation` is the typed
 *  outcome (`keyEntryLimit` with `manageUrl` and `keyEntries`, `licenseOwned` with `signInUrl`);
 *  neither clears the device's token, cache or store. */
export interface KeyActivation {
  keyEntries: KeyEntries | null;
}

/** `signOut()`'s answer: `released` is true when the server freed this device (the token is
 *  gone), false when the device keeps its key activation and only the account is forgotten. */
export interface SignOutResult {
  released: boolean;
  /** The sign-out itself completed, but the browser could not store the "signed out" flag, so
   *  only this page remembers it: a reload may sign in again silently. */
  warning?: "sign-out-flag-not-saved";
}

/** `attach({confirm})`'s typed answer (identity.attach). A refusal is a result, never a throw: it
 *  keeps the token, the cache and the subject (`code` is the server's: `account_required`,
 *  `license_owned`, `license_email_bound`, `not_found`, `unauthorized`). */
export type AttachResult =
  | {
      kind: "confirm";
      license: { id: string; tierId: string | null; name: string | null };
    }
  | { kind: "ok"; subject: string | null; attached: "claimed" | null }
  | { kind: "refused"; code: string; status: number };

/** What `decideUpdate()` takes: the same three arguments as `@polaris-key/node`'s
 *  `client.update.decide()`. */
export interface UpdateDecideOptions {
  /** The channel to ask about, as the host names it (an alias such as `latest` is fine: the
   *  feed's own `channel` claim comes back as `UpdateCheck.channel`). Defaults to `stable`. */
  channel?: string;
  /** An update the host staged and verified, under the `UpdateCheck.channel` it was staged on. */
  staged?: StagedUpdate | null;
  /** The version the boot guard rolled back. */
  skipVersion?: string | null;
}

/** The two documents a snapshot is projected from. v3 split the fused v2 artifact in two:
 *  grants ride the LICENSE document, settings ride the CONFIG document. A transport that
 *  still receives them fused (the browser identity session) splits them at its own edge. */
export interface PolarisDocs {
  license: LicenseDoc | null;
  config: Record<string, ManagedEntry>;
}

/** The single immutable snapshot the store holds and every hook reads from. Both adapters
 *  produce exactly this shape. */
export interface PolarisState {
  /** First-load phase. `loading` until the adapter resolves its first snapshot. */
  phase: PolarisPhase;
  /** The transport that produced this state. */
  mode: PolarisMode;
  /** The full gate result (status + grace/version metadata), from `@polaris-key/client-core`. */
  gate: LicenseState;
  /** Convenience mirror of `gate.status`. */
  status: LicenseStatus;
  /** How this install became activated, or `null`. Replaces v2's `hasToken` boolean: an
   *  air-gapped install activated from a signed bundle is activated too (§7). */
  activation: ActivationSource | null;
  /**
   * §4.2's monotonic clock floor, in epoch SECONDS: `max(issuedAt)` over the verified
   * artifacts this client holds. The gate evaluates at `max(now, highWaterMark)`, which makes
   * a wound-back system clock inert. `0` when nothing signed has been seen yet.
   */
  highWaterMark: number;
  /** What the product runs, per D-21. Discovery when it answered; the host's `expectedServices`
   *  (default: license + config) when it did not. Never all-true. */
  capabilities: ServicesMap;
  /** The signed profile (name/email), once a license document is present. */
  profile: DocProfile | null;
  /** Device id from the verified document, once a device-bound document is present. */
  currentDeviceId: string | null;
  /** License id from the verified document, once present. */
  licenseId: string | null;
  /** Plaintext config, RESOLVED to effective values (key → value): per-key precedence is
   *  `enforced|hidden` (remote, locked) > `local` override > `remote-default` > fallback.
   *  This is the map every existing hook/getter reads, so it stays effective, not raw. */
  config: Record<string, JSONValue>;
  /** The raw config entries off the config document (state + value + updatedAt), kept so
   *  provenance (`getConfigSource`) and enumeration (`listUserConfig`) can be derived. */
  configEntries: Record<string, ManagedEntry>;
  /** The client-supplied local/user overrides applied to `default`-state keys (never to
   *  `enforced`/`hidden`). Frozen onto the snapshot so reads are pure. */
  localOverrides: Record<string, JSONValue>;
  /** Capability map (entitlement name → value), off the LICENSE document (D-20). */
  entitlements: Record<string, JSONValue>;
  /** Per-service in-flight flags. A config refresh no longer greys out the sign-out button. */
  busy: ServiceBusyMap;
  /** Per-service last error (cleared on that service's next successful op). */
  error: ServiceErrorMap;
}

/** A device sign-in handle the desktop adapter returns from `signInWithOidc` so a caller
 *  can render the verification URL/code while polling completes in the background. */
export interface OidcSignInHandle {
  /** The URL to open (desktop: a device/verification URL; browser: never returned —
   *  the browser adapter navigates the page instead). */
  verificationUrl?: string;
  /** Optional user code to display alongside the URL. */
  userCode?: string;
  /** The bare verification page, for typing the code by hand (additive; absent from older
   *  hosts). */
  verificationUri?: string;
  /** Epoch seconds the code expires at, on this client's clock (additive). */
  expiresAt?: number;
  /** Stop waiting for the sign-in: polling ends and nothing is reported as an error. Absent
   *  from a host that cannot stop the wait (additive). */
  cancel?: () => void;
}

/** A short-lived token edge-mint signed for a third-party API (config.mint). Memory only. */
export interface MintedToken {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** One store product a licence's commerce binding sells (commerce.receipt, P6-01). */
export interface CommerceProduct {
  store: string;
  productId: string;
  flag: string;
  deliverable: string;
}

export interface CommerceBinding {
  /** Hand this to the store BEFORE buying (App Store `appAccountToken`, Play
   *  `obfuscatedAccountId`, Steam `GetAuthTicketForWebApi` identity). */
  bindingId: string;
  products: CommerceProduct[];
}

/** SDK-PARITY-PASS §3.9's claim result. On `ok` the adapter has already synced. */
export type CommerceClaimResult =
  | {
      kind: "ok";
      store: string;
      productId: string;
      flag: string;
      deliverable: string;
      state: string;
      granted: boolean;
      changed: boolean;
    }
  | { kind: "notOwned"; code: string; reason: string; status: number }
  | { kind: "attestationRequired"; code: string; status: number }
  | { kind: "refused"; code: string; reason?: string; status: number };

export type CommerceStore = "app-store" | "play" | "steam";

export type CommercePayload =
  | { signedTransaction: string }
  | { productId: string; purchaseToken: string }
  | { ticket: string; dlcAppId: string | number };

/** The native updater feeds `feedUrl()` names (SDK-PARITY-PASS §3.7). */
export type FeedKind =
  | "appcast"
  | "winsparkle"
  | "velopack"
  | "appInstaller"
  | "zsync";

/** `feedUrl()`'s options: the channel (aliases rewrite to their canonical channel first), the
 *  Velopack channel (without one the answer is the feed directory) and the AppImage build id. */
export interface FeedUrlOptions {
  channel?: string;
  velopackChannel?: string;
  buildId?: string;
  arch?: string;
}

/** `feedUrl()`'s answer: the URL, or the typed reason there is none (PARITY §2.2). */
export type FeedUrl = { supported: true; url: string } | Unsupported;

/** How a browser adapter authenticates (SDK-PARITY-PASS §3.17). */
export type BrowserAuthMode = "cookie" | "bearer";

/** The unified transport contract. The hooks ONLY ever talk to this — they never know
 *  which mode is active. Both `browserAdapter` and `desktopAdapter` implement it. */
export interface PolarisAdapter {
  readonly mode: PolarisMode;
  /**
   * Whether a parity feature works through this adapter, and if not why (PARITY §2.2): offline,
   * synchronous and side-effect free, from the generated capability table, this adapter's
   * runtime (`web` or `desktop-bridge`) and its current capability map. `reason` is `runtime`
   * (this transport cannot do it), `product` (the owning service is off) or `version` (this SDK
   * does not implement it yet, or does not know the id).
   */
  supports(feature: string): Support;
  /** The feature ids `supports()` answers Supported for, in registry order. */
  caps(): string[];
  /** The current state, synchronously (the store seed + every read). */
  snapshot(): PolarisState;
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(cb: (state: PolarisState) => void): () => void;
  /** Re-pull the license/config from the source of truth and re-apply. */
  /** Re-read the state from the transport. An automatic caller (a timer) passes nothing and
   *  stays off the network while the transport backs off; a person's retry passes
   *  `force: true` and goes through. */
  refresh(opts?: { force?: boolean }): Promise<void>;
  /** Begin an OIDC sign-in. Desktop returns a verification handle; browser navigates
   *  the page (and never resolves, since the page unloads). */
  signInWithOidc(): Promise<OidcSignInHandle | void>;
  /** Activate with a typed key using the active transport. */
  submitKey(key: string): Promise<void>;
  /** `submitKey`'s SDK-named form (license.activateWithKey): resolves with the licence's
   *  `keyEntries`; a refusal throws `sign-in-failed` with the typed `activation` (see
   *  {@link KeyActivation}). */
  activateWithKey(key: string): Promise<KeyActivation>;
  /** Sign out. With the product's account endpoints (discovery's `identity.endpoints.signout`),
   *  after the {@link onBeforeSignOut} hooks, it asks the server to release this device;
   *  without them it deauthorizes and wipes local state, as it always did. */
  signOut(): Promise<SignOutResult>;
  /** The account this device's licence is in (a pairwise `ps_` subject), or `null`. Bearer and
   *  desktop modes; a cookie page, or a product with no account endpoint, throws the typed
   *  `UnsupportedError`. */
  subject(): Promise<string | null>;
  /** `attach({confirm: false})` previews the device's licence, `{confirm: true}` puts it in the
   *  signed-in account. Typed `UnsupportedError` where the transport or product cannot. */
  attach(opts: { confirm: boolean }): Promise<AttachResult>;
  /** The licence choice an app shows itself after `signIn` answered `choose` (identity.choice).
   *  Bearer mode; a cookie page and the desktop renderer throw the typed `UnsupportedError`. */
  readonly choice: ChoiceNamespace;
  /** The link offer after a redirect sign-in (identity.link). Present on the browser adapter
   *  (typed `unavailable` where the page has no bearer session); absent elsewhere, which the kit
   *  reads as no offer. */
  readonly link?: LinkClient;
  /** The automatic sign-in ladder (identity.autosignin): a stored token, then the platform
   *  provider silently, then (only with `prompt: "optional"`) its chooser. Bearer mode runs it;
   *  the desktop renderer, a cookie page and the local adapter answer `unavailable`. */
  autoSignIn(opts?: AutoSignInOptions): Promise<AutoSignInResult>;
  /** Open the product's page in the customer portal (discovery's `accountPortal`). Typed
   *  `UnsupportedError` when the product names none. */
  openAccount(): Promise<void>;
  /** Register a function `signOut()` awaits first (Cloud Sync's flush). Returns the remover. */
  onBeforeSignOut(hook: () => Promise<void> | void): () => void;
  /** The current device, when the active session has a verified device-bound document. */
  currentDevice(): DeviceInfo | null;
  /** List account/license devices when supported by the backend. */
  listDevices(): Promise<DeviceInfo[]>;
  /** Rename a device. Throws `device-management-unsupported` where the transport cannot. */
  renameDevice(deviceId: string, label: string | null): Promise<void>;
  /** Deauthorize a device. */
  deauthorizeDevice(deviceId: string): Promise<void>;
  /** `GET /<product>/update/version` for the requested channel. Throws `service-disabled`
   *  when the product does not run the Update service. */
  checkUpdate(opts?: { channel?: string }): Promise<VersionCheck>;
  /**
   * The wire v4 update decision (WIRE-CONTRACT-V4 §2.5, plans/P3-01.md §2.8): the signed feed
   * and the pinned release record, verified, then `decideUpdate`. Browser: fetched, verified and
   * persisted in-page through `@polaris-key/client-core`. Desktop: the bridge's
   * `invoke("update", "decide", opts)`, which the host answers with `client.update.decide()`.
   * Throws `service-unavailable` when discovery lacks the v4 endpoints (fall back to
   * `checkUpdate()`), `not-configured` without pinned release keys, and the §2.5 code when
   * there is nothing committed to decide from.
   */
  decideUpdate(opts?: UpdateDecideOptions): Promise<UpdateCheck>;
  /** The download URL of one build of a release, from discovery's
   *  `distribution.endpoints.builds` template (`{selector}` = the version, `{buildId}` = the
   *  build id), or null when discovery has none. Optional: the desktop bridge has no such verb. */
  buildUrl?(version: string, buildId: string): Promise<string | null>;
  /** Device-local overrides (`config.local`): `set`, `clear`, `clearAll`, `setting`,
   *  `onConfigChange`. Browser: persisted in `localStorage` per product (memory when storage is
   *  unusable, which `persistent()` reports). Desktop: forwarded to the host's `client.config`
   *  over bridge v4; a v3 host refuses writes with the typed `UnsupportedError`. */
  readonly config: import("./localConfig.js").LocalConfig;
  /** Read a single config value with a fallback, honoring v3 state + local overrides:
   *  `enforced`/`hidden` → remote value (locked); else `localOverrides[key] ?? remote ?? fallback`. */
  getConfig<T = JSONValue>(key: string, fallback: T): T;
  /** Enumerate config for a settings UI: every key EXCEPT `hidden`, each resolved to its
   *  effective value with an `enforced` flag (true ⇒ render read-only, server value wins). */
  listUserConfig(): UserConfigEntry[];
  /** Where the effective value for `key` comes from (provenance), for diagnostics/UI. */
  getConfigSource(key: string): ConfigSource;
  /** Read a single secret value. Neither transport can: secrets are never delivered to a
   *  browser session or a renderer (`config.secret` is a `runtime` N/A on `web` and
   *  `desktop-bridge`), so both throw `UnsupportedError` (code `unsupported`). The return type is
   *  kept for source compatibility. */
  getSecret(key: string): string | null;
  /** True when a boolean entitlement is granted. */
  isEntitled(name: string): boolean;
  /** The channels the licence grants: the `channels` entitlement's string values in order, or
   *  `["stable"]` when it is absent or not an array — the Worker's answer, and every SDK's. */
  entitledChannels(): string[];
  /** `GET /<product>/config/schema` — the product's active config catalog, or `null` on ANY
   *  failure. Unsigned and diagnostic: it never throws, and a product without Config is not
   *  even probed (D-21). Desktop: the bridge's `fetchSchema`. */
  fetchSchema(): Promise<ProductCatalog | null>;
  /** `GET /<product>/release/changelog`, newest first. Throws `service-disabled` when the
   *  product does not run Release, `release-refused` (with the refusal's `wireCode`) for a 401 or
   *  403. Desktop: `invoke("release", "changelog")`. */
  changelog(): Promise<ChangelogEntry[]>;
  /** The canonical install-script URL. Built, not fetched. */
  installUrl(): Promise<string>;
  /** The artifact URL `/<product>/release/dl/:version/:binary-:arch[.dmg][?checksum=sha256]`.
   *  Built, not fetched: the caller streams it. */
  downloadUrl(
    version: string,
    binary: string,
    arch: string,
    opts?: DownloadUrlOptions,
  ): Promise<string>;
  /** Import an offline activation bundle (§7). All-or-nothing: a refusal (`bundle-rejected`,
   *  `wireCode` = the step that refused) changes nothing. A bundle carrying a licence leaves the
   *  gate at `activation: "bundle"`. Desktop: the bridge's `importBundle` (protocol v3);
   *  browser: verified in-page and kept in IndexedDB. */
  importBundle(jws: string): Promise<ImportBundleResult>;
  /** Post device telemetry now (`POST /<product>/devices/report`). Desktop only, through
   *  `invoke("devices", "report")`; a browser holds no device bearer, so it throws
   *  `report-unsupported` (a registered runtime N/A). */
  report(): Promise<boolean>;
  /**
   * Journal one update-health event (telemetry.updates, SDK-PARITY-PASS §3.13) for the next
   * device report, which carries at most 16, oldest first. `event` is a P6-03 name
   * (`UpdateEvent`); the adapter fills in the id, the outlet, the channel (unless given) and the
   * time. Resolves to the journalled entry, or null when a value was malformed (the event is not
   * recorded). Browser: bearer mode's in-page journal; a cookie page holds no device token and
   * throws the typed `UnsupportedError` (`runtime`). Desktop: forwarded to the host's journal
   * over bridge v4 (`invoke("update", "journal", {event, ...input})`); an older host answers
   * the typed `version` N/A.
   */
  recordUpdateEvent(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): Promise<UpdateEventEntry | null>;
  // ── SDK parity pass additions. Every adapter implements every verb; a transport that cannot
  //    serve one throws the typed `UnsupportedError` (PARITY §2.2), never a missing method. ──
  /** `POST /<p>/license/enroll`: a free licence with no key, when the product offers one, then a
   *  sync. Throws `sign-in-failed` with the §3.1 `activation` on a refusal. */
  enroll(): Promise<void>;
  /** `signIn.start(opts)` (identity.signIn): a device-code session (browser bearer mode: the
   *  CORS-covered device-code routes; desktop: the bridge's `beginSignIn`/`pollSignIn`) or a web
   *  redirect session (bearer mode), and `signIn.complete(callbackUrl)` after the navigation
   *  back. A cookie page refuses with the typed `UnsupportedError`. */
  readonly signIn: SignInNamespace;
  /**
   * The Cloud Sync key ring (sync.keyring, WIRE-CONTRACT-V5 §13.11): create, unlock with the
   * recovery code, set a new code, reset, and wrap the root to another device. Browser bearer
   * mode runs it in-page. A cookie page, the desktop bridge (until the host serves a ring verb)
   * and the local adapter answer the typed `UnsupportedError`; `unsupported` says which.
   */
  readonly keyring: import("./keyring.js").KeyringClient;
  /**
   * Cloud Sync for settings (sync.settings, WIRE-CONTRACT-V5 section 13.10): the host that runs the
   * sync machine, its state in IndexedDB with one writer tab. Browser bearer mode runs it. A cookie
   * page, the desktop bridge (until bridge v4 carries the verbs) and the local adapter answer the
   * typed `UnsupportedError`; `unsupported` says which.
   */
  readonly cloudSync: import("./cloudSync.js").CloudSyncClient;
  /**
   * Cloud Connect over the relay (connect.app, WIRE-CONTRACT-V5 §15.7): start, stop, peers,
   * open a session to another device of the person, and the channels and notices that arrive.
   * Browser bearer mode runs it (the relay is a page's only path). A cookie page and the local
   * adapter answer the typed `UnsupportedError`; the desktop renderer's host runs it in its Node SDK.
   */
  readonly cloudConnect: import("../browser/connect/index.js").CloudConnectClient;
  /** Edge-mint a short-lived third-party token (config.mint). Memory-cached per device token. */
  mintToken(recipeId: string): Promise<MintedToken>;
  /** The licence's commerce binding (commerce.receipt). */
  commerceBinding(): Promise<CommerceBinding>;
  /** Forward one store purchase; on `ok` the flag arrives with the sync the adapter runs. */
  commerceClaim(
    store: CommerceStore,
    payload: CommercePayload,
  ): Promise<CommerceClaimResult>;
  /** The verified discovery document, once it answered (null before, or on a failure). */
  discovery(): Promise<Record<string, unknown> | null>;
  /**
   * Discovery's `core.presentation` (core.presentation, HA-13): client-core's
   * `PresentationSource` seam the UI kits read (the product's name, developer, accents and
   * verified icon), plus `iconUrl()`, a `blob:` URL of the icon. Browser: parsed from this page's
   * discovery, the icon fetched and verified in-page. Desktop: the host's Node client answers
   * (`invoke("core", "presentation")`), so the renderer reuses its cache. Never throws; no
   * presentation reads as `current() === null`.
   */
  presentationSource(): import("./presentation.js").ReactPresentationSource;
  /** The id an operator mints an offline bundle against (`OfflineActivation`), or null where
   *  this transport keeps none. */
  offlineDeviceId(): Promise<string | null>;
  /** Where the device credential lives, and why if that is weaker than this platform's best
   *  (core.store). Null where the transport holds no credential (the cookie session). */
  storeStatus(): Promise<import("@polaris-key/client-core").StoreStatus | null>;
  // ── SP-12: boot, the verified download, the download model, feed URLs, crash tags ──
  /**
   * One-call boot (ui.boot, SDK-PARITY-PASS §3.4): discovery, the keyless registration of a
   * fresh install on an `open` product, the sync (trust, documents, report), the reacquire per
   * `core.registration`, the gate, the update decision and the required packs, through
   * client-core's stage machine to its outcome. Never prompts: a gate that needs the player
   * ends `waiting`. Browser: in-page (the bearer engine, or the cookie session). Desktop: the
   * host's `client.boot()` over bridge v4 (`invoke("core", "boot")`), refused typed (`version`)
   * on an older host.
   */
  boot(opts?: BootRunOptions): Promise<BootResult>;
  /**
   * The verified download (release.fetch, §3.6): one build's payload with the device bearer,
   * resumed with `Range`/`If-Range` after an interruption, its size and SHA-256 checked against
   * the verified release record before it is returned. Browser: a `Blob`, in bearer mode (a
   * cookie page holds no device bearer; a build that needs none still downloads). Desktop: the
   * host's `client.release.fetch(target, {to})` over bridge v4, which writes the file in the
   * privileged process and answers its `path` (no `blob`).
   */
  releaseFetch(
    target: FetchTarget,
    opts?: ReleaseFetchOptions & { to?: string },
  ): Promise<ReleaseFetchResult>;
  /** The public download model (release.distribution, §3.8): `GET /<p>/distribution/
   *  download.json`. Desktop: the host's `client.distribution.downloadModel()` over bridge v4. */
  downloadModel(opts?: { channel?: string }): Promise<DownloadModel>;
  /** This platform's group of the download model, the primary action first (the visitor's OS on
   *  a page; the host's platform on desktop), unless `platform` is given. */
  thisPlatform(opts?: {
    channel?: string;
    platform?: string;
  }): Promise<ThisPlatform>;
  /** A native updater feed URL (update.feeds, §3.7). Desktop: the host's
   *  `client.update.feedUrl(kind, opts)` over bridge v4. Browser: the typed runtime N/A (a page
   *  has no native updater; its service worker is update.driver). Never throws for a missing
   *  feed: the answer is the typed `Unsupported`. */
  feedUrl(kind: FeedKind, opts?: FeedUrlOptions): Promise<FeedUrl>;
  /** The crash-reporter tags (crash.tags, §3.14): `release` `<deliverable>@<version>[+<build>]`,
   *  `environment` the channel, `pkey.outlet` the outlet, as the Worker's Sentry hook parses
   *  them. Desktop: the host's `client.crashTags()` over bridge v4. */
  crashTags(opts?: CrashTagsOptions): Promise<CrashTags>;
  /**
   * The headers for the app's own backend (`client.backend.headers()`, WIRE-CONTRACT-V4 §14.5):
   * `X-PKey-License`, the signed licence document (when one is held), and `X-PKey-Device`.
   * A document within the refresh margin of its expiry is synced first, and concurrent callers
   * share that sync; `force` syncs unconditionally and throws when the sync fails. Never the
   * device token or the config document. Raw: use `usePolarisFetch()` to send them. Browser:
   * bearer mode (a cookie page holds no signed document and throws the typed
   * `UnsupportedError`). Desktop: the host's `client.backend.headers()` over bridge v4
   * (`invoke("core", "backendHeaders")`).
   */
  backendHeaders(opts?: {
    force?: boolean;
    /** The origin the headers are for. Desktop passes it to the host, which refuses one outside its
     *  `backend.origins`. */
    origin?: string;
  }): Promise<Record<string, string>>;
  /**
   * Install what a decision offers (update.driver, SDK-PARITY-PASS §3.16): answers an
   * `InstallOutcome` and never throws for something that cannot be installed (it answers
   * `unsupported{reason}`). Browser: a decision whose build is a newer one this page already
   * holds as a waiting service worker hands off to it (`skipWaiting`, then a reload, after
   * sending the bearer journal) and answers `handedOff`, or `restartRequired` with `reload:
   * false`; a worker that has not taken control within 15 s is `unsupported{dependency}`.
   * Desktop: the host's install driver, over bridge v4 (`invoke("update", "install",
   * {decision})`), `unsupported{version}` on an older host. Local: `unsupported{runtime}`.
   */
  installUpdate(
    decision: UpdateDecision,
    opts?: InstallOptions,
  ): Promise<InstallOutcome>;
  /**
   * Count this launch before the app does anything that could crash (update.bootguard, §3.15):
   * the first launch of a new version moves the slots, client-core's `bootGuardAction` decides,
   * and the launch is counted as unconfirmed. After `MAX_FAILED_BOOTS` unconfirmed launches of
   * an unconfirmed version it rolls back (through the host's `rollback` when it passed one),
   * journals `boot_rolled_back` and, in bearer mode, sends the journal. `boot()` calls it as its
   * guard stage: call it yourself only when you do not boot through `boot()`. Browser: slots in
   * browser storage, keyed by the page's `version`. Desktop: the host's guard over bridge v4
   * (`invoke("update", "markBootAttempt")`).
   */
  markBootAttempt(): Promise<BootAttempt>;
  /** Mark this launch healthy: resets the count and journals `update_confirmed` once (bearer
   *  mode then sends the journal at once: nothing records it again). `boot()` confirms by the
   *  stage matrix's `confirmCases`; call it yourself for a boot you drive. */
  confirmBoot(): Promise<void>;
  /**
   * The host asks the renderer to open a view (UK-06.4): a native menu item on the desktop
   * bridge. Returns an unsubscribe. Optional: only the desktop adapter has a host to ask, and an
   * older host never asks.
   */
  onOpen?(cb: (view: KitView) => void): () => void;
  /**
   * The OS facts the desktop host reports (UK-06): the chrome (`os`), the system accent, high
   * contrast and reduced transparency. `null` until a v4 host sends them, and always on an adapter
   * with no host. The value is replaced only when a fact changes, so it can back a store snapshot.
   */
  hostFacts?(): BridgeHost | null;
  /** Dispose any listeners/timers the adapter owns. */
  dispose(): void;
}

/** Build the initial `loading` state for a given mode (shared adapter seed). Local overrides
 *  and the fail-closed capability fallback are carried from the very first seed, so a getter
 *  is correct — and a capability check honest — before the first document lands. */
export function initialState(
  mode: PolarisMode,
  capabilities: ServicesMap,
  localOverrides: Record<string, JSONValue> = {},
): PolarisState {
  return {
    phase: "loading",
    mode,
    // Seeded from the fallback capabilities so a config-only product is `not-applicable`
    // (usable) rather than flashing `needs-activation` on its very first frame.
    gate: { status: seedStatus(capabilities) },
    status: seedStatus(capabilities),
    activation: null,
    highWaterMark: 0,
    capabilities,
    profile: null,
    currentDeviceId: null,
    licenseId: null,
    config: {},
    configEntries: {},
    localOverrides,
    entitlements: {},
    busy: noBusy(),
    error: noErrors(),
  };
}

function seedStatus(capabilities: ServicesMap): LicenseStatus {
  return capabilities.license.enabled ? "needs-activation" : "not-applicable";
}

export type { ServiceSlug, ServicesMap, ServiceBusyMap, ServiceErrorMap };
