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
  /** A URL to open in the system browser (device/verification flow). The complete one — with
   *  the code in it — is the QR payload. */
  verificationUrl?: string;
  /** A user code to display alongside the URL. */
  userCode?: string;
  /** v4: the bare verification page (the code typed by hand). */
  verificationUri?: string;
  /** v4: when the code expires, epoch seconds on the host's clock. */
  expiresAt?: number;
  /** v4: the minimum seconds between polls. */
  interval?: number;
}

/** The terminal outcome of polling an OIDC flow. v4's `ok` may carry the signed-in identity. */
export type BridgeOidcPoll =
  | { kind: "pending" }
  | { kind: "ok"; identity?: { name?: string; email?: string } }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

/** The result of submitting a typed key (mirrors @polaris-key/node's ActivationResult). v4 adds
 *  the kinds Node already returns (`fingerprint-required`, `enroll-disabled`,
 *  `hardware-mismatch`) and `refused`, which carries the server's own code so a refusal other
 *  than the device cap is never shown as one (SDK-PARITY-PASS §3.1). */
export type BridgeActivation =
  | { kind: "ok" }
  /** `manageUrl` (PX-W8): the portal link the host's Node SDK read off the refusal. */
  | {
      kind: "device-limit";
      limit?: number;
      deviceCount?: number;
      manageUrl?: string;
    }
  | { kind: "unauthorized" }
  | { kind: "fingerprint-required" }
  | { kind: "enroll-disabled" }
  | { kind: "hardware-mismatch"; drift?: number; changed?: string[] }
  | { kind: "refused"; code: string; status?: number; message?: string }
  | { kind: "error"; message: string; code?: string };

/** The bridge protocol revision this package speaks. A host may report its own via
 *  `version`; the adapter treats an absent value as 1 and degrades accordingly. A v3 host keeps
 *  working: every v4 verb it does not answer is refused with a typed `UnsupportedError`.
 *
 * ── WHAT v4 ADDS (SP-R07; the host side is pending SP-N10) ─────────────────────────────
 *
 * The renderer half below is implemented here. The Node Electron host still speaks v3
 * (`@polaris-key/node`'s bridge reports version 3 and answers none of the v4 `invoke` verbs)
 * until SP-N10 ships, so against today's host every v4 verb is refused typed.
 *
 *   * `beginSignIn({deviceName?})`; the begin result's `verificationUri`, `expiresAt`, `interval`;
 *     `pollSignIn`'s `ok` carrying `identity`.
 *   * `submitKey`'s `BridgeActivation` gains `fingerprint-required`, `enroll-disabled`,
 *     `hardware-mismatch` and `refused{code}`, so the renderer keeps the server's code (§3.1).
 *   * `invoke` verbs, sent only to a host whose `version` is 4 or later (a v3 host gets a typed
 *     `UnsupportedError` with reason `version`, or `null` for the nullable reads, without the
 *     call crossing the bridge): `("config","mint",{recipeId})` → `{token, expiresAt}`;
 *     `("commerce","binding")` → `{bindingId, products}`; `("commerce","claim",{store,payload})`
 *     → a `CommerceClaimResult`; `("core","discovery")`; `("core","storeStatus")`;
 *     `("devices","id")`.
 *
 * Reserved, not yet used by this package: pack verbs (`("packs", …)`), telemetry extras and the
 * `onPackProgress` push below are declared for a later revision; nothing here calls or
 * subscribes to them.
 */
export const BRIDGE_VERSION = 4;

/** The bridge revisions this package accepts: v3 hosts keep working with the v4 verbs refused
 *  typed; v4 hosts get everything. The v4 gate itself is `version >= BRIDGE_VERSION`. */
export const BRIDGE_VERSIONS_ACCEPTED = [3, 4] as const;

/** One pushed pack-progress event. Reserved for a later bridge revision: declared, not yet
 *  subscribed by this package. */
export interface BridgePackProgress {
  packId: string;
  phase: "queued" | "downloading" | "applying" | "ready" | "failed";
  done?: number;
  total?: number;
  code?: string;
}

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
  /** Begin an OIDC sign-in; returns a handle to render + poll. v4 passes `{deviceName}`. */
  beginSignIn(opts?: { deviceName?: string }): Promise<BridgeOidcBegin>;
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
  /** Reserved (later revision): pushed pack progress; returns an unsubscribe. This package does
   *  not subscribe to it yet, so a host need not implement it. */
  onPackProgress?(cb: (p: BridgePackProgress) => void): () => void;
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
