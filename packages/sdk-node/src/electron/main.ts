// `exposePolarisBridge` (SDK parity pass SP-N10, v4 in SP-31): the Electron main process's half of
// the PolarisBridge v4 contract that `@polaris-key/react`'s desktop adapter drives (the contract
// is written down once, in that package's `desktop/bridge.ts`, "WHAT v4 ADDS"). The privileged
// process owns the real client (token, keyring, cache, pinned trust); the renderer gets a proxy
// that can read state and ask for the verbs listed here, and nothing else.
//
//   main:     exposePolarisBridge(client, { ipcMain })
//   preload:  import "@polaris-key/node/electron/preload"
//   renderer: <PolarisProvider adapter={new DesktopAdapter()}> — unchanged
//
// Security: the device code of a sign-in never leaves this process (the renderer holds an opaque
// flow id), `invoke` answers only an allowlist of verbs, and a host can refuse a sender
// (`allowSender`) — for example any frame not loaded from the app's own origin.

import { randomUUID } from "node:crypto";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { PolarisError } from "@polaris-key/client-core/errors";
import type { PolarisKeyClient } from "../client.js";
import type { ClientBootOptions } from "../boot.js";
import type { ClaimResult, CommerceStore } from "../commerce/client.js";
import { ErrorCode, type UpdateEvent } from "../constants.generated.js";
import { copy } from "../core/copy.js";
import type { DeviceCodeSession } from "../identity/signIn.js";
import type { ActivationResult } from "../license/endpoints.js";
import type { FeedKind } from "../update/client.js";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import {
  BRIDGE_METHODS,
  DEFAULT_BRIDGE_CHANNEL,
  DEFAULT_INVOKE_VERBS,
  POLARIS_BRIDGE_VERSION,
  KIT_VIEWS,
  channelOf,
  openChannel,
  stateChannel,
  updateProgressChannel,
  type BridgeEnvelope,
  type BridgeMethod,
  type KitView,
} from "./protocol.js";
import { resolveLocale } from "../cli/copy.js";
import { KIT_COPY, KIT_COPY_VARIANTS } from "../kitCopy.generated.js";

/** The part of Electron's `WebContents` the bridge uses. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
  once?(event: "destroyed", listener: () => void): unknown;
  removeListener?(event: "destroyed", listener: () => void): unknown;
  /** The window's top frame (Electron's `webContents.mainFrame`). Pushes that are not a reply to
   *  a call (`open`) are re-checked against it; a window that reports none gets no such push. */
  readonly mainFrame?: { url: string; parent?: unknown } | null;
}

/** The part of Electron's `IpcMainInvokeEvent` the bridge uses. */
export interface IpcMainInvokeEventLike {
  sender: WebContentsLike;
  senderFrame?: { url: string; parent?: unknown } | null;
}

/** The part of Electron's `ipcMain` the bridge uses. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

/** The parts of Electron's `systemPreferences` and `nativeTheme` the host facts read. Passed in
 *  (`electron: { systemPreferences, nativeTheme }`) so this module imports no `electron`. Every
 *  member is optional: a fact the runtime cannot answer is left out of `host`. */
export interface HostElectronLike {
  systemPreferences?: { getAccentColor?(): string };
  nativeTheme?: {
    shouldUseHighContrastColors?: boolean;
    prefersReducedTransparency?: boolean;
  };
}

/** The OS facts a state carries (`BridgeState.host`, UK-06.3): the kit picks its desktop chrome
 *  from them. */
export interface BridgeHostFacts {
  os: "macos" | "windows" | "linux";
  accentColor?: string;
  highContrast?: boolean;
  reducedTransparency?: boolean;
}

/** The part of an Electron `Notification` instance the bridge uses. */
export interface NotificationLike {
  show(): void;
  on(event: "click" | "close", listener: () => void): unknown;
}

/** Electron's `Notification` class, injected (this module imports no `electron`). */
export interface NotificationClassLike {
  new (options: { title: string; body: string }): NotificationLike;
  isSupported?(): boolean;
}

/** Opt-in OS notifications (UK-06.5): two events, each only while the app is not focused. */
export interface BridgeNotifications {
  /** Electron's `Notification` class. */
  Notification: NotificationClassLike;
  /** Whether the app has focus right now; a notification is shown only when this is false. */
  isAppFocused: () => boolean;
  /** Runs when the person clicks a notification: focus the host window. */
  onClick?: () => void;
  /** The kit-copy locale of the text (default English). */
  locale?: string;
}

export interface ExposePolarisBridgeOptions {
  ipcMain: IpcMainLike;
  /** OS notifications for "update ready to restart" and "signed in", only while the app is not
   *  focused. Without it the bridge shows none. The text is the kit copy's `notify.*` keys:
   *  static sentences, never a key, code, email or license id. */
  notifications?: BridgeNotifications;
  /** Electron's `systemPreferences` and `nativeTheme`, for the accent colour, high contrast and
   *  reduced transparency in `state.host`. Without it `host` carries the OS only. */
  electron?: HostElectronLike;
  /** Renderers that get `stateChanged` pushes without subscribing (the preload subscribes on
   *  its own, so this is only for a custom preload). */
  webContents?: WebContentsLike | WebContentsLike[];
  /** Electron's `shell`, for the `openExternal` bridge call (links the kit opens: replace a
   *  device, release notes, the sign-in page). Only an `https:` URL without credentials is
   *  opened; anything else is refused. Without it the call answers `not-configured`. */
  shell?: { openExternal(url: string): Promise<void> | void };
  /** The IPC channel prefix. Default `polaris-key`; the preload must use the same. */
  channel?: string;
  /** Refuse a sender: answer `false` and every call from it resolves `sender-refused`.
   *  Default: the TOP frame of the app's own origin (`appOrigin`; without it, any frame served
   *  from a local origin: `file:`, a custom scheme or loopback). A host that passes its own
   *  predicate replaces the default. */
  allowSender?: (event: IpcMainInvokeEventLike) => boolean;
  /** The origin(s) the app's window loads from, for the default `allowSender`. Set it when the
   *  app loads a remote `https:` page; the bridge then answers that origin's top frame only.
   *  A custom scheme (`app://main`) has an opaque origin, so it is pinned by scheme and host.
   *  A `file:` pin is refused (no host to pin): serve the app from a custom scheme. */
  appOrigin?: string | string[];
  /** `invoke` verbs beyond the default allowlist, as `service.method`, each with its handler. */
  invoke?: {
    extra?: Record<string, (args: unknown) => Promise<unknown> | unknown>;
  };
  /** The device name a sign-in started from this bridge reports when the renderer names none
   *  (v4: `beginSignIn({deviceName})`, the renderer's name wins). */
  deviceName?: string;
  /** The one directory `release.fetch` writes under. The renderer's `to` is a path RELATIVE to
   *  it; an absolute path or a `..` escape is refused with `invalid-argument`. Pass Electron's
   *  `app.getPath("downloads")`. Without it `release.fetch` answers `not-configured` and
   *  writes nothing. */
  downloadDir?: string;
  /** A sign-in flow is forgotten this long after its code expired. Default 60 seconds. */
  flowGraceSeconds?: number;
}

/** The key a URL is pinned and compared by: `.origin` for http(s), `scheme//host` for a custom
 *  scheme (its `.origin` is the opaque "null", shared by every such URL). */
function originKey(url: URL): string {
  if (url.origin !== "null") return url.origin;
  return `${url.protocol}//${url.host}`.toLowerCase();
}

/** The default sender rule: the top frame, on the app's origin (no `data:`, `blob:` or `about:` document). A frame the app did
 *  not load itself (an iframe, a navigated-away window, remote content) cannot drive the
 *  bridge. */
function defaultAllowSender(
  appOrigin: string | string[] | undefined,
): (event: IpcMainInvokeEventLike) => boolean {
  const pinned =
    appOrigin === undefined
      ? null
      : (Array.isArray(appOrigin) ? appOrigin : [appOrigin]).map((o) => {
          let u: URL;
          try {
            u = new URL(o);
          } catch {
            return o;
          }
          if (u.protocol === "file:")
            throw new Error(
              "appOrigin cannot pin a file: page (every file: URL shares one origin); serve the app from a custom scheme such as app://main",
            );
          return originKey(u);
        });
  return (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent != null) return false;
    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      return false;
    }
    if (pinned) return pinned.includes(originKey(url));
    if (url.protocol === "http:" || url.protocol === "https:")
      return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // Without a pinned origin only the app's own content may drive the bridge: a file or a custom
    // protocol the host registered. Documents a page can synthesise or navigate to are not that.
    return !["data:", "blob:", "about:", "javascript:", "ws:", "wss:"].includes(
      url.protocol,
    );
  };
}

/** At most this often (10 per second) an install pushes progress to its window. */
const PROGRESS_INTERVAL_MS = 100;

/** One app-menu item the host places: Electron's `MenuItemConstructorOptions` accepts it as is
 *  (this module imports no `electron`). */
export interface PolarisMenuItem {
  id: string;
  label: string;
  click: () => void;
}

/** The menu items' copy keys, in menu order, and the view each opens. */
const MENU_ITEMS: readonly { id: string; key: string; view: KitView }[] = [
  {
    id: "polaris-key.checkForUpdates",
    key: "update.checkNow",
    view: "update",
  },
  {
    id: "polaris-key.manageLicense",
    key: "menu.manageLicense",
    view: "settings",
  },
];

/** What `exposePolarisBridge` returns: tear down every handler and listener. */
export type PolarisBridgeHandle = {
  close(): void;
  /** Push the current state to every subscribed renderer now. */
  pushState(): void;
  /**
   * Ask the subscribed renderers to open a view in their window: Settings (the license) or the
   * update check (`polaris-key:open`). A renderer subscribes by listening (the preload's
   * `onOpen`, which `<PolarisKeyGate>` uses); one that does not listen, or an older renderer,
   * ignores it. An unknown view is refused with a thrown error, never pushed.
   */
  open(view: KitView): void;
  /**
   * The app-menu items for the host to place ("Check for updates" and "Manage license"), as plain
   * `{ id, label, click }` objects. The labels come from the kit copy in `locale` (default
   * English): sentence case, and on macOS (`platform` "darwin" or "macos", default
   * `process.platform`) title case with an ellipsis, in English only (§1.5 rule 11). A click calls
   * `open(view)`.
   */
  menuItems(opts?: { platform?: string; locale?: string }): PolarisMenuItem[];
};

interface FlowEntry {
  prompt: DeviceCodeSession;
  timer: ReturnType<typeof setTimeout>;
}

/** `process.platform` as the kit's `os`. */
function hostOs(platform: string): BridgeHostFacts["os"] {
  return platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : "linux";
}

/** The host facts for a state. Each Electron read is guarded: a throwing or missing accessor
 *  leaves its fact out rather than failing the state. The accent is Electron's `rrggbbaa` as
 *  `#rrggbb`; anything else is dropped. */
export function hostFacts(electron?: HostElectronLike): BridgeHostFacts {
  const host: BridgeHostFacts = { os: hostOs(process.platform) };
  try {
    const raw = electron?.systemPreferences?.getAccentColor?.();
    if (typeof raw === "string") {
      const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw);
      if (m) host.accentColor = `#${m[1]!.toLowerCase()}`;
    }
  } catch {
    // No accent on this OS.
  }
  try {
    const hc = electron?.nativeTheme?.shouldUseHighContrastColors;
    if (typeof hc === "boolean") host.highContrast = hc;
  } catch {
    // Unknown.
  }
  try {
    const rt = electron?.nativeTheme?.prefersReducedTransparency;
    if (typeof rt === "boolean") host.reducedTransparency = rt;
  } catch {
    // Unknown.
  }
  return host;
}

/** A BridgeState: the client's SyncState plus the capability map, the config entries, the
 *  device-local overrides (v4 `config.local`), the presentation member and, when the caller
 *  passes them, the host facts (UK-06.3). */
export function bridgeState(
  client: PolarisKeyClient,
  host?: BridgeHostFacts,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    ...client.getSyncState(),
    capabilities: client.capabilities(),
  };
  const config = client.config.entries();
  if (config) state.config = config;
  // v4 (`config.local`): the host's persisted overrides ride every state.
  state.localConfig = client.config.localValues();
  // Discovery's `core.presentation` (HA-13): the member rides every state, null for none.
  state.presentation =
    typeof client.presentation === "function" ? client.presentation() : null;
  if (host) state.host = host;
  return state;
}

/** Map `license.activateWithKey`'s outcome onto the bridge's `BridgeActivation` (v4). The kinds
 *  the bridge names (`device-limit`, `unauthorized`, `fingerprint-required`, `enroll-disabled`,
 *  `hardware-mismatch`, `refused`) keep their shape and the server's code; every other refusal
 *  becomes `error` with the copy catalog's sentence and the server's code. The messages are the
 *  catalog's, never a raw server body. */
export function bridgeActivation(r: ActivationResult): Record<string, unknown> {
  switch (r.kind) {
    case "ok":
      return r.keyEntries
        ? {
            kind: "ok",
            keyEntries: { used: r.keyEntries.used, limit: r.keyEntries.limit },
          }
        : { kind: "ok" };
    case "key-entry-limit": {
      const out: Record<string, unknown> = {
        kind: "key-entry-limit",
        keyEntries: { used: r.keyEntries.used, limit: r.keyEntries.limit },
      };
      if (r.manageUrl !== undefined) out.manageUrl = r.manageUrl;
      return out;
    }
    case "license-owned":
      return { kind: "license-owned", signInUrl: r.signInUrl };
    case "device-limit": {
      const out: Record<string, unknown> = { kind: "device-limit" };
      if (r.limit !== undefined) out.limit = r.limit;
      if (r.deviceCount !== undefined) out.deviceCount = r.deviceCount;
      if (r.manageUrl !== undefined) out.manageUrl = r.manageUrl;
      return out;
    }
    case "unauthorized":
      return { kind: "unauthorized" };
    case "fingerprint-required":
      return { kind: "fingerprint-required" };
    case "enroll-disabled":
      return { kind: "enroll-disabled" };
    case "hardware-mismatch": {
      const out: Record<string, unknown> = { kind: "hardware-mismatch" };
      if (r.drift !== undefined) out.drift = r.drift;
      if (r.changed !== undefined) out.changed = r.changed;
      return out;
    }
    case "refused":
      return {
        kind: "refused",
        code: r.code,
        status: r.status,
        message: `${copy.message(r.code)} [${r.code}]`,
      };
    default: {
      const text =
        r.kind === "error"
          ? copy.message(r.code)
          : copy.activation(r.kind, { code: r.code });
      return {
        kind: "error",
        message: `${text} [${r.code}]`,
        code: r.code,
      };
    }
  }
}

function envelopeError(e: unknown): BridgeEnvelope {
  // Only the SDK's own typed errors and the bridge's refusals describe themselves to the renderer.
  // Anything else (a filesystem error naming a path, a TypeError from a host callback) is a
  // host detail: the renderer gets a generic answer, never its message.
  if (!(e instanceof PolarisError) && !(e instanceof BridgeRefusal))
    return { ok: false, code: "unknown", message: "The request failed." };
  const err = e as { code?: unknown; message?: unknown; detail?: unknown };
  const out: BridgeEnvelope = {
    ok: false,
    code:
      typeof err?.code === "string" && err.code !== "" ? err.code : "unknown",
    message:
      typeof err?.message === "string" ? err.message : String(e ?? "error"),
  };
  if (typeof err?.detail === "string" || err?.detail === null)
    out.detail = err.detail as string | null;
  return out;
}

class BridgeRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function bag(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "")
    throw new BridgeRefusal("invalid-argument", `${name} must be a string.`);
  return v;
}

/** The v4 verbs' argument check: `invalid-argument`, the code the bridge documents. */
function arg(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "")
    throw new BridgeRefusal("invalid-argument", `${name} must be a string.`);
  return v;
}

/** `v` when it is a string, else undefined (an optional string argument). */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Resolve a renderer's `release.fetch` destination inside `dir`, the one directory the host
 *  lets a renderer write under. A renderer can name a file, never a place: an absolute path (on
 *  either platform's rules), a NUL, or any path that resolves outside `dir` or to `dir` itself is
 *  refused with `invalid-argument`. */
export function resolveDownloadPath(dir: string, to: unknown): string {
  const refuse = (why: string): never => {
    throw new BridgeRefusal(
      "invalid-argument",
      `release.fetch \`to\` must be a file path inside the download directory: ${why}.`,
    );
  };
  if (typeof to !== "string" || to === "") return refuse("it is empty");
  if (to.includes("\0")) return refuse("it contains a NUL");
  if (isAbsolute(to) || posix.isAbsolute(to) || win32.isAbsolute(to))
    return refuse("it is absolute");
  const root = resolve(dir);
  const target = resolve(root, to);
  const rel = relative(root, target);
  if (rel === "") return refuse("it names the directory itself");
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return refuse("it escapes the directory");
  return target;
}

const FEED_KINDS: readonly FeedKind[] = [
  "appcast",
  "winsparkle",
  "velopack",
  "appInstaller",
  "zsync",
];

/** The one shape of `release.fetch` target a renderer may send: a release record's hash (and a
 *  build id), or a `binary` decision, which names the same hash. A renderer-supplied record is
 *  never accepted: the host fetches the record itself and verifies it against its pinned release
 *  keys, so the renderer cannot choose what the SHA-256 check compares against. */
function fetchTarget(v: unknown): { sha256: string; buildId?: string } {
  const t = bag(v);
  if ("record" in t)
    throw new BridgeRefusal(
      "invalid-argument",
      "release.fetch takes a record hash (or a binary decision), not a record: the host verifies the record itself.",
    );
  const release = bag(t.release);
  const sha256 = optStr(t.sha256) ?? optStr(release.sha256);
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))
    throw new BridgeRefusal(
      "invalid-argument",
      "release.fetch target needs the release record's sha256.",
    );
  const buildId = optStr(t.buildId) ?? optStr(t.build);
  return { sha256, ...(buildId ? { buildId } : {}) };
}

/** The React desktop adapter's `CommerceClaimResult` for a Node `ClaimResult`. The stores' own
 *  failures (`error`: no answer, a 5xx) reject with their code instead. */
function bridgeClaim(r: ClaimResult): Record<string, unknown> {
  switch (r.kind) {
    case "ok":
      return {
        kind: "ok",
        store: r.store,
        productId: r.productId,
        flag: r.flag,
        deliverable: r.deliverable ?? "app",
        state: r.state,
        granted: r.granted,
        changed: r.changed,
      };
    case "not-owned":
      return {
        kind: "notOwned",
        code: r.code,
        reason: r.reason ?? "not_owned",
        status: r.status,
      };
    case "attestation-required":
      return { kind: "attestationRequired", code: r.code, status: r.status };
    case "refused":
      return {
        kind: "refused",
        code: r.code,
        ...(r.reason ? { reason: r.reason } : {}),
        status: r.status,
      };
    case "error":
      throw new BridgeRefusal(r.code, r.message);
  }
}

/** `commerce.claim`'s payload, reduced to the fields the store's claim carries. */
function claimPayload(
  store: CommerceStore,
  a: unknown,
): Record<string, unknown> {
  const p = bag(a);
  const need = (name: string): string => arg(p[name], `payload.${name}`);
  if (store === "app-store")
    return { signedTransaction: need("signedTransaction") };
  if (store === "play")
    return {
      productId: need("productId"),
      purchaseToken: need("purchaseToken"),
    };
  const dlc = p.dlcAppId;
  if (typeof dlc !== "string" && typeof dlc !== "number")
    throw new BridgeRefusal(
      "invalid-argument",
      "payload.dlcAppId must be a string or number.",
    );
  return { ticket: need("ticket"), dlcAppId: String(dlc) };
}

/**
 * Whether a renderer's install offer names the same install the host's current decision does: the
 * same installable action, release version and artifact (build, or listing URL for a store). Only
 * `binary` and `store` decisions install; anything else never matches.
 */
function sameOffer(
  current: UpdateDecision,
  offered: Record<string, unknown>,
): boolean {
  if (current.action !== "binary" && current.action !== "store") return false;
  if (offered.action !== current.action) return false;
  const release = offered.release as { version?: unknown } | undefined;
  if (!release || release.version !== current.release.version) return false;
  if (current.action === "binary") return offered.build === current.build;
  return offered.listingUrl === current.listingUrl;
}

/**
 * Register the PolarisBridge v4 handlers on `ipcMain` for `client`. Call once, after the client
 * is created; the preload (`@polaris-key/node/electron/preload`) exposes the matching
 * `window.polarisKey`. Returns a handle whose `close()` removes every handler.
 */
export function exposePolarisBridge(
  client: PolarisKeyClient,
  opts: ExposePolarisBridgeOptions,
): PolarisBridgeHandle {
  const prefix = opts.channel ?? DEFAULT_BRIDGE_CHANNEL;
  const graceMs = (opts.flowGraceSeconds ?? 60) * 1000;
  const subscribers = new Map<number, WebContentsLike>();
  const flows = new Map<string, FlowEntry>();
  for (const wc of [opts.webContents ?? []].flat()) subscribers.set(wc.id, wc);

  const currentState = (): Record<string, unknown> =>
    bridgeState(client, hostFacts(opts.electron));

  const pushState = (): void => {
    if (subscribers.size === 0) return;
    const state = currentState();
    for (const [id, wc] of subscribers) {
      if (wc.isDestroyed?.()) {
        subscribers.delete(id);
        continue;
      }
      try {
        // Re-checked at push time, like `open` and the progress push: a window that navigated off
        // the app since it subscribed gets no state (no frame, no push).
        if (!senderAllowed({ sender: wc, senderFrame: wc.mainFrame ?? null }))
          continue;
        wc.send(stateChannel(prefix), state);
      } catch {
        subscribers.delete(id);
      }
    }
  };

  const onLicense = (): void => pushState();
  const onConfig = (): void => pushState();
  client.events.on("license", onLicense);
  client.events.on("config", onConfig);
  // A new presentation member is a push too, so the renderer re-reads it (HA-13). A host's own
  // client double without the accessor simply carries none.
  const offPresentation =
    typeof client.presentationSource === "function"
      ? client.presentationSource().subscribe(() => pushState())
      : () => undefined;

  const forgetFlow = (id: string): void => {
    const f = flows.get(id);
    if (f) clearTimeout(f.timer);
    flows.delete(id);
  };
  // The restart an install staged, applied by `update.restart` (the function cannot cross IPC).
  let pendingRestart: (() => Promise<void>) | null = null;
  // The options of the last `update.decide`: an install re-derives the offer under the same ones
  // (the adapter names the decision only, so a non-default channel is kept here, not re-sent).
  let lastDecide: Parameters<PolarisKeyClient["update"]["decide"]>[0] = {};

  const senderAllowed = opts.allowSender ?? defaultAllowSender(opts.appOrigin);

  /** Update-install progress for ONE `update.install` call: pushed to the invoking sender only
   *  (never `subscribers`), at most 10 per second, and never after the install settled or its
   *  window went away. The sender is re-checked against `allowSender` on every push: a frame
   *  that navigated off the app's origin mid-install stops receiving. A custom `allowSender`
   *  that admits subframes still receives the push on the window's MAIN frame (`wc.send`): the
   *  push is addressed to the window, not to the frame that asked.
   *
   *  `finish()` (the install succeeded) sends the newest event the throttle held back, so a UI
   *  can reach `done === total`; `end()` (any outcome) stops everything and removes the
   *  `destroyed` listener. After a failure or a cancel nothing is sent, not even the held event. */
  const installProgress = (
    event: IpcMainInvokeEventLike,
    decision: UpdateDecision,
  ): {
    onProgress: (done: number, total: number) => void;
    signal: AbortSignal;
    finish: () => void;
    end: () => void;
  } => {
    const wc = event.sender;
    const ctl = new AbortController();
    let ended = false;
    let last = -Infinity;
    let held: Record<string, unknown> | null = null;
    const onDestroyed = (): void => {
      ended = true;
      held = null;
      ctl.abort();
    };
    // The window closing cancels the install: nobody is left to restart into.
    wc.once?.("destroyed", onDestroyed);
    const version =
      decision.action === "binary" || decision.action === "store"
        ? decision.release.version
        : undefined;
    const push = (payload: Record<string, unknown>): boolean => {
      try {
        if (!senderAllowed(event)) return false;
        wc.send(updateProgressChannel(prefix), payload);
        return true;
      } catch {
        // A window that cannot receive is not the install's problem.
        return false;
      }
    };
    return {
      signal: ctl.signal,
      finish: () => {
        const h = held;
        held = null;
        if (h && !ended && !wc.isDestroyed?.()) push(h);
      },
      end: () => {
        ended = true;
        held = null;
        wc.removeListener?.("destroyed", onDestroyed);
      },
      onProgress: (done, total) => {
        if (ended || wc.isDestroyed?.()) return;
        if (typeof done !== "number" || !Number.isFinite(done) || done < 0)
          return;
        // A total is a count only when it is a positive number no smaller than what arrived;
        // anything else is "unknown", never a guessed percentage.
        const known =
          typeof total === "number" &&
          Number.isFinite(total) &&
          total > 0 &&
          total >= done;
        const payload = {
          ...(version ? { version } : {}),
          done,
          total: known ? total : null,
          phase: "download",
        };
        const now = Date.now();
        if (now - last < PROGRESS_INTERVAL_MS) {
          held = payload;
          return;
        }
        held = null;
        if (push(payload)) last = now;
      },
    };
  };

  const invokeVerbs: Record<
    string,
    (args: unknown, event: IpcMainInvokeEventLike) => Promise<unknown>
  > = {
    "devices.list": async () => client.listDevices(),
    "devices.rename": async (a) => {
      const b = bag(a);
      const label = b.label;
      if (label !== null && typeof label !== "string")
        throw new BridgeRefusal(
          "invalid-argument",
          "label must be a string or null.",
        );
      await client.renameDevice(str(b.deviceId, "deviceId"), label);
      return null;
    },
    "devices.deauthorize": async (a) => {
      await client.deauthorizeDevice(str(bag(a).deviceId, "deviceId"));
      return null;
    },
    "devices.report": async () => client.devices.report(),
    "update.check": async (a) => {
      const b = bag(a);
      return client.update.check(
        typeof b.channel === "string" ? { channel: b.channel } : {},
      );
    },
    "update.decide": async (a) => {
      const b = bag(a);
      const o: Parameters<PolarisKeyClient["update"]["decide"]>[0] = {};
      if (typeof b.channel === "string") o.channel = b.channel;
      if (b.staged !== undefined)
        o.staged = b.staged as NonNullable<typeof o>["staged"];
      if (typeof b.skipVersion === "string" || b.skipVersion === null)
        o.skipVersion = b.skipVersion as string | null;
      lastDecide = o;
      return client.update.decide(o);
    },
    "update.install": async (a, event) => {
      const b = bag(a);
      const offered = b.decision;
      if (typeof offered !== "object" || offered === null)
        throw new BridgeRefusal(
          "invalid-argument",
          "decision must be an update decision.",
        );
      // The host decides what to install, never the renderer: a store decision's listing URL goes
      // to the shell, so the renderer may only confirm an offer the host makes now.
      const current = (await client.update.decide(lastDecide)).decision;
      if (!sameOffer(current, offered as Record<string, unknown>))
        throw new BridgeRefusal(
          "invalid-argument",
          "that update is no longer offered; check for updates again.",
        );
      const progress = installProgress(event, current);
      let outcome: Awaited<ReturnType<PolarisKeyClient["update"]["install"]>>;
      try {
        outcome = await client.update.install(current, {
          onProgress: progress.onProgress,
          signal: progress.signal,
        });
        // Installed: the newest held-back event goes out before the answer.
        progress.finish();
      } finally {
        // Success, failure or cancel: nothing is pushed after the install has settled.
        progress.end();
      }
      // Any install clears a restart left pending from an earlier one.
      pendingRestart = null;
      if (outcome.kind === "restartRequired") {
        pendingRestart = outcome.restart;
        notify("updateReady");
        return { kind: outcome.kind, version: outcome.version };
      }
      return outcome;
    },
    "update.restart": async () => {
      const restart = pendingRestart;
      if (!restart)
        throw new BridgeRefusal(
          "not-configured",
          "no install is staged to restart into.",
        );
      pendingRestart = null;
      await restart();
      return null;
    },
    "update.markBootAttempt": async () => client.update.markBootAttempt(),
    "update.confirmBoot": async () => {
      await client.update.confirmBoot();
      return null;
    },
    "core.presentationIcon": async (a) => {
      const b = bag(a);
      const num = (v: unknown, fallback: number): number =>
        typeof v === "number" && Number.isFinite(v) ? v : fallback;
      const decodable = Array.isArray(b.decodable)
        ? b.decodable.filter((t): t is string => typeof t === "string")
        : undefined;
      return client.presentationIcon({
        px: num(b.px, 64),
        scale: num(b.scale, 1),
        ...(decodable ? { decodable } : {}),
      });
    },
    "release.changelog": async () => client.release.changelog(),
    "release.installUrl": async () => client.release.installUrl(),
    "release.downloadUrl": async (a) => {
      const b = bag(a);
      const o: { checksum?: boolean; dmg?: boolean } = {};
      if (typeof b.checksum === "boolean") o.checksum = b.checksum;
      if (typeof b.dmg === "boolean") o.dmg = b.dmg;
      return client.release.downloadUrl(
        str(b.version, "version"),
        str(b.binary, "binary"),
        str(b.arch, "arch"),
        o,
      );
    },
    // ── v4 (SP-R07) ────────────────────────────────────────────────────────────────────
    "config.mint": async (a) => {
      const m = await client.config.mintToken(arg(bag(a).recipeId, "recipeId"));
      return { token: m.token, expiresAt: m.expiresAt };
    },
    "commerce.binding": async () => {
      const r = await client.commerce.binding();
      if (r.kind !== "ok") throw new BridgeRefusal(r.code, r.message);
      return {
        bindingId: r.bindingId,
        products: r.products.map((p) => ({
          store: p.store,
          productId: p.productId,
          flag: p.flag,
          deliverable: p.deliverable ?? "app",
        })),
      };
    },
    "commerce.claim": async (a) => {
      const b = bag(a);
      const store = arg(b.store, "store");
      if (store !== "app-store" && store !== "play" && store !== "steam")
        throw new BridgeRefusal(
          "invalid-argument",
          "store must be app-store, play or steam.",
        );
      const r = await client.commerce.claim(
        store,
        claimPayload(store, b.payload),
        {
          sync: true,
        },
      );
      const out = bridgeClaim(r);
      if (r.kind === "ok") pushState();
      return out;
    },
    "core.discovery": async () => {
      const known = client.discovery();
      if (known) return known;
      const r = await client.discover();
      return r.kind === "ok" ? r.manifest : null;
    },
    "core.storeStatus": async () => client.storeStatus(),
    "devices.id": async () => client.currentDevice().id,
    // ── I-10a.9: the account ─────────────────────────────────────────────────────────────
    "identity.subject": async () => client.identity.subject(),
    "identity.attach": async (a) => {
      const r = await client.identity.attach({
        confirm: bag(a).confirm === true,
      });
      // The renderer's `{kind}` vocabulary.
      if (r.status === "confirm")
        return { kind: "confirm", license: r.license };
      if (r.status === "refused")
        return { kind: "refused", code: r.code, status: r.httpStatus };
      pushState();
      return {
        kind: "ok",
        subject: r.subject,
        ...(r.attached ? { attached: r.attached } : {}),
      };
    },
    "identity.openAccount": async () => {
      await client.identity.openAccount();
      return null;
    },
    // ── v4 (SP-12) ─────────────────────────────────────────────────────────────────────
    "core.boot": async (a) => {
      const b = bag(a);
      const o: ClientBootOptions = {};
      if (
        b.consent === "always" ||
        b.consent === "metered" ||
        b.consent === "never"
      )
        o.consent = b.consent;
      if (typeof b.metered === "boolean") o.metered = b.metered;
      if (typeof b.allowOffline === "boolean") o.allowOffline = b.allowOffline;
      if (typeof b.allowGrace === "boolean") o.allowGrace = b.allowGrace;
      if (typeof b.autoConfirm === "boolean") o.autoConfirm = b.autoConfirm;
      if (typeof b.registration === "boolean") o.registration = b.registration;
      if (Array.isArray(b.requiredPacks))
        o.requiredPacks = b.requiredPacks.filter(
          (p): p is string => typeof p === "string",
        );
      const r = await client.boot(o);
      pushState();
      return {
        outcome: r.outcome,
        state: r.state,
        license: r.license,
        decision: r.decision,
        emits: r.emits,
        guard: r.guard,
      };
    },
    "core.crashTags": async (a) => {
      const b = bag(a);
      return client.crashTags({
        ...(optStr(b.deliverable)
          ? { deliverable: optStr(b.deliverable)! }
          : {}),
        ...(typeof b.build === "string" || b.build === null
          ? { build: b.build }
          : {}),
      });
    },
    // SP-58: the pre-synced X-PKey-License and X-PKey-Device. The renderer decides which
    // origins get them; the host only hands them over.
    // With backend.origins configured, the renderer must name the origin it will send them to,
    // and it must be one of those: the licence document never goes to a page's choice of host.
    "core.backendHeaders": async (a) => {
      const allowed = client.backend.origins;
      if (allowed.length > 0) {
        const origin = optStr(bag(a).origin);
        let ok = false;
        try {
          ok = origin !== undefined && allowed.includes(new URL(origin).origin);
        } catch {
          ok = false;
        }
        if (!ok)
          throw new BridgeRefusal(
            ErrorCode.backendOriginNotAllowed,
            "That origin is not in the host's backend.origins.",
          );
      }
      return client.backend.headers();
    },
    "release.fetch": async (a) => {
      const b = bag(a);
      if (!opts.downloadDir)
        throw new BridgeRefusal(
          "not-configured",
          "This desktop host sets no download directory, so it does not write downloads.",
        );
      const to = resolveDownloadPath(opts.downloadDir, b.to);
      const r = await client.release.fetch(fetchTarget(b.target), { to });
      pushState();
      return {
        path: r.path,
        size: r.size,
        sha256: r.sha256,
        version: r.version,
        buildId: r.buildId,
      };
    },
    "distribution.downloadModel": async (a) => {
      const channel = optStr(bag(a).channel);
      return client.distribution.downloadModel(channel ? { channel } : {});
    },
    "distribution.thisPlatform": async (a) => {
      const b = bag(a);
      const channel = optStr(b.channel);
      const platform = optStr(b.platform);
      return client.distribution.thisPlatform({
        ...(channel ? { channel } : {}),
        ...(platform ? { platform } : {}),
      });
    },
    "update.feedUrl": async (a) => {
      const b = bag(a);
      const kind = FEED_KINDS.find((k) => k === b.kind);
      if (!kind)
        throw new BridgeRefusal(
          "invalid-argument",
          `kind must be one of ${FEED_KINDS.join(", ")}.`,
        );
      const o: Parameters<PolarisKeyClient["update"]["feedUrl"]>[1] = {};
      for (const k of [
        "channel",
        "velopackChannel",
        "buildId",
        "arch",
      ] as const) {
        const v = optStr(b[k]);
        if (v) o[k] = v;
      }
      return client.update.feedUrl(kind, o);
    },
    // ── v4 (SP-13 config.local, SP-14 update-health events) ───────────────────────────
    "config.set": async (a) => {
      const b = bag(a);
      if (!("value" in b))
        throw new BridgeRefusal("invalid-argument", "value is required.");
      await client.config.set(
        arg(b.key, "key"),
        b.value as Parameters<PolarisKeyClient["config"]["set"]>[1],
      );
      pushState();
      return null;
    },
    "config.clear": async (a) => {
      await client.config.clear(arg(bag(a).key, "key"));
      pushState();
      return null;
    },
    "update.journal": async (a) => {
      const b = bag(a);
      return client.update.journal.record(
        arg(b.event, "event") as UpdateEvent,
        {
          release: arg(b.release, "release"),
          ...(typeof b.fromRelease === "string" || b.fromRelease === null
            ? { fromRelease: b.fromRelease }
            : {}),
          ...(optStr(b.deliverable)
            ? { deliverable: optStr(b.deliverable)! }
            : {}),
          ...(optStr(b.channel) ? { channel: optStr(b.channel)! } : {}),
          ...(typeof b.packSetId === "string" || b.packSetId === null
            ? { packSetId: b.packSetId }
            : {}),
          ...(typeof b.code === "string" || b.code === null
            ? { code: b.code }
            : {}),
        },
      );
    },
  };
  for (const v of DEFAULT_INVOKE_VERBS)
    if (!invokeVerbs[v]) throw new Error(`bridge verb ${v} has no handler`);
  for (const [name, fn] of Object.entries(opts.invoke?.extra ?? {}))
    invokeVerbs[name] = async (a) => fn(a);

  const handlers: Record<
    BridgeMethod,
    (event: IpcMainInvokeEventLike, ...args: unknown[]) => Promise<unknown>
  > = {
    getSyncState: async () => currentState(),
    refresh: async () => {
      await client.sync({ force: true });
      return currentState();
    },
    beginSignIn: async (_e, begin) => {
      // v4: the renderer's device name wins over the host option, which stays the default.
      const deviceName = optStr(bag(begin).deviceName) ?? opts.deviceName;
      const prompt = await client.identity.signIn.start({
        channel: "device-code",
        ...(deviceName ? { deviceName } : {}),
      });
      const flowId = randomUUID();
      const ttl = Math.max(0, prompt.expiresIn * 1000) + graceMs;
      const timer = setTimeout(() => flows.delete(flowId), ttl);
      timer.unref?.();
      flows.set(flowId, { prompt, timer });
      return {
        flowId,
        verificationUrl: prompt.verificationUriComplete,
        userCode: prompt.userCode,
        verificationUri: prompt.verificationUri,
        expiresAt: prompt.expiresAt,
        interval: prompt.interval,
      };
    },
    pollSignIn: async (_e, flowId) => {
      const flow = flows.get(str(flowId, "flowId"));
      if (!flow) return { kind: "expired" };
      let r;
      try {
        r = await flow.prompt.wait({ once: true });
      } catch (e) {
        // Transport trouble says nothing about the sign-in: keep polling.
        const code = (e as { code?: unknown }).code;
        if (code === "network-error" || code === "server-error")
          return { kind: "pending" };
        if (code === ErrorCode.signInDenied) {
          forgetFlow(flowId as string);
          return { kind: "denied" };
        }
        if (code === ErrorCode.signInFailed) {
          forgetFlow(flowId as string);
          return { kind: "error", message: (e as Error).message };
        }
        throw e;
      }
      switch (r.kind) {
        case "pending":
        case "choose":
          return { kind: "pending" };
        case "signedIn":
          forgetFlow(flowId as string);
          pushState();
          notify("signedIn");
          return r.identity
            ? { kind: "ok", identity: r.identity }
            : { kind: "ok" };
        case "expired":
        case "cancelled":
          forgetFlow(flowId as string);
          return { kind: "expired" };
      }
    },
    submitKey: async (_e, key) => {
      const r = await client.license.activateWithKey(str(key, "key"));
      if (r.kind === "ok") pushState();
      return bridgeActivation(r);
    },
    signOut: async () => {
      await client.identity.signOut();
      pushState();
      return null;
    },
    invoke: async (event, service, method, args) => {
      const name = `${str(service, "service")}.${str(method, "method")}`;
      const fn = Object.hasOwn(invokeVerbs, name) ? invokeVerbs[name] : null;
      if (!fn)
        throw new BridgeRefusal(
          "invoke-not-allowed",
          `This desktop host does not expose ${name} to the renderer.`,
        );
      const value = await fn(args, event);
      if (name === "devices.deauthorize") pushState();
      return value ?? null;
    },
    fetchSchema: async () => client.config.fetchSchema(),
    importBundle: async (_e, jws) => {
      const r = await client.importBundle(str(jws, "jws"));
      pushState();
      return r;
    },
    openExternal: async (_e, url) => {
      const raw = str(url, "url");
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new BridgeRefusal(
          "invalid-argument",
          "url must be an https URL.",
        );
      }
      if (u.protocol !== "https:" || u.username || u.password)
        throw new BridgeRefusal(
          "invalid-argument",
          "url must be an https URL.",
        );
      if (!opts.shell)
        throw new BridgeRefusal(
          "not-configured",
          "This desktop host has no shell to open links with.",
        );
      await opts.shell.openExternal(u.href);
      return true;
    },
    subscribe: async (event) => {
      const wc = event.sender;
      if (!subscribers.has(wc.id)) {
        subscribers.set(wc.id, wc);
        wc.once?.("destroyed", () => subscribers.delete(wc.id));
      }
      return { version: POLARIS_BRIDGE_VERSION };
    },
    unsubscribe: async (event) => {
      subscribers.delete(event.sender.id);
      return null;
    },
  };

  for (const method of BRIDGE_METHODS) {
    const handler = handlers[method];
    opts.ipcMain.handle(
      channelOf(prefix, method),
      async (event, ...args): Promise<BridgeEnvelope> => {
        try {
          if (!senderAllowed(event))
            throw new BridgeRefusal(
              "sender-refused",
              "This window may not use the Polaris Key bridge.",
            );
          return { ok: true, value: await handler(event, ...args) };
        } catch (e) {
          return envelopeError(e);
        }
      },
    );
  }

  // OS notifications (opt-in). A failure here is never the verb's failure.
  const live = new Set<NotificationLike>();
  const notify = (kind: "updateReady" | "signedIn"): void => {
    const n = opts.notifications;
    if (!n) return;
    try {
      if (n.isAppFocused()) return;
      if (n.Notification.isSupported && !n.Notification.isSupported()) return;
      const locale = resolveLocale(n.locale);
      const text = (part: "title" | "body"): string =>
        KIT_COPY[locale][`notify.${kind}.${part}`] ??
        KIT_COPY.en[`notify.${kind}.${part}`]!;
      const note = new n.Notification({
        title: text("title"),
        body: text("body"),
      });
      live.add(note); // kept until it is clicked or closed, so it is not collected unseen
      note.on("click", () => {
        live.delete(note);
        try {
          n.onClick?.();
        } catch {
          // The host's focus handler failing is its own.
        }
      });
      note.on("close", () => void live.delete(note));
      note.show();
    } catch {
      // No notification is better than a failed install or sign-in.
    }
  };

  const open = (view: KitView): void => {
    if (!KIT_VIEWS.includes(view))
      throw new Error(`open(): ${String(view)} is not a view the kit opens.`);
    for (const [id, wc] of subscribers) {
      if (wc.isDestroyed?.()) {
        subscribers.delete(id);
        continue;
      }
      try {
        // Re-checked at push time, as the progress push is: a window that navigated off the app
        // since it subscribed gets nothing. `allowSender` runs against the window's main frame
        // (what a call from the window's top frame would have carried); no frame, no push.
        if (!senderAllowed({ sender: wc, senderFrame: wc.mainFrame ?? null }))
          continue;
        wc.send(openChannel(prefix), view);
      } catch {
        subscribers.delete(id);
      }
    }
  };

  const menuItems = (
    o: { platform?: string; locale?: string } = {},
  ): PolarisMenuItem[] => {
    const locale = resolveLocale(o.locale);
    const platform = o.platform ?? process.platform;
    const mac = platform === "darwin" || platform === "macos";
    return MENU_ITEMS.map(({ id, key, view }) => ({
      id,
      // The macOS wording is English's (the catalog's `macos` variants); other locales keep
      // their own text on every platform.
      label:
        (mac && locale === "en" ? KIT_COPY_VARIANTS[key]?.macos : undefined) ??
        KIT_COPY[locale][key] ??
        KIT_COPY.en[key]!,
      click: () => open(view),
    }));
  };

  return {
    pushState,
    open,
    menuItems,
    close() {
      for (const method of BRIDGE_METHODS)
        opts.ipcMain.removeHandler(channelOf(prefix, method));
      client.events.off("license", onLicense);
      client.events.off("config", onConfig);
      offPresentation();
      for (const id of [...flows.keys()]) forgetFlow(id);
      subscribers.clear();
      live.clear();
    },
  };
}
