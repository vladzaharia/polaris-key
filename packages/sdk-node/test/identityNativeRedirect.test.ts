// @pkey-feature identity.redirect.native identity.devicelabel
// The native redirect sign-in beyond what the transcripts show (I-15b.2): the listener's rules
// against a real socket, the order (bind, push, open), the single-use session, the fallbacks and
// the headless rule. The wire conversation itself is the transcripts' (`redirect-native-*`).

import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import { defaultDeviceName } from "../src/core/deviceLabel.js";
import {
  bindLoopbackListener,
  isHeadless,
  type NativeRedirectSession,
} from "../src/identity/nativeRedirect.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const API = `${BASE}/${PRODUCT}`;
const ISS = `${API}/identity`;
const RETURN = `${BASE}/signin/return`;
const SCHEME = "com.tidewater.studio:/pkey/callback";
const RQ = `rq_${"A".repeat(22)}`;
const REQUEST_URI = `urn:ietf:params:oauth:request_uri:${"B".repeat(22)}`;

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
  headers: Headers;
  body: string;
}

function setup(
  opts: {
    push?: (seen: Seen[]) => Response | Promise<Response>;
    native?: Record<string, unknown>;
    request?: boolean;
    expiresIn?: number;
    tokenGate?: Promise<void>;
  } = {},
) {
  const seen: Seen[] = [];
  const identity = {
    enabled: true,
    configured: true,
    issuer: ISS,
    endpoints: {
      authorize: `${API}/identity/authorize`,
      token: `${API}/identity/token`,
      ...(opts.request === false
        ? {}
        : {
            request: `${API}/identity/request`,
            signinReturn: RETURN,
          }),
    },
    nativeRedirect: opts.native ?? {
      loopback: true,
      schemes: [SCHEME],
      claimedHttps: [],
    },
  };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const entry: Seen = {
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body: req.method === "GET" ? "" : await req.text(),
    };
    seen.push(entry);
    if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`)
      return json({ product: PRODUCT, services: { identity } });
    if (url.pathname === `/${PRODUCT}/identity/request`)
      return opts.push
        ? opts.push(seen)
        : json(
            { request_uri: REQUEST_URI, expires_in: opts.expiresIn ?? 600 },
            201,
          );
    if (url.pathname === `/${PRODUCT}/identity/token`) {
      await opts.tokenGate;
      return json(TOKEN_OK);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { seen, store: new InMemoryStore(), fetchImpl };
}

async function boot(env: ReturnType<typeof setup>) {
  const c = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    trustRefresh: false,
    store: env.store,
    fetchImpl: env.fetchImpl,
    requestTimeoutMs: 0,
    expectedServices: ["identity"],
    devices: { fingerprint: false },
  });
  await c.init();
  (c.identity as unknown as { onAcquired: () => Promise<void> }).onAcquired =
    async () => undefined;
  return c;
}

const opened: string[] = [];
const openOk = async (url: string): Promise<boolean> => {
  opened.push(url);
  return true;
};

async function start(
  env: ReturnType<typeof setup>,
  extra: Record<string, unknown> = {},
) {
  const c = await boot(env);
  const s = await c.identity.signIn.start({
    channel: "redirect",
    openUrl: openOk,
    ...extra,
  } as never);
  return { c, s: s as unknown as NativeRedirectSession };
}

/** The port the push named, the state, and the callback query a good browser would bring. */
function pushed(env: ReturnType<typeof setup>) {
  const push = env.seen.find((s) => s.path === `/${PRODUCT}/identity/request`)!;
  const form = new URLSearchParams(push.body);
  const uri = new URL(form.get("redirect_uri")!);
  const state = form.get("state")!;
  return {
    form,
    push,
    port: Number(uri.port),
    state,
    query: (extra = "") =>
      `code=C0DE&state=${state}&iss=${encodeURIComponent(ISS)}&request=${RQ}${extra}`,
  };
}

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One raw request to the listener, with an exact `Host` (and any other header). */
function hit(
  port: number,
  path: string,
  o: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: o.method ?? "GET",
        headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += String(d)));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Is something still accepting connections on the port? */
function listening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

const tokenCalls = (e: ReturnType<typeof setup>) =>
  e.seen.filter((s) => s.path === `/${PRODUCT}/identity/token`);

afterEach(() => {
  opened.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("native redirect: the order and the push", () => {
  it("binds the listener before it pushes, and keeps the socket until the callback", async () => {
    let boundAtPush: boolean | null = null;
    const env = setup({
      push: async (seen) => {
        const form = new URLSearchParams(
          seen.find((s) => s.path.endsWith("/identity/request"))!.body,
        );
        boundAtPush = await listening(
          Number(new URL(form.get("redirect_uri")!).port),
        );
        return json({ request_uri: REQUEST_URI, expires_in: 600 }, 201);
      },
    });
    const { s } = await start(env);
    const p = pushed(env);
    expect(boundAtPush).toBe(true);
    expect(p.form.get("redirect_uri")).toBe(
      `http://127.0.0.1:${p.port}/pkey/callback`,
    );
    expect(await listening(p.port)).toBe(true);
    s.cancel();
    await s.wait();
  });

  it("sends the pusher's device header, the label and no secret in the URL it opens", async () => {
    const env = setup();
    const { c, s } = await start(env, { deviceName: "Ada's Mac" });
    const p = pushed(env);
    expect(p.push.method).toBe("POST");
    expect(p.push.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(p.push.headers.get("x-pkey-device")).toBe(c.core.deviceId);
    expect(p.push.headers.get("x-pkey-sdk")).toBeTruthy();
    expect(p.form.get("device_name")).toBe("Ada's Mac");
    expect(p.form.get("code_challenge_method")).toBe("S256");
    expect(p.form.has("code_verifier")).toBe(false);
    // The system browser gets authorize with the client and the pushed request only.
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "request_uri",
    ]);
    expect(url.searchParams.get("request_uri")).toBe(REQUEST_URI);
    expect(s.redirectClass).toBe("loopback");
    s.cancel();
  });
});

describe("native redirect: the listener's rules", () => {
  it("binds 127.0.0.1 only", async () => {
    const env = setup();
    const { s } = await start(env);
    const { port } = pushed(env);
    expect(await listening(port, "127.0.0.1")).toBe(true);
    for (const list of Object.values(networkInterfaces()))
      for (const a of list ?? [])
        if (a.family === "IPv4" && !a.internal)
          expect(await listening(port, a.address)).toBe(false);
    s.cancel();
  });

  it("answers anything but the exact callback 404 and keeps listening", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    const bad: [string, Parameters<typeof hit>[2]?][] = [
      [`/pkey/callback/x?${p.query()}`],
      [`/other?${p.query()}`],
      [`/?${p.query()}`],
      [`/pkey/callback?${p.query()}`, { method: "POST" }],
      [`/pkey/callback?${p.query()}`, { host: `localhost:${p.port}` }],
      [`/pkey/callback?${p.query()}`, { host: "evil.test" }],
      [`/pkey/callback?${p.query()}`, { host: `127.0.0.1:${p.port + 1}` }],
      [
        `/pkey/callback?code=C0DE&state=wrong-state-0123456789&iss=x&request=${RQ}`,
      ],
      [`/pkey/callback?${p.query(`&state=${p.state}`)}`],
      [
        `/pkey/callback?${p.query()}`,
        { headers: { "sec-fetch-mode": "no-cors" } },
      ],
      [
        `/pkey/callback?${p.query()}`,
        { headers: { "sec-fetch-dest": "image" } },
      ],
    ];
    for (const [path, o] of bad) {
      const got = await hit(p.port, path, o);
      expect(got.status, path).toBe(404);
      expect(got.body).toBe("");
    }
    expect(tokenCalls(env)).toHaveLength(0);
    expect(await listening(p.port)).toBe(true);
    // The real callback still works afterwards.
    const ok = await hit(p.port, `/pkey/callback?${p.query()}`, {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    expect(ok.status).toBe(303);
    expect((await s.wait()).kind).toBe("signedIn");
  });

  it("takes one callback: 303 to the return page, no HTML, no CORS, then closed", async () => {
    const env = setup();
    const { c, s } = await start(env);
    const p = pushed(env);
    const got = await hit(p.port, `/pkey/callback?${p.query()}`);
    expect(got.status).toBe(303);
    expect(got.headers.location).toBe(`${RETURN}?request=${RQ}`);
    expect(got.headers["referrer-policy"]).toBe("no-referrer");
    expect(got.headers["cache-control"]).toBe("no-store");
    expect(got.body).toBe("");
    expect(
      Object.keys(got.headers).some((h) => h.startsWith("access-control")),
    ).toBe(false);
    const out = await s.wait();
    expect(out).toMatchObject({ kind: "signedIn", subject: "ps_abc" });
    expect(await env.store.getToken()).toBe("pkeyt_new");
    // Redeemed from the pushing device, with the verifier and the same redirect URI.
    const [call] = tokenCalls(env);
    expect(call!.headers.get("x-pkey-device")).toBe(c.core.deviceId);
    const form = new URLSearchParams(call!.body);
    expect(form.get("code")).toBe("C0DE");
    expect(form.get("redirect_uri")).toBe(p.form.get("redirect_uri"));
    expect(form.get("code_verifier")).toBeTruthy();
    // The listener closed on the first match.
    expect(await listening(p.port)).toBe(false);
    expect(tokenCalls(env)).toHaveLength(1);
  });

  it("answers the card's Cancel with the return page marked cancelled, and redeems nothing", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    const got = await hit(
      p.port,
      `/pkey/callback?error=access_denied&state=${p.state}&iss=${encodeURIComponent(ISS)}&request=${RQ}`,
    );
    expect(got.status).toBe(303);
    expect(got.headers.location).toBe(`${RETURN}?request=${RQ}&cancelled=1`);
    expect(await s.wait()).toEqual({ kind: "cancelled" });
    expect(tokenCalls(env)).toHaveLength(0);
    expect(await listening(p.port)).toBe(false);
  });

  it("a callback with the right state but a wrong issuer ends the sign-in: 400, no redeem", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    const got = await hit(
      p.port,
      `/pkey/callback?code=C0DE&state=${p.state}&iss=${encodeURIComponent("https://evil.test/x")}&request=${RQ}`,
    );
    expect(got.status).toBe(400);
    expect(got.body).toBe("");
    await expect(s.wait()).rejects.toMatchObject({ code: "sign-in-failed" });
    expect(tokenCalls(env)).toHaveLength(0);
    expect(await listening(p.port)).toBe(false);
  });

  it("closes when the pushed request lapses", async () => {
    const env = setup({ expiresIn: 1 });
    const { s } = await start(env);
    const p = pushed(env);
    expect(await s.wait()).toEqual({ kind: "expired" });
    expect(await listening(p.port)).toBe(false);
    expect(await s.reopen()).toBe(false);
    expect(tokenCalls(env)).toHaveLength(0);
  });

  it("closes on cancel, and a later callback is refused locally", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    s.cancel();
    expect(await s.wait()).toEqual({ kind: "cancelled" });
    expect(await listening(p.port)).toBe(false);
    await expect(
      s.handleRedirect(`http://127.0.0.1:${p.port}/pkey/callback?${p.query()}`),
    ).rejects.toMatchObject({ code: "sign-in-failed" });
    expect(tokenCalls(env)).toHaveLength(0);
  });

  it("never writes the code to a log", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    await hit(p.port, `/pkey/callback?${p.query()}`);
    await s.wait();
    const written = [...spies, out, err]
      .flatMap((sp) => sp.mock.calls)
      .map((c) => String(c[0]));
    expect(written.some((w) => w.includes("C0DE"))).toBe(false);
    expect(JSON.stringify(s)).not.toContain("C0DE");
  });

  it("bindLoopbackListener answers 404 to everything until armed", async () => {
    const l = await bindLoopbackListener();
    const got = await hit(l.port, "/pkey/callback?state=x");
    expect(got.status).toBe(404);
    l.close();
    expect(await listening(l.port)).toBe(false);
  });
});

describe("native redirect: the session", () => {
  it("is single use: a second handleRedirect is refused without a request", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    const url = `http://127.0.0.1:${p.port}/pkey/callback?${p.query()}`;
    expect((await s.handleRedirect(url)).kind).toBe("signedIn");
    await expect(s.handleRedirect(url)).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(tokenCalls(env)).toHaveLength(1);
  });

  it("cancel() while the code is being redeemed stores nothing and ends cancelled", async () => {
    let release!: () => void;
    const env = setup({ tokenGate: new Promise<void>((r) => (release = r)) });
    const { s } = await start(env);
    const p = pushed(env);
    const redeeming = s.handleRedirect(
      `http://127.0.0.1:${p.port}/pkey/callback?${p.query()}`,
    );
    await vi.waitFor(() => expect(tokenCalls(env)).toHaveLength(1));
    s.cancel();
    release();
    expect(await redeeming).toEqual({ kind: "cancelled" });
    expect(await s.wait()).toEqual({ kind: "cancelled" });
    expect(await env.store.getToken()).toBeNull();
    expect(env.seen.some((x) => x.path.endsWith("/signout"))).toBe(false);
  });

  it("refuses a callback with a wrong state, a stray parameter or no request handle", async () => {
    for (const [mutate, reason] of [
      [
        (q: string) => q.replace(/state=[^&]+/, "state=other-state-0123456789"),
        "state-mismatch",
      ],
      [(q: string) => `${q}&extra=1`, "unexpected-parameter"],
      [(q: string) => q.replace(/&request=[^&]+/, ""), "request-invalid"],
    ] as const) {
      const env = setup();
      const { s } = await start(env);
      const p = pushed(env);
      await expect(
        s.handleRedirect(
          `http://127.0.0.1:${p.port}/pkey/callback?${mutate(p.query())}`,
        ),
      ).rejects.toMatchObject({
        code: "sign-in-failed",
        message: expect.stringContaining(reason),
      });
      expect(tokenCalls(env)).toHaveLength(0);
    }
  });

  it("a foreign delivery is refused without ending the sign-in", async () => {
    const env = setup();
    const { s } = await start(env);
    const p = pushed(env);
    for (const bad of [
      "not a url",
      `http://127.0.0.1:${p.port + 1}/pkey/callback?${p.query()}`,
      `http://127.0.0.1:${p.port}/pkey/callback?${p.query().replace(/state=[^&]+/, "state=other-state-0123456789")}`,
    ])
      await expect(s.handleRedirect(bad)).rejects.toMatchObject({
        code: "sign-in-failed",
      });
    expect(tokenCalls(env)).toHaveLength(0);
    // The flow and its listener are intact.
    expect(await listening(p.port)).toBe(true);
    expect((await hit(p.port, `/pkey/callback?${p.query()}`)).status).toBe(303);
    expect((await s.wait()).kind).toBe("signedIn");
  });

  it("Open browser again reopens the same URL without a new push", async () => {
    const env = setup();
    const { s } = await start(env);
    expect(await s.reopen()).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    expect(
      env.seen.filter((x) => x.path.endsWith("/identity/request")),
    ).toHaveLength(1);
    s.cancel();
    expect(await s.reopen()).toBe(false);
  });

  it("a registered scheme is used when no listener is wanted; the host delivers the URL", async () => {
    const env = setup();
    const { s } = await start(env, {
      loopback: false,
      registeredSchemes: [SCHEME],
      returnUri: SCHEME,
    });
    const p = pushed(env);
    expect(s.redirectClass).toBe("scheme");
    expect(p.form.get("redirect_uri")).toBe(SCHEME);
    expect(p.form.get("return_uri")).toBe(SCHEME);
    const out = await s.handleRedirect(
      `${SCHEME}?code=C0DE&state=${p.state}&iss=${encodeURIComponent(ISS)}`,
    );
    expect(out.kind).toBe("signedIn");
    // The host's delivery also settles wait().
    expect((await s.wait()).kind).toBe("signedIn");
  });
});

describe("native redirect: the fallbacks", () => {
  const unavailable = { code: "redirect-unavailable" };

  it("a product that does not serve the request endpoint is redirect-unavailable", async () => {
    const env = setup({ request: false });
    const c = await boot(env);
    await expect(
      c.identity.signIn.start({ channel: "redirect", openUrl: openOk }),
    ).rejects.toMatchObject(unavailable);
    expect(opened).toHaveLength(0);
  });

  it("no listener and no registered scheme is redirect-unavailable", async () => {
    const env = setup();
    const c = await boot(env);
    await expect(
      c.identity.signIn.start({
        channel: "redirect",
        openUrl: openOk,
        loopback: false,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(env.seen.some((x) => x.path.endsWith("/identity/request"))).toBe(
      false,
    );
  });

  it("loopback turned off by the product falls to the scheme, else unavailable", async () => {
    const off = setup({
      native: { loopback: false, schemes: [SCHEME], claimedHttps: [] },
    });
    const a = await start(off, { registeredSchemes: [SCHEME] });
    expect(a.s.redirectClass).toBe("scheme");
    a.s.cancel();
    const none = setup({
      native: { loopback: false, schemes: [], claimedHttps: [] },
    });
    const c = await boot(none);
    await expect(
      c.identity.signIn.start({ channel: "redirect", openUrl: openOk }),
    ).rejects.toMatchObject(unavailable);
  });

  it("a headless host with no opener of its own is redirect-unavailable before it binds", async () => {
    for (const k of ["SSH_CONNECTION", "SSH_TTY", "CI"]) {
      vi.stubEnv(k, "1");
      const env = setup();
      const c = await boot(env);
      await expect(
        c.identity.signIn.start({ channel: "redirect" }),
      ).rejects.toMatchObject(unavailable);
      expect(env.seen.some((x) => x.path.endsWith("/identity/request"))).toBe(
        false,
      );
      vi.unstubAllEnvs();
    }
  });

  it("the headless rule reads SSH, CI and, on Linux, the display", () => {
    expect(isHeadless({ SSH_CONNECTION: "a b c d" }, "darwin")).toBe(true);
    expect(isHeadless({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(true);
    expect(isHeadless({ CI: "true" }, "win32")).toBe(true);
    expect(isHeadless({}, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(isHeadless({}, "darwin")).toBe(false);
    expect(isHeadless({}, "win32")).toBe(false);
  });

  it("a browser that will not open is redirect-unavailable and frees the port", async () => {
    const env = setup();
    const c = await boot(env);
    await expect(
      c.identity.signIn.start({
        channel: "redirect",
        openUrl: async () => false,
      }),
    ).rejects.toMatchObject(unavailable);
    const p = pushed(env);
    expect(await listening(p.port)).toBe(false);
  });

  it("a refused push is thrown under the Worker's code and frees the port", async () => {
    const env = setup({
      push: () => json({ error: "rate_limited", retryAfter: 7 }, 429),
    });
    const c = await boot(env);
    await expect(
      c.identity.signIn.start({ channel: "redirect", openUrl: openOk }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const p = pushed(env);
    expect(await listening(p.port)).toBe(false);
    expect(opened).toHaveLength(0);
  });
});

describe("the computer's label (SIGN-IN D-73)", () => {
  const src = (over: Partial<Parameters<typeof defaultDeviceName>[0]>) => ({
    platform: "linux" as NodeJS.Platform,
    hostname: () => "host.local",
    macComputerName: () => null,
    linuxPrettyHostname: () => null,
    ...over,
  });

  it("macOS: the computer name, else the host name without .local", () => {
    expect(
      defaultDeviceName(
        src({ platform: "darwin", macComputerName: () => "Ada's Mac" }),
      ),
    ).toBe("Ada's Mac");
    expect(defaultDeviceName(src({ platform: "darwin" }))).toBe("host");
  });

  it("Linux: PRETTY_HOSTNAME, else the host name", () => {
    expect(
      defaultDeviceName(src({ linuxPrettyHostname: () => "Living Room PC" })),
    ).toBe("Living Room PC");
    expect(defaultDeviceName(src({}))).toBe("host");
  });

  it("Windows: the host name unless Windows generated it", () => {
    const win = (hostname: string) =>
      defaultDeviceName(src({ platform: "win32", hostname: () => hostname }));
    expect(win("ADA-STUDIO")).toBe("ADA-STUDIO");
    expect(win("DESKTOP-4F2K9QX")).toBe("Windows PC");
    expect(win("LAPTOP-4F2K9QX")).toBe("Windows laptop");
  });
});
