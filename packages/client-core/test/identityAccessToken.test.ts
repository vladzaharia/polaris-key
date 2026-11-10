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

  it("reuses a token until the margin before expiry, then asks again", async () => {
    let t = 1000;
    const c = new AccessTokenCache(() => t);
    let calls = 0;
    const ask = async () => {
      calls++;
      return grant;
    };
    const first = await c.get(ask);
    expect(first).toMatchObject({ expiresIn: 600, expiresAt: 1600 });
    t = 1000 + 600 - ACCESS_TOKEN_REUSE_MARGIN_SECONDS - 1;
    const again = await c.get(ask);
    expect(again.accessToken).toBe(JWT);
    expect(again.expiresIn).toBe(ACCESS_TOKEN_REUSE_MARGIN_SECONDS + 1);
    expect(calls).toBe(1);
    t = 1000 + 600 - ACCESS_TOKEN_REUSE_MARGIN_SECONDS;
    await c.get(ask);
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
    const all = Promise.all([c.get(ask), c.get(ask), c.get(ask)]);
    release();
    const got = await all;
    expect(calls).toBe(1);
    expect(new Set(got.map((g) => g.accessToken)).size).toBe(1);
  });

  it("does not keep a failure", async () => {
    const c = new AccessTokenCache(() => 0);
    await expect(
      c.get(async () => {
        throw new PolarisError("rate_limited", "slow down");
      }),
    ).rejects.toThrow("slow down");
    let calls = 0;
    await c.get(async () => {
      calls++;
      return grant;
    });
    expect(calls).toBe(1);
  });

  it("clear drops the token and an exchange still in flight", async () => {
    const c = new AccessTokenCache(() => 0);
    await c.get(async () => grant);
    c.clear();
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = c.get(async () => {
      calls++;
      await gate;
      return grant;
    });
    c.clear();
    release();
    await slow;
    // The answer that landed after the clear was not kept.
    await c.get(async () => {
      calls++;
      return grant;
    });
    expect(calls).toBe(2);
  });
});
