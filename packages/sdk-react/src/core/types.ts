// The shared, mode-agnostic surface. Every type here is identical across the browser
// and desktop adapters — this is what makes the hooks return the same shapes regardless
// of transport (mode-parity). The adapters differ only in HOW they fill a `PolarisState`.
//
// The GATE is not defined here any more: `@polaris-key/client-core` owns the one implementation every
// JS SDK runs (wire contract v3 §5), including the monotonic clock floor this package's old
// local port silently dropped. Both adapters reduce their transport to the same
// `client-core` `GateInput` and run the same `licenseState`.

import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@polaris-key/protocol/license";
import type { ConfigSource, LicenseState } from "@polaris-key/client-core";
// `services.ts` imports only the `PolarisError` TYPE from this module, and `import type` is
// erased, so this value import creates no runtime cycle.
import { noBusy, noErrors } from "./services.js";
import type {
  ServiceBusyMap,
  ServiceErrorMap,
  ServiceSlug,
  ServicesMap,
} from "./services.js";

/** Which transport an adapter speaks. `auto` resolves at construction time. */
export type PolarisMode = "browser" | "desktop";

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
  | "unknown";

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

/** A typed error every adapter throws so callers can branch on `.code` not on strings. */
export class PolarisError extends Error {
  readonly code: PolarisErrorCode;
  constructor(code: PolarisErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PolarisError";
    this.code = code;
  }
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
  /** What the product runs, per D-21. Discovery when it answered; the host's `expectServices`
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
}

/** The unified transport contract. The hooks ONLY ever talk to this — they never know
 *  which mode is active. Both `browserAdapter` and `desktopAdapter` implement it. */
export interface PolarisAdapter {
  readonly mode: PolarisMode;
  /** The current state, synchronously (the store seed + every read). */
  snapshot(): PolarisState;
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(cb: (state: PolarisState) => void): () => void;
  /** Re-pull the license/config from the source of truth and re-apply. */
  refresh(): Promise<void>;
  /** Begin an OIDC sign-in. Desktop returns a verification handle; browser navigates
   *  the page (and never resolves, since the page unloads). */
  signInWithOidc(): Promise<OidcSignInHandle | void>;
  /** Activate with a typed key using the active transport. */
  submitKey(key: string): Promise<void>;
  /** Sign out / deauthorize and wipe local state. */
  signOut(): Promise<void>;
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
  /** Read a single config value with a fallback, honoring v3 state + local overrides:
   *  `enforced`/`hidden` → remote value (locked); else `localOverrides[key] ?? remote ?? fallback`. */
  getConfig<T = JSONValue>(key: string, fallback: T): T;
  /** Enumerate config for a settings UI: every key EXCEPT `hidden`, each resolved to its
   *  effective value with an `enforced` flag (true ⇒ render read-only, server value wins). */
  listUserConfig(): UserConfigEntry[];
  /** Where the effective value for `key` comes from (provenance), for diagnostics/UI. */
  getConfigSource(key: string): ConfigSource;
  /** Read a single secret value (browser: never exposed → always null). */
  getSecret(key: string): string | null;
  /** True when a boolean entitlement is granted. */
  isEntitled(name: string): boolean;
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
