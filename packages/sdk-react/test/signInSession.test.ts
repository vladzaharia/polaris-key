// @vitest-environment node
//
// @pkey-feature identity.devicecode identity.redirect.web identity.signin.hints identity.toggle
//
// I-10a.10: `signIn.start` / `signIn.complete` through the ADAPTERS (the transcript replayer
// drives the bearer engine; this is what the adapter adds): the device-code session and the web
// redirect in bearer mode, the verifier and `state` kept in `sessionStorage` across the
// navigation, and the desktop adapter's device code over the bridge with no new verb.

import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  makeFakeBridge,
  newTestKey,
  okBridgeState,
  settled,
  signedDocs,
} from "./fixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "BEARERDEVICE00000000000000000001";
const ORIGIN = "https://key.plrs.im/acme";
const ISSUER = `${ORIGIN}/identity`;
const REDIRECT = "https://app.example/auth/callback";
const PERSISTED = { persisted: async () => true };

/** A Map-backed `sessionStorage`: the page's tab storage, shared by "reloads". */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
});

interface Server {
  fetchImpl: typeof fetch;
  seen: Array<{ method: string; path: string; body: string | null }>;
  key: Awaited<ReturnType<typeof newTestKey>>;
  /** What the next device poll answers. */
  poll: Array<{ status: number; body: unknown }>;
  startStatus: number;
}

async function server(): Promise<Server> {
  const key = await newTestKey("pkey-test-signin");
  const { license, config } = await signedDocs(key, {
    aud: "acme",
    deviceId: DEVICE,
    now: NOW,
  });
  const seen: Server["seen"] = [];
  const s: Server = {
    seen,
    key,
    poll: [],
    startStatus: 200,
    fetchImpl: undefined as never,
  };
  const disc = {
    version: 2,
    protocolVersion: 4,
    product: "acme",
    slug: "acme",
    baseUrl: "https://key.plrs.im",
    core: { registration: "requires-license" },
    services: {
      license: {
        enabled: true,
        endpoints: { document: `${ORIGIN}/license/document` },
      },
      config: {
        enabled: true,
        endpoints: { document: `${ORIGIN}/config/document` },
      },
      identity: {
        enabled: true,
        configured: true,
        issuer: ISSUER,
        endpoints: {
          authorize: `${ORIGIN}/identity/authorize`,
          token: `${ORIGIN}/identity/token`,
          subject: `${ORIGIN}/identity/subject`,
          signout: `${ORIGIN}/identity/signout`,
          attach: `${ORIGIN}/identity/attach`,
        },
      },
    },
  };
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json" },
    });
  s.fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({
      method: init.method ?? "GET",
      path: url.pathname,
      body: typeof init.body === "string" ? init.body : null,
    });
    switch (url.pathname) {
      case "/acme/.well-known/polaris.json":
        return json(disc);
      case "/acme/identity/auth/device/start":
        return s.startStatus === 200
          ? json({
              deviceCode: "dc-secret",
              userCode: "WDJB-MJHT",
              verificationUri: `${ORIGIN}/identity/auth/device`,
              verificationUriComplete: `${ORIGIN}/identity/auth/device?user_code=WDJB-MJHT`,
              expiresIn: 600,
              interval: 2,
            })
          : json({ error: "not_found" }, s.startStatus);
      case "/acme/identity/auth/device/poll": {
        const next = s.poll.shift() ?? {
          status: 200,
          body: { status: "pending" },
        };
        return json(next.body, next.status);
      }
      case "/acme/identity/token":
        return json({
          access_token: "pkeyt_redirect",
          scope: "profile email",
          subject: "ps_redirect",
          schemaVersion: 1,
          device: {},
          license: null,
        });
      case "/acme/identity/subject":
        return json({ subject: "ps_device" });
      case "/acme/license/document":
        return new Response(license, { status: 200 });
      case "/acme/config/document":
        return new Response(config, { status: 200 });
      case "/acme/devices/report":
        return json({ ok: true });
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  return s;
}

async function bearer(s: Server) {
  const factory = new IDBFactory();
  await indexedDbOfflineStore(factory)!.write("acme", { deviceId: DEVICE });
  const adapter = browserAdapter({
    productSlug: "acme",
    auth: "bearer",
    now: () => NOW,
    version: "1.2.0",
    trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
    fetchImpl: s.fetchImpl,
    store: indexedDbStore("acme", { factory, persistence: PERSISTED })!,
  });
  await settled(adapter);
  return adapter;
}

const callback = (state: string, extra = "") =>
  `${REDIRECT}?code=the-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(ISSUER)}${extra}`;

describe("bearer: device code", () => {
  it("start sends the hints, the session shows the prompt and never the poll credential", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({
      channel: "device-code",
      deviceName: "Living-room PC",
      loginHint: "ada@example.com",
      purpose: "attach",
    });
    expect(session).toMatchObject({
      channel: "device-code",
      userCode: "WDJB-MJHT",
      expiresIn: 600,
      interval: 2,
    });
    expect(JSON.stringify(session)).not.toContain("dc-secret");
    const start = s.seen.find((r) => r.path.endsWith("/auth/device/start"));
    expect(JSON.parse(start!.body!)).toMatchObject({
      deviceName: "Living-room PC",
      loginHint: "ada@example.com",
      purpose: "attach",
    });
  });

  it("wait({once}) answers pending then slow-down; a ready poll is signedIn with the subject", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({ channel: "device-code" });
    s.poll.push(
      { status: 200, body: { status: "pending" } },
      { status: 429, body: { interval: 7 } },
      {
        status: 200,
        body: {
          status: "ready",
          token: "pkeyt_device",
          identity: { name: "Ada", email: "ada@example.com" },
        },
      },
    );
    await expect(session.wait({ once: true })).resolves.toEqual({
      kind: "pending",
      interval: 2,
    });
    await expect(session.wait({ once: true })).resolves.toEqual({
      kind: "pending",
      interval: 7,
      slowDown: true,
    });
    await expect(session.wait({ once: true })).resolves.toMatchObject({
      kind: "signedIn",
      subject: "ps_device",
      identity: { name: "Ada" },
    });
    expect(adapter.snapshot().status).toBe("ok");
    expect(adapter.snapshot().busy.identity).toBe(false);
  });

  it("a person's refusal throws sign-in-denied and records the slice error", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({ channel: "device-code" });
    s.poll.push({
      status: 200,
      body: { status: "error", reason: "access_denied" },
    });
    await expect(session.wait({ once: true })).rejects.toMatchObject({
      code: "sign-in-denied",
    });
  });

  it("cancel makes wait answer cancelled and clears busy", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({ channel: "device-code" });
    expect(adapter.snapshot().busy.identity).toBe(true);
    session.cancel();
    await expect(session.wait()).resolves.toEqual({ kind: "cancelled" });
    expect(adapter.snapshot().busy.identity).toBe(false);
  });

  it("a 404 on the device start is the typed service-unavailable", async () => {
    const s = await server();
    const adapter = await bearer(s);
    s.startStatus = 404;
    await expect(
      adapter.signIn.start({ channel: "device-code" }),
    ).rejects.toMatchObject({
      code: "service-unavailable",
      name: "UnsupportedError",
      feature: "identity.devicecode",
    });
  });
});

describe("bearer: web redirect", () => {
  it("start builds the authorize URL with the hints and keeps the verifier in sessionStorage by state", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
      loginHint: "ada@example.com",
      nameHint: "Ada",
      purpose: "signin",
      licenseChoice: "app",
    });
    const url = new URL(session.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/identity/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "acme",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      scope: "profile email",
      login_hint: "ada@example.com",
      name_hint: "Ada",
      purpose: "signin",
    });
    // No choice endpoints in this discovery: the card chooses, nothing is sent.
    expect(url.searchParams.has("license_choice")).toBe(false);
    expect(session.authorizeUrl).not.toContain("code_verifier");
    const state = url.searchParams.get("state")!;
    expect(storage.getItem(`pkey.signin.redirect:acme:${state}`)).toContain(
      "codeVerifier",
    );
  });

  it("the session's complete redeems the code, stores the token and drops the stash", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
    });
    const state = new URL(session.authorizeUrl).searchParams.get("state")!;
    const done = await session.complete(callback(state));
    expect(done).toMatchObject({
      kind: "signedIn",
      subject: "ps_redirect",
      scope: "profile email",
    });
    expect(storage.length).toBe(0);
    expect(adapter.snapshot().status).toBe("ok");
    const token = s.seen.find((r) => r.path === "/acme/identity/token");
    expect(token!.method).toBe("POST");
    expect(token!.body).toContain("grant_type=authorization_code");
    expect(token!.body).toContain("client_id=acme");
    // Single use: a replayed callback never reaches the token endpoint.
    const before = s.seen.length;
    await expect(session.complete(callback(state))).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(s.seen.length).toBe(before);
  });

  it("after the navigation back, signIn.complete(url) finishes from the stash on a fresh page", async () => {
    const s = await server();
    const first = await bearer(s);
    const session = await first.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
    });
    const state = new URL(session.authorizeUrl).searchParams.get("state")!;
    // The page unloads; a new one boots over the same tab storage.
    const second = await bearer(s);
    const done = await second.signIn.complete(callback(state));
    expect(done).toMatchObject({ kind: "signedIn", subject: "ps_redirect" });
    expect(storage.length).toBe(0);
    await expect(second.signIn.complete(callback(state))).rejects.toMatchObject(
      { code: "sign-in-failed" },
    );
  });

  it("a callback with another state, or none, is sign-in-failed and sends nothing", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.signIn.start({ channel: "redirect", redirectUri: REDIRECT });
    const before = s.seen.length;
    await expect(
      adapter.signIn.complete(callback("someone-elses-state-0123456789")),
    ).rejects.toMatchObject({ code: "sign-in-failed" });
    await expect(adapter.signIn.complete(REDIRECT)).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(s.seen.length).toBe(before);
  });

  it("a wrong issuer is sign-in-failed, nothing is sent, and the token is untouched", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
    });
    const state = new URL(session.authorizeUrl).searchParams.get("state")!;
    await expect(
      session.complete(
        `${REDIRECT}?code=c&state=${state}&iss=https%3A%2F%2Fevil.example`,
      ),
    ).rejects.toMatchObject({ code: "sign-in-failed" });
    expect(s.seen.some((r) => r.path === "/acme/identity/token")).toBe(false);
    expect(adapter.snapshot().status).not.toBe("ok");
  });

  it("access_denied is cancelled", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const session = await adapter.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
    });
    const state = new URL(session.authorizeUrl).searchParams.get("state")!;
    await expect(
      session.complete(
        `${REDIRECT}?error=access_denied&state=${state}&iss=${encodeURIComponent(ISSUER)}`,
      ),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  it("without sessionStorage the redirect cannot start: sign-in-unavailable", async () => {
    const s = await server();
    const adapter = await bearer(s);
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    await expect(
      adapter.signIn.start({ channel: "redirect", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "sign-in-unavailable" });
  });

  it("a redirect URI that is not https is refused before any request", async () => {
    const s = await server();
    const adapter = await bearer(s);
    const before = s.seen.length;
    await expect(
      adapter.signIn.start({
        channel: "redirect",
        redirectUri: "http://app.example/cb",
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(s.seen.length).toBe(before);
    expect(storage.length).toBe(0);
  });
});

describe("desktop: device code over the bridge, no new verb", () => {
  async function desktop(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const bridge = {
      ...makeFakeBridge(okBridgeState()),
      version: 4,
      beginSignIn: async (opts?: unknown) => {
        calls.push(`begin ${JSON.stringify(opts ?? null)}`);
        return {
          flowId: "flow-1",
          verificationUrl: "https://key.plrs.im/acme/identity/auth/device?c=1",
          verificationUri: "https://key.plrs.im/acme/identity/auth/device",
          userCode: "ABCD-1234",
          interval: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        };
      },
      pollSignIn: async () => {
        calls.push("poll");
        return { kind: "ok", identity: { name: "Ada" } } as const;
      },
      invoke: async (_s: string, method: string) =>
        method === "subject" ? "ps_desktop" : null,
      ...overrides,
    };
    const adapter = new DesktopAdapter({ bridge: bridge as never });
    await settled(adapter);
    return { adapter, calls };
  }

  it("start names the device; wait polls until the host says ok and answers signedIn", async () => {
    const { adapter, calls } = await desktop();
    const session = await adapter.signIn.start({
      channel: "device-code",
      deviceName: "Den PC",
    });
    expect(session).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: "https://key.plrs.im/acme/identity/auth/device",
      deviceName: "Den PC",
    });
    await expect(session.wait()).resolves.toMatchObject({
      kind: "signedIn",
      subject: "ps_desktop",
      identity: { name: "Ada" },
    });
    expect(calls).toEqual(['begin {"deviceName":"Den PC"}', "poll"]);
  });

  it("wait({once}) is pending while the host is; denied and expired map to their outcomes", async () => {
    let answer: unknown = { kind: "pending" };
    const { adapter } = await desktop({ pollSignIn: async () => answer });
    const session = await adapter.signIn.start({ channel: "device-code" });
    await expect(session.wait({ once: true })).resolves.toEqual({
      kind: "pending",
      interval: 1,
    });
    answer = { kind: "denied" };
    await expect(session.wait({ once: true })).rejects.toMatchObject({
      code: "sign-in-denied",
    });
    answer = { kind: "expired" };
    await expect(session.wait({ once: true })).resolves.toEqual({
      kind: "expired",
    });
  });

  it("the redirect and hints the bridge does not carry are typed unsupported, never dropped", async () => {
    const { adapter, calls } = await desktop();
    await expect(
      adapter.signIn.start({ channel: "redirect", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({
      name: "UnsupportedError",
      feature: "identity.redirect.web",
      reason: "runtime",
    });
    await expect(adapter.signIn.complete(REDIRECT)).rejects.toMatchObject({
      name: "UnsupportedError",
    });
    await expect(
      adapter.signIn.start({ channel: "device-code", loginHint: "a@b.co" }),
    ).rejects.toMatchObject({
      name: "UnsupportedError",
      feature: "identity.signin.hints",
    });
    expect(calls).toEqual([]);
  });

  it("identity off is service-unavailable before anything crosses the bridge", async () => {
    const { adapter, calls } = await desktop();
    (adapter as unknown as { capabilities: unknown }).capabilities = {
      ...(adapter as unknown as { capabilities: Record<string, unknown> })
        .capabilities,
      identity: { enabled: false },
    };
    await expect(
      adapter.signIn.start({ channel: "device-code" }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("bearer: the link offer's marker and handle (I-46.13)", () => {
  const HANDLE_KEY = "pkey-link-handle:acme";
  const handle = `${NOW} lh_Vi3oKcGS3HqS09Aj2lrrjYKeGlmwdbt8oEqR6x1M_zg`;

  /** A device-code sign-in as `ps_device`, answered ready on the first poll. */
  async function landByCode(
    s: Server,
    adapter: Awaited<ReturnType<typeof bearer>>,
  ) {
    const session = await adapter.signIn.start({ channel: "device-code" });
    s.poll.push({ status: 200, body: { status: "ready", token: "pkeyt_d" } });
    await session.wait({ once: true });
  }

  async function land(adapter: Awaited<ReturnType<typeof bearer>>) {
    const session = await adapter.signIn.start({
      channel: "redirect",
      redirectUri: REDIRECT,
    });
    const state = new URL(session.authorizeUrl).searchParams.get("state")!;
    return adapter.signIn.complete(callback(state));
  }

  it("a redirect sign-in leaves the offer pending; a device-code one does not", async () => {
    const s = await server();
    const adapter = await bearer(s);
    expect(adapter.link!.pending()).toBe(false);
    await landByCode(s, adapter);
    expect(adapter.link!.pending()).toBe(false);
    await land(adapter);
    expect(adapter.link!.pending()).toBe(true);
  });

  it("a handle stays for the same account that lands again, and goes when another lands", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await land(adapter);
    storage.setItem(HANDLE_KEY, handle);
    await land(adapter);
    expect(storage.getItem(HANDLE_KEY)).toBe(handle);
    // Another account signs in (the device-code answer names ps_device): the handle was not its.
    await landByCode(s, adapter);
    expect(storage.getItem(HANDLE_KEY)).toBeNull();
  });

  it("sign-out drops the marker and the handle", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await land(adapter);
    storage.setItem(HANDLE_KEY, handle);
    await adapter.signOut().catch(() => undefined);
    expect(adapter.link!.pending()).toBe(false);
    expect(storage.getItem(HANDLE_KEY)).toBeNull();
  });
});
