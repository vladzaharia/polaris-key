// @vitest-environment node
//
// @pkey-feature identity.link identity.redirect.web
//
// The held device token on the redirect token request (I-46.13): it goes only to the Worker that
// issued it. A token endpoint off the base origin, with userinfo, protocol-relative, or merely
// sharing the base as a prefix gets no Authorization header; a redirect answer is never followed.

import { describe, expect, it } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { BearerSession } from "../src/browser/bearer/session.js";

const BASE = "https://key.plrs.im";

/** A store holding `token` and nothing else worth keeping. */
function storeWith(token: string | null): Store {
  let held = token;
  let cache: CacheRecordV3 | null = null;
  return {
    getToken: async () => held,
    setToken: async (t) => void (held = t),
    clearToken: async () => void (held = null),
    getDeviceId: async () => "GUARDDEVICE0000000000000000001",
    readCache: async () => cache,
    writeCache: async (r) => void (cache = r),
    clearCache: async () => void (cache = null),
  };
}

async function redeem(tokenEndpoint: string, token: string | null) {
  const seen: { url: string; headers: Headers; redirect?: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
    });
  }) as typeof fetch;
  const session = new BearerSession({
    baseUrl: BASE,
    product: "acme",
    version: "1.0.0",
    fetchImpl,
    now: () => 1_700_000_000,
    pinned: { k: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
    store: storeWith(token),
    enabled: (slug) => slug === "license" || slug === "identity",
    random: () => 0,
  });
  const pending = {
    authorizeUrl: `${BASE}/acme/identity/authorize`,
    state: "state-0123456789-abcdefghij",
    codeVerifier: "verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
    redirectUri: "https://app.example/cb",
    clientId: "acme",
    issuer: `${BASE}/acme/identity`,
    tokenEndpoint,
  };
  await session
    .redeemRedirect(
      pending as never,
      `https://app.example/cb?code=abc&state=${pending.state}&iss=${encodeURIComponent(pending.issuer)}`,
    )
    .catch(() => undefined);
  return seen;
}

describe("the held token on the redirect token request", () => {
  it("goes to the product's own token endpoint, and a redirect is never followed", async () => {
    const [req] = await redeem(`${BASE}/acme/identity/token`, "pkeyt_held");
    expect(req!.headers.get("authorization")).toBe("Bearer pkeyt_held");
    expect(req!.redirect).toBe("error");
  });

  it("is not sent when the device holds none", async () => {
    const [req] = await redeem(`${BASE}/acme/identity/token`, null);
    expect(req!.headers.has("authorization")).toBe(false);
  });

  it.each([
    ["another host", "https://evil.example/acme/identity/token"],
    ["userinfo naming the base", "https://key.plrs.im@evil.example/token"],
    ["a host that starts with the base", "https://key.plrs.im.evil.example/t"],
    ["protocol-relative", "//evil.example/token"],
    ["another port", "https://key.plrs.im:8443/acme/identity/token"],
    ["another scheme", "http://key.plrs.im/acme/identity/token"],
    ["a different case", "https://KEY.plrs.im/acme/identity/token"],
  ])("is not sent to %s", async (_n, endpoint) => {
    const seen = await redeem(endpoint, "pkeyt_held");
    // The request is made (the check is on the header, not on the call being skipped).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.has("authorization"), endpoint).toBe(false);
  });
});
