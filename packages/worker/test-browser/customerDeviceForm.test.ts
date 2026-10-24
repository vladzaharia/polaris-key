// LXF-DEV-fix B2: a code typed on polaris.locker/device reaches the IdP in a real browser, through
// the Worker's real responses and CSP. The form is GET /device under `form-action 'self'`, and
// browsers check that directive on every redirect of the submission's chain, so the Worker answers
// a form-started sign-in with a 200 whose `<meta refresh>` moves on. Chromium and WebKit; the
// pre-fix 303 chain left the page on /device in both (the review's csp/run.mjs).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issuerMetadataResponse } from "../test/oidcIssuerFake.js";
import { chromium, webkit, type BrowserType } from "playwright";
import { makeTestDb } from "../test/helpers.js";
import { KvMock } from "../test/kvMock.js";
import { makeEnv, NOW, seedProduct } from "../test/seed.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";

/** One loopback port per host: real sockets, so the browser's redirect and CSP handling is real. */
function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "::", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

async function world() {
  // The two Worker hosts: 127.0.0.1 and localhost are different origins on loopback.
  const hosts: { api: string; customer: string } = { api: "", customer: "" };
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  const bridge: http.RequestListener = (req, res) => {
    void (async () => {
      const url = `http://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const out = await dispatchWith(
        new Request(url, { headers, redirect: "manual" }),
        env,
        db,
        NOW,
      );
      const h: Record<string, string | string[]> = {};
      out.headers.forEach((v, k) => {
        if (k !== "set-cookie") h[k] = v;
      });
      const cookies = (
        out.headers as unknown as { getSetCookie(): string[] }
      ).getSetCookie();
      if (cookies.length > 0) h["set-cookie"] = cookies;
      res.writeHead(out.status, h);
      res.end(Buffer.from(await out.arrayBuffer()));
    })();
  };
  const api = await listen(bridge);
  const customer = await listen(bridge);
  hosts.api = `http://localhost:${api.port}`;
  hosts.customer = `http://127.0.0.1:${customer.port}`;
  env.CONSOLE_ORIGIN = hosts.api;
  env.CUSTOMER_ORIGIN = hosts.customer;
  await seedProduct(db, "djdl");
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [
      s,
      { enabled: ["license", "config", "identity"].includes(s) },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    "djdl",
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
  const idpOrigin = "https://id.example"; // the relying-party client refuses a plain-http issuer
  // The Worker's own discovery fetch for the IdP is answered here; the browser talks to the real
  // sockets above.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      (await issuerMetadataResponse(input, null)) ?? realFetch(input, init),
  );
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    idpOrigin,
    "client-djdl",
    null,
    JSON.stringify([`${hosts.api}/djdl/identity/auth/callback`]),
    JSON.stringify({ members: { role: "user", tier: "pro" } }),
  );
  return {
    db,
    env,
    hosts,
    idpOrigin,
    close: () => {
      for (const x of [api, customer]) x.server.close();
    },
  };
}

const lanes: [string, BrowserType][] = [
  ["chromium", chromium],
  ["webkit", webkit],
];

describe.each(lanes)("typed code on the customer host, %s", (_name, type) => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(() => {
    vi.restoreAllMocks();
    w.close();
  });

  it("reaches the IdP page through the real CSP", async () => {
    const started = await dispatchWith(
      new Request(`${w.hosts.api}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "tv-1" }),
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const { userCode } = (await started.json()) as { userCode: string };
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${w.hosts.customer}/device`);
      await page.fill("#user_code", userCode);
      // The IdP's authorize request is the proof: a blocked chain never gets there. The IdP host
      // does not exist here, so the request itself (not a page) is what is awaited.
      const authorize = page.waitForRequest(
        (r) => r.url().startsWith(`${w.idpOrigin}/authorize?`),
        { timeout: 15_000 },
      );
      await page.click("button[type=submit]");
      expect((await authorize).url()).toContain("client_id=client-djdl");
    } finally {
      await browser.close();
    }
  });

  // The /tv lockup is the TV size from the TV breakpoint up and the BRAND phone size (36 px) on a
  // phone, with a gutter of at least 16 px (it filled the 390 px width edge to edge).
  it.each([
    [390, 36],
    [360, 36],
    [1280, 72],
  ])("sizes the /tv lockup at %i px wide", async (width, height) => {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(`${w.hosts.customer}/tv`);
      const box = await page.locator(".ac-brand svg").first().boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBe(height);
      if (width < 480) {
        expect(box!.width).toBeLessThanOrEqual(width - 32);
        expect(box!.x).toBeGreaterThanOrEqual(16);
      }
    } finally {
      await browser.close();
    }
  });
});
