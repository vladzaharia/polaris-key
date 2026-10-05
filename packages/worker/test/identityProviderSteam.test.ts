// I-06: Sign in with Steam on the login card. OpenID 2.0 against Steam's fixed endpoint, the
// assertion checked locally (op_endpoint, return_to, identity, signed fields, nonce) and then
// confirmed by Steam (`check_authentication`), then the persona through the Web API key.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieFrom,
  fixture,
  makeProviderHarness,
  STEAM_KEY,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderCaches();
});

const STEAM_ID = "76561197960435530";

function isoNow(offsetSec = 0): string {
  return new Date(Date.now() + offsetSec * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** Steam's redirect back: the recorded assertion, completed for this flow. */
function assertion(
  returnTo: string,
  over: Record<string, string | null> = {},
): URLSearchParams {
  const base = JSON.parse(fixture("steam-assertion.json")) as Record<
    string,
    string
  >;
  base["openid.return_to"] = returnTo;
  base["openid.response_nonce"] = `${isoNow()}8ZvVbJ3TfRZi1M5Xx0M1dXyX5Y4=`;
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  return new URLSearchParams(base);
}

async function steamCallback(
  h: ProviderHarness,
  over: Record<string, string | null> = {},
  opts: { returnTo?: (real: string) => string } = {},
): Promise<Response> {
  const { location, cookie } = await h.start("steam");
  const real = location.searchParams.get("openid.return_to")!;
  const params = assertion(opts.returnTo ? opts.returnTo(real) : real, over);
  // Steam appends its fields to our return URL, whose own query carries the state.
  const url = new URL(real);
  for (const [k, v] of params) url.searchParams.set(k, v);
  return h.request(`${url.pathname}${url.search}`, { cookie });
}

describe("Sign in with Steam", () => {
  it("starts OpenID 2.0 with the realm and a state-carrying return URL", async () => {
    const h = await makeProviderHarness();
    const { location, state } = await h.start("steam");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://steamcommunity.com/openid/login",
    );
    expect(location.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(location.searchParams.get("openid.ns")).toBe(
      "http://specs.openid.net/auth/2.0",
    );
    expect(location.searchParams.get("openid.realm")).toBe(
      "https://key.plrs.im",
    );
    expect(location.searchParams.get("openid.return_to")).toBe(
      `https://key.plrs.im/login/steam/callback?state=${state}`,
    );
    expect(location.searchParams.get("openid.identity")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
  });

  it("signs in against the recorded assertion and yields an identity with no email", async () => {
    const h = await makeProviderHarness();
    const res = await steamCallback(h);
    expect(res.status).toBe(302);
    expect(cookieFrom(res, PORTAL_COOKIE)).toBeTruthy();

    // Steam itself confirmed the assertion: every openid.* field sent back, mode switched.
    const check = h.calls.find(
      (c) =>
        c.url === "https://steamcommunity.com/openid/login" &&
        c.method === "POST",
    )!;
    const sent = new URLSearchParams(check.body);
    expect(sent.get("openid.mode")).toBe("check_authentication");
    expect(sent.get("openid.sig")).toBe("W0u5DRbtHE1GG0ZKXjerUZDUGmc=");
    expect(sent.get("state")).toBeNull();
    // The persona came through the Web API key.
    const summary = h.calls.find((c) => c.url.includes("GetPlayerSummaries"))!;
    expect(new URL(summary.url).searchParams.get("key")).toBe(STEAM_KEY);
    expect(new URL(summary.url).searchParams.get("steamids")).toBe(STEAM_ID);

    const link = await h.db.first<{
      issuer_key: string;
      subject: string;
      email: string | null;
      email_verified: number;
      display_name: string | null;
    }>("SELECT * FROM account_links WHERE kind = 'steam'");
    expect(link).toMatchObject({
      issuer_key: "steam",
      subject: STEAM_ID,
      email: null,
      email_verified: 0,
      display_name: "Robin",
    });
    const account = await h.db.first<{ primary_email: string | null }>(
      "SELECT primary_email FROM accounts",
    );
    expect(account?.primary_email).toBeNull();
  });

  it("still signs in when the Web API does not answer", async () => {
    const h = await makeProviderHarness();
    h.routes.set(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      () => new Response("Forbidden", { status: 403 }),
    );
    expect((await steamCallback(h)).status).toBe(302);
    const link = await h.db.first<{ display_name: string | null }>(
      "SELECT display_name FROM account_links WHERE kind = 'steam'",
    );
    expect(link?.display_name).toBeNull();
  });

  it("refuses an assertion Steam does not confirm", async () => {
    const h = await makeProviderHarness();
    h.routes.set(
      "https://steamcommunity.com/openid/login",
      () =>
        new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:false\n"),
    );
    expect((await steamCallback(h)).status).toBe(401);
    expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
  });

  describe("audience equivalents (S-16 §5.4 item 2)", () => {
    it("refuses an assertion issued for another site's return URL", async () => {
      const h = await makeProviderHarness();
      const res = await steamCallback(
        h,
        {},
        {
          returnTo: (real) =>
            real.replace("https://key.plrs.im", "https://other-game.example"),
        },
      );
      expect(res.status).toBe(401);
      expect(h.calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("refuses an assertion for another flow of ours", async () => {
      const h = await makeProviderHarness();
      const res = await steamCallback(
        h,
        {},
        {
          returnTo: () =>
            "https://key.plrs.im/login/steam/callback?state=another",
        },
      );
      expect(res.status).toBe(401);
    });

    it.each([
      [
        "another OP",
        { "openid.op_endpoint": "https://evil.example/openid/login" },
      ],
      [
        "mismatched identities",
        {
          "openid.identity":
            "https://steamcommunity.com/openid/id/76561197960435531",
        },
      ],
      [
        "a non-Steam identity",
        {
          "openid.claimed_id":
            "https://evil.example/openid/id/76561197960435530",
          "openid.identity": "https://evil.example/openid/id/76561197960435530",
        },
      ],
      [
        "an unsigned return URL",
        {
          "openid.signed":
            "signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle",
        },
      ],
      ["a stale nonce", { "openid.response_nonce": "2020-01-01T00:00:00Zabc" }],
      ["a cancelled sign-in", { "openid.mode": "cancel" }],
      [
        "another protocol version",
        { "openid.ns": "http://openid.net/signon/1.1" },
      ],
    ])("refuses %s", async (_label, over) => {
      const h = await makeProviderHarness();
      const res = await steamCallback(h, over);
      expect([400, 401]).toContain(res.status);
      expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    });
  });
});
