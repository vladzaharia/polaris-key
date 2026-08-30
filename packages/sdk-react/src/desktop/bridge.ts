// The desktop IPC contract, version 2. In an Electron/Tauri app the main/native process owns
// the real `@polaris-key/node` client (token + keyring + loopback OIDC) and exposes THIS object to the
// renderer (default: `window.polarisKey`, via a contextBridge preload). The React desktop
// adapter is a thin renderer-side proxy over these methods — all credential and filesystem
// state stays in the privileged process.
//
// ── WHAT v2 CHANGED ─────────────────────────────────────────────────────────────────────────
//
//   * `hasToken: boolean` → `activation: "token" | "bundle" | null`. A device activated from a
//     verified offline bundle (§7) has no token and IS activated; a boolean could not say so.
//     Replaced outright, with no derived alias: pre-launch, a deprecated shim is just a second
//     shape to keep correct.
//   * `highWaterMark` — §4.2's monotonic clock floor, in epoch SECONDS. Only the privileged
//     process can compute it (it folds the trust manifest and both documents, which live in the
//     cache), and without it the renderer's gate is the one gate in the suite a rolled-back
//     clock can still fool. This is the field this package used to be missing.
//   * `capabilities` — the product's `services` map (D-21). Absent ⇒ the adapter keeps its
//     configured `expectServices` belief; it never assumes all-true.
//   * `config` — the CONFIG document's entries. v3 split the fused document, so grants arrive
//     on `doc` (a `LicenseDoc`) and settings arrive here.
//   * `getSyncState()` and a versioned, ALLOW-LISTED `invoke(service, method, args)` escape
//     hatch. See `DESKTOP_BRIDGE_METHODS` below for why it is a closed set and not `string`.
//
// ── THE @polaris-key/node MIRROR ───────────────────────────────────────────────────────────────────
//
// `@polaris-key/node`'s `PolarisKeyClient.getSyncState(): SyncState` SATISFIES this contract's state
// half: `BridgeState` is `SyncState` field for field (`activation`, `doc`, `lastSyncUnauthorized`,
// `blocked`, `lastVerifiedAt`, `highWaterMark`) plus the two renderer-only additions above. The
// optionality is deliberately WIDER here than on the Node side, so a host can write
//
//     getSyncState: () => client.getSyncState()
//
// and have it type-check with nothing in between. `test/bridge.test.ts` pins the assignability
// so a field rename on either side stops compiling instead of drifting.

import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import type { BlockedState } from "@polaris-key/client-core";
import type { ServicesMap } from "../core/services.js";

/** The serialized gate inputs the bridge reports — the renderer can't run the Node gate
 *  itself, so the privileged process sends the documents + the sync bookkeeping and the
 *  adapter derives the same `LicenseState` the Node SDK would (via `@polaris-key/client-core`). */
export interface BridgeState {
  /** How this install became activated, or `null`. Replaces v1's `hasToken`. */
  activation: ActivationSource | null;
  /** The cached, re-verified LICENSE document (or null). Carries grants (D-20). */
  doc: LicenseDoc | null;
  /** Set when the last sync returned a hard 401. */
  lastSyncUnauthorized?: boolean;
  /** Set when the last document fetch returned a 403 version/channel block. */
  blocked?: BlockedState | null;
  /** Epoch MILLIseconds of the last successful online verify, or null. */
  lastVerifiedAt?: number | null;
  /** §4.2's monotonic clock floor, epoch SECONDS. Folded over the trust manifest AND both
   *  documents by the privileged process — a floor built from a document alone is inert. */
  highWaterMark?: number;
  /** The product's service capability map (D-21). Absent ⇒ keep the configured expectation. */
  capabilities?: ServicesMap;
  /** The CONFIG document's entries (v3 split them off the license document). */
  config?: Record<string, ManagedEntry>;
}

/** The result of a desktop OIDC begin — a verification URL/code to render while polling. */
export interface BridgeOidcBegin {
  /** Opaque handle the bridge uses to correlate the subsequent `pollSignIn`. */
  flowId: string;
  /** A URL to open in the system browser (device/verification flow). */
  verificationUrl?: string;
  /** A user code to display alongside the URL. */
  userCode?: string;
}

/** The terminal outcome of polling an OIDC flow. */
export type BridgeOidcPoll =
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

/** The result of submitting a typed key (mirrors @polaris-key/node's ActivationResult). */
export type BridgeActivation =
  | { kind: "ok" }
  | { kind: "device-limit"; limit?: number; deviceCount?: number }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/** The bridge protocol revision this package speaks. A host may report its own via
 *  `version`; the adapter treats an absent value as 1 and degrades accordingly. */
export const BRIDGE_VERSION = 2;

/**
 * The ALLOW-LIST for `invoke` — every `(service, method)` pair `DesktopAdapter` actually calls,
 * and therefore the only ones a host is ever asked to dispatch.
 *
 * It is a closed set because `invoke` crosses the contextBridge into the RENDERER. Typed as two
 * bare `string`s it is a reflective escape hatch, and a host that implements it as
 * `client[service][method](args)` has handed every script running in the renderer — including
 * anything that reaches it through an XSS or a third-party bundle — the privileged process's
 * whole sub-client surface. That includes `config.getSecret` (which returns the PLAINTEXT
 * managed secret both adapters deliberately answer `null` for) and `license.deactivate`.
 *
 * Exported as a runtime value so a host can validate against exactly what the renderer is
 * allowed to ask for, and so the accepted types below are DERIVED from that same list rather
 * than restated beside it.
 */
export const DESKTOP_BRIDGE_METHODS = [
  { service: "devices", method: "list" },
  { service: "devices", method: "rename" },
  { service: "devices", method: "deauthorize" },
  { service: "update", method: "check" },
] as const;

/** One allow-listed pair, as a discriminated union derived from `DESKTOP_BRIDGE_METHODS`. */
export type DesktopBridgeMethod = (typeof DESKTOP_BRIDGE_METHODS)[number];

/** The sub-clients `invoke` may address. Note what is NOT here: `config` and `license`. */
export type BridgeInvokeService = DesktopBridgeMethod["service"];

/** The verbs `invoke` may address ON a given service — the pairing is what is enforced, so
 *  `invoke("update", "list")` is as much an error as `invoke("config", "getSecret")`. */
export type BridgeInvokeMethod<S extends BridgeInvokeService> = Extract<
  DesktopBridgeMethod,
  { service: S }
>["method"];

/**
 * The contract the native side implements and the renderer calls. Every method is async
 * (it crosses the IPC boundary). `on("stateChanged", …)` lets the privileged process push
 * state updates up to the renderer.
 */
export interface PolarisBridge {
  /** The bridge protocol revision. Absent ⇒ treated as 1 (pre-suite). */
  readonly version?: number;
  /** Snapshot the current gate inputs (no network). The v2 name, mirroring
   *  `@polaris-key/node`'s `getSyncState()`. */
  getSyncState(): Promise<BridgeState>;
  /** Re-pull + re-apply the managed documents; resolves to the fresh state. */
  refresh(): Promise<BridgeState>;
  /** Begin an OIDC sign-in; returns a handle to render + poll. */
  beginSignIn(): Promise<BridgeOidcBegin>;
  /** Poll an in-flight OIDC sign-in by its `flowId`. */
  pollSignIn(flowId: string): Promise<BridgeOidcPoll>;
  /** Activate with a typed key. */
  submitKey(key: string): Promise<BridgeActivation>;
  /** Deauthorize + wipe local state. */
  signOut(): Promise<void>;
  /**
   * The versioned escape hatch: call one of the ALLOW-LISTED sub-client verbs the privileged
   * process exposes, without growing this interface once per verb. `service` and `method` are
   * spelled as `@polaris-key/node` spells them, and the accepted pairs are exactly
   * `DESKTOP_BRIDGE_METHODS`; `args` is a single serialisable bag.
   *
   * It exists because the alternative — a bridge method per verb — makes every new service
   * capability a breaking change to a contract shipped inside somebody else's Electron app.
   * It stays OPTIONAL for the same reason: a host that omits `invoke` simply has the device
   * and update capabilities reported as unsupported instead of failing to satisfy the contract.
   *
   * Dispatch it with an explicit `switch` over those pairs, never reflectively — see this
   * package's README. A reflective `client[service][method](args)` implementation reaches
   * `config.getSecret` and `license.deactivate` from the renderer.
   */
  invoke?<S extends BridgeInvokeService>(
    service: S,
    method: BridgeInvokeMethod<S>,
    args?: unknown,
  ): Promise<unknown>;
  /** Optionally let the renderer fetch the product config schema/catalog. */
  fetchSchema?(): Promise<JSONValue>;
  /** Subscribe to pushed state changes; returns an unsubscribe. */
  on(event: "stateChanged", cb: (state: BridgeState) => void): () => void;
}

/** The default global the adapter looks for when no bridge is passed explicitly. */
export interface PolarisBridgeWindow {
  polarisKey?: PolarisBridge;
}

/** Resolve the bridge from an explicit arg or `window.polarisKey`. */
export function resolveBridge(explicit?: PolarisBridge): PolarisBridge | null {
  if (explicit) return explicit;
  if (typeof globalThis !== "undefined") {
    const w = globalThis as unknown as PolarisBridgeWindow;
    if (w.polarisKey) return w.polarisKey;
  }
  return null;
}
