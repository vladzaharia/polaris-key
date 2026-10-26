// @pkey-feature identity.redirect.web identity.signin.hints
// I-10a.7: the redirect core's vectors. Python, Swift, Kotlin and Godot port THESE tables
// (RFC 7636 appendix B, the transcript conversation's authorize URL and form body, the callback
// checks, the token answers); the transcripts redeem the same bytes.
import { describe, expect, it } from "vitest";
import {
  checkCallback,
  generateCodeVerifier,
  generateState,
  isRedirectUri,
  parseTokenAnswer,
  pkceChallenge,
  startRedirect,
  tokenForm,
  type StartRedirectOptions,
} from "../src/index.js";

const ISS = "https://key.plrs.im/djdl/identity";
const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const REDIRECT = "https://app.example/auth/callback";
const base: StartRedirectOptions = {
  authorizeEndpoint: "https://key.plrs.im/djdl/identity/authorize",
  tokenEndpoint: "https://key.plrs.im/djdl/identity/token",
  issuer: ISS,
  clientId: "djdl",
  redirectUri: REDIRECT,
  state: STATE,
  codeVerifier: VERIFIER,
};
const AUTH = `${base.authorizeEndpoint}?response_type=code&client_id=djdl&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&state=${STATE}&code_challenge=-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10&code_challenge_method=S256&scope=profile+email`;

describe("S256 PKCE", () => {
  it.each([
    // RFC 7636 appendix B
    [
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    ],
    // the conformance/transcripts conversation
    [VERIFIER, "-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10"],
  ])("challenge of %s", async (verifier, challenge) => {
    expect(await pkceChallenge(verifier)).toBe(challenge);
  });

  it("generates 43-character unreserved verifiers and states that differ", () => {
    const a = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(a);
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateState(() => new Uint8Array(32))).toBe("A".repeat(43));
  });
});

describe("startRedirect: the authorize URL", () => {
  it.each<[string, Partial<StartRedirectOptions>, string]>([
    ["the plain request", {}, AUTH],
    [
      "hints, verbatim and form-encoded",
      { loginHint: "Ada@Example.com", nameHint: "Ada", purpose: "attach" },
      `${AUTH}&login_hint=Ada%40Example.com&name_hint=Ada&purpose=attach`,
    ],
    [
      "a hint that is not an email is still sent as given",
      { loginHint: "not an email" },
      `${AUTH}&login_hint=not+an+email`,
    ],
    [
      "license_choice=app when asked and the choice endpoints exist",
      { licenseChoice: "app", choiceAvailable: true },
      `${AUTH}&license_choice=app`,
    ],
    [
      "license_choice withheld when discovery has no choice endpoints",
      { licenseChoice: "app", choiceAvailable: false },
      AUTH,
    ],
    [
      "license_choice=card is never sent",
      { licenseChoice: "card", choiceAvailable: true },
      AUTH,
    ],
    [
      "a scope list",
      { scope: ["profile", "cloudSync"] },
      AUTH.replace("scope=profile+email", "scope=profile+cloudSync"),
    ],
    ["empty hints are dropped", { loginHint: "", nameHint: "" }, AUTH],
    [
      "UTF-8, * and ~ in a hint (WHATWG form encoding)",
      { nameHint: "Zoë * ~" },
      `${AUTH}&name_hint=Zo%C3%AB+*+%7E`,
    ],
  ])("%s", async (_name, extra, url) => {
    const p = await startRedirect({ ...base, ...extra });
    expect(p.authorizeUrl).toBe(url);
    expect(p.state).toBe(STATE);
    expect(p.authorizeUrl).not.toContain(VERIFIER);
  });

  it("random entropy yields a request that satisfies its own rules", async () => {
    const p = await startRedirect({
      ...base,
      state: undefined,
      codeVerifier: undefined,
    });
    expect(p.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.authorizeUrl).toContain(
      `code_challenge=${await pkceChallenge(p.codeVerifier)}`,
    );
  });

  it.each([
    ["http redirect", { redirectUri: "http://app.example/cb" }],
    ["loopback http (I-15's)", { redirectUri: "http://127.0.0.1:8080/cb" }],
    ["a fragment", { redirectUri: `${REDIRECT}#x` }],
    ["userinfo", { redirectUri: "https://u:p@app.example/cb" }],
    ["a relative URI", { redirectUri: "/cb" }],
    ["a short state", { state: "short" }],
    ["a short verifier", { codeVerifier: "too-short" }],
    [
      "a verifier outside the unreserved set",
      { codeVerifier: "a".repeat(42) + "+" },
    ],
    ["no issuer", { issuer: "" }],
    ["a relative token endpoint", { tokenEndpoint: "/djdl/identity/token" }],
    ["an empty scope", { scope: "  " }],
  ])("refuses %s before anything is built", async (_n, extra) => {
    await expect(startRedirect({ ...base, ...extra })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("isRedirectUri", () => {
    expect(isRedirectUri(REDIRECT)).toBe(true);
    expect(isRedirectUri("https://app.example")).toBe(true);
    expect(isRedirectUri("https://app.example/a b")).toBe(false);
    expect(isRedirectUri("https://app.example\\@evil.example/")).toBe(false);
    expect(isRedirectUri(5)).toBe(false);
  });
});

describe("checkCallback", () => {
  const p = { state: STATE, redirectUri: REDIRECT, issuer: ISS };
  const iss = encodeURIComponent(ISS);
  const ok = `${REDIRECT}?code=abc_DEF-123&state=${STATE}&iss=${iss}`;

  it.each([
    ["a valid callback", ok, { kind: "code", code: "abc_DEF-123" }],
    [
      "parameters in another order, with an extra one",
      `${REDIRECT}?iss=${iss}&x=1&state=${STATE}&code=c`,
      { kind: "code", code: "c" },
    ],
    [
      "access_denied is cancelled",
      `${REDIRECT}?error=access_denied&state=${STATE}&iss=${iss}`,
      { kind: "cancelled" },
    ],
    [
      "another error is a failure, naming it",
      `${REDIRECT}?error=server_error&state=${STATE}&iss=${iss}`,
      {
        kind: "failed",
        code: "sign-in-failed",
        reason: "authorization-error",
        error: "server_error",
      },
    ],
    [
      "a wrong state",
      ok.replace(STATE, "another-state-0123456789"),
      { kind: "failed", code: "sign-in-failed", reason: "state-mismatch" },
    ],
    [
      "no state",
      `${REDIRECT}?code=c&iss=${iss}`,
      { kind: "failed", code: "sign-in-failed", reason: "state-mismatch" },
    ],
    [
      "a wrong issuer (mix-up, RFC 9207)",
      `${REDIRECT}?code=c&state=${STATE}&iss=${encodeURIComponent("https://evil.example/djdl/identity")}`,
      { kind: "failed", code: "sign-in-failed", reason: "issuer-mismatch" },
    ],
    [
      "no issuer",
      `${REDIRECT}?code=c&state=${STATE}`,
      { kind: "failed", code: "sign-in-failed", reason: "issuer-mismatch" },
    ],
    [
      "state is checked before iss, and iss before error",
      `${REDIRECT}?error=access_denied&state=bad-state-0123456789&iss=x`,
      { kind: "failed", code: "sign-in-failed", reason: "state-mismatch" },
    ],
    [
      "an access_denied from the wrong issuer is not a cancel",
      `${REDIRECT}?error=access_denied&state=${STATE}&iss=x`,
      { kind: "failed", code: "sign-in-failed", reason: "issuer-mismatch" },
    ],
    [
      "no code",
      `${REDIRECT}?state=${STATE}&iss=${iss}`,
      { kind: "failed", code: "sign-in-failed", reason: "missing-code" },
    ],
    [
      "an empty code",
      `${REDIRECT}?code=&state=${STATE}&iss=${iss}`,
      { kind: "failed", code: "sign-in-failed", reason: "missing-code" },
    ],
    [
      "a repeated code",
      `${ok}&code=other`,
      { kind: "failed", code: "sign-in-failed", reason: "malformed" },
    ],
    [
      "another redirect URI path",
      ok.replace("/auth/callback", "/other"),
      { kind: "failed", code: "sign-in-failed", reason: "redirect-mismatch" },
    ],
    [
      "another origin",
      ok.replace("app.example", "evil.example"),
      { kind: "failed", code: "sign-in-failed", reason: "redirect-mismatch" },
    ],
    [
      "a fragment carrying the code is not read",
      `${REDIRECT}#code=c&state=${STATE}&iss=${iss}`,
      { kind: "failed", code: "sign-in-failed", reason: "state-mismatch" },
    ],
    [
      "not a URL",
      "code=c&state=x",
      { kind: "failed", code: "sign-in-failed", reason: "malformed" },
    ],
  ])("%s", (_name, url, expected) => {
    expect(checkCallback(p, url)).toEqual(expected);
  });

  it("a malformed percent escape is malformed, not a throw", () => {
    expect(
      checkCallback(p, `${REDIRECT}?code=%E0%A4%A&state=${STATE}`),
    ).toMatchObject({ kind: "failed", reason: "malformed" });
  });
});

describe("tokenForm", () => {
  it("fixed member order, form-encoded", () => {
    expect(
      tokenForm(
        { clientId: "djdl", codeVerifier: VERIFIER, redirectUri: REDIRECT },
        "pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0",
      ),
    ).toBe(
      `grant_type=authorization_code&client_id=djdl&code=pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0&code_verifier=${VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback`,
    );
  });
  it("adds device_name last when there is one", () => {
    expect(
      tokenForm(
        { clientId: "djdl", codeVerifier: VERIFIER, redirectUri: REDIRECT },
        "c",
        "Ada's PC",
      ),
    ).toMatch(/&redirect_uri=[^&]+&device_name=Ada%27s\+PC$/);
  });
});

describe("parseTokenAnswer", () => {
  const device = { id: "D", status: "authorized" };
  const GRANT = "sg_" + "A".repeat(43);
  it("a token response", () => {
    expect(
      parseTokenAnswer(200, {
        access_token: "pkeyt_x",
        token_type: "Bearer",
        scope: "profile email",
        schemaVersion: 1,
        device,
        license: null,
        subject: "ps_abc",
      }),
    ).toEqual({
      kind: "token",
      accessToken: "pkeyt_x",
      scope: "profile email",
      subject: "ps_abc",
      schemaVersion: 1,
      device,
      license: null,
    });
  });
  it("choose is decided by status alone, even beside other members", () => {
    expect(
      parseTokenAnswer(200, {
        status: "choose",
        grant: GRANT,
        expiresIn: 300,
        choices: { state: "choose" },
        access_token: "pkeyt_ignored",
      }),
    ).toEqual({
      kind: "choose",
      grant: GRANT,
      expiresIn: 300,
      choices: { state: "choose" },
    });
  });
  it.each([
    [
      "a bad grant",
      { status: "choose", grant: "sg_short", expiresIn: 1, choices: {} },
    ],
    ["no access_token", { scope: "x", subject: "s", device, license: null }],
    ["no subject", { access_token: "t", scope: "x", device, license: null }],
    [
      "no license member",
      { access_token: "t", scope: "x", subject: "s", device },
    ],
    ["not an object", "x"],
  ])("200 with %s is malformed", (_n, body) => {
    expect(parseTokenAnswer(200, body)).toEqual({ kind: "malformed" });
  });
  it.each([
    [
      400,
      { error: "invalid_grant" },
      { kind: "refused", error: "invalid_grant", status: 400 },
    ],
    [
      401,
      { error: "invalid_client" },
      { kind: "refused", error: "invalid_client", status: 401 },
    ],
    [
      429,
      { error: "rate_limited", retryAfter: 2.2 },
      {
        kind: "refused",
        error: "rate_limited",
        status: 429,
        retryAfterSeconds: 3,
      },
    ],
    [500, "oops", { kind: "refused", error: "server_error", status: 500 }],
    [
      502,
      { error: "" },
      { kind: "refused", error: "server_error", status: 502 },
    ],
  ])("%i %j", (status, body, expected) => {
    expect(parseTokenAnswer(status, body)).toEqual(expected);
  });
});
