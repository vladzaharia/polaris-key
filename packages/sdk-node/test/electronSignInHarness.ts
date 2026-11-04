// The bridge host the device-code sign-in suites share (electronChoice, electronSignInCancel): a
// fake Node client whose `signIn.start` answers one session, behind the real bridge and an
// in-process ipc pair.

import { vi, type Mock } from "vitest";
import type { PolarisBridge } from "@polaris-key/react/desktop";
import type { PolarisKeyClient } from "../src/client.js";
import { PolarisEventEmitter } from "../src/core/events.js";
import { exposePolarisBridge } from "../src/electron/main.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";

export const GRANT = "sg_WORKER_GRANT_never_leaves_the_host_process_01";

type AnyMock = Mock<(...args: any[]) => any>;

export function signInHost<C extends object>(
  choice: C,
  wait: () => Promise<unknown>,
): {
  bridge: PolarisBridge;
  handle: { close(): void };
  identity: { signIn: { start: AnyMock }; choice: C; signOut: AnyMock };
  session: { cancel: AnyMock; wait: AnyMock };
  choice: C;
  ipc: ReturnType<typeof ipcPair>;
} {
  const events = new PolarisEventEmitter();
  const session = {
    userCode: "ABCD-EFGH",
    verificationUri: "https://id.example.test/d",
    verificationUriComplete: "https://id.example.test/d?c=1",
    expiresIn: 600,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    interval: 2,
    wait: vi.fn(wait),
    cancel: vi.fn(),
  };
  const identity = {
    signIn: { start: vi.fn(async () => session) },
    choice,
    signOut: vi.fn(async () => {
      events.emit("identity", { kind: "signedOut", released: false });
      return { released: false };
    }),
  };
  const client = {
    identity,
    events,
    presentationSource: () => ({ subscribe: () => () => undefined }),
    presentation: () => null,
    config: { localValues: () => ({}), entries: () => null },
    capabilities: () => ({}),
    getSyncState: () => ({ state: "licensed" }),
  } as unknown as PolarisKeyClient;
  const ipc = ipcPair();
  const handle = exposePolarisBridge(client, {
    ipcMain: ipc.ipcMain,
    allowSender: allowApp,
  });
  const bridge: PolarisBridge = createPreloadBridge(ipc.ipcRenderer);
  return { bridge, handle, identity, session, choice, ipc };
}
