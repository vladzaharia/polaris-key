// @pkey-feature identity.accesstoken
// The device exchange's client half (WIRE-CONTRACT-V5 §12.13.10): the request form, the answer
// reader and the in-memory cache rule. The conversation itself is the identity-access-token
// transcript, replayed by the Node and React runners.

import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_REUSE_MARGIN_SECONDS,
  AccessTokenCache,
  PolarisError,
  accessTokenRequest,
  readAccessToken,
} from "../src/index.js";

const JWT = "aaa.bbb.ccc";
const answer = {
  access_token: JWT,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 600,
  scope: "",
};

describe("accessTokenRequest", () => {
  it("builds the token-exchange form in the contract's order", () => {
    const r = accessTokenRequest({
      tokenEndpoint: "https://key.example/p/identity/token",
      clientId: "p",
      deviceToken: "pkeyt_abc",
    });
    expect(r.url).toBe("https://key.example/p/identity/token");
    expect(r.contentType).toBe("application/x-www-form-urlencoded");
    expect(r.body).toBe(
      [
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
        "client_id=p",
        "subject_token=pkeyt_abc",
        "subject_token_type=urn%3Apolaris-key%3Atoken-type%3Adevice",
        "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
      ].join("&"),
    );
  });

  it("refuses a missing token or a relative endpoint before anything is sent", () => {
    expect(() =>
      accessTokenRequest({
        tokenEndpoint: "https://key.example/t",
        clientId: "p",
        deviceToken: "",
      }),
    ).toThrow(PolarisError);
    expect(() =>
      accessTokenRequest({
        tokenEndpoint: "/t",
        clientId: "p",
        deviceToken: "pkeyt_x",
      }),
    ).toThrow(PolarisError);
  });
});

describe("readAccessToken", () => {
  it("reads the one answer shape", () => {
    expect(readAccessToken(answer)).toEqual({
      accessToken: JWT,
      expiresIn: 600,
    });
  });

  it.each([
    ["no token", { ...answer, access_token: undefined }],
    ["not a compact JWS", { ...answer, access_token: "abc" }],
    ["wrong issued type", { ...answer, issued_token_type: "x" }],
    ["wrong token type", { ...answer, token_type: "MAC" }],
    ["over 8 KiB", { ...answer, access_token: `a.b.${"c".repeat(8192)}` }],
    ["zero lifetime", { ...answer, expires_in: 0 }],
    ["fractional lifetime", { ...answer, expires_in: 1.5 }],
    ["not an object", "nope"],
  ])("answers bad_response for %s", (_n, body) => {
    expect(() => readAccessToken(body)).toThrow(
      expect.objectContaining({ code: "bad_response" }),
    );
  });
});

describe("AccessTokenCache", () => {
  const grant = { accessToken: JWT, expiresIn: 600 };
  const KEY = "pkeyt_a";

  it("reuses a token until the margin before expiry, then asks again", async () => {
    let t = 1000;
    const c = new AccessTokenCache(() => t);
    let calls = 0;
    const ask = async () => {
      calls++;
      return grant;
    };
    const first = await c.get(KEY, ask);
    expect(first).toMatchObject({ expiresIn: 600, expiresAt: 1600 });
    t = 1000 + 600 - ACCESS_TOKEN_REUSE_MARGIN_SECONDS - 1;
    const again = await c.get(KEY, ask);
    expect(again.accessToken).toBe(JWT);
    expect(again.expiresIn).toBe(ACCESS_TOKEN_REUSE_MARGIN_SECONDS + 1);
    expect(calls).toBe(1);
    t = 1000 + 600 - ACCESS_TOKEN_REUSE_MARGIN_SECONDS;
    await c.get(KEY, ask);
    expect(calls).toBe(2);
  });

  it("shares one exchange between callers that arrive together", async () => {
    const c = new AccessTokenCache(() => 0);
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const ask = async () => {
      calls++;
      await gate;
      return grant;
    };
    const all = Promise.all([
      c.get(KEY, ask),
      c.get(KEY, ask),
      c.get(KEY, ask),
    ]);
    release();
    const got = await all;
    expect(calls).toBe(1);
    expect(new Set(got.map((g) => g.accessToken)).size).toBe(1);
  });

  it("does not keep a failure", async () => {
    const c = new AccessTokenCache(() => 0);
    await expect(
      c.get(KEY, async () => {
        throw new PolarisError("rate_limited", "slow down");
      }),
    ).rejects.toThrow("slow down");
    let calls = 0;
    await c.get(KEY, async () => {
      calls++;
      return grant;
    });
    expect(calls).toBe(1);
  });

  it("clear drops the token and an exchange still in flight", async () => {
    const c = new AccessTokenCache(() => 0);
    await c.get(KEY, async () => grant);
    c.clear();
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = c.get(KEY, async () => {
      calls++;
      await gate;
      return grant;
    });
    c.clear();
    release();
    await slow;
    // The answer that landed after the clear was not kept.
    await c.get(KEY, async () => {
      calls++;
      return grant;
    });
    expect(calls).toBe(2);
  });

  it("is bound to the device token: another key is a miss", async () => {
    const c = new AccessTokenCache(() => 0);
    const seen: string[] = [];
    const ask = (name: string) => async () => {
      seen.push(name);
      return { accessToken: `${name}.b.c`, expiresIn: 600 };
    };
    expect((await c.get("pkeyt_a", ask("a"))).accessToken).toBe("a.b.c");
    expect((await c.get("pkeyt_a", ask("x"))).accessToken).toBe("a.b.c");
    // A replaced token, or another account's sign-in, gets its own exchange.
    expect((await c.get("pkeyt_b", ask("b"))).accessToken).toBe("b.b.c");
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not hand an exchange in flight to a caller with another key", async () => {
    const c = new AccessTokenCache(() => 0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const old = c.get("pkeyt_a", async () => {
      await gate;
      return { accessToken: "a.b.c", expiresIn: 600 };
    });
    const fresh = await c.get("pkeyt_b", async () => ({
      accessToken: "b.b.c",
      expiresIn: 600,
    }));
    expect(fresh.accessToken).toBe("b.b.c");
    release();
    expect((await old).accessToken).toBe("a.b.c");
    // The late answer for the old key did not displace the new caller's token.
    let calls = 0;
    const again = await c.get("pkeyt_b", async () => {
      calls++;
      return grant;
    });
    expect(again.accessToken).toBe("b.b.c");
    expect(calls).toBe(0);
  });

  it("remembers a 429's wait and fails fast until it passes, refresh included", async () => {
    let t = 100;
    const c = new AccessTokenCache(() => t);
    let calls = 0;
    const limited = async (): Promise<typeof grant> => {
      calls++;
      throw new PolarisError("rate_limited", "slow down", {
        retryAfterSeconds: 60,
      });
    };
    await expect(c.get(KEY, limited)).rejects.toThrow("slow down");
    t = 130;
    const err = await c
      .get(KEY, limited, { refresh: true })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited", retryAfterSeconds: 30 });
    expect(calls).toBe(1);
    // Another device token is not under this wait.
    await c.get("pkeyt_b", async () => grant);
    t = 160;
    await c.get(KEY, async () => {
      calls++;
      return grant;
    });
    expect(calls).toBe(2);
  });

  it("clear forgets a rate-limit wait", async () => {
    const c = new AccessTokenCache(() => 0);
    await c
      .get(KEY, async () => {
        throw new PolarisError("rate_limited", "x", { retryAfterSeconds: 60 });
      })
      .catch(() => undefined);
    c.clear();
    await expect(c.get(KEY, async () => grant)).resolves.toBeDefined();
  });
});
