// The desktop IPC contract. In an Electron/Tauri app the main/native process owns the
// real @polaris-key/node client (token + keyring + loopback OIDC) and exposes THIS object
// to the renderer (default: `window.polarisKey`, via a contextBridge preload). The React
// desktop adapter is a thin renderer-side proxy over these methods — all credential and
// filesystem state stays in the privileged process.
//
// The shapes deliberately mirror @polaris-key/node's client surface (getState / refresh /
// enroll / deauthorize / report) so the Node side can implement each method with a
// near-1:1 delegation. Export it so that Node side can `import type { PolarisBridge }`.

import type { AllowedRange, BlockReason, JSONValue, ManagedConfigDoc } from "@polaris-key/protocol";

/** The serialized gate the bridge reports — the renderer can't run the Node gate itself,
 *  so the privileged process sends the doc + the sync bookkeeping and the adapter derives
 *  the same `LicenseState` the Node SDK would (via the shared gateModel). */
export interface BridgeState {
  /** Whether a per-machine token is stored. */
  hasToken: boolean;
  /** The cached, verified doc (or null). */
  doc: ManagedConfigDoc | null;
  /** Set when the last sync returned a hard 401. */
  lastSyncUnauthorized?: boolean;
  /** Set when the last sync returned a 403 version/channel block. */
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
  /** Epoch ms of the last successful online verify. */
  lastVerifiedAt?: number;
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

/** The result of submitting a typed key (mirrors @polaris-key/node's EnrollResult). */
export type BridgeEnroll =
  | { kind: "ok" }
  | { kind: "machine-limit"; limit?: number; machineCount?: number }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/**
 * The contract the native side implements and the renderer calls. Every method is async
 * (it crosses the IPC boundary). `on("stateChanged", …)` lets the privileged process push
 * hot-reload updates (the Node client's HubDO signal) up to the renderer.
 */
export interface PolarisBridge {
  /** Snapshot the current gate inputs (no network). */
  getState(): Promise<BridgeState>;
  /** Re-pull + re-apply the managed config; resolves to the fresh state. */
  refresh(): Promise<BridgeState>;
  /** Begin an OIDC sign-in; returns a handle to render + poll. */
  beginSignIn(): Promise<BridgeOidcBegin>;
  /** Poll an in-flight OIDC sign-in by its `flowId`. */
  pollSignIn(flowId: string): Promise<BridgeOidcPoll>;
  /** Enroll with a typed key. */
  submitKey(key: string): Promise<BridgeEnroll>;
  /** Deauthorize + wipe local state. */
  signOut(): Promise<void>;
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
