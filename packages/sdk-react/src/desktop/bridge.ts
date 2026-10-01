// The desktop IPC contract, version 3. In an Electron/Tauri app the main/native process owns
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
//   * `getSyncState()` and a versioned `invoke(service, method, args)` escape hatch.
//
// ── WHAT v3 CHANGED (P1b-07) ────────────────────────────────────────────────────────────────
//
//   * `importBundle(jws)` — offline activation (§7) through the host's
//     `PolarisKeyClient.importBundle`, which verifies and writes the cache in the privileged
//     process. OPTIONAL: a v2 host omits it and the adapter reports `bundle-import-unsupported`.
//   * `fetchSchema()` returns the product catalog or `null` (the host's
//     `client.config.fetchSchema()`), never a throw for a failed fetch.
//   * The renderer reaches more sub-client verbs through `invoke` — `("release", "changelog")`,
//     `("release", "installUrl")`, `("release", "downloadUrl", {version, binary, arch,
//     checksum?, dmg?})` and `("devices", "report")` — which need no interface change, only a
//     host that answers them (the last two map onto `client.release.downloadUrl(version,
//     binary, arch, {checksum, dmg})` and `client.devices.report()`).
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
export const BRIDGE_VERSION = 3;

/** What `importBundle` landed. `@polaris-key/node`'s `ImportBundleResult`, field for field. */
export interface BridgeImportBundle {
  bundleId: string;
  imported: ("license" | "config")[];
}

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
   * The versioned escape hatch: call any sub-client verb the privileged process exposes
   * without growing this interface for it. `service` is the sub-client name as `@polaris-key/node`
   * spells it (`"devices"`, `"update"`, `"release"`, `"config"`, `"license"`), `method` the
   * verb, `args` a single serialisable bag.
   *
   * It exists because the alternative — a bridge method per verb — makes every new service
   * capability a breaking change to a contract shipped inside somebody else's Electron app.
   * A host that omits `invoke` simply has those capabilities reported as unsupported.
   */
  invoke?(service: string, method: string, args?: unknown): Promise<unknown>;
  /** Optionally let the renderer fetch the product config catalog: the host's
   *  `client.config.fetchSchema()`, which answers `null` on any failure. */
  fetchSchema?(): Promise<JSONValue>;
  /**
   * Protocol v3: verify and install an offline activation bundle (§7) in the privileged
   * process — the host's `client.importBundle(jws)`. All-or-nothing; a refusal rejects with the
   * §7 step that refused (`@polaris-key/node`'s `PolarisError.code`). Absent on a v2 host,
   * which the adapter reports as `bundle-import-unsupported`.
   */
  importBundle?(jws: string): Promise<BridgeImportBundle>;
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
