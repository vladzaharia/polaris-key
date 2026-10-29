// The desktop IPC contract, version 4. In an Electron/Tauri app the main/native process owns
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
//     configured `expectedServices` belief; it never assumes all-true.
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
  /** v4 (`config.local`): the host's persisted device-local overrides,
   *  `client.config.localValues()`. Absent ⇒ the renderer keeps what it last knew. */
  localConfig?: Record<string, JSONValue>;
  /** Discovery's `core.presentation` as the host's Node client holds it
   *  (`client.presentation()`), null for none. Absent ⇒ an older host: no presentation. */
  presentation?: unknown;
  /** v4 (UK-06): the host's OS facts. Absent ⇒ an older host: the renderer keeps `web` chrome. */
  host?: BridgeHost;
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
  /** `keyEntries` (identity.keyentry): the licence's entries, when Identity is on. */
  | { kind: "ok"; keyEntries?: { used: number; limit: number } }
  /** identity.keyentry: the licence has no key entries left. Not an auth failure: nothing is
   *  cleared. `manageUrl` is the portal link, re-validated by the renderer. */
  | {
      kind: "key-entry-limit";
      manageUrl?: string;
      keyEntries?: { used: number; limit: number };
    }
  /** identity.keyentry: the key's licence is in an account; `signInUrl` is the sign-in link. */
  | { kind: "license-owned"; signInUrl?: string }
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
 * ── WHAT v4 ADDS (SP-R07, SP-12 to SP-14; the host is `@polaris-key/node/electron`, SP-31) ───
 *
 * `exposePolarisBridge` in `@polaris-key/node/electron` is the reference v4 host: its
 * `subscribe` answers `{version: 4}`, its preload object reports `version: 4`, and it answers
 * every verb below over the Node client. It stays an allowlist (`DEFAULT_INVOKE_VERBS`); a host
 * adds its own verbs with `invoke.extra`. A v4 host keeps answering every v3 method and verb
 * unchanged. Each verb resolves a value or rejects with an error carrying the host's `code`
 * (and, for an update refusal, `detail`); the adapter maps it by that code.
 *
 * Method changes:
 *
 *   * `beginSignIn({deviceName?})`: the renderer's name wins over the host's `deviceName`
 *     option, which stays the default. The result adds `verificationUri` (the bare page, the
 *     code typed by hand), `expiresAt` (epoch seconds, the host's clock) and `interval` (the
 *     minimum seconds between polls) to `flowId`, `verificationUrl` and `userCode`. The device
 *     code never leaves the host.
 *   * `pollSignIn`'s `ok` carries `identity` (`{name?, email?}`) when the host's poll knew it.
 *   * `submitKey`'s `BridgeActivation` gains `fingerprint-required`, `enroll-disabled`,
 *     `hardware-mismatch{drift?, changed?}` and `refused{code, status, message}`, so the
 *     renderer keeps the server's code (§3.1) instead of one folded `error`. A refusal outside
 *     the named kinds is still `error{message, code}`.
 *   * `BridgeState.localConfig` is `client.config.localValues()` on every state (`config.local`).
 *
 * `invoke` verbs, sent only to a host whose `version` is 4 or later (a v3 host gets a typed
 * `UnsupportedError` with reason `version`, or `null` for the nullable reads, without the call
 * crossing the bridge). Arguments are one bag; a malformed one rejects `invalid-argument`:
 *
 *   * `("config","mint",{recipeId})` → `{token, expiresAt}`: `client.config.mintToken()`.
 *   * `("commerce","binding")` → `{bindingId, products: [{store, productId, flag, deliverable}]}`;
 *     a refusal rejects with its code.
 *   * `("commerce","claim",{store, payload})` → a `CommerceClaimResult` (`ok`, `notOwned`,
 *     `attestationRequired`, `refused`), then a state push after an `ok`. `store` is
 *     `app-store` (`{signedTransaction}`), `play` (`{productId, purchaseToken}`) or `steam`
 *     (`{ticket, dlcAppId}`). No answer or a 5xx rejects with the Node code.
 *   * `("core","discovery")` → the host's discovery document, or `null`.
 *   * `("core","storeStatus")` → `{backend, degraded?}` or `null`: where the host keeps the token.
 *   * `("devices","id")` → the host's device id (what an offline bundle is minted for).
 *   * `("core","boot",opts)` → `{outcome, state, license, decision, emits}`: `client.boot()` in
 *     the host (`consent`, `metered`, `allowOffline`, `allowGrace`, `registration`,
 *     `requiredPacks`; callbacks do not cross), then a state push.
 *   * `("core","crashTags",{deliverable?, build?})` → `{release, environment, "pkey.outlet"}`.
 *   * `("release","fetch",{target, to})` → `{path, size, sha256, version, buildId}`: the verified
 *     download. `target` is a release record hash, `{sha256, buildId?}` or a `binary` decision
 *     (a record the renderer holds is refused: the host fetches and verifies its own).
 *     `to` is a path RELATIVE to the host's `downloadDir` option (Electron's
 *     `app.getPath("downloads")`); an absolute path or a `..` escape rejects `invalid-argument`,
 *     and a host with no `downloadDir` rejects `not-configured`. `path` is the resolved file.
 *     A state push follows.
 *   * `("distribution","downloadModel",{channel?})` → the download model.
 *   * `("distribution","thisPlatform",{channel?, platform?})` → the host's platform group
 *     (`platform` overrides).
 *   * `("update","feedUrl",{kind, channel?, velopackChannel?, buildId?, arch?})` → `FeedUrl`,
 *     `{supported: true, url}` or the typed `Unsupported` as a result.
 *   * `("config","set",{key,value})` and `("config","clear",{key})` → `null` (`config.local`,
 *     SP-13): `client.config.set`/`clear`; a refusal keeps its `managed_by_admin` or
 *     `bad_request` code. A state push follows, carrying `localConfig`.
 *   * `("update","journal",{event, release, fromRelease?, deliverable?, channel?, packSetId?,
 *     code?})` → the journalled `UpdateEventEntry` or `null` (SP-14: the renderer's update-health
 *     events, recorded with `client.update.journal.record(event, input)`, so the host's next
 *     report drains them).
 *   * `("update","install",{decision})` → the host's `client.update.install(decision)`, an `InstallOutcome` over IPC (`restartRequired` and `handedOff` carry a `version`, `storeOpened` a `url`, `unsupported` a `reason` and `detail`). The renderer sends only `binary` and `store` decisions, the ones a driver installs (SP-15).
 *   * `("update","restart")` → apply the install the host just staged (a `restartRequired` outcome's `restart()`), and `("update","markBootAttempt")` / `("update","confirmBoot")` → `client.update.markBootAttempt()` / `client.update.confirmBoot()`. The host's `boot()` already runs the guard, so a renderer that boots through it never calls the last two. The host adds all four to `DEFAULT_INVOKE_VERBS`.
 *   * `("core","boot",opts)` also takes `autoConfirm` (`false` leaves a `ready` launch for the renderer's `confirmBoot()`) and returns `guard`, the `BootAttempt` the guard stage produced, which the renderer passes on as `BootResult.guard` (`null` when the host sends none).
 *
 * ── I-10a.9: THE ACCOUNT, WITH NO NEW VERB ──────────────────────────────────────────────────────
 *
 * `submitKey`'s `BridgeActivation` carries `keyEntries` on `ok` and adds `key-entry-limit` and
 * `license-owned` (a host that never sends them keeps working: a refusal outside the named kinds
 * is `refused{code}`, which the renderer classifies by the same codes). The account calls ride
 * `invoke`, on a v4 host, one bag each; a host that does not allowlist them rejects
 * `invoke-not-allowed`, which the renderer reports as the typed `UnsupportedError` (`version`):
 *
 *   * `("identity","subject")` → the pairwise subject string, or `null`.
 *   * `("identity","attach",{confirm})` → `{kind:"confirm", license:{id,tierId,name}}`,
 *     `{kind:"ok", subject, attached}` (a state push follows) or `{kind:"refused", code, status}`.
 *   * `("identity","openAccount")` → `null`: the host opens the portal page in the system browser.
 *
 * `signOut` stays the bridge method; the renderer reads `released` off the state that follows
 * (the activation is gone, or it is not).
 *
 * ── WHAT v4 ADDS (UK-06) ─────────────────────────────────────────────────────────────────────
 *
 * Four OPTIONAL members, so an older v4 host never sends them and an adapter that finds them
 * absent behaves as before. `BRIDGE_VERSION` stays 4. Declared by UK-06.1; the host
 * (`@polaris-key/node/electron`) and the renderer use them in later UK-06 slices.
 *
 *   * `BridgeState.host` (`BridgeHost`): the OS facts the kit picks its desktop chrome from.
 *   * `onUpdateProgress(cb)`: pushed progress while `("update","install")` runs.
 *   * `onOpen(cb)`: the host asks the renderer to open a `KitView` (a native menu item).
 *   * `openExternal(url)` (UK-06.16): open an https link in the system browser; the host's
 *     `shell.openExternal` runs only behind its https check and its `allowSender` rule.
 *
 * Reserved, not yet used by this package: pack verbs (`("packs", …)`), telemetry extras and the
 * `onPackProgress` push below are declared for a later revision; nothing here calls or
 * subscribes to them, and the Node host answers none of them.
 */
export const BRIDGE_VERSION = 4;

/** The bridge revisions this package accepts: v3 hosts keep working with the v4 verbs refused
 *  typed; v4 hosts get everything. The v4 gate itself is `version >= BRIDGE_VERSION`. */
export const BRIDGE_VERSIONS_ACCEPTED = [3, 4] as const;

/** v4 (UK-06): the host's OS facts, `BridgeState.host`. `os` picks the desktop chrome. */
export interface BridgeHost {
  os: "macos" | "windows" | "linux";
  /** The system accent colour as `#rrggbb`, when the host knows it. */
  accentColor?: string;
  highContrast?: boolean;
  reducedTransparency?: boolean;
}

/** v4 (UK-06): one pushed update-install progress event (`onUpdateProgress`). Sent to the window
 *  that started the install only. `total` is `null` when the driver does not know the size: the
 *  renderer then draws an indeterminate bar and invents no percentage. */
export interface BridgeUpdateProgress {
  /** Bytes received so far. */
  done: number;
  /** Total bytes, or `null` when the driver does not know it. */
  total?: number | null;
  /** The release being installed. */
  version?: string;
  /** What the bytes are for. The host sends `download`. */
  phase?: "download";
}

/** v4 (UK-06): a view the host can ask the renderer to open (`onOpen`). */
export type KitView = "settings" | "update";

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
  /** v4 (UK-06.16): open an https link in the system browser, in the privileged process (the
   *  host refuses any other scheme). Optional: the kit's links use it when it is present, and
   *  `window.open` otherwise. */
  openExternal?(url: string): Promise<boolean>;
  /** Subscribe to pushed state changes; returns an unsubscribe. */
  on(event: "stateChanged", cb: (state: BridgeState) => void): () => void;
  /** v4 (UK-06): pushed update-install progress; returns an unsubscribe. Absent on a host that
   *  does not forward it. */
  onUpdateProgress?(cb: (p: BridgeUpdateProgress) => void): () => void;
  /** v4 (UK-06): the host asks the renderer to open a view (a native menu item); returns an
   *  unsubscribe. Absent on a host with no menu items. */
  onOpen?(cb: (view: KitView) => void): () => void;
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
