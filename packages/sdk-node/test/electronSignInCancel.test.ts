// The bridge verb that ends a sign-in flow from its window, for the device-code flow and the
// choice ref a flow can hold. The redirect flow's cases are in electronNativeRedirect.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { PolarisKeyClient } from "../src/client.js";
import type { PolarisBridge } from "@polaris-key/react/desktop";
import { PolarisEventEmitter } from "../src/core/events.js";
import { exposePolarisBridge } from "../src/electron/main.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";

const GRANT = "sg_WORKER_GRANT_never_leaves_the_host_process_01";

function setup(wait: () => Promise<unknown>) {
  const events = new PolarisEventEmitter();
  const choice = {
    cancel: vi.fn(async () => ({ kind: "ok" })),
    complete: vi.fn(async () => ({ kind: "ok" })),
    licenses: vi.fn(async () => ({ kind: "ok", view: {} })),
  };
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
  return {
    bridge: createPreloadBridge(ipc.ipcRenderer),
    handle,
    identity,
    session,
    choice,
  };
}

const end = (h: ReturnType<typeof setup>, flowId: string) =>
  h.bridge.invoke!("identity", "signIn.cancel", { flowId });

describe("ending a device-code flow from its window", () => {
  it("cancels the session; the next poll is expired", async () => {
    const h = setup(async () => ({ kind: "pending", interval: 2 }));
    const b = (await h.bridge.beginSignIn()) as { flowId: string };
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(h.session.cancel).toHaveBeenCalledTimes(1);
    expect(await h.bridge.pollSignIn(b.flowId)).toEqual({ kind: "expired" });
    expect(await end(h, b.flowId)).toEqual({ ended: false });
    h.handle.close();
  });

  it("a poll in flight when the flow is ended answers expired and signs nothing out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Like the real session: a cancel during the poll wins over the answer.
    let cancelled = false;
    const h = setup(async () => {
      await gate;
      return cancelled
        ? { kind: "cancelled" }
        : { kind: "signedIn", subject: null, activation: {} };
    });
    h.session.cancel.mockImplementation(() => {
      cancelled = true;
    });
    const b = (await h.bridge.beginSignIn()) as { flowId: string };
    const polling = h.bridge.pollSignIn(b.flowId);
    await new Promise((r) => setTimeout(r, 0));
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    release();
    expect(await polling).toEqual({ kind: "expired" });
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("sign-out ends the flow's choice and the flow", async () => {
    const h = setup(async () => ({ kind: "pending", interval: 2 }));
    const b = (await h.bridge.beginSignIn()) as { flowId: string };
    await h.bridge.signOut();
    expect(await h.bridge.pollSignIn(b.flowId)).toEqual({ kind: "expired" });
    expect(await end(h, b.flowId)).toEqual({ ended: false });
    h.handle.close();
  });

  it("releases a held choice ref", async () => {
    const h = setup(async () => ({
      kind: "choose",
      grant: GRANT,
      expiresIn: 300,
      choices: { state: "choose", choices: [] },
    }));
    const b = (await h.bridge.beginSignIn({
      licenseChoice: "app",
    })) as { flowId: string };
    const r = (await h.bridge.pollSignIn(b.flowId)) as {
      kind: string;
      grant: string;
    };
    if (r.kind !== "choose") throw new Error("expected choose");
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(
      await h.bridge.invoke!("identity", "choice.licenses", { grant: r.grant }),
    ).toMatchObject({ kind: "refused", code: "invalid_grant" });
    expect(h.choice.licenses).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("a cancel while the held ref is idle ends the flow and stores nothing", async () => {
    const h = setup(async () => ({
      kind: "choose",
      grant: GRANT,
      expiresIn: 300,
      choices: { state: "choose", choices: [] },
    }));
    const b = (await h.bridge.beginSignIn({
      licenseChoice: "app",
    })) as { flowId: string };
    await h.bridge.pollSignIn(b.flowId);
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(h.choice.complete).not.toHaveBeenCalled();
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("a cancel while the completion is in flight is too late: the sign-in finishes and stays", async () => {
    const h = setup(async () => ({
      kind: "choose",
      grant: GRANT,
      expiresIn: 300,
      choices: { state: "choose", choices: [] },
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.choice.complete.mockImplementation(async () => {
      await gate;
      return { kind: "ok" };
    });
    const b = (await h.bridge.beginSignIn({
      licenseChoice: "app",
    })) as { flowId: string };
    const r = (await h.bridge.pollSignIn(b.flowId)) as {
      kind: string;
      grant: string;
    };
    const completing = h.bridge.invoke!("identity", "choice.complete", {
      grant: r.grant,
      choice: { kind: "keep" },
    });
    await new Promise((x) => setTimeout(x, 0));
    expect(await end(h, b.flowId)).toEqual({ ended: false });
    release();
    expect(await completing).toMatchObject({ kind: "ok" });
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });
});
