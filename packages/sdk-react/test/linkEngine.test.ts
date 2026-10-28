// @vitest-environment node
// @pkey-feature identity.link
//
// The link engine's two paths and its decline key (I-46.13): by handle (no provider prompt), by a
// fresh provider token with its own nonce (one prompt), and the refusals the kit tells apart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebDeviceKeyStore } from "@polaris-key/client-core";
import type { PlatformIdentityProvider } from "../src/core/index.js";
import { createLinkClient } from "../src/browser/bearer/link.js";
import {
  declineHash,
  runAccept,
  runOffer,
  type LinkContext,
} from "../src/browser/bearer/link.js";

const BASE = "https://key.plrs.im";
const NONCE = "R8dZ1Hsj7fkxSDhUPxODfGzxl-JSR6kV9XUr_dhhtvI";
const HANDLE = "lh_Vi3oKcGS3HqS09Aj2lrrjYKeGlmwdbt8oEqR6x1M_zg";

function ctx(routes: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const c: LinkContext = {
    product: "djdl",
    deviceId: "TRANSCRIPTDEVICE0000000000000001",
    endpoints: {
      kinds: ["google", "apple"],
      nonceEndpoint: `${BASE}/djdl/identity/nonce`,
      tokenEndpoint: `${BASE}/djdl/identity/token`,
      linkEndpoint: `${BASE}/djdl/identity/link`,
    },
    baseUrl: BASE,
    bearer: () => "pkeyt_test",
    headers: (x) => ({ "x-pkey-device": "d", ...x }),
    send: async (url, init) => {
      calls.push({ url, init });
      return routes(url, init);
    },
    now: () => 1700000000,
  };
  return { c, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("the link engine", () => {
  it("by handle: one POST, the proof only, the handle in the body", async () => {
    const port = createWebDeviceKeyStore();
    const { c, calls } = ctx(() =>
      json(200, { linked: { kind: "apple", reach: "developer" } }),
    );
    const r = await runAccept(c, port, { linkHandle: HANDLE });
    expect(r).toEqual({
      kind: "linked",
      linked: { kind: "apple", reach: "developer" },
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Object.keys(body).sort()).toEqual(["linkHandle", "proof"]);
  });

  it("by a fresh token: a nonce first, the token asked once, then the POST", async () => {
    const port = createWebDeviceKeyStore();
    const { c, calls } = ctx((url) =>
      url.endsWith("/nonce")
        ? json(200, { nonce: NONCE, expiresIn: 300 })
        : json(200, { linked: { kind: "google", reach: "developer" } }),
    );
    const token = vi.fn(async (n: string) => {
      expect(n).toBe(NONCE);
      return "provider.token.value";
    });
    const r = await runAccept(c, port, { kind: "google", subjectToken: token });
    expect(r.kind).toBe("linked");
    expect(token).toHaveBeenCalledTimes(1);
    expect(calls.map((x) => x.url.split("/").pop())).toEqual(["nonce", "link"]);
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(Object.keys(body).sort()).toEqual([
      "agreeKey",
      "nonce",
      "proof",
      "signKey",
      "subjectToken",
    ]);
  });

  it("tells a conflict and a stale step-up apart; a malformed handle never leaves", async () => {
    const port = createWebDeviceKeyStore();
    for (const [status, code] of [
      [409, "link_conflict"],
      [401, "step_up_required"],
    ] as const) {
      const { c } = ctx(() => json(status, { error: { code } }));
      expect(await runAccept(c, port, { linkHandle: HANDLE })).toEqual({
        kind: "refused",
        status,
        code,
      });
    }
    const { c, calls } = ctx(() => json(200, {}));
    expect(await runAccept(c, port, { linkHandle: "nope" })).toMatchObject({
      kind: "refused",
      code: "not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("the offer lists the kinds, and an endpoint off the origin is never called", async () => {
    const { c } = ctx(() =>
      json(200, { offer: [{ kind: "google", reach: null }, { kind: "x" }] }),
    );
    expect(await runOffer(c)).toEqual({
      kind: "ok",
      offer: [{ kind: "google", reach: null }],
    });
    const off = ctx(() => json(200, { offer: [] }));
    off.c.endpoints = {
      ...off.c.endpoints!,
      linkEndpoint: "https://evil.example/link",
    };
    expect(await runOffer(off.c)).toEqual({ kind: "unavailable" });
    expect(off.calls).toHaveLength(0);
  });

  it("a declined identity is stored as a hash and nothing else", async () => {
    const h = await declineHash(`${BASE}/djdl/identity`, "ps_abc");
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain("ps_abc");
  });
});

// ── The engine over the page's session storage ────────────────────────────────────────────

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  marker.value = undefined;
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const HANDLE_KEY = "pkey-link-handle:djdl";

/** A host whose session is signed in as `account`; every request is recorded. */
function engine(
  account: string | null,
  routes: (url: string) => Response,
  provider: PlatformIdentityProvider | null = null,
) {
  const { c, calls } = ctx((url) => routes(url));
  const bearer = {
    account,
    init: async () => undefined,
    wire: () => c,
    bearer: "pkeyt_test",
    subject: async () => null,
  };
  const host = {
    linkFor_: marker.value,
    product: "djdl",
    base: BASE,
    bearer: bearer as never,
    bearerStore: { status: async () => ({ backend: "memory" }) } as never,
    configError: null,
    discovery_: null,
    clock: () => 1_700_000_000,
    ensureDiscovery: async () => undefined,
    deviceKeyPort: async () => createWebDeviceKeyStore(),
    platformProvider: () => provider,
  };
  const client = createLinkClient(host as never);
  return { client, calls, host };
}

/** The page's marker (the account whose sign-in landed) and the handle in session storage. */
const marker: { value: string | undefined } = { value: undefined };
const OFFERS = () => json(200, { offer: [{ kind: "google", reach: null }] });
const hold = (subject: string, at = 1_700_000_000) => {
  marker.value = subject;
  store.set(HANDLE_KEY, `${at} ${HANDLE}`);
};

describe("the marker and the handle belong to one account", () => {
  it("another account's marker offers nothing, sends nothing, and is dropped", async () => {
    hold("ps_A");
    const { client, calls, host } = engine("ps_B", () =>
      json(200, { offer: [] }),
    );
    expect(await client.offer()).toEqual({ kind: "unavailable" });
    expect(await client.accept()).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(host.linkFor_).toBeUndefined();
    expect(store.has(HANDLE_KEY)).toBe(false);
  });

  it("the same account's handle is sent, and spent by the answer", async () => {
    hold("ps_A");
    const { client, calls, host } = engine("ps_A", () =>
      json(200, { linked: { kind: "google", reach: "developer" } }),
    );
    expect((await client.accept()).kind).toBe("linked");
    expect(JSON.parse(String(calls[0]!.init.body)).linkHandle).toBe(HANDLE);
    expect(host.linkFor_).toBeUndefined();
    expect(store.has(HANDLE_KEY)).toBe(false);
  });

  it("a lapsed handle is not sent", async () => {
    hold("ps_A", 1_700_000_000 - 601);
    const { client, calls } = engine("ps_A", () => json(200, {}));
    expect(await client.accept()).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("dismiss forgets the offer without remembering a decline", async () => {
    hold("ps_A");
    const { client, host } = engine("ps_A", OFFERS);
    await client.dismiss();
    expect(client.pending()).toBe(false);
    // A decline would have silenced the offer; a dismissal has not.
    host.linkFor_ = "ps_A";
    expect((await client.offer()).kind).toBe("ok");
  });
});

describe("a handle that lapsed falls through to the provider in the same press", () => {
  it("not_found on the handle, then one nonce, one prompt, one link", async () => {
    hold("ps_A");
    const token = vi.fn(async () => "provider.token.value");
    const provider = {
      kind: "google",
      available: () => true,
      token,
      signOutCleanup: async () => undefined,
    } as unknown as PlatformIdentityProvider;
    let links = 0;
    const { client, calls } = engine(
      "ps_A",
      (url) => {
        if (url.endsWith("/nonce")) return json(200, { nonce: NONCE });
        links += 1;
        return links === 1
          ? json(404, { error: { code: "not_found" } })
          : json(200, { linked: { kind: "google", reach: "developer" } });
      },
      provider,
    );
    expect((await client.accept()).kind).toBe("linked");
    expect(token).toHaveBeenCalledTimes(1);
    expect(calls.map((x) => x.url.split("/").pop())).toEqual([
      "link",
      "nonce",
      "link",
    ]);
  });

  it("a dismissed chooser is nothing: unavailable, the handle kept for the next press", async () => {
    hold("ps_A");
    const provider = {
      kind: "google",
      available: () => true,
      token: async () => null,
      signOutCleanup: async () => undefined,
    } as unknown as PlatformIdentityProvider;
    const { client } = engine(
      "ps_A",
      (url) =>
        url.endsWith("/nonce")
          ? json(200, { nonce: NONCE })
          : json(404, { error: { code: "not_found" } }),
      provider,
    );
    expect(await client.accept()).toEqual({ kind: "unavailable" });
  });
});

describe("a decline with no known subject covers no one", () => {
  it("is not stored", async () => {
    marker.value = "";
    const { client } = engine(null, OFFERS);
    await client.decline();
    // Another account later on the same device is not silenced by it.
    marker.value = "";
    expect((await engine("ps_Z", OFFERS).client.offer()).kind).toBe("ok");
  });

  it("is stored per account", async () => {
    marker.value = "";
    const { client } = engine("ps_A", OFFERS);
    await client.decline();
    marker.value = "";
    expect(await client.offer()).toEqual({ kind: "unavailable" });
    marker.value = "";
    expect((await engine("ps_B", OFFERS).client.offer()).kind).toBe("ok");
  });
});
