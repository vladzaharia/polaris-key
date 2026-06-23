// The shared, mode-agnostic surface. Every type here is identical across the browser
// and desktop adapters — this is what makes the hooks return the same shapes regardless
// of transport (mode-parity). The adapters differ only in HOW they fill a `PolarisState`.

import type { DocProfile, JSONValue, LicenseStatus } from "@polaris-key/protocol";
import type { LicenseState } from "./gateModel.js";

export type { LicenseState } from "./gateModel.js";
export { licenseState, isUsable } from "./gateModel.js";

/** Which transport an adapter speaks. `auto` resolves at construction time. */
export type PolarisMode = "browser" | "desktop";

/** The phase of the very first load — distinct from a license `status`. Until the first
 *  snapshot resolves we render a loading screen, not a (misleading) `needs-enroll`. */
export type PolarisPhase = "loading" | "ready";

/** Stable error codes surfaced by adapter operations. `key-entry-unsupported` is thrown
 *  by the browser adapter's `submitKey` (browser enrollment is OIDC-only). */
export type PolarisErrorCode =
  | "key-entry-unsupported"
  | "sign-in-failed"
  | "sign-out-failed"
  | "refresh-failed"
  | "network"
  | "bridge-missing"
  | "unknown";

/** A typed error every adapter throws so callers can branch on `.code` not on strings. */
export class PolarisError extends Error {
  readonly code: PolarisErrorCode;
  constructor(code: PolarisErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PolarisError";
    this.code = code;
  }
}

/** The single immutable snapshot the store holds and every hook reads from. Both adapters
 *  produce exactly this shape. */
export interface PolarisState {
  /** First-load phase. `loading` until the adapter resolves its first snapshot. */
  phase: PolarisPhase;
  /** The transport that produced this state. */
  mode: PolarisMode;
  /** The full gate result (status + grace/version metadata). */
  gate: LicenseState;
  /** Convenience mirror of `gate.status`. */
  status: LicenseStatus;
  /** The signed profile (name/email), once a doc is present. */
  profile: DocProfile | null;
  /** Plaintext config entries (key → value). */
  config: Record<string, JSONValue>;
  /** Capability map (entitlement name → value). */
  entitlements: Record<string, JSONValue>;
  /** True while a refresh/sign-in/sign-out op is in flight (post first load). */
  busy: boolean;
  /** The last operation error, if any (cleared on the next successful op). */
  error: PolarisError | null;
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
  /** Enroll with a typed key. **Desktop only** — browser throws `key-entry-unsupported`. */
  submitKey(key: string): Promise<void>;
  /** Sign out / deauthorize and wipe local state. */
  signOut(): Promise<void>;
  /** Read a single config value with a fallback. */
  getConfig<T = JSONValue>(key: string, fallback: T): T;
  /** Read a single secret value (browser: never exposed → always null). */
  getSecret(key: string): string | null;
  /** True when a boolean entitlement is granted. */
  isEntitled(name: string): boolean;
  /** Dispose any listeners/timers the adapter owns. */
  dispose(): void;
}

/** Build the initial `loading` state for a given mode (shared adapter seed). */
export function initialState(mode: PolarisMode): PolarisState {
  return {
    phase: "loading",
    mode,
    gate: { status: "needs-enroll" },
    status: "needs-enroll",
    profile: null,
    config: {},
    entitlements: {},
    busy: false,
    error: null,
  };
}
