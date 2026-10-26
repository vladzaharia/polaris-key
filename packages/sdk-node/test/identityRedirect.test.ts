// @pkey-feature identity.redirect.web identity.signin.hints
// The Node redirect session beyond what a recording shows (I-10a.7): the session is single use,
// a refusal never wipes the device's token, a bad callback sends nothing, and the endpoints come
// from discovery or not at all. The wire conversation itself is the transcripts'
// (`redirect-web-*`, `identity-request-hints`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import type { ServiceSlug } from "../src/discovery.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const API = `${BASE}/${PRODUCT}`;
const ISS = `${API}/identity`;
const REDIRECT = "https://app.example/cb";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const TOKEN_OK = {
  access_token: "pkeyt_new",
  token_type: "Bearer",
  scope: "profile email",
  schemaVersion: 1,
  device: { id: "D" },
  license: { id: "lic_1" },
  subject: "ps_abc",
};

interface Seen {
  method: string;
  path: string;
  type: string | null;
  body: string;
}

function setup(opts: {
  token?: () => Response;
  identity?: Record<string, unknown> | null;
  services?: ServiceSlug[];
}) {
  const seen: Seen[] = [];
  const identity =
    opts.identity === null
      ? undefined
      : {
          enabled: true,
          configured: true,
          issuer: ISS,
          endpoints: {
            authorize: `${API}/identity/authorize`,
            token: `${API}/identity/token`,
          },
          ...opts.identity,
        };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname,
      type: req.headers.get("content-type"),
      body: req.method === "GET" ? "" : await req.text(),
    });
    if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`)
      return json({
        product: PRODUCT,
        services: identity ? { identity } : {},
      });
    if (url.pathname === `/${PRODUCT}/identity/token`)
      return (opts.token ?? (() => json(TOKEN_OK)))();
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = new InMemoryStore();
  return { seen, store, fetchImpl, services: opts.services ?? ["identity"] };
}

async function boot(env: ReturnType<typeof setup>, token?: string) {
  if (token) await env.store.setToken(token);
  const c = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    trustRefresh: false,
    store: env.store,
    fetchImpl: env.fetchImpl,
    requestTimeoutMs: 0,
    expectedServices: env.services,
    devices: { fingerprint: false },
  });
  await c.init();
  // The acquisition sync is the sync transcripts' business.
  (c.identity as unknown as { onAcquired: () => Promise<void> }).onAcquired =
    async () => undefined;
  return c;
}

/** A started session, its `state`, and a callback URL builder carrying the right issuer. */
async function begin(
  env: ReturnType<typeof setup>,
  deviceToken?: string,
  extra: { licenseChoice?: "app" } = {},
) {
  const c = await boot(env, deviceToken);
  const s = await c.identity.signIn.start({
    channel: "redirect",
    redirectUri: REDIRECT,
    ...extra,
  });
  const state = new URL(s.authorizeUrl).searchParams.get("state")!;
  const cb = (q: string) =>
    callback(`${q}&state=${state}&iss=${encodeURIComponent(ISS)}`);
  return { c, s, state, cb };
}

const callback = (q: string) => `${REDIRECT}?${q}`;
const tokenCalls = (e: ReturnType<typeof setup>) =>
  e.seen.filter((s) => s.path === `/${PRODUCT}/identity/token`);

describe("redirect sign-in", () => {
  it("builds the authorize URL from discovery and redeems the code with a form body", async () => {
    const env = setup({});
    const c = await boot(env);
    const s = await c.identity.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
      loginHint: "ada@example.com",
    });
    const url = new URL(s.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/identity/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(PRODUCT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_hint")).toBe("ada@example.com");
    expect(url.searchParams.has("code_verifier")).toBe(false);
    const state = url.searchParams.get("state")!;

    const out = await s.complete(
      callback(`code=C0DE&state=${state}&iss=${encodeURIComponent(ISS)}`),
    );
    expect(out).toEqual({
      kind: "signedIn",
      subject: "ps_abc",
      scope: "profile email",
      licenseId: "lic_1",
      activation: { licenseId: "lic_1" },
    });
    expect(await env.store.getToken()).toBe("pkeyt_new");
    // The subject is persisted for `identity.subject()` (a value that is no `ps_` subject reads as none).
    const dir = (c.identity as unknown as { ctx: { dirs: { state: string } } })
      .ctx.dirs.state;
    expect(JSON.parse(readFileSync(join(dir, "subject.json"), "utf8"))).toEqual(
      { subject: "ps_abc" },
    );
    const [call] = tokenCalls(env);
    expect(call!.type).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call!.body);
    expect(form.get("code")).toBe("C0DE");
    expect(form.get("grant_type")).toBe("authorization_code");
    // The verifier hashes to the challenge the URL carried (S256, never sent in the URL).
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(form.get("code_verifier")!),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
  });

  it("is single use: a replayed callback sends nothing", async () => {
    const env = setup({});
    const { s, cb } = await begin(env);
    await s.complete(cb("code=C"));
    await expect(s.complete(cb("code=C"))).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(tokenCalls(env)).toHaveLength(1);
  });

  it.each([
    [
      "a wrong state",
      (s: string) =>
        `code=C&state=other-state-0123456789&iss=${encodeURIComponent(ISS)}`,
    ],
    [
      "a wrong issuer",
      (s: string) =>
        `code=C&state=${s}&iss=${encodeURIComponent("https://evil.example/x")}`,
    ],
    ["no issuer", (s: string) => `code=C&state=${s}`],
    [
      "a server_error",
      (s: string) =>
        `error=server_error&state=${s}&iss=${encodeURIComponent(ISS)}`,
    ],
  ])(
    "%s is sign-in-failed, sends no token request and keeps the device token",
    async (_n, q) => {
      const env = setup({});
      const { s, state } = await begin(env, "pkeyt_old");
      await expect(s.complete(callback(q(state)))).rejects.toMatchObject({
        code: "sign-in-failed",
      });
      expect(tokenCalls(env)).toHaveLength(0);
      expect(await env.store.getToken()).toBe("pkeyt_old");
    },
  );

  it("access_denied is a cancelled outcome, with the token untouched", async () => {
    const env = setup({});
    const { s, cb } = await begin(env, "pkeyt_old");
    expect(await s.complete(cb("error=access_denied"))).toEqual({
      kind: "cancelled",
    });
    expect(tokenCalls(env)).toHaveLength(0);
    expect(await env.store.getToken()).toBe("pkeyt_old");
  });

  it("the Worker's refusal is thrown under its code and keeps the token", async () => {
    const env = setup({ token: () => json({ error: "invalid_grant" }, 400) });
    const { s, cb } = await begin(env, "pkeyt_old");
    await expect(s.complete(cb("code=C"))).rejects.toMatchObject({
      code: "invalid_grant",
      status: 400,
    });
    expect(await env.store.getToken()).toBe("pkeyt_old");
  });

  it("rate_limited carries retryAfterSeconds", async () => {
    const env = setup({
      token: () => json({ error: "rate_limited", retryAfter: 7 }, 429),
    });
    const { s, cb } = await begin(env);
    await expect(s.complete(cb("code=C"))).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 7,
    });
  });

  it("cancel() ends the session without a request", async () => {
    const env = setup({});
    const { s, cb } = await begin(env);
    s.cancel();
    await expect(s.complete(cb("code=C"))).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(tokenCalls(env)).toHaveLength(0);
  });

  it("license_choice=app only when discovery serves the choice endpoints", async () => {
    const wants = { licenseChoice: "app" } as const;
    const without = await begin(setup({}), undefined, wants);
    expect(
      new URL(without.s.authorizeUrl).searchParams.has("license_choice"),
    ).toBe(false);
    const choice = Object.fromEntries(
      ["Licenses", "Devices", "Complete", "Cancel"].map((n) => [
        `choice${n}`,
        `${API}/identity/choice/${n.toLowerCase()}`,
      ]),
    );
    const withEp = await begin(
      setup({
        identity: {
          endpoints: {
            authorize: `${API}/identity/authorize`,
            token: `${API}/identity/token`,
            ...choice,
          },
        },
      }),
      undefined,
      wants,
    );
    expect(
      new URL(withEp.s.authorizeUrl).searchParams.get("license_choice"),
    ).toBe("app");
  });

  it("refuses an http redirect URI before any token request", async () => {
    const c = await boot(setup({}));
    await expect(
      c.identity.signIn.start({
        channel: "redirect",
        redirectUri: "http://app.example/cb",
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("sign-in-unavailable when discovery serves no authorize endpoint", async () => {
    const c = await boot(setup({ identity: { endpoints: {} } }));
    await expect(
      c.identity.signIn.start({ channel: "redirect", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "sign-in-unavailable" });
  });

  it("Identity off: service-unavailable before any request", async () => {
    const env = setup({ services: ["license", "config"] });
    const c = await boot(env);
    await expect(
      c.identity.signIn.start({ channel: "redirect", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
    expect(env.seen).toHaveLength(0);
  });
});
