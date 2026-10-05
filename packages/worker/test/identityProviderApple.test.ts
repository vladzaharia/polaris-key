// I-06: Sign in with Apple on the login card. The Polaris Services ID as the only audience, the
// ES256 client secret minted from the sealed `.p8`, `response_mode=form_post` found by `state`
// with no Lax cookie, the first-consent name, and the server-to-server notifications.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import {
  APPLE_KEY_ID,
  APPLE_SERVICES_ID,
  APPLE_TEAM_ID,
  appleClaims,
  cookieFrom,
  gateView,
  makeProviderHarness,
  nonceOf,
  nowSec,
  passGate,
  setCookies,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { EMAIL_GATE_LANDING } from "../src/services/identity/card/gate.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";
import { appleFirstConsentName } from "../src/services/identity/providers/apple.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderCaches();
});

const FIRST_CONSENT_USER = JSON.stringify({
  name: { firstName: "Grace", lastName: "Hopper" },
  email: "attacker-chosen@example.com",
});

async function appleCallback(
  h: ProviderHarness,
  claims: (nonce: string) => Record<string, unknown>,
  opts: {
    user?: string;
    cookie?: string | null;
    iss?: string;
    /** Leave I-07's email gate open instead of confirming Apple's verified email. */
    keepGate?: boolean;
  } = {},
): Promise<Response> {
  const { location, state, cookie } = await h.start("apple");
  h.idToken.apple = await h.signApple(claims(nonceOf(location)));
  const form = new URLSearchParams({ state, code: "c0ffee.0.abcd.apple-code" });
  if (opts.user) form.set("user", opts.user);
  if (opts.iss) form.set("iss", opts.iss);
  // A cross-site top-level form POST from appleid.apple.com: Lax cookies are NOT sent, so the
  // request carries at most the SameSite=None binding cookie.
  const res = await h.request("/login/apple/callback", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://appleid.apple.com",
      "sec-fetch-site": "cross-site",
    },
    body: form.toString(),
    cookie: opts.cookie === undefined ? cookie : opts.cookie,
  });
  // A first sign-in opens I-07's email gate; the card confirms Apple's (verified) email.
  if (!opts.keepGate && res.headers.get("location") === EMAIL_GATE_LANDING) {
    expect((await passGate(h, res)).status).toBe(200);
  }
  return res;
}

describe("Sign in with Apple", () => {
  it("starts a form_post flow for the Polaris Services ID", async () => {
    const h = await makeProviderHarness();
    const { location } = await h.start("apple");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://appleid.apple.com/auth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe(APPLE_SERVICES_ID);
    expect(location.searchParams.get("response_mode")).toBe("form_post");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("name email");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://key.plrs.im/login/apple/callback",
    );
  });

  it("completes the form_post flow without a Lax cookie and yields a verified identity", async () => {
    const h = await makeProviderHarness();
    const { location, state, cookie } = await h.start("apple");
    // Only the SameSite=None binding cookie: no portal cookie, no Lax cookie of any kind.
    expect(cookie.startsWith("__Host-pkey_signin=")).toBe(true);
    h.idToken.apple = await h.signApple(appleClaims(nonceOf(location)));
    const res = await h.request("/login/apple/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        state,
        code: "c0ffee",
        user: FIRST_CONSENT_USER,
      }).toString(),
      cookie,
    });
    expect(res.status).toBe(303);
    // A first sign-in goes to I-07's email gate: no account and no session yet.
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(cookieFrom(res, PORTAL_COOKIE)).toBeNull();
    expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    // The binding cookie is spent.
    expect(
      setCookies(res).some((c) => /__Host-pkey_signin=;.*Max-Age=0/.test(c)),
    ).toBe(true);
    const view = await gateView(h, res);
    expect(view.email).toMatchObject({
      provider: "q7x9k2@privaterelay.appleid.com",
      providerVerified: true,
      relay: true,
    });
    // Apple's verified address passes the gate without a code, and the session opens there.
    const passed = await passGate(h, res);
    expect(passed.status).toBe(200);
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();

    const link = await h.db.first<{
      issuer_key: string;
      tenant_scope: string;
      email: string;
      email_verified: number;
    }>("SELECT * FROM account_links WHERE kind = 'apple'");
    expect(link).toMatchObject({
      issuer_key: "https://appleid.apple.com",
      tenant_scope: "",
      // From the signed ID token, never from the unsigned `user` field.
      email: "q7x9k2@privaterelay.appleid.com",
      email_verified: 1,
    });
    const account = await h.db.first<{ display_name: string | null }>(
      "SELECT display_name FROM accounts",
    );
    expect(account?.display_name).toBe("Grace Hopper");
  });

  it("mints the ES256 client secret from the sealed .p8", async () => {
    const h = await makeProviderHarness();
    expect((await appleCallback(h, (n) => appleClaims(n))).status).toBe(303);
    const tokenCall = h.calls.find(
      (c) => c.url === "https://appleid.apple.com/auth/token",
    )!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("client_id")).toBe(APPLE_SERVICES_ID);
    const secret = form.get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: APPLE_KEY_ID,
    });
    const { payload } = await jwtVerify(secret, h.applePublicKey, {
      issuer: APPLE_TEAM_ID,
      subject: APPLE_SERVICES_ID,
      audience: "https://appleid.apple.com",
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(300);
  });

  it("refuses the callback by GET", async () => {
    const h = await makeProviderHarness();
    const { state, cookie } = await h.start("apple");
    expect(
      (
        await h.request(`/login/apple/callback?state=${state}&code=c`, {
          cookie,
        })
      ).status,
    ).toBe(405);
  });

  it("refuses a form_post from a browser that did not start the flow", async () => {
    const h = await makeProviderHarness();
    expect(
      (await appleCallback(h, (n) => appleClaims(n), { cookie: null })).status,
    ).toBe(400);
  });

  describe("audience (S-16 §5.4 item 2)", () => {
    it("refuses a token Apple minted for a developer's bundle id", async () => {
      const h = await makeProviderHarness();
      const res = await appleCallback(h, (n) =>
        appleClaims(n, { aud: "com.example.diceroll" }),
      );
      expect(res.status).toBe(401);
      expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    });

    it("refuses a token for the Services ID among other audiences without azp", async () => {
      const h = await makeProviderHarness();
      const res = await appleCallback(h, (n) =>
        appleClaims(n, { aud: [APPLE_SERVICES_ID, "com.example.diceroll"] }),
      );
      expect(res.status).toBe(401);
    });

    it("refuses a token without the flow's nonce", async () => {
      const h = await makeProviderHarness();
      expect((await appleCallback(h, () => appleClaims("other"))).status).toBe(
        401,
      );
    });
  });

  describe("mix-up (RFC 9207)", () => {
    it("accepts an iss that names Apple", async () => {
      const h = await makeProviderHarness();
      const res = await appleCallback(h, appleClaims, {
        iss: "https://appleid.apple.com",
      });
      expect(res.status).toBe(303);
    });

    it("refuses an iss naming another issuer, before redeeming the code", async () => {
      const h = await makeProviderHarness();
      const res = await appleCallback(h, appleClaims, {
        iss: "https://accounts.google.com",
      });
      expect(res.status).toBe(401);
      expect(h.calls.some((c) => c.url.includes("/auth/token"))).toBe(false);
      expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    });
  });

  it('passes email_verified "false" on as unverified', async () => {
    const h = await makeProviderHarness();
    const res = await appleCallback(
      h,
      (n) =>
        appleClaims(n, {
          email: "grace@example.com",
          email_verified: "false",
          is_private_email: "false",
        }),
      { keepGate: true },
    );
    expect(res.status).toBe(303);
    // The gate offers the address but, unverified, it will need a code of ours.
    expect((await gateView(h, res)).email).toMatchObject({
      provider: "grace@example.com",
      providerVerified: false,
    });
  });

  it("reads the first-consent name defensively", () => {
    expect(appleFirstConsentName(FIRST_CONSENT_USER)).toBe("Grace Hopper");
    expect(
      appleFirstConsentName(JSON.stringify({ name: { firstName: "Ada" } })),
    ).toBe("Ada");
    expect(appleFirstConsentName("not json")).toBeNull();
    expect(appleFirstConsentName(null)).toBeNull();
    expect(
      appleFirstConsentName(
        JSON.stringify({ name: { firstName: "A\u0000\u001bB" } }),
      ),
    ).toBe("AB");
  });
});

describe("Apple server-to-server notifications", () => {
  const SUB = "001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.1234";

  async function notify(
    h: ProviderHarness,
    type: string,
    over: Record<string, unknown> = {},
  ): Promise<Response> {
    const payload = await h.signApple({
      iss: "https://appleid.apple.com",
      aud: APPLE_SERVICES_ID,
      iat: nowSec(),
      jti: crypto.randomUUID(),
      events: JSON.stringify({
        type,
        sub: SUB,
        email: "q7x9k2@privaterelay.appleid.com",
        is_private_email: "true",
        event_time: Date.now(),
      }),
      ...over,
    });
    return h.request("/login/apple/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
    });
  }

  async function flag(h: ProviderHarness): Promise<string | null> {
    const row = await h.db.first<{ provider_flag: string | null }>(
      "SELECT provider_flag FROM account_links WHERE kind = 'apple'",
    );
    return row?.provider_flag ?? null;
  }

  it("flags the link on consent-revoked, and a fresh Apple sign-in clears it", async () => {
    const h = await makeProviderHarness();
    expect((await appleCallback(h, (n) => appleClaims(n))).status).toBe(303);
    const res = await notify(h, "consent-revoked");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: true });
    expect(await flag(h)).toBe("consent_revoked");
    const audit = await h.db.all<{ action: string }>(
      "SELECT action FROM portal_audit ORDER BY at, rowid",
    );
    expect(audit.map((a) => a.action)).toContain("account.link.flagged");

    expect((await appleCallback(h, (n) => appleClaims(n))).status).toBe(303);
    expect(await flag(h)).toBeNull();
  });

  it("flags account-delete for good and never deletes the link", async () => {
    const h = await makeProviderHarness();
    await appleCallback(h, (n) => appleClaims(n));
    expect((await notify(h, "account-delete")).status).toBe(200);
    expect(await flag(h)).toBe("account_deleted");
    // A later, lesser event does not overwrite it.
    await notify(h, "email-disabled");
    expect(await flag(h)).toBe("account_deleted");
    expect(
      await h.db.first("SELECT id FROM account_links WHERE kind = 'apple'"),
    ).not.toBeNull();
  });

  it("tracks email-disabled and email-enabled", async () => {
    const h = await makeProviderHarness();
    await appleCallback(h, (n) => appleClaims(n));
    await notify(h, "email-disabled");
    expect(await flag(h)).toBe("email_disabled");
    await notify(h, "email-enabled");
    expect(await flag(h)).toBeNull();
  });

  it("acknowledges an event for a subject no account holds", async () => {
    const h = await makeProviderHarness();
    const res = await notify(h, "consent-revoked");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: false });
  });

  it("refuses an event addressed to another client, or unsigned", async () => {
    const h = await makeProviderHarness();
    await appleCallback(h, (n) => appleClaims(n));
    expect(
      (await notify(h, "consent-revoked", { aud: "com.example.diceroll" }))
        .status,
    ).toBe(401);
    const forged = await h.request("/login/apple/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: "eyJhbGciOiJub25lIn0.eyJldmVudHMiOiJ7fSJ9.",
      }),
    });
    expect(forged.status).toBe(401);
    expect(await flag(h)).toBeNull();
  });

  it("refuses an unknown event type and a malformed body", async () => {
    const h = await makeProviderHarness();
    expect((await notify(h, "something-else")).status).toBe(401);
    const bad = await h.request("/login/apple/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);
  });
});
