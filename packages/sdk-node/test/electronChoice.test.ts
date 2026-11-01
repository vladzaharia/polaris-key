// @pkey-feature identity.devicecode.choice
// Bridge v6 (UK-42.22.7): a device sign-in that ends in `choose`, and the four `identity.choice.*`
// verbs that finish it. The Worker's grant stays in the host; the renderer holds a ref bound to
// its window.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolarisBridge } from "@polaris-key/react/desktop";
import type { PolarisKeyClient } from "../src/client.js";
import { PolarisEventEmitter } from "../src/core/events.js";
import {
  createChoiceHost,
  type ChoiceWindow,
} from "../src/electron/choiceHost.js";
import { exposePolarisBridge } from "../src/electron/main.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { channelOf, DEFAULT_BRIDGE_CHANNEL } from "../src/electron/protocol.js";
import { allowApp, ipcPair } from "./electronIpc.js";

const GRANT = "sg_WORKER_GRANT_never_leaves_the_host_process_01";

function setup() {
  const events = new PolarisEventEmitter();
  let waits = 0;
  const choice = {
    licenses: vi.fn(async () => ({
      kind: "ok",
      view: { state: "choose", choices: [] },
    })),
    devices: vi.fn(async () => ({
      kind: "refused",
      code: "not_found",
      httpStatus: 404,
    })),
    complete: vi.fn(async () => ({
      kind: "ok",
      licenseId: "lic_1",
      subject: "ps_x",
      scope: "openid",
    })),
    cancel: vi.fn(async () => ({ kind: "ok" })),
  };
  const session = {
    userCode: "ABCD-EFGH",
    verificationUri: "https://id.example.test/d",
    verificationUriComplete: "https://id.example.test/d?c=1",
    expiresIn: 600,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    interval: 2,
    wait: vi.fn(async () => {
      waits++;
      return waits < 2
        ? { kind: "pending", interval: 2 }
        : {
            kind: "choose",
            grant: GRANT,
            expiresIn: 300,
            choices: { state: "choose", choices: [{ id: "lic_1" }] },
          };
    }),
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
  /** A call as another window (id 8) would make it. */
  const asOther = async (method: string, ...args: unknown[]) => {
    const handler = ipc.handlers.get(
      channelOf(DEFAULT_BRIDGE_CHANNEL, method as never),
    )!;
    const frame = { url: "app://main" };
    const event = {
      sender: { id: 8, send() {}, mainFrame: frame },
      senderFrame: frame,
    };
    return (await handler(event, ...args)) as { ok: boolean; value?: unknown };
  };
  return { bridge, handle, identity, choice, asOther };
}

async function chosen(h: ReturnType<typeof setup>) {
  const begin = await h.bridge.beginSignIn({ licenseChoice: "app" });
  let r = await h.bridge.pollSignIn(begin.flowId);
  if (r.kind === "pending") r = await h.bridge.pollSignIn(begin.flowId);
  if (r.kind !== "choose") throw new Error("expected choose");
  return { begin, r };
}

describe("bridge v6: licence and device choice", () => {
  it("answers choose with an opaque ref, never the grant", async () => {
    const h = setup();
    const { begin, r } = await chosen(h);
    expect(h.identity.signIn.start).toHaveBeenCalledWith(
      expect.objectContaining({ licenseChoice: "app" }),
    );
    expect(r.grant).toMatch(/^[0-9a-f]{32}$/);
    expect(r.grant).not.toBe(GRANT);
    expect(JSON.stringify(r)).not.toContain(GRANT);
    expect(r.expiresIn).toBeGreaterThan(0);
    expect(r.choices).toEqual({ state: "choose", choices: [{ id: "lic_1" }] });
    // Polling again answers the same choose; the Node session is not asked again.
    expect(await h.bridge.pollSignIn(begin.flowId)).toEqual(r);
    expect(h.identity.signIn.start).toHaveBeenCalledTimes(1);
    h.handle.close();
  });

  it("spends the real grant through licenses, devices and complete, then the ref is dead", async () => {
    const h = setup();
    const { r } = await chosen(h);
    const call = (m: string, a: unknown) => h.bridge.invoke!("identity", m, a);
    expect(await call("choice.licenses", { grant: r.grant })).toMatchObject({
      kind: "ok",
    });
    expect(h.choice.licenses).toHaveBeenCalledWith(GRANT);
    await call("choice.devices", { grant: r.grant, licenseId: "lic_1" });
    expect(h.choice.devices).toHaveBeenCalledWith(GRANT, "lic_1");
    const done = await call("choice.complete", {
      grant: r.grant,
      choice: { kind: "license", licenseId: "lic_1", extra: "dropped" },
    });
    expect(done).toMatchObject({ kind: "ok", licenseId: "lic_1" });
    expect(h.choice.complete).toHaveBeenCalledWith(GRANT, {
      kind: "license",
      licenseId: "lic_1",
    });
    expect(await call("choice.licenses", { grant: r.grant })).toEqual({
      kind: "refused",
      code: "invalid_grant",
      httpStatus: 400,
    });
    expect(h.choice.licenses).toHaveBeenCalledTimes(1);
    h.handle.close();
  });

  it("refuses a foreign window, a guessed ref and a malformed choice", async () => {
    const h = setup();
    const { begin, r } = await chosen(h);
    const refused = { kind: "refused", code: "invalid_grant", httpStatus: 400 };
    expect(
      (
        await h.asOther("invoke", "identity", "choice.licenses", {
          grant: r.grant,
        })
      ).value,
    ).toEqual(refused);
    expect(
      (
        await h.asOther("invoke", "identity", "choice.complete", {
          grant: r.grant,
          choice: { kind: "keep" },
        })
      ).value,
    ).toEqual(refused);
    expect(
      await h.bridge.invoke!("identity", "choice.cancel", {
        grant: "0".repeat(32),
      }),
    ).toEqual(refused);
    await expect(
      h.bridge.invoke!("identity", "choice.complete", {
        grant: r.grant,
        choice: { kind: "wipe" },
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(h.choice.licenses).not.toHaveBeenCalled();
    expect(h.choice.complete).not.toHaveBeenCalled();
    // The foreign window cannot read the choose by polling the flow either: the flow belongs to
    // the window that began it, so another window's poll gets an expired answer and the SDK's
    // session is not asked.
    const fresh = await h.bridge.beginSignIn();
    const session = await h.identity.signIn.start.mock.results.at(-1)!.value;
    const polled = session.wait.mock.calls.length;
    for (const flowId of [begin.flowId, fresh.flowId])
      expect(await h.asOther("pollSignIn", flowId)).toEqual({
        ok: true,
        value: { kind: "expired" },
      });
    expect(session.wait.mock.calls.length).toBe(polled);
    h.handle.close();
  });

  it("a refusal the person can fix leaves the ref open; cancel and sign-out end it", async () => {
    const h = setup();
    h.choice.complete.mockResolvedValueOnce({
      kind: "refused",
      code: "device_limit",
      httpStatus: 409,
    } as never);
    const { begin, r } = await chosen(h);
    const call = (m: string, a: unknown) => h.bridge.invoke!("identity", m, a);
    expect(
      await call("choice.complete", {
        grant: r.grant,
        choice: { kind: "keep" },
      }),
    ).toMatchObject({ code: "device_limit" });
    expect(await call("choice.cancel", { grant: r.grant })).toEqual({
      kind: "ok",
    });
    expect(h.choice.cancel).toHaveBeenCalledWith(GRANT);
    expect(await call("choice.licenses", { grant: r.grant })).toMatchObject({
      code: "invalid_grant",
    });
    // The flow went with its ref.
    expect(await h.bridge.pollSignIn(begin.flowId)).toEqual({
      kind: "expired",
    });

    const second = await chosen(h);
    await h.bridge.signOut();
    expect(
      await call("choice.licenses", { grant: second.r.grant }),
    ).toMatchObject({ code: "invalid_grant" });
    h.handle.close();
  });
});

// The host's own controls, driven directly.
describe("choice host controls", () => {
  afterEach(() => vi.useRealTimers());
  const GR = { grant: "sg_x", expiresIn: 300, choices: {} };
  const OK = { kind: "ok", licenseId: "l", subject: "ps_x", scope: "openid" };

  function host() {
    let release!: (v: never) => void;
    const choice = {
      licenses: vi.fn(async () => ({ kind: "ok" })),
      devices: vi.fn(),
      complete: vi.fn(
        () => new Promise((res) => (release = res)) as Promise<never>,
      ),
      cancel: vi.fn(async () => ({ kind: "ok" })),
    };
    const ended: string[] = [];
    const signedIn = vi.fn();
    const discard = vi.fn(async () => undefined);
    const h = createChoiceHost({
      choice: () => choice as never,
      signedIn,
      discard,
      ended: (f) => void ended.push(f),
    });
    let destroyed: (() => void) | undefined;
    const wc: ChoiceWindow = {
      id: 1,
      once: (_e, l) => void (destroyed = l),
    };
    return {
      h,
      wc,
      choice,
      ended,
      signedIn,
      discard,
      destroy: () => destroyed?.(),
      release: (v: unknown) => release(v as never),
    };
  }
  const refused = { kind: "refused", code: "invalid_grant", httpStatus: 400 };

  it("a sign-out during an in-flight complete discards the late result", async () => {
    const t = host();
    const { grant } = t.h.issue(t.wc, "f", GR);
    const p = t.h.complete(t.wc, { grant, choice: { kind: "keep" } });
    t.h.dropAll();
    t.release(OK);
    expect(await p).toEqual(refused);
    expect(t.discard).toHaveBeenCalledTimes(1);
    expect(t.signedIn).not.toHaveBeenCalled();
  });

  it("a second complete and a cancel while one is in flight are refused", async () => {
    const t = host();
    const { grant } = t.h.issue(t.wc, "f", GR);
    const p = t.h.complete(t.wc, { grant, choice: { kind: "keep" } });
    expect(
      await t.h.complete(t.wc, { grant, choice: { kind: "keep" } }),
    ).toEqual(refused);
    expect(await t.h.cancel(t.wc, { grant })).toEqual(refused);
    expect(t.choice.complete).toHaveBeenCalledTimes(1);
    expect(t.choice.cancel).not.toHaveBeenCalled();
    t.release(OK);
    expect(await p).toMatchObject({ kind: "ok" });
    expect(t.signedIn).toHaveBeenCalledTimes(1);
    expect(t.discard).not.toHaveBeenCalled();
  });

  it("a ref expires with its grant", async () => {
    vi.useFakeTimers();
    const t = host();
    const { grant } = t.h.issue(t.wc, "f", GR);
    vi.advanceTimersByTime(299_000);
    expect(await t.h.licenses(t.wc, { grant })).toMatchObject({ kind: "ok" });
    vi.advanceTimersByTime(2_000);
    expect(await t.h.licenses(t.wc, { grant })).toEqual(refused);
    expect(t.ended).toEqual(["f"]);
  });

  it("closing the window ends its ref", async () => {
    const t = host();
    const { grant } = t.h.issue(t.wc, "f", GR);
    t.destroy();
    expect(await t.h.licenses(t.wc, { grant })).toEqual(refused);
    expect(t.ended).toEqual(["f"]);
  });

  it("closing the bridge removes the choice verbs", async () => {
    const h = setup();
    const { r } = await chosen(h);
    h.handle.close();
    await expect(
      h.bridge.invoke!("identity", "choice.licenses", { grant: r.grant }),
    ).rejects.toThrow();
    expect(h.choice.licenses).not.toHaveBeenCalled();
  });
});
