// @pkey-feature config.mint
// Edge-mint (`client.config.mintToken`): the client-side rules a transcript pins only in part.
//
//   * a second mint for the same recipe inside its lifetime (until `expiresAt` - 30 s) makes NO
//     request, and the minted token is never written to the store;
//   * Config off ⇒ `service-unavailable`, and a recipe id the router could never match ⇒
//     `bad_request`, both before any request;
//   * no device token ⇒ `unauthorized` without a request;
//   * a 401 gets exactly one re-acquire and one retry;
//   * a cached token is bound to the device token it was minted with: after `deactivate()` the
//     next mint refuses with `unauthorized` and makes no request, and a different device token
//     re-mints instead of reusing it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import type { ServiceSlug } from "../src/discovery.js";
import type { TokenManager } from "../src/core/token.js";

const PRODUCT = "djdl";
const BASE_URL = "https://k.test";
const T0 = 1_700_000_000;
const MINT = `/${PRODUCT}/config/mint/musickit/token`;
const REACQUIRE = `/${PRODUCT}/license/token`;

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

function plane(answers: Record<string, Response[]>) {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    calls.push({
      method: req.method,
      path,
      authorization: req.headers.get("authorization"),
    });
    const queue = answers[path];
    if (!queue?.length) return new Response("{}", { status: 404 });
    return (queue.length > 1 ? queue.shift()! : queue[0]!).clone();
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function client(
  fetchImpl: typeof fetch,
  opts: { services?: ServiceSlug[]; token?: string | null } = {},
) {
  const store = new InMemoryStore();
  if (opts.token !== null) await store.setToken(opts.token ?? "pkeyt_device");
  const c = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE_URL,
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    trustRefresh: false,
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    expectedServices: opts.services ?? ["license", "config"],
  });
  await c.init();
  return { c, store };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("config.mintToken", () => {
  it("serves a second mint inside the lifetime from memory, and re-mints past expiresAt - 30", async () => {
    const p = plane({
      [MINT]: [
        json({ token: "minted-1", expiresAt: T0 + 600 }),
        json({ token: "minted-2", expiresAt: T0 + 1200 }),
      ],
    });
    const { c, store } = await client(p.fetchImpl);
    expect(await c.config.mintToken("musickit")).toEqual({
      token: "minted-1",
      expiresAt: T0 + 600,
    });
    expect(p.calls[0]!.authorization).toBe("Bearer pkeyt_device");

    vi.setSystemTime((T0 + 569) * 1000);
    expect((await c.config.mintToken("musickit")).token).toBe("minted-1");
    expect(p.calls).toHaveLength(1);

    vi.setSystemTime((T0 + 570) * 1000);
    expect((await c.config.mintToken("musickit")).token).toBe("minted-2");
    expect(p.calls).toHaveLength(2);

    // Memory only: nothing minted reaches the store.
    expect(JSON.stringify(await store.readCache())).not.toContain("minted");
    expect(await store.getToken()).toBe("pkeyt_device");
  });

  it("shares one request between two concurrent mints of the same recipe", async () => {
    const p = plane({ [MINT]: [json({ token: "m", expiresAt: T0 + 600 })] });
    const { c } = await client(p.fetchImpl);
    const [a, b] = await Promise.all([
      c.config.mintToken("musickit"),
      c.config.mintToken("musickit"),
    ]);
    expect(a).toEqual(b);
    expect(p.calls).toHaveLength(1);
  });

  it("drops the cached token once the device token is gone (deactivate)", async () => {
    const p = plane({
      [MINT]: [json({ token: "minted-1", expiresAt: T0 + 600 })],
      [`/${PRODUCT}/license/deauthorize`]: [json({ ok: true })],
    });
    const { c } = await client(p.fetchImpl);
    expect((await c.config.mintToken("musickit")).token).toBe("minted-1");
    await c.license.deactivate();
    const mints = () => p.calls.filter((x) => x.path === MINT).length;
    expect(mints()).toBe(1);
    await expect(c.config.mintToken("musickit")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(mints()).toBe(1);
  });

  it("re-mints instead of reusing a token minted under a different device token", async () => {
    const p = plane({
      [MINT]: [
        json({ token: "minted-1", expiresAt: T0 + 600 }),
        json({ token: "minted-2", expiresAt: T0 + 600 }),
      ],
    });
    const { c } = await client(p.fetchImpl);
    expect((await c.config.mintToken("musickit")).token).toBe("minted-1");
    await (c as unknown as { tokens: TokenManager }).tokens.set("pkeyt_other");
    expect((await c.config.mintToken("musickit")).token).toBe("minted-2");
    expect(p.calls.map((x) => x.authorization)).toEqual([
      "Bearer pkeyt_device",
      "Bearer pkeyt_other",
    ]);
  });

  it("refuses with service-unavailable before any request when Config is off", async () => {
    const p = plane({ [MINT]: [json({ token: "m", expiresAt: T0 + 600 })] });
    const { c } = await client(p.fetchImpl, { services: ["license"] });
    await expect(c.config.mintToken("musickit")).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(p.calls).toEqual([]);
  });

  it("refuses a recipe id outside the router's alphabet before any request", async () => {
    const p = plane({});
    const { c } = await client(p.fetchImpl);
    for (const bad of ["../license", "Music", "a/b", ""])
      await expect(c.config.mintToken(bad)).rejects.toMatchObject({
        code: "bad_request",
      });
    expect(p.calls).toEqual([]);
  });

  it("refuses with unauthorized, without a request, when no device token is held", async () => {
    const p = plane({});
    const { c } = await client(p.fetchImpl, { token: null });
    await expect(c.config.mintToken("musickit")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(p.calls).toEqual([]);
  });

  it("re-acquires once on a 401 and retries with the new token", async () => {
    const p = plane({
      [MINT]: [
        json({ error: "unauthorized" }, 401),
        json({ token: "m", expiresAt: T0 + 600 }),
      ],
      [REACQUIRE]: [json({ token: "pkeyt_rotated", schemaVersion: 1 })],
    });
    const { c, store } = await client(p.fetchImpl);
    expect((await c.config.mintToken("musickit")).token).toBe("m");
    expect(p.calls.map((x) => [x.path, x.authorization])).toEqual([
      [MINT, "Bearer pkeyt_device"],
      [REACQUIRE, "Bearer pkeyt_device"],
      [MINT, "Bearer pkeyt_rotated"],
    ]);
    expect(await store.getToken()).toBe("pkeyt_rotated");
  });

  it("fails unauthorized after one re-acquire, never looping", async () => {
    const p = plane({
      [MINT]: [json({ error: "unauthorized" }, 401)],
      [REACQUIRE]: [json({ error: "unauthorized" }, 401)],
    });
    const { c } = await client(p.fetchImpl);
    await expect(c.config.mintToken("musickit")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(p.calls.map((x) => x.path)).toEqual([MINT, REACQUIRE]);
  });

  it("surfaces the Worker's code for an unknown recipe and does not cache the failure", async () => {
    const p = plane({
      [MINT]: [
        json({ error: "not_found", message: "no such edge-mint recipe" }, 404),
        json({ token: "m", expiresAt: T0 + 600 }),
      ],
    });
    const { c } = await client(p.fetchImpl);
    await expect(c.config.mintToken("musickit")).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await c.config.mintToken("musickit")).token).toBe("m");
  });
});
