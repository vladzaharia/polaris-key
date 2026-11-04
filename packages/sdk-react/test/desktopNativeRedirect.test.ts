// @vitest-environment node
//
// @pkey-feature identity.redirect.native
//
// I-15b.8: the desktop adapter's native redirect sign-in. `signIn.start({channel: "redirect"})`
// with no `redirectUri` forwards to the host's `beginSignIn({channel: "redirect"})`; the host's
// main process owns the listener, the browser and the code. The renderer polls, reopens and
// cancels over the same bridge verbs, over a fake bridge.

import { describe, expect, it, vi } from "vitest";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeOidcPoll } from "../src/desktop/bridge.js";
import { emptyBridgeState, makeFakeBridge, NOW_SEC } from "./fixtures.js";

type Session = {
  channel: string;
  expiresAt: number;
  reopen(): Promise<boolean>;
  cancel(): void;
  wait(o?: { once?: boolean }): Promise<{ kind: string }>;
};

const BEGIN = {
  flowId: "n1",
  channel: "redirect" as const,
  expiresAt: NOW_SEC + 600,
};

async function mounted(version = 6) {
  const bridge = makeFakeBridge(emptyBridgeState());
  (bridge as { version?: number }).version = version;
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
  return { bridge, adapter };
}
const start = (a: Awaited<ReturnType<typeof mounted>>["adapter"], o = {}) =>
  a.signIn.start({
    channel: "redirect",
    ...o,
  } as never) as unknown as Promise<Session>;

describe("DesktopAdapter - native redirect sign-in", () => {
  it("forwards to the host with channel redirect and the hints, no URL comes back", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    const s = await start(adapter, { deviceName: "Den", licenseChoice: "app" });
    expect(bridge.beginSignIn).toHaveBeenCalledWith({
      channel: "redirect",
      deviceName: "Den",
      licenseChoice: "app",
    });
    expect(s.channel).toBe("redirect");
    expect(s.expiresAt).toBe(BEGIN.expiresAt);
    expect(Object.keys(s)).not.toContain("authorizeUrl");
    adapter.dispose();
  });

  it("settles signedIn when the host's poll answers ok, applying the host's state", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    const answers: BridgeOidcPoll[] = [{ kind: "pending" }, { kind: "ok" }];
    bridge.pollSignIn = vi.fn(async () => answers.shift()!);
    const s = await start(adapter);
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
    expect(await s.wait()).toMatchObject({ kind: "signedIn" });
    expect(bridge.pollSignIn).toHaveBeenCalledWith("n1");
    adapter.dispose();
  });

  it("an expired or refused poll ends the session", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    bridge.pollSignIn = vi.fn(async () => ({ kind: "expired" }) as const);
    expect(await (await start(adapter)).wait()).toMatchObject({
      kind: "expired",
    });
    bridge.pollSignIn = vi.fn(async () => ({ kind: "denied" }) as const);
    await expect((await start(adapter)).wait()).rejects.toMatchObject({
      code: "sign-in-denied",
    });
    adapter.dispose();
  });

  it("Open browser again asks the host to reopen the same flow, and starts nothing", async () => {
    const { bridge, adapter } = await mounted();
    const calls: unknown[] = [];
    bridge.beginSignIn = vi.fn(async (b?: unknown) => {
      calls.push(b);
      return (
        (b as { reopen?: string })?.reopen ? { reopened: true } : BEGIN
      ) as never;
    });
    const s = await start(adapter);
    expect(await s.reopen()).toBe(true);
    expect(calls[1]).toEqual({ channel: "redirect", reopen: "n1" });
    bridge.beginSignIn = vi.fn(async () => ({ reopened: false }) as never);
    expect(await s.reopen()).toBe(false);
    bridge.beginSignIn = vi.fn(async () => {
      throw new Error("sender refused");
    });
    expect(await s.reopen()).toBe(false);
    adapter.dispose();
  });

  it("cancel ends a running wait as cancelled", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    bridge.pollSignIn = vi.fn(async () => ({ kind: "pending" }) as const);
    const s = await start(adapter);
    const waiting = s.wait();
    await new Promise((r) => setTimeout(r, 0));
    s.cancel();
    expect(await waiting).toEqual({ kind: "cancelled" });
    adapter.dispose();
  });

  it("cancel asks a v6 host to end the flow by its id, once, and a refusal changes nothing", async () => {
    const { bridge, adapter } = await mounted();
    const invoke = vi.fn(async () => {
      throw new Error("refused");
    });
    (bridge as { invoke?: unknown }).invoke = invoke;
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    bridge.pollSignIn = vi.fn(async () => ({ kind: "pending" }) as const);
    const s = await start(adapter);
    const waiting = s.wait();
    await new Promise((r) => setTimeout(r, 0));
    s.cancel();
    s.cancel();
    expect(await waiting).toEqual({ kind: "cancelled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("identity", "signIn.cancel", {
      flowId: "n1",
    });
    adapter.dispose();
  });

  it("cancel on a host below v6 sends nothing and still stops waiting", async () => {
    const { bridge, adapter } = await mounted(5);
    const invoke = vi.fn(async () => ({ ended: true }));
    (bridge as { invoke?: unknown }).invoke = invoke;
    bridge.beginSignIn = vi.fn(async () => ({
      flowId: "d1",
      verificationUrl: "https://k.test/v",
      userCode: "ABCD",
    }));
    bridge.pollSignIn = vi.fn(async () => ({ kind: "pending" }) as const);
    const s = (await adapter.signIn.start({
      channel: "device-code",
    } as never)) as unknown as Session;
    const waiting = s.wait();
    await new Promise((r) => setTimeout(r, 0));
    s.cancel();
    expect(await waiting).toEqual({ kind: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("cancel on a v6 host with no invoke sends nothing and still settles locally", async () => {
    const { bridge, adapter } = await mounted();
    (bridge as { invoke?: unknown }).invoke = undefined;
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    bridge.pollSignIn = vi.fn(async () => ({ kind: "pending" }) as const);
    const s = await start(adapter);
    const waiting = s.wait();
    await new Promise((r) => setTimeout(r, 0));
    expect(() => s.cancel()).not.toThrow();
    expect(await waiting).toEqual({ kind: "cancelled" });
    adapter.dispose();
  });

  it("a sender the host refuses is a typed sign-in-unavailable, no session", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => {
      throw Object.assign(new Error("sender refused"), {
        code: "sender-refused",
      });
    });
    await expect(start(adapter)).rejects.toMatchObject({
      code: "sign-in-unavailable",
    });
    adapter.dispose();
  });

  it("a host below bridge v6 is the typed version N/A before anything crosses", async () => {
    const { bridge, adapter } = await mounted(5);
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    await expect(start(adapter)).rejects.toMatchObject({
      unsupported: { reason: "version", feature: "identity.redirect.native" },
    });
    expect(bridge.beginSignIn).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("a redirectUri is still the web redirect, typed N/A on the desktop", async () => {
    const { bridge, adapter } = await mounted();
    bridge.beginSignIn = vi.fn(async () => BEGIN);
    await expect(
      start(adapter, { redirectUri: "https://app.example/cb" }),
    ).rejects.toMatchObject({
      unsupported: { reason: "runtime", feature: "identity.redirect.web" },
    });
    expect(bridge.beginSignIn).not.toHaveBeenCalled();
    adapter.dispose();
  });
});
