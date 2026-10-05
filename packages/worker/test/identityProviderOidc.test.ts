// I-06: Sign in with Google on the login card, OIDC discovery behind the SSRF and allowlist
// gates, RFC 9207 `iss`, and per-provider audience enforcement. Driven through the portal's
// composition (`handlePortal`) against Google's recorded discovery document.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieFrom,
  fixture,
  GOOGLE_CLIENT_ID,
  gateView,
  googleClaims,
  makeProviderHarness,
  nonceOf,
  passGate,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import { EMAIL_GATE_LANDING } from "../src/services/identity/card/gate.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { SIGNIN_BIND_COOKIE } from "../src/services/identity/providers/flow.js";
import {
  discoverProvider,
  resetProviderCaches,
  verifyProviderIdToken,
} from "../src/services/identity/providers/discovery.js";
import {
  PROVIDER_HOSTS,
  providerUrlProblem,
} from "../src/services/identity/providers/net.js";
import {
  configuredSignInProviders,
  resolveSignInClient,
} from "../src/services/identity/providers/config.js";
import { matchRoute } from "../src/router.js";
import {
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderCaches();
});

async function googleCallback(
  h: ProviderHarness,
  claims: (nonce: string) => Record<string, unknown>,
  opts: { iss?: string | null; cookie?: string | null; path?: string } = {},
): Promise<Response> {
  const { location, state, cookie } = await h.start("google");
  h.idToken.google = await h.signGoogle(claims(nonceOf(location)));
  const qs = new URLSearchParams({
    code: "4/0AQSTgQ-code",
    state,
    scope: "email",
  });
  const iss = opts.iss === undefined ? "https://accounts.google.com" : opts.iss;
  if (iss !== null) qs.set("iss", iss);
  return h.request(`${opts.path ?? "/login/google/callback"}?${qs}`, {
    cookie: opts.cookie === undefined ? cookie : opts.cookie,
  });
}

describe("routing", () => {
  it("reserves /login/<provider> ahead of product routes", () => {
    expect(matchRoute("/login/google").kind).toBe("portalProviderSignIn");
    expect(matchRoute("/login/apple/callback").kind).toBe(
      "portalProviderSignIn",
    );
    expect(matchRoute("/login/apple/notifications").kind).toBe(
      "portalProviderSignIn",
    );
    expect(matchRoute("/login").kind).toBe("portalLogin");
  });

  it("answers an unknown provider or step with the not-found page", async () => {
    const h = await makeProviderHarness();
    expect((await h.request("/login/discord")).status).toBe(404);
    expect((await h.request("/login/google/notifications")).status).toBe(404);
    expect((await h.request("/login/google/extra/deep")).status).toBe(404);
  });
});

describe("platform client configuration (fail closed)", () => {
  it("offers only fully configured providers", async () => {
    const h = await makeProviderHarness({ configure: ["google"] });
    expect(configuredSignInProviders(h.env)).toEqual(["google"]);
    expect((await h.request("/login/apple")).status).toBe(404);
    expect((await h.request("/login/steam")).status).toBe(404);
  });

  it("refuses a secret that is not sealed for its slot", async () => {
    const h = await makeProviderHarness();
    h.env.SIGNIN_GOOGLE_CLIENT_SECRET = "plain-text-secret";
    expect(await resolveSignInClient(h.env, "google")).toBeNull();
    expect((await h.request("/login/google")).status).toBe(404);
    // A blob sealed for another provider's slot does not open either.
    h.env.SIGNIN_GOOGLE_CLIENT_SECRET = h.env.SIGNIN_STEAM_WEB_API_KEY;
    expect(await resolveSignInClient(h.env, "google")).toBeNull();
  });

  it("refuses to verify against an empty audience", async () => {
    const h = await makeProviderHarness();
    const discovered = await discoverProvider("google");
    const token = await h.signGoogle(googleClaims("n"));
    await expect(
      verifyProviderIdToken(discovered, token, { audience: "" }),
    ).rejects.toThrow(/no audience/);
  });
});

describe("Sign in with Google", () => {
  it("starts with PKCE, a nonce, state and a browser-binding cookie", async () => {
    const h = await makeProviderHarness();
    const res = await h.request(
      "/login/google?return_to=https%3A%2F%2Fkey.plrs.im%2F%23%2Flibrary",
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(loc.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "https://key.plrs.im/login/google/callback",
    );
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain(`${SIGNIN_BIND_COOKIE}=`);
    expect(set).toContain("SameSite=None");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
  });

  it("signs in against the recorded provider and yields a verified identity", async () => {
    const h = await makeProviderHarness();
    const res = await googleCallback(h, (n) => googleClaims(n));
    expect(res.status).toBe(302);
    // A first sign-in goes to I-07's email gate; Google's verified address passes it without a
    // code, and only then do the account and its session exist.
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(cookieFrom(res, PORTAL_COOKIE)).toBeNull();
    expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    const passed = await passGate(h, res);
    expect(passed.status).toBe(200);
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();
    // The token POST carried the PKCE verifier and the client secret, to the discovered endpoint.
    const tokenCall = h.calls.find(
      (c) => c.url === "https://oauth2.googleapis.com/token",
    )!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("client_secret")).toBe("google-secret");
    expect(form.get("redirect_uri")).toBe(
      "https://key.plrs.im/login/google/callback",
    );

    const link = await h.db.first<{
      kind: string;
      issuer_key: string;
      email: string;
      email_verified: number;
    }>("SELECT * FROM account_links WHERE kind = 'google'");
    expect(link).toMatchObject({
      issuer_key: "https://accounts.google.com",
      email: "ada@example.com",
      email_verified: 1,
    });
    const account = await h.db.first<{
      primary_email: string | null;
      display_name: string | null;
    }>("SELECT * FROM accounts");
    expect(account).toMatchObject({
      primary_email: "ada@example.com",
      display_name: "Ada Lovelace",
    });
    // Upstream tokens are not kept anywhere: no D1 row or KV value holds them.
    const dump = JSON.stringify(await h.db.all("SELECT * FROM portal_audit"));
    expect(dump).not.toContain("ya29");
    expect(dump).toContain("portal.login.google");
  });

  it("passes an unverified provider email on as unverified", async () => {
    const h = await makeProviderHarness();
    const res = await googleCallback(h, (n) =>
      googleClaims(n, { email_verified: false }),
    );
    expect(res.status).toBe(302);
    // The gate offers the address but, unverified, it needs a code of ours: nothing is written.
    expect((await gateView(h, res)).email).toMatchObject({
      provider: "ada@example.com",
      providerVerified: false,
    });
    expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
  });

  it("never joins by email match: a verified email another account uses writes nothing", async () => {
    const h = await makeProviderHarness();
    const other = await insertAccount(
      h.db,
      {
        primaryEmail: "ada@example.com",
        primaryEmailVerified: true,
        displayName: null,
      },
      1,
    );
    await insertLink(
      h.db,
      other.id,
      {
        issuerKey: "email",
        tenantScope: "",
        subject: "ada@example.com",
        kind: "email",
        email: "ada@example.com",
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      1,
    );
    const res = await googleCallback(h, (n) => googleClaims(n));
    // Confirming the address at the gate stops with the join offer; nothing joins silently.
    const confirmed = await passGate(h, res);
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({ error: "email_in_use" });
    const google = await h.db.first(
      "SELECT id FROM account_links WHERE kind = 'google'",
    );
    expect(google).toBeNull();
  });

  describe("audience (S-16 §5.4 item 2)", () => {
    it("refuses a token minted for another client", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) =>
        googleClaims(n, {
          aud: "999-developer-app.apps.googleusercontent.com",
          azp: undefined,
        }),
      );
      expect(res.status).toBe(401);
      expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    });

    it("refuses a multi-audience token whose azp is not the platform client", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) =>
        googleClaims(n, {
          aud: [
            GOOGLE_CLIENT_ID,
            "999-developer-app.apps.googleusercontent.com",
          ],
          azp: undefined,
        }),
      );
      expect(res.status).toBe(401);
    });

    it("refuses a token whose azp names another client", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) =>
        googleClaims(n, {
          azp: "999-developer-app.apps.googleusercontent.com",
        }),
      );
      expect(res.status).toBe(401);
    });

    it("refuses a token from another issuer", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) =>
        googleClaims(n, { iss: "https://appleid.apple.com" }),
      );
      expect(res.status).toBe(401);
    });

    it("refuses a stale token and a token without the flow's nonce", async () => {
      const h = await makeProviderHarness();
      const t = Math.floor(Date.now() / 1000);
      expect(
        (await googleCallback(h, (n) => googleClaims(n, { iat: t - 3600 })))
          .status,
      ).toBe(401);
      expect(
        (await googleCallback(h, () => googleClaims("another-nonce"))).status,
      ).toBe(401);
    });
  });

  describe("RFC 9207 and mix-up defence", () => {
    it("requires iss, since Google advertises it", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) => googleClaims(n), {
        iss: null,
      });
      expect(res.status).toBe(401);
    });

    it("refuses an iss that names another provider", async () => {
      const h = await makeProviderHarness();
      const res = await googleCallback(h, (n) => googleClaims(n), {
        iss: "https://appleid.apple.com",
      });
      expect(res.status).toBe(401);
    });

    it("never redeems a Google state on another provider's callback", async () => {
      const h = await makeProviderHarness();
      const { state, cookie } = await h.start("google");
      const res = await h.request("/login/apple/callback", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "c", state }).toString(),
        cookie,
      });
      expect(res.status).toBe(400);
      expect(h.calls.some((c) => c.url.includes("/auth/token"))).toBe(false);
    });
  });

  describe("the flow", () => {
    it("is single-use", async () => {
      const h = await makeProviderHarness();
      const { location, state, cookie } = await h.start("google");
      h.idToken.google = await h.signGoogle(googleClaims(nonceOf(location)));
      const qs = `code=c&state=${state}&iss=${encodeURIComponent("https://accounts.google.com")}`;
      expect(
        (await h.request(`/login/google/callback?${qs}`, { cookie })).status,
      ).toBe(302);
      expect(
        (await h.request(`/login/google/callback?${qs}`, { cookie })).status,
      ).toBe(400);
    });

    it("is bound to the browser that started it", async () => {
      const h = await makeProviderHarness();
      expect(
        (await googleCallback(h, (n) => googleClaims(n), { cookie: null }))
          .status,
      ).toBe(400);
      expect(
        (
          await googleCallback(h, (n) => googleClaims(n), {
            cookie: `${SIGNIN_BIND_COOKIE}=someone-elses`,
          })
        ).status,
      ).toBe(400);
      expect(await h.db.first("SELECT id FROM accounts")).toBeNull();
    });

    it("answers a refused code (invalid_grant) as unverified, an outage as unavailable", async () => {
      const refused = await makeProviderHarness();
      refused.routes.set(
        "https://oauth2.googleapis.com/token",
        () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      );
      expect((await googleCallback(refused, googleClaims)).status).toBe(401);

      const down = await makeProviderHarness();
      down.routes.set(
        "https://oauth2.googleapis.com/token",
        () => new Response("upstream unavailable", { status: 503 }),
      );
      expect((await googleCallback(down, googleClaims)).status).toBe(502);
      expect(await down.db.first("SELECT id FROM accounts")).toBeNull();
    });

    it("burns the flow on a cancelled sign-in", async () => {
      const h = await makeProviderHarness();
      const { state, cookie } = await h.start("google");
      const res = await h.request(
        `/login/google/callback?error=access_denied&state=${state}`,
        { cookie },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("cancelled");
    });

    it("returns to a same-origin return_to and refuses a foreign one", async () => {
      const h = await makeProviderHarness();
      expect(
        (
          await h.request(
            "/login/google?return_to=https%3A%2F%2Fevil.example%2F",
          )
        ).status,
      ).toBe(400);
      const { location, state, cookie } = await h.start(
        "google",
        "https://key.plrs.im/#/library",
      );
      h.idToken.google = await h.signGoogle(googleClaims(nonceOf(location)));
      const res = await h.request(
        `/login/google/callback?code=c&state=${state}&iss=${encodeURIComponent("https://accounts.google.com")}`,
        { cookie },
      );
      // The gate carries the return URL and hands it back once it passes.
      expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
      const passed = await passGate(h, res);
      expect(await passed.json()).toMatchObject({
        status: "signed_in",
        next: "https://key.plrs.im/#/library",
      });
    });
  });
});

describe("discovery gates (SSRF and the allowlist)", () => {
  // The recorded document, then poisoned per test.
  const google = JSON.parse(
    fixture("google-openid-configuration.json"),
  ) as Record<string, unknown>;

  async function startWith(doc: Record<string, unknown>) {
    const h = await makeProviderHarness();
    h.routes.set(
      "https://accounts.google.com/.well-known/openid-configuration",
      () => new Response(JSON.stringify(doc)),
    );
    return { h, res: await h.request("/login/google") };
  }

  it.each([
    [
      "a link-local token endpoint",
      { token_endpoint: "https://169.254.169.254/latest/meta-data" },
    ],
    ["a private-address JWKS", { jwks_uri: "https://10.0.0.7/certs" }],
    [
      "a loopback authorize endpoint",
      { authorization_endpoint: "https://127.0.0.1/auth" },
    ],
    [
      "a public host off the allowlist",
      { token_endpoint: "https://exfil.attacker.example/token" },
    ],
    ["plain http", { jwks_uri: "http://www.googleapis.com/oauth2/v3/certs" }],
    [
      "an explicit port",
      { token_endpoint: "https://oauth2.googleapis.com:8443/token" },
    ],
    [
      "embedded credentials",
      { token_endpoint: "https://u:p@oauth2.googleapis.com/token" },
    ],
    ["another issuer", { issuer: "https://accounts.google.com.evil.example" }],
  ])("refuses a document naming %s", async (_label, poison) => {
    const { h, res } = await startWith({ ...google, ...poison });
    expect(res.status).toBe(502);
    // Nothing was dialled beyond the discovery document itself.
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://accounts.google.com/.well-known/openid-configuration",
    ]);
  });

  it("does not follow a redirect from the discovery URL", async () => {
    const h = await makeProviderHarness();
    h.routes.set(
      "https://accounts.google.com/.well-known/openid-configuration",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/" },
        }),
    );
    expect((await h.request("/login/google")).status).toBe(502);
    expect(h.calls).toHaveLength(1);
  });

  it("classifies URLs with the provider allowlist", () => {
    const hosts = PROVIDER_HOSTS.google;
    expect(
      providerUrlProblem("https://oauth2.googleapis.com/token", hosts),
    ).toBeNull();
    expect(providerUrlProblem("https://[::1]/token", hosts)).not.toBeNull();
    expect(
      providerUrlProblem("https://192.168.1.1/token", hosts),
    ).not.toBeNull();
    expect(providerUrlProblem("https://localhost/token", hosts)).not.toBeNull();
    expect(
      providerUrlProblem("https://appleid.apple.com/auth/token", hosts),
    ).toBe("host not on the provider allowlist");
    expect(providerUrlProblem("ftp://oauth2.googleapis.com/x", hosts)).toBe(
      "not https",
    );
  });
});
