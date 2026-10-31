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
    ["key_return=allow, last", { keyReturn: true }, `${AUTH}&key_return=allow`],
    [
      "key_return after license_choice",
      {
        purpose: "signin",
        licenseChoice: "app",
        choiceAvailable: true,
        keyReturn: true,
      },
      `${AUTH}&purpose=signin&license_choice=app&key_return=allow`,
    ],
    ["key_return=false sends nothing", { keyReturn: false }, AUTH],
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

describe("parseTokenAnswer: the key return (LK-SKIP)", () => {
  const device = { id: "D", status: "authorized" };
  const license = { id: "L", tier: "pro" };
  const SUBJECT = "ps_" + "A".repeat(22);
  const good = {
    access_token: "pkeyt_x",
    token_type: "Bearer",
    via: "key",
    scope: "",
    schemaVersion: 1,
    device,
    license,
    subject: null,
    keyEntries: { used: 1, limit: 3 },
  };
  const opt = { keyReturn: true };
  const activated = {
    kind: "activated",
    accessToken: "pkeyt_x",
    scope: "",
    subject: null,
    schemaVersion: 1,
    device,
    license,
    keyEntries: { used: 1, limit: 3 },
  };

  it("the opt-in is recorded on the pending request, and only when set", async () => {
    expect((await startRedirect({ ...base, keyReturn: true })).keyReturn).toBe(
      true,
    );
    expect(await startRedirect(base)).not.toHaveProperty("keyReturn");
    expect(
      await startRedirect({ ...base, keyReturn: false }),
    ).not.toHaveProperty("keyReturn");
  });
  it("an opted-in via:key body is activated, subject null", () => {
    expect(parseTokenAnswer(200, good, opt)).toEqual(activated);
  });
  it("a pairwise subject string is accepted", () => {
    expect(parseTokenAnswer(200, { ...good, subject: SUBJECT }, opt)).toEqual({
      ...activated,
      subject: SUBJECT,
    });
  });
  it("zero counts are non-negative integers", () => {
    expect(
      parseTokenAnswer(
        200,
        { ...good, keyEntries: { used: 0, limit: 0 } },
        opt,
      ),
    ).toEqual({ ...activated, keyEntries: { used: 0, limit: 0 } });
  });
  it("via:key without the opt-in is malformed", () => {
    expect(parseTokenAnswer(200, good)).toEqual({ kind: "malformed" });
    expect(parseTokenAnswer(200, good, {})).toEqual({ kind: "malformed" });
    expect(parseTokenAnswer(200, good, { keyReturn: false })).toEqual({
      kind: "malformed",
    });
  });
  it.each([
    ["via is not key", { via: "account" }],
    ["via is null", { via: null }],
    ["via is empty", { via: "" }],
    ["scope is not empty", { scope: "profile" }],
    ["scope is absent", { scope: undefined }],
    ["license is null", { license: null }],
    ["license is a string", { license: "L" }],
    ["license is an array", { license: [] }],
    ["license is absent", { license: undefined }],
    ["keyEntries is absent", { keyEntries: undefined }],
    ["keyEntries is null", { keyEntries: null }],
    ["keyEntries is an array", { keyEntries: [1, 3] }],
    ["keyEntries.used is absent", { keyEntries: { limit: 3 } }],
    ["keyEntries.limit is absent", { keyEntries: { used: 1 } }],
    ["keyEntries.used is negative", { keyEntries: { used: -1, limit: 3 } }],
    ["keyEntries.limit is negative", { keyEntries: { used: 1, limit: -3 } }],
    ["keyEntries.used is fractional", { keyEntries: { used: 1.5, limit: 3 } }],
    ["keyEntries.limit is a string", { keyEntries: { used: 1, limit: "3" } }],
    ["keyEntries.used is NaN", { keyEntries: { used: NaN, limit: 3 } }],
    ["subject is absent", { subject: undefined }],
    ["subject is a number", { subject: 7 }],
    ["subject is empty", { subject: "" }],
    ["subject is not a pairwise subject", { subject: "user-1" }],
    ["subject is a short pairwise subject", { subject: "ps_abc" }],
    ["access_token is absent", { access_token: undefined }],
    ["access_token is empty", { access_token: "" }],
    ["device is absent", { device: undefined }],
    ["device is a string", { device: "D" }],
  ])("an opted-in via:key body where %s is malformed", (_n, patch) => {
    expect(parseTokenAnswer(200, { ...good, ...patch }, opt)).toEqual({
      kind: "malformed",
    });
  });
  it("a via member of any other value is malformed, opted in or not", () => {
    const ordinary = {
      access_token: "t",
      scope: "profile",
      subject: SUBJECT,
      schemaVersion: 1,
      device,
      license: null,
    };
    expect(parseTokenAnswer(200, { ...ordinary, via: "other" }, opt)).toEqual({
      kind: "malformed",
    });
    expect(parseTokenAnswer(200, { ...ordinary, via: "other" })).toEqual({
      kind: "malformed",
    });
  });
  it("an ordinary answer is still a token when opted in, and a null subject is not one", () => {
    const ordinary = {
      access_token: "t",
      scope: "profile",
      subject: SUBJECT,
      schemaVersion: 1,
      device,
      license: null,
    };
    expect(parseTokenAnswer(200, ordinary, opt)).toMatchObject({
      kind: "token",
      subject: SUBJECT,
    });
    expect(parseTokenAnswer(200, { ...ordinary, subject: null }, opt)).toEqual({
      kind: "malformed",
    });
  });
  it("choose is decided first, even with the opt-in and via:key beside it", () => {
    const GRANT = "sg_" + "A".repeat(43);
    expect(
      parseTokenAnswer(
        200,
        { ...good, status: "choose", grant: GRANT, expiresIn: 3, choices: {} },
        opt,
      ),
    ).toMatchObject({ kind: "choose", grant: GRANT });
  });
  it("a non-200 is refused whatever the opt-in", () => {
    expect(
      parseTokenAnswer(400, { ...good, error: "invalid_grant" }, opt),
    ).toMatchObject({
      kind: "refused",
      error: "invalid_grant",
    });
  });

  describe("refusal details", () => {
    it("device_limit carries limit, deviceCount and manageUrl", () => {
      expect(
        parseTokenAnswer(403, {
          error: "device_limit",
          limit: 2,
          deviceCount: 2,
          manageUrl: "https://key.plrs.im/manage",
        }),
      ).toEqual({
        kind: "refused",
        error: "device_limit",
        status: 403,
        details: {
          limit: 2,
          deviceCount: 2,
          manageUrl: "https://key.plrs.im/manage",
        },
      });
    });
    it("key_entry_limit carries keyEntries and manageUrl", () => {
      expect(
        parseTokenAnswer(403, {
          error: "key_entry_limit",
          keyEntries: { used: 3, limit: 3 },
          manageUrl: "https://m.example/x",
        }),
      ).toEqual({
        kind: "refused",
        error: "key_entry_limit",
        status: 403,
        details: {
          keyEntries: { used: 3, limit: 3 },
          manageUrl: "https://m.example/x",
        },
      });
    });
    it("license_owned carries signInUrl", () => {
      expect(
        parseTokenAnswer(403, {
          error: "license_owned",
          signInUrl: "https://s.example/in",
        }),
      ).toEqual({
        kind: "refused",
        error: "license_owned",
        status: 403,
        details: { signInUrl: "https://s.example/in" },
      });
    });
    it("a member of the wrong type is dropped, and no details member appears when none is left", () => {
      expect(
        parseTokenAnswer(403, {
          error: "device_limit",
          limit: "2",
          deviceCount: -1,
          manageUrl: 5,
          keyEntries: { used: 1 },
          signInUrl: "",
        }),
      ).toEqual({ kind: "refused", error: "device_limit", status: 403 });
    });
  });
});
