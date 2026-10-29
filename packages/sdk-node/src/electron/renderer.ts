// The preload half of the PolarisBridge (SDK parity pass SP-N10, v4 in SP-31): a `PolarisBridge`
// v4 object over `ipcRenderer`, for `contextBridge.exposeInMainWorld`. No Node or Electron import, so a
// sandboxed preload bundle can include it; `./preload.ts` is the one-line wiring.
//
// The object is plain (functions and a number), which is what `contextBridge` can clone. Every
// method unwraps the main process's envelope and rethrows a refusal as a `PolarisBridgeError` (a
// `PolarisError`) carrying the host's `code` (and an update refusal's `detail`), which is how
// `@polaris-key/react`'s desktop adapter maps it. `@polaris-key/client-core/errors` is the one
// import outside this directory: the error class alone, with no Node or Electron dependency.

import { PolarisError } from "@polaris-key/client-core/errors";
import {
  DEFAULT_BRIDGE_CHANNEL,
  DEFAULT_BRIDGE_KEY,
  POLARIS_BRIDGE_VERSION,
  channelOf,
  KIT_VIEWS,
  openChannel,
  stateChannel,
  updateProgressChannel,
  type KitView,
  type BridgeEnvelope,
  type BridgeMethod,
} from "./protocol.js";

/** The part of Electron's `ipcRenderer` the preload uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): unknown;
}

/** The part of Electron's `contextBridge` the preload uses. */
export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

/** A refusal from the host, as the renderer sees it: a `PolarisError` with the host's code. */
export class PolarisBridgeError extends PolarisError {
  readonly detail: string | null;

  constructor(code: string, message: string, detail: string | null = null) {
    super(code, message);
    this.name = "PolarisBridgeError";
    this.detail = detail;
  }
}

export interface PreloadBridgeOptions {
  /** The IPC channel prefix; the main process's `exposePolarisBridge` must use the same. */
  channel?: string;
}

/** The bridge object the preload exposes. Its shape is `@polaris-key/react`'s `PolarisBridge`
 *  (protocol v4); `test/electronBridge.test.ts` pins the assignability. */
export interface PreloadPolarisBridge {
  readonly version: number;
  getSyncState(): Promise<never>;
  refresh(): Promise<never>;
  beginSignIn(opts?: { deviceName?: string }): Promise<never>;
  pollSignIn(flowId: string): Promise<never>;
  submitKey(key: string): Promise<never>;
  signOut(): Promise<void>;
  invoke(service: string, method: string, args?: unknown): Promise<unknown>;
  fetchSchema(): Promise<never>;
  importBundle(jws: string): Promise<never>;
  /** v4 (UK-06.16): open an https link in the system browser (the host refuses anything else). */
  openExternal(url: string): Promise<boolean>;
  on(event: "stateChanged", cb: (state: never) => void): () => void;
  /** v4 (UK-06.3): progress of an `update.install` this window started. */
  onUpdateProgress(cb: (p: PreloadUpdateProgress) => void): () => void;
  /** v4 (UK-06.4): the host asks this window to open a view (a native menu item). */
  onOpen(cb: (view: KitView) => void): () => void;
}

/** One pushed update-install progress event, as `@polaris-key/react`'s `BridgeUpdateProgress`. */
export interface PreloadUpdateProgress {
  done: number;
  total?: number | null;
  version?: string;
  phase?: "download";
}

function unwrap(raw: unknown): unknown {
  const env = raw as BridgeEnvelope | null;
  if (!env || typeof env !== "object" || typeof env.ok !== "boolean")
    throw new PolarisBridgeError(
      "bridge-protocol",
      "The Polaris Key host answered outside the bridge protocol.",
    );
  if (env.ok) return env.value;
  throw new PolarisBridgeError(env.code, env.message, env.detail ?? null);
}

/** Build the PolarisBridge v4 object over `ipcRenderer`. */
export function createPreloadBridge(
  ipc: IpcRendererLike,
  opts: PreloadBridgeOptions = {},
): PreloadPolarisBridge {
  const prefix = opts.channel ?? DEFAULT_BRIDGE_CHANNEL;
  const call = async (method: BridgeMethod, ...args: unknown[]) =>
    unwrap(await ipc.invoke(channelOf(prefix, method), ...args));
  const listeners = new Set<(state: never) => void>();
  let subscribed = false;
  // `subscribe` is the host's list of windows it may push to (state and open); it is held while
  // anything here listens for either.
  let holders = 0;
  const hold = (): void => {
    if (holders++ === 0) void call("subscribe").catch(() => undefined);
  };
  const release = (): void => {
    if (--holders === 0) void call("unsubscribe").catch(() => undefined);
  };
  const openListeners = new Set<(view: KitView) => void>();
  const onOpenPush = (_event: unknown, view: unknown): void => {
    if (typeof view !== "string" || !KIT_VIEWS.includes(view as KitView))
      return;
    for (const cb of [...openListeners]) {
      try {
        cb(view as KitView);
      } catch {
        // A renderer listener's failure is its own.
      }
    }
  };
  const onState = (_event: unknown, state: unknown): void => {
    for (const cb of [...listeners]) {
      try {
        cb(state as never);
      } catch {
        // A renderer listener's failure is its own.
      }
    }
  };
  const progressListeners = new Set<(p: PreloadUpdateProgress) => void>();
  const onProgress = (_event: unknown, raw: unknown): void => {
    // Only the three counted fields cross to the page, whatever the main process sent.
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.done !== "number" || !Number.isFinite(r.done)) return;
    const p: PreloadUpdateProgress = {
      done: r.done,
      total:
        typeof r.total === "number" && Number.isFinite(r.total)
          ? r.total
          : null,
      phase: "download",
    };
    if (typeof r.version === "string") p.version = r.version;
    for (const cb of [...progressListeners]) {
      try {
        cb(p);
      } catch {
        // A renderer listener's failure is its own.
      }
    }
  };
  // `never` in the declared returns lets the object satisfy the renderer's richer types (the
  // values are whatever the main process sent); the casts below are the one place that says so.
  const bridge = {
    version: POLARIS_BRIDGE_VERSION,
    getSyncState: () => call("getSyncState") as Promise<never>,
    refresh: () => call("refresh") as Promise<never>,
    beginSignIn: (opts?: { deviceName?: string }) =>
      call("beginSignIn", opts) as Promise<never>,
    pollSignIn: (flowId: string) =>
      call("pollSignIn", flowId) as Promise<never>,
    submitKey: (key: string) => call("submitKey", key) as Promise<never>,
    signOut: async () => {
      await call("signOut");
    },
    invoke: (service: string, method: string, args?: unknown) =>
      call("invoke", service, method, args),
    fetchSchema: () => call("fetchSchema") as Promise<never>,
    importBundle: (jws: string) => call("importBundle", jws) as Promise<never>,
    openExternal: async (url: string) =>
      (await call("openExternal", url)) === true,
    onUpdateProgress(cb: (p: PreloadUpdateProgress) => void): () => void {
      progressListeners.add(cb);
      if (progressListeners.size === 1)
        ipc.on(updateProgressChannel(prefix), onProgress);
      return () => {
        if (!progressListeners.delete(cb)) return;
        if (progressListeners.size === 0)
          ipc.removeListener(updateProgressChannel(prefix), onProgress);
      };
    },
    onOpen(cb: (view: KitView) => void): () => void {
      openListeners.add(cb);
      if (openListeners.size === 1) {
        ipc.on(openChannel(prefix), onOpenPush);
        hold();
      }
      return () => {
        if (!openListeners.delete(cb) || openListeners.size > 0) return;
        ipc.removeListener(openChannel(prefix), onOpenPush);
        release();
      };
    },
    on(event: "stateChanged", cb: (state: never) => void): () => void {
      if (event !== "stateChanged") return () => undefined;
      listeners.add(cb);
      if (!subscribed) {
        subscribed = true;
        ipc.on(stateChannel(prefix), onState);
        hold();
      }
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && subscribed) {
          subscribed = false;
          ipc.removeListener(stateChannel(prefix), onState);
          release();
        }
      };
    },
  };
  return bridge;
}

/** Expose the bridge as `window.<key>` (default `window.polarisKey`, which the React desktop
 *  adapter finds on its own). */
export function exposePolarisBridgeInMainWorld(
  electron: { contextBridge: ContextBridgeLike; ipcRenderer: IpcRendererLike },
  opts: PreloadBridgeOptions & { key?: string } = {},
): void {
  electron.contextBridge.exposeInMainWorld(
    opts.key ?? DEFAULT_BRIDGE_KEY,
    createPreloadBridge(electron.ipcRenderer, opts),
  );
}
