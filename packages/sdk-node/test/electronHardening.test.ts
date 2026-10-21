// @pkey-feature core.errors
// B-152: the bridge's refusal codes have one spelling (all registered), the default sender rule
// refuses documents a page can synthesise, and a non-Polaris error never reaches the renderer
// with its message.

import { describe, expect, it } from "vitest";
import { ErrorCode } from "../src/constants.generated.js";
import { exposePolarisBridge } from "../src/electron/index.js";
import { channelOf, DEFAULT_BRIDGE_CHANNEL } from "../src/electron/protocol.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";
import { seededClient, signedLicense } from "./parityFixtures.js";

async function host(allow: boolean) {
  const seeded = await seededClient({
    license: await signedLicense({ pro: true }),
    token: "pkeyt_seed",
    routes: {},
  });
  const ipc = ipcPair();
  exposePolarisBridge(seeded.client, {
    ipcMain: ipc.ipcMain,
    ...(allow ? { allowSender: allowApp } : {}),
  });
  return { ...seeded, ipc, bridge: createPreloadBridge(ipc.ipcRenderer) };
}

describe("bridge refusal codes", () => {
  it("spells a malformed argument one way on every verb, and registers each code", async () => {
    const { bridge } = await host(true);
    await expect(
      bridge.invoke!("devices", "rename", { deviceId: "d", label: 5 }),
    ).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
    await expect(
      bridge.invoke!("devices", "deauthorize", {}),
    ).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
    await expect(
      bridge.invoke!("nope", "nothing", {}),
    ).rejects.toMatchObject({ code: ErrorCode.invokeNotAllowed });
    expect(ErrorCode.senderRefused).toBe("sender-refused");
  });

  it("does not leak a non-Polaris error's message to the renderer", async () => {
    const { bridge, client } = await host(true);
    (client as unknown as { listDevices: () => Promise<never> }).listDevices =
      async () => {
        throw new TypeError("ENOENT: /Users/secret/store.json");
      };
    const err = await bridge.invoke!("devices", "list", {}).catch(
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: "unknown" });
    expect(String((err as Error).message)).not.toContain("secret");
  });
});

describe("the default sender rule", () => {
  async function answer(url: string, parent: unknown = null) {
    const { ipc } = await host(false);
    const handler = ipc.handlers.get(
      channelOf(DEFAULT_BRIDGE_CHANNEL, "getSyncState"),
    )!;
    const res = (await handler({
      sender: { id: 1, send() {}, once() {} },
      senderFrame: { url, parent },
    })) as { ok: boolean; code?: string };
    return res.ok;
  }

  it("accepts the app's own file and custom-protocol pages and loopback dev servers", async () => {
    expect(await answer("app://main/index.html")).toBe(true);
    expect(await answer("file:///app/index.html")).toBe(true);
    expect(await answer("http://localhost:5173/")).toBe(true);
  });

  it("refuses data, blob, about, remote and nested documents", async () => {
    expect(await answer("data:text/html,x")).toBe(false);
    expect(await answer("blob:null/1234")).toBe(false);
    expect(await answer("about:blank")).toBe(false);
    expect(await answer("https://evil.test/")).toBe(false);
    expect(await answer("app://main/", {})).toBe(false);
  });
});
