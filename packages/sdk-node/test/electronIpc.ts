// An in-process ipcMain/ipcRenderer pair for the Electron bridge suites (here and in
// `@polaris-key/react`'s desktop host test). It structured-clones every message, as Electron
// does, so a function or class instance in a reply fails the test.

import type { IpcMainLike } from "../src/electron/index.js";
import type { IpcRendererLike } from "../src/electron/renderer.js";

export function ipcPair() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<
    string,
    Set<(e: unknown, ...a: unknown[]) => void>
  >();
  const sender = {
    id: 7,
    mainFrame: { url: "app://main" } as { url: string },
    send(channel: string, ...args: unknown[]) {
      for (const l of listeners.get(channel) ?? [])
        l({}, ...structuredClone(args));
    },
    once() {
      return undefined;
    },
  };
  let allowed = true;
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn as never),
    removeHandler: (ch) => void handlers.delete(ch),
  };
  const ipcRenderer: IpcRendererLike = {
    async invoke(ch, ...args) {
      const h = handlers.get(ch);
      if (!h) throw new Error(`No handler registered for '${ch}'`);
      const event = {
        sender,
        senderFrame: { url: allowed ? "app://main" : "https://evil.test" },
      };
      return structuredClone(await h(event, ...structuredClone(args)));
    },
    on(ch, l) {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(l);
    },
    removeListener(ch, l) {
      listeners.get(ch)?.delete(l);
    },
  };
  return {
    ipcMain,
    ipcRenderer,
    handlers,
    sender,
    deny: () => {
      allowed = false;
    },
  };
}

/** The sender rule the suites pass as `allowSender`: the app's own scheme. */
export const allowApp = (e: {
  senderFrame?: { url: string } | null;
}): boolean => e.senderFrame?.url.startsWith("app://") === true;
