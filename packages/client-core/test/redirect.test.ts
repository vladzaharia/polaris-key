// @pkey-feature identity.redirect.native
// I-15b.1: the native redirect helpers. The five redirect-native-* transcripts are the fixtures:
// the pushed request's body, the authorize path, the redirect back and the token form are the
// bytes the Worker recorded.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authorizeUrlFor,
  chooseRedirectClass,
  classifyNativeRedirectUri,
  closeNativeSession,
  nativeRedirectUri,
  nativeTokenRequest,
  parseNativeCallback,
  parsePushedAnswer,
  pushRequest,
  reopen,
  startNativeSession,
} from "../src/index.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/transcripts",
);
interface Item {
  request: { method: string; path: string; body: { json?: unknown } | null };
  response: { status: number; body: unknown };
}
interface Step {
  action: string;
  args: Record<string, string>;
  exchanges?: { items: Item[] };
}
function steps(name: string): Step[] {
  return JSON.parse(
    readFileSync(join(dir, `redirect-native-${name}.json`), "utf8"),
  ).steps;
}
const items = (s: Step): Item[] => s.exchanges?.items ?? [];
const find = (name: string, pathPart: string): Item[] =>
  steps(name)
    .flatMap(items)
    .filter((i) => i.request.path.includes(pathPart));
const formObject = (body: string) =>
  Object.fromEntries(new URLSearchParams(body).entries());

const ISS = "https://key.plrs.im/djdl/identity";
const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const ENDPOINTS = {
  requestEndpoint: "https://key.plrs.im/djdl/identity/request",
  authorizeEndpoint: "https://key.plrs.im/djdl/identity/authorize",
  tokenEndpoint: "https://key.plrs.im/djdl/identity/token",
  issuer: ISS,
  clientId: "djdl",
  state: STATE,
  codeVerifier: VERIFIER,
  deviceName: "Ada's Mac",
};
const LOOP = "http://127.0.0.1:49152/pkey/callback";
const SCHEME = "com.tidewater.studio:/pkey/callback";

describe("transcript fixtures: the pushed request", () => {
  it("loopback: body, answer, authorize URL", async () => {
    const [push, authorize] = find("loopback", "/identity/").filter(
      (i) => !i.request.path.includes("/token"),
    );
    const out = await pushRequest({ ...ENDPOINTS, redirectUri: LOOP });
    expect(formObject(out.body)).toEqual(push!.request.body!.json);
    expect(out.contentType).toBe("application/x-www-form-urlencoded");
    const answer = parsePushedAnswer(
      push!.response.status,
      push!.response.body,
    );
    expect(answer.kind).toBe("pushed");
    if (answer.kind !== "pushed") return;
    const session = startNativeSession(out.pending, answer, 1_000);
    expect(
      new URL(session.authorizeUrl).pathname +
        new URL(session.authorizeUrl).search,
    ).toBe(authorize!.request.path);
  });
  it("scheme: return_uri; choose-app: license_choice", async () => {
    const [push] = find("scheme", "/identity/request");
    const out = await pushRequest({
      ...ENDPOINTS,
      redirectUri: SCHEME,
      returnUri: SCHEME,
    });
    expect(formObject(out.body)).toEqual(push!.request.body!.json);
    const [app] = find("choose-app", "/identity/request");
    const o2 = await pushRequest({
      ...ENDPOINTS,
      redirectUri: LOOP,
      licenseChoice: "app",
      choiceAvailable: true,
    });
    expect(formObject(o2.body)).toEqual(app!.request.body!.json);
    const o3 = await pushRequest({
      ...ENDPOINTS,
      redirectUri: LOOP,
      licenseChoice: "app",
    });
    expect(formObject(o3.body).license_choice).toBeUndefined();
  });
  it("errors: refusals read flat; the token form and device header match", () => {
    const refused = find("errors", "/identity/request");
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      if (r.response.status === 201) continue;
      const a = parsePushedAnswer(r.response.status, r.response.body);
      expect(a).toMatchObject({
        kind: "refused",
        error: "redirect_uri_mismatch",
      });
    }
    const [tok] = find("loopback", "/identity/token");
    const req = nativeTokenRequest(
      {
        tokenEndpoint: ENDPOINTS.tokenEndpoint,
        clientId: "djdl",
        codeVerifier: VERIFIER,
        redirectUri: LOOP,
      },
      (tok!.request.body!.json as Record<string, string>).code!,
      "TRANSCRIPTDEVICE0000000000000001",
    );
    expect(formObject(req.body)).toEqual(tok!.request.body!.json);
    expect(req.headers["X-PKey-Device"]).toBe(
      "TRANSCRIPTDEVICE0000000000000001",
    );
    expect(req.url).toBe(ENDPOINTS.tokenEndpoint);
  });
});

describe("transcript fixtures: the redirect back", () => {
  const cb = (name: string) =>
    steps(name).find((s) => s.action === "redirectComplete")!.args.callbackUrl!;
  it("loopback carries request=; scheme does not", () => {
    const l = parseNativeCallback(
      { state: STATE, issuer: ISS, redirectUri: LOOP },
      cb("loopback"),
    );
    expect(l).toMatchObject({ kind: "code" });
    expect((l as { request?: string }).request).toMatch(/^rq_/);
    const s = parseNativeCallback(
      { state: STATE, issuer: ISS, redirectUri: SCHEME },
      cb("scheme"),
    );
    expect(s).toMatchObject({ kind: "code" });
    expect((s as { request?: string }).request).toBeUndefined();
  });
});

describe("parseNativeCallback refusals", () => {
  const p = { state: STATE, issuer: ISS, redirectUri: LOOP };
  const rq = "rq_fxXQ7DEgqPUfZlsJYdm76w";
  const q = (extra: string) =>
    `${LOOP}?code=abc&state=${STATE}&iss=${encodeURIComponent(ISS)}&request=${rq}${extra}`;
  const reason = (u: unknown, pending = p) => {
    const r = parseNativeCallback(pending, u);
    return r.kind === "failed" ? r.reason : r.kind;
  };
  it("accepts the exact shape", () => {
    expect(reason(q(""))).toBe("code");
  });
  it.each([
    [q("&extra=1"), "unexpected-parameter"],
    [q("&code=two"), "malformed"],
    [q("#frag"), "malformed"],
    [q("").replace("49152", "49153"), "redirect-mismatch"],
    [q("").replace("127.0.0.1", "localhost"), "redirect-mismatch"],
    [q("").replace(STATE, "other-state-0123456789"), "state-mismatch"],
    [
      q("").replace(encodeURIComponent(ISS), "https%3A%2F%2Fevil.example"),
      "issuer-mismatch",
    ],
    [`${LOOP}?code=abc&state=${STATE}&request=${rq}`, "issuer-mismatch"],
    [
      `${LOOP}?code=abc&state=${STATE}&iss=${encodeURIComponent(ISS)}`,
      "request-invalid",
    ],
    [q("").replace(rq, "rq_short"), "request-invalid"],
    [
      `${LOOP}?state=${STATE}&iss=${encodeURIComponent(ISS)}&request=${rq}`,
      "missing-code",
    ],
    [42, "malformed"],
  ])("%s -> %s", (url, want) => {
    expect(reason(url)).toBe(want);
  });
  it("errors: access_denied cancels, others fail, extras refused", () => {
    const base = `${LOOP}?state=${STATE}&iss=${encodeURIComponent(ISS)}&request=${rq}`;
    expect(parseNativeCallback(p, `${base}&error=access_denied`)).toMatchObject(
      { kind: "cancelled" },
    );
    expect(parseNativeCallback(p, `${base}&error=server_error`)).toMatchObject({
      kind: "failed",
      reason: "authorization-error",
      error: "server_error",
    });
    expect(reason(`${base}&error=access_denied&x=1`)).toBe(
      "unexpected-parameter",
    );
  });
  it("scheme class: request optional, but a present one must be valid", () => {
    const s = { state: STATE, issuer: ISS, redirectUri: SCHEME };
    const base = `${SCHEME}?code=abc&state=${STATE}&iss=${encodeURIComponent(ISS)}`;
    expect(reason(base, s)).toBe("code");
    expect(reason(`${base}&request=bad`, s)).toBe("request-invalid");
    expect(
      reason(base.replace("com.tidewater.studio", "com.other.app"), s),
    ).toBe("redirect-mismatch");
  });
});

describe("redirect URIs and class choice", () => {
  it("classifies", () => {
    expect(classifyNativeRedirectUri(LOOP)).toBe("loopback");
    expect(classifyNativeRedirectUri("http://[::1]:5000/pkey/callback")).toBe(
      "loopback",
    );
    expect(classifyNativeRedirectUri(SCHEME)).toBe("scheme");
    expect(classifyNativeRedirectUri("https://app.example/open/pkey")).toBe(
      "claimed",
    );
    for (const bad of [
      "http://localhost:49152/pkey/callback",
      "http://127.0.0.1/pkey/callback",
      "http://127.0.0.1:80/pkey/callback",
      "http://127.0.0.1:49152/other",
      "http://127.0.0.1:49152/pkey/callback?x=1",
      "http://127.0.0.1:49152/pkey/callback#f",
      "http://user@127.0.0.1:49152/pkey/callback",
      "com.x:/other",
      "com.x://pkey/callback",
      "https://user@app.example/open",
      "https://app.example/open#f",
      "https://app.example/",
      "javascript:/pkey/callback",
      "",
      7,
    ])
      expect(classifyNativeRedirectUri(bad)).toBeNull();
  });
  it("builds", () => {
    expect(nativeRedirectUri("loopback", { port: 49152 })).toBe(LOOP);
    expect(
      nativeRedirectUri("scheme", { scheme: "com.tidewater.studio" }),
    ).toBe(SCHEME);
    expect(() => nativeRedirectUri("loopback", { port: 80 })).toThrow();
    expect(() => nativeRedirectUri("scheme", { scheme: "https" })).toThrow();
  });
  const discovery = {
    loopback: true,
    schemes: [SCHEME],
    claimedHttps: ["https://app.example/open"],
  };
  const requestEndpoint = ENDPOINTS.requestEndpoint;
  it("chooses in order and falls back", () => {
    const base = { requestEndpoint, discovery, canListen: true };
    expect(chooseRedirectClass(base)).toEqual({ kind: "loopback" });
    expect(
      chooseRedirectClass({
        ...base,
        canListen: false,
        registeredSchemes: [SCHEME],
      }),
    ).toEqual({ kind: "scheme", redirectUri: SCHEME });
    expect(
      chooseRedirectClass({
        ...base,
        discovery: { ...discovery, loopback: false },
        registeredClaimed: ["https://app.example/open"],
      }),
    ).toEqual({ kind: "claimed", redirectUri: "https://app.example/open" });
    expect(
      chooseRedirectClass({
        ...base,
        canListen: false,
        registeredSchemes: ["x:/pkey/callback"],
      }),
    ).toMatchObject({
      kind: "unavailable",
      code: "redirect-unavailable",
      reason: "no-class",
    });
    expect(
      chooseRedirectClass({ ...base, requestEndpoint: undefined }),
    ).toMatchObject({
      kind: "unavailable",
      reason: "request-not-served",
    });
    expect(
      chooseRedirectClass({ ...base, discovery: undefined }),
    ).toMatchObject({
      reason: "request-not-served",
    });
  });
});

describe("pushed answer, reopen, request validation", () => {
  it("parses answers", () => {
    const ok = {
      request_uri: "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw",
      expires_in: 600,
    };
    expect(parsePushedAnswer(201, ok)).toEqual({
      kind: "pushed",
      requestUri: ok.request_uri,
      expiresIn: 600,
    });
    expect(parsePushedAnswer(200, ok).kind).toBe("refused");
    expect(parsePushedAnswer(201, { ...ok, request_uri: "urn:x" }).kind).toBe(
      "malformed",
    );
    expect(parsePushedAnswer(201, { ...ok, expires_in: 601 }).kind).toBe(
      "malformed",
    );
    expect(parsePushedAnswer(201, null).kind).toBe("malformed");
    expect(
      parsePushedAnswer(429, { error: "rate_limited", retryAfter: 4.2 }),
    ).toEqual({
      kind: "refused",
      error: "rate_limited",
      status: 429,
      retryAfterSeconds: 5,
    });
    expect(parsePushedAnswer(502, "x")).toMatchObject({
      error: "server_error",
    });
  });
  it("reopen returns the same URL until expiry or close", () => {
    const session = startNativeSession(
      { authorizeEndpoint: ENDPOINTS.authorizeEndpoint, clientId: "djdl" },
      {
        kind: "pushed",
        requestUri: "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw",
        expiresIn: 600,
      },
      0,
    );
    const a = reopen(session, 1000);
    const b = reopen(session, 599_999);
    expect(a).toEqual({ kind: "open", url: session.authorizeUrl });
    expect(b).toEqual(a);
    expect(reopen(session, 600_000)).toEqual({ kind: "expired" });
    closeNativeSession(session);
    expect(reopen(session, 1)).toEqual({ kind: "closed" });
    expect(() =>
      authorizeUrlFor(ENDPOINTS.authorizeEndpoint, "djdl", "urn:bad"),
    ).toThrow();
  });
  it("refuses a non-native redirect, a bad return_uri and bad entropy", async () => {
    await expect(
      pushRequest({ ...ENDPOINTS, redirectUri: "http://app.example/auth" }),
    ).rejects.toThrow();
    await expect(
      pushRequest({ ...ENDPOINTS, redirectUri: LOOP, returnUri: LOOP }),
    ).rejects.toThrow();
    await expect(
      pushRequest({ ...ENDPOINTS, redirectUri: LOOP, state: "short" }),
    ).rejects.toThrow();
    await expect(
      pushRequest({ ...ENDPOINTS, redirectUri: LOOP, codeVerifier: "x" }),
    ).rejects.toThrow();
    const out = await pushRequest({
      ...ENDPOINTS,
      state: undefined,
      codeVerifier: undefined,
      redirectUri: LOOP,
    });
    expect(out.pending.state).toHaveLength(43);
    expect(out.body).not.toContain(out.pending.codeVerifier);
  });
});
