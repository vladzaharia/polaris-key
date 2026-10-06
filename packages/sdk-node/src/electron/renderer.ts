// The preload half of the PolarisBridge (SDK parity pass SP-N10): a `PolarisBridge` v3 object
// over `ipcRenderer`, for `contextBridge.exposeInMainWorld`. No Node or Electron import, so a
// sandboxed preload bundle can include it; `./preload.ts` is the one-line wiring.
//
// The object is plain (functions and a number), which is what `contextBridge` can clone. Every
// method unwraps the main process's envelope and rethrows a refusal as an `Error` carrying the
// host's `code` (and an update refusal's `detail`), which is how `@polaris-key/react`'s desktop
// adapter maps it.

import {
  DEFAULT_BRIDGE_CHANNEL,
  DEFAULT_BRIDGE_KEY,
  POLARIS_BRIDGE_VERSION,
  channelOf,
  stateChannel,
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

/** A refusal from the host, as the renderer sees it. */
export class PolarisBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "PolarisBridgeError";
  }
}

export interface PreloadBridgeOptions {
  /** The IPC channel prefix; the main process's `exposePolarisBridge` must use the same. */
  channel?: string;
}

/** The bridge object the preload exposes. Its shape is `@polaris-key/react`'s `PolarisBridge`
 *  (protocol v3); `test/electronBridge.test.ts` pins the assignability. */
export interface PreloadPolarisBridge {
  readonly version: number;
  getSyncState(): Promise<never>;
  refresh(): Promise<never>;
  beginSignIn(): Promise<never>;
  pollSignIn(flowId: string): Promise<never>;
  submitKey(key: string): Promise<never>;
  signOut(): Promise<void>;
  invoke(service: string, method: string, args?: unknown): Promise<unknown>;
  fetchSchema(): Promise<never>;
  importBundle(jws: string): Promise<never>;
  on(event: "stateChanged", cb: (state: never) => void): () => void;
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

/** Build the PolarisBridge v3 object over `ipcRenderer`. */
export function createPreloadBridge(
  ipc: IpcRendererLike,
  opts: PreloadBridgeOptions = {},
): PreloadPolarisBridge {
  const prefix = opts.channel ?? DEFAULT_BRIDGE_CHANNEL;
  const call = async (method: BridgeMethod, ...args: unknown[]) =>
    unwrap(await ipc.invoke(channelOf(prefix, method), ...args));
  const listeners = new Set<(state: never) => void>();
  let subscribed = false;
  const onState = (_event: unknown, state: unknown): void => {
    for (const cb of [...listeners]) {
      try {
        cb(state as never);
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
    beginSignIn: () => call("beginSignIn") as Promise<never>,
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
    on(event: "stateChanged", cb: (state: never) => void): () => void {
      if (event !== "stateChanged") return () => undefined;
      listeners.add(cb);
      if (!subscribed) {
        subscribed = true;
        ipc.on(stateChannel(prefix), onState);
        void call("subscribe").catch(() => undefined);
      }
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && subscribed) {
          subscribed = false;
          ipc.removeListener(stateChannel(prefix), onState);
          void call("unsubscribe").catch(() => undefined);
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
