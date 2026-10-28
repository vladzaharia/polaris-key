// @vitest-environment node
// @pkey-feature identity.link
//
// The link engine's two paths and its decline key (I-46.13): by handle (no provider prompt), by a
// fresh provider token with its own nonce (one prompt), and the refusals the kit tells apart.

import { describe, expect, it, vi } from "vitest";
import { createWebDeviceKeyStore } from "@polaris-key/client-core";
import { memoryStore } from "../src/browser/bearer/store.js";
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
    const store = memoryStore("djdl");
    const h = await declineHash(`${BASE}/djdl/identity`, "ps_abc");
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain("ps_abc");
    expect(await store.flags!.getFlag(`declined\0${h}`)).toBe(false);
    await store.flags!.setFlag(true, `declined\0${h}`);
    expect(await store.flags!.getFlag(`declined\0${h}`)).toBe(true);
  });
});
