// @pkey-feature identity.redirect.native
// The Electron host's native redirect sign-in (I-15b.2): `beginSignIn({channel: "redirect"})`
// and `pollSignIn` over IPC. The main process binds the listener, opens the browser through the
// host's `shell` and redeems the code; the renderer holds a flow id and sees an end. The flow is
// bound to the window that began it and the sender check runs before any of it.

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { exposePolarisBridge } from "../src/electron/index.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";
import { BASE, PRODUCT, json, seededClient } from "./parityFixtures.js";

const ISS = `${BASE}/${PRODUCT}/identity`;
const RETURN = `${BASE}/signin/return`;
const RQ = `rq_${"A".repeat(22)}`;
const REQUEST_URI = `urn:ietf:params:oauth:request_uri:${"B".repeat(22)}`;

const TOKEN_OK = {
  access_token: "pkeyt_new",
  token_type: "Bearer",
  scope: "profile email",
  schemaVersion: 1,
  device: { id: "D" },
  license: { id: "lic_1" },
  subject: "ps_abc",
};

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function setup(o: { request?: boolean } = {}) {
  const identity = {
    enabled: true,
    configured: true,
    issuer: ISS,
    endpoints: {
      authorize: `${BASE}/${PRODUCT}/identity/authorize`,
      token: `${BASE}/${PRODUCT}/identity/token`,
      ...(o.request === false
        ? {}
        : {
            request: `${BASE}/${PRODUCT}/identity/request`,
            signinReturn: RETURN,
          }),
    },
    nativeRedirect: { loopback: true, schemes: [], claimedHttps: [] },
  };
  const seeded = await seededClient({
    token: null,
    extra: { expectedServices: ["identity"] as never },
    routes: {
      [`GET /${PRODUCT}/.well-known/polaris.json`]: () =>
        json({ product: PRODUCT, services: { identity } }),
      [`POST /${PRODUCT}/identity/request`]: () =>
        json({ request_uri: REQUEST_URI, expires_in: 600 }, 201),
      [`POST /${PRODUCT}/identity/token`]: () => json(TOKEN_OK),
    },
  });
  (
    seeded.client.identity as unknown as { onAcquired: () => Promise<void> }
  ).onAcquired = async () => undefined;
  const ipc = ipcPair();
  const opened: string[] = [];
  const handle = exposePolarisBridge(seeded.client, {
    ipcMain: ipc.ipcMain,
    allowSender: allowApp,
    shell: {
      openExternal: async (url) => {
        opened.push(url);
      },
    },
  });
  closers.push(() => handle.close());
  const bridge = createPreloadBridge(ipc.ipcRenderer);
  return { ...seeded, ipc, handle, bridge, opened };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** What the push named: the loopback port and the state. */
function pushed(env: Setup) {
  const push = env.seen.find((s) => s.path.endsWith("/identity/request"))!;
  const form = new URLSearchParams(push.body!);
  return {
    port: Number(new URL(form.get("redirect_uri")!).port),
    state: form.get("state")!,
  };
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

/** The browser's redirect back to the app, to the real listener. */
function deliver(port: number, state: string): Promise<number> {
  const q = `code=C0DE&state=${state}&iss=${encodeURIComponent(ISS)}&request=${RQ}`;
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: `/pkey/callback?${q}`, agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      )
      .on("error", reject);
  });
}

async function settled(bridge: Setup["bridge"], flowId: string) {
  for (let i = 0; i < 200; i++) {
    const r = (await bridge.pollSignIn(flowId)) as { kind: string };
    if (r.kind !== "pending") return r;
    await new Promise((r2) => setTimeout(r2, 10));
  }
  throw new Error("the flow never ended");
}

describe("PolarisBridge: the native redirect sign-in", () => {
  it("opens the browser from main, takes the redirect and ends ok, with no secret in IPC", async () => {
    const env = await setup();
    const begin = (await env.bridge.beginSignIn({
      channel: "redirect",
    } as never)) as unknown as Record<string, unknown>;
    expect(typeof begin.flowId).toBe("string");
    expect(begin.channel).toBe("redirect");
    expect(env.opened).toHaveLength(1);
    const url = new URL(env.opened[0]!);
    expect(url.searchParams.get("request_uri")).toBe(REQUEST_URI);
    // The renderer is told neither the URL, the port nor the state.
    const p = pushed(env);
    const wire = JSON.stringify(begin);
    expect(wire).not.toContain(REQUEST_URI);
    expect(wire).not.toContain(String(p.port));
    expect(wire).not.toContain(p.state);
    expect(await env.bridge.pollSignIn(begin.flowId as string)).toEqual({
      kind: "pending",
    });
    expect(await deliver(p.port, p.state)).toBe(303);
    const done = await settled(env.bridge, begin.flowId as string);
    expect(JSON.stringify(done)).not.toContain("C0DE");
    expect(done).toEqual({ kind: "ok" });
    expect(await env.store.getToken()).toBe("pkeyt_new");
    expect(await env.bridge.pollSignIn(begin.flowId as string)).toEqual({
      kind: "expired",
    });
    expect(await listening(p.port)).toBe(false);
  });

  it("binds the flow to the window that began it", async () => {
    const env = await setup();
    const begin = (await env.bridge.beginSignIn({
      channel: "redirect",
    } as never)) as unknown as { flowId: string };
    const call = async (sender: number, ...args: unknown[]) =>
      (await (
        env.ipc.handlers.get("polaris-key:pollSignIn")! as (
          ...a: unknown[]
        ) => Promise<{ ok: boolean; value: unknown }>
      )(
        { sender: { id: sender }, senderFrame: { url: "app://main" } },
        ...args,
      )) as { ok: boolean; value: unknown };
    // Another window cannot poll it, reopen it or end it.
    expect((await call(8, begin.flowId)).value).toEqual({ kind: "expired" });
    const reopen = (await (
      env.ipc.handlers.get("polaris-key:beginSignIn")! as (
        ...a: unknown[]
      ) => Promise<{ value: unknown }>
    )(
      { sender: { id: 8 }, senderFrame: { url: "app://main" } },
      { channel: "redirect", reopen: begin.flowId },
    )) as { value: unknown };
    expect(reopen.value).toEqual({ reopened: false });
    expect(env.opened).toHaveLength(1);
    // The owner still has it.
    expect(await env.bridge.pollSignIn(begin.flowId)).toEqual({
      kind: "pending",
    });
  });

  it("Open browser again reopens the same URL without a new push", async () => {
    const env = await setup();
    const begin = (await env.bridge.beginSignIn({
      channel: "redirect",
    } as never)) as unknown as { flowId: string };
    const r = await env.bridge.beginSignIn({
      channel: "redirect",
      reopen: begin.flowId,
    } as never);
    expect(r).toEqual({ reopened: true });
    expect(env.opened).toHaveLength(2);
    expect(env.opened[1]).toBe(env.opened[0]);
    expect(
      env.seen.filter((s) => s.path.endsWith("/identity/request")),
    ).toHaveLength(1);
  });

  it("a sender the host refuses starts nothing", async () => {
    const env = await setup();
    env.ipc.deny();
    await expect(
      env.bridge.beginSignIn({ channel: "redirect" } as never),
    ).rejects.toMatchObject({ code: "sender-refused" });
    expect(env.seen.some((s) => s.path.endsWith("/identity/request"))).toBe(
      false,
    );
    expect(env.opened).toHaveLength(0);
  });

  it("a product with no request endpoint is redirect-unavailable, so the kit offers a code", async () => {
    const env = await setup({ request: false });
    await expect(
      env.bridge.beginSignIn({ channel: "redirect" } as never),
    ).rejects.toMatchObject({ code: "redirect-unavailable" });
    expect(env.opened).toHaveLength(0);
  });

  it("closing the bridge frees the listener", async () => {
    const env = await setup();
    await env.bridge.beginSignIn({ channel: "redirect" } as never);
    const { port } = pushed(env);
    expect(await listening(port)).toBe(true);
    env.handle.close();
    expect(await listening(port)).toBe(false);
  });
});
