// The two Electron exports `./preload.ts` imports, declared so this package type-checks without
// depending on `electron` (the host's own dependency). Only the members the preload passes on;
// they match `IpcRendererLike` and `ContextBridgeLike` in ./renderer.ts.
declare module "electron" {
  type Listener = (event: unknown, ...args: unknown[]) => void;
  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: Listener): unknown;
    removeListener(channel: string, listener: Listener): unknown;
  };
}
