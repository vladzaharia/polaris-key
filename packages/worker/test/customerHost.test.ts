// LK-03 (plans/LK-00.md §7.1–7.5): the customer host, `customerOrigin()`, the old-URL
// redirects (LK-17: no switch, a usable CUSTOMER_ORIGIN is the cutover) and the call-site migration. With `CUSTOMER_ORIGIN` unset nothing here changes a byte.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  customerHostname,
  customerOrigin,
  isCustomerHost,
} from "../src/core/hosts.js";
import {
  accountPortalUrl,
  buildSignInUrl,
} from "../src/core/licensing/manageUrl.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const NOW = 1_800_000_000;

describe("the customer host kind", () => {
  it("is unusable when unset, unparsable or the console host", () => {
    expect(customerHostname({})).toBeNull();
    expect(customerHostname({ CUSTOMER_ORIGIN: "nope" })).toBeNull();
    expect(
      customerHostname({ CUSTOMER_ORIGIN: API, CONSOLE_ORIGIN: API }),
    ).toBeNull();
    expect(
      customerHostname({ CUSTOMER_ORIGIN: CUSTOMER, CONSOLE_ORIGIN: API }),
    ).toBe("polaris.locker");
  });

  it("needs a usable console origin and a bare origin", () => {
    // No console origin: a misconfigured deploy must not confine the console.
    expect(customerHostname({ CUSTOMER_ORIGIN: CUSTOMER })).toBeNull();
    expect(
      customerHostname({ CUSTOMER_ORIGIN: CUSTOMER, CONSOLE_ORIGIN: "nope" }),
    ).toBeNull();
    for (const bad of [
      `${CUSTOMER}/path`,
      `${CUSTOMER}/?q=1`,
      `${CUSTOMER}/#x`,
      "https://user:pw@polaris.locker",
      "http://polaris.locker",
    ])
      expect(
        customerHostname({ CUSTOMER_ORIGIN: bad, CONSOLE_ORIGIN: API }),
        bad,
      ).toBeNull();
  });

  it("loses to an earlier auxiliary host", () => {
    expect(
      customerHostname({
        CUSTOMER_ORIGIN: CUSTOMER,
        CONSOLE_ORIGIN: API,
        IMG_ORIGIN: "https://polaris.locker",
      }),
    ).toBeNull();
  });

  it("matches in any case and with the trailing dot", () => {
    const env = { CUSTOMER_ORIGIN: CUSTOMER, CONSOLE_ORIGIN: API };
    expect(isCustomerHost(new URL("https://POLARIS.locker./x"), env)).toBe(
      true,
    );
    expect(isCustomerHost(new URL(`${API}/x`), env)).toBe(false);
    expect(isCustomerHost(new URL(`${API}/x`), {})).toBe(false);
  });
});

describe("customerOrigin()", () => {
  const env = { CUSTOMER_ORIGIN: CUSTOMER, CONSOLE_ORIGIN: API };
  const req = new Request("https://other.example/x");

  it("answers the customer origin whenever the host is usable", () => {
    expect(customerOrigin(env, req)).toBe(CUSTOMER);
    expect(customerOrigin({ CONSOLE_ORIGIN: API }, req)).toBe(API);
  });

  it("falls back to the console origin, then the request's", () => {
    expect(customerOrigin({ CUSTOMER_ORIGIN: CUSTOMER }, req)).toBe(
      "https://other.example",
    );
    expect(customerOrigin({}, "https://x.example/p?q=1")).toBe(
      "https://x.example",
    );
    expect(customerOrigin({ CONSOLE_ORIGIN: "not a url" }, req)).toBe(
      "https://other.example",
    );
  });

  it("ignores an unusable customer origin", () => {
    expect(
      customerOrigin({ CUSTOMER_ORIGIN: API, CONSOLE_ORIGIN: API }, req),
    ).toBe(API);
    expect(
      customerOrigin({ CUSTOMER_ORIGIN: "http://evil.example" }, req),
    ).toBe("https://other.example");
  });
});

describe("customer URLs follow CUSTOMER_ORIGIN", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.CONSOLE_ORIGIN = API;
    await seedProduct(db, "djdl");
  });

  it("is the console origin with no customer origin", async () => {
    expect(customerOrigin(env, `${API}/x`)).toBe(API);
  });

  it("moves every customer URL together once set", async () => {
    const req = new Request(`${API}/djdl/license/activate`);
    expect(await buildSignInUrl(env, db, req, { slug: "djdl" })).toBe(
      `${API}/signin?product=djdl`,
    );
    env.CUSTOMER_ORIGIN = CUSTOMER;
    expect(await buildSignInUrl(env, db, req, { slug: "djdl" })).toBe(
      `${CUSTOMER}/signin?product=djdl`,
    );
    expect(await accountPortalUrl(env, db, API, { slug: "djdl" })).toBe(
      `${CUSTOMER}/#/p/djdl`,
    );
  });
});

describe("old customer URLs on the console host", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.CONSOLE_ORIGIN = API;
    env.CUSTOMER_ORIGIN = CUSTOMER;
    await seedProduct(db, "djdl");
  });
  const get = (url: string, init?: RequestInit) =>
    dispatchWith(
      new Request(url, { redirect: "manual", ...init }),
      env,
      db,
      NOW,
    );

  it("301s the pages to the same path and query", async () => {
    for (const [path, to] of [
      ["/activate", "/activate"],
      [
        "/activate?product=djdl&next=free-device",
        "/activate?product=djdl&next=free-device",
      ],
      ["/signin?product=djdl", "/signin?product=djdl"],
      ["/device?user_code=ABCD", "/device?user_code=ABCD"],
      ["/tv", "/tv"],
      ["/login", "/login"],
      ["/index.html", "/"],
    ] as const) {
      const res = await get(`${API}${path}`);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`${CUSTOMER}${to}`);
    }
  });

  it("302s no-store a path that carries a credential", async () => {
    for (const path of [
      "/activate?key=pkey_x",
      "/magic/verify?token=t",
      "/callback?code=c&state=s",
      "/login/google/callback?code=c",
      "/logout",
      "/download/tok",
    ]) {
      const res = await get(`${API}${path}`);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(`${CUSTOMER}${path}`);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("leaves the bind hop, the API, media, assets and non-GET alone", async () => {
    for (const path of [
      "/signin?request=abc",
      "/api/portal/x",
      "/assets/a.js",
      "/media/djdl/x",
    ])
      expect((await get(`${API}${path}`)).status, path).not.toBe(301);
    expect((await get(`${API}/signin?request=abc`)).status).not.toBe(302);
    expect((await get(`${API}/device`, { method: "POST" })).status).not.toBe(
      301,
    );
  });

  it("does nothing with CUSTOMER_ORIGIN unset", async () => {
    delete env.CUSTOMER_ORIGIN;
    for (const path of [
      "/activate",
      "/signin?product=djdl",
      "/device",
      "/tv",
    ]) {
      const res = await get(`${API}${path}`);
      expect(res.headers.get("location") ?? "", path).not.toContain(CUSTOMER);
      expect(res.status, path).not.toBe(301);
    }
  });
});

describe("customer host confinement", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.CONSOLE_ORIGIN = API;
    env.CUSTOMER_ORIGIN = CUSTOMER;
    await seedProduct(db, "djdl");
  });
  const get = (url: string, init?: RequestInit) =>
    dispatchWith(new Request(url, init), env, db, NOW);

  it("answers 404 for everything but the customer routes", async () => {
    for (const path of [
      "/manage",
      "/manage/api/me",
      "/docs/start/concepts/",
      "/djdl/.well-known/polaris.json",
      "/djdl/identity/auth/device",
      "/webhooks/github",
      "/djdl",
    ])
      expect((await get(`${CUSTOMER}${path}`)).status, path).toBe(404);
  });

  it("serves the customer routes", async () => {
    expect((await get(`${CUSTOMER}/signin?product=djdl`)).status).toBe(302);
    expect((await get(`${CUSTOMER}/device`)).status).toBe(200);
    expect((await get(`${CUSTOMER}/tv`)).status).toBe(200);
    expect((await get(`${CUSTOMER}/`)).status).not.toBe(404);
  });

  it("the API host still serves the product routes", async () => {
    expect((await get(`${API}/djdl/.well-known/polaris.json`)).status).toBe(
      200,
    );
  });

  it("answers the health check with CORS for the console only", async () => {
    const res = await get(`${CUSTOMER}/.well-known/polaris-host.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "customer" });
    expect(res.headers.get("access-control-allow-origin")).toBe(API);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(
      (
        await get(`${CUSTOMER}/.well-known/polaris-host.json`, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    // Not on the API host.
    expect((await get(`${API}/.well-known/polaris-host.json`)).status).toBe(
      404,
    );
  });

  it("robots.txt keeps crawlers off the sign-in and API paths", async () => {
    const res = await get(`${CUSTOMER}/robots.txt`);
    expect(await res.text()).toContain("Disallow: /api/");
  });

  it("is inert with CUSTOMER_ORIGIN unset", async () => {
    delete env.CUSTOMER_ORIGIN;
    expect((await get(`${CUSTOMER}/manage`)).status).not.toBe(404);
  });
});
