// LK-03 (plans/LK-00.md §7.1–7.5): the customer host, `customerOrigin()`, the old-URL
// redirects (LK-17: no switch, a usable CUSTOMER_ORIGIN is the cutover) and the call-site migration. With `CUSTOMER_ORIGIN` unset nothing here changes a byte.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, seedProduct, setPortalToggles } from "../seed.js";
import { dispatchWith } from "../../src/dispatch.js";
import {
  customerHostname,
  customerOrigin,
  isCustomerHost,
} from "../../src/core/hosts.js";
import {
  accountPortalUrl,
  buildSignInUrl,
} from "../../src/core/licensing/manageUrl.js";
import type { Env } from "../../src/platform/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";

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

  it("core.portal.activate follows CUSTOMER_ORIGIN, and is {enabled:false} while the portal is off (DISC-01)", async () => {
    const discover = async () =>
      (
        (await (
          await dispatchWith(
            new Request(`${API}/djdl/.well-known/polaris.json`),
            env,
            db,
            NOW,
          )
        ).json()) as { core: { portal: unknown } }
      ).core.portal;
    expect(await discover()).toEqual({
      enabled: true,
      activate: `${API}/activate?product=djdl`,
    });
    env.CUSTOMER_ORIGIN = CUSTOMER;
    expect(await discover()).toEqual({
      enabled: true,
      activate: `${CUSTOMER}/activate?product=djdl`,
    });
    await setPortalToggles(db, "djdl", { portalEnabled: false });
    expect(await discover()).toEqual({ enabled: false });
  });

  it("the API host's root is the customer portal with no customer origin and the console's front door once it is set (LK-14)", async () => {
    const get = (path: string, init?: RequestInit) =>
      dispatchWith(new Request(`${API}${path}`, init), env, db, NOW);
    expect((await get("/")).status).toBe(200);
    env.CUSTOMER_ORIGIN = CUSTOMER;
    for (const path of ["/", "/index.html"]) {
      const res = await get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location")).toBe("/manage");
    }
    // Only the root here: the old customer pages redirect (LK-17, below); assets are untouched.
    expect((await get("/activate")).status).toBe(301);
    expect((await get("/manage")).status).not.toBe(302);
    // The customer host's own root is still the portal.
    expect(
      (await dispatchWith(new Request(`${CUSTOMER}/`), env, db, NOW)).status,
    ).toBe(200);
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
      "/djdl/.well-known/polaris.json",
      "/djdl/identity/auth/device",
      "/webhooks/github",
      "/djdl",
    ])
      expect((await get(`${CUSTOMER}${path}`)).status, path).toBe(404);
  });

  describe("Help (LK-09, D7)", () => {
    beforeEach(() => {
      const files: Record<string, string> = {
        "/docs/help/index.html": "<html>help home</html>",
        "/docs/help/activate/index.html": "<html>help activate</html>",
        "/docs/_astro/app.abc.css": "body{}",
        "/docs/pagefind-help/pagefind.js": "export{}",
        "/docs/404.html": "<html>404</html>",
      };
      env.ASSETS = {
        fetch: async (input: RequestInfo | URL) => {
          const u = new URL(
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input.url,
          );
          const body = files[u.pathname];
          return body === undefined
            ? new Response("no", { status: 404 })
            : new Response(body);
        },
      } as unknown as Fetcher;
    });

    it("serves Help and what Help loads, with no session", async () => {
      for (const path of [
        "/docs/help/",
        "/docs/help/activate/",
        "/docs/_astro/app.abc.css",
        "/docs/pagefind-help/pagefind.js",
      ])
        expect((await get(`${CUSTOMER}${path}`)).status, path).toBe(200);
      expect(
        await (await get(`${CUSTOMER}/docs/help/activate/`)).text(),
      ).toContain("help activate");
    });

    it("sends every other /docs path to the console host", async () => {
      for (const path of [
        "/docs/start/concepts/",
        "/docs/",
        "/docs/operate/",
        "/docs/access/",
        "/docs/pagefind/pagefind.js",
        "/docs/pagefind-member/pagefind.js",
        "/docs/helpful/",
      ]) {
        const res = await get(`${CUSTOMER}${path}`);
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe(`${API}${path}`);
      }
    });

    it("keeps /help on the customer host", async () => {
      for (const [from, to] of [
        ["/help", "/docs/help/"],
        ["/help/", "/docs/help/"],
        ["/help/activate/?x=1", "/docs/help/activate/?x=1"],
      ]) {
        const res = await get(`${CUSTOMER}${from}`);
        expect(res.status, from).toBe(302);
        expect(res.headers.get("location"), from).toBe(to);
      }
    });

    it("moves /help and /docs/help/* off the console host", async () => {
      const alias = await get(`${API}/help/activate/`);
      expect(alias.headers.get("location")).toBe(
        `${CUSTOMER}/docs/help/activate/`,
      );
      for (const path of [
        "/docs/help",
        "/docs/help/",
        "/docs/help/activate/?a=b",
      ]) {
        const res = await get(`${API}${path}`);
        expect(res.status, path).toBe(301);
        expect(res.headers.get("location"), path).toBe(`${CUSTOMER}${path}`);
      }
      // The rest of the docs, and the files the console host's own pages load, stay.
      expect((await get(`${API}/docs/start/`)).status).not.toBe(301);
      expect((await get(`${API}/docs/_astro/app.abc.css`)).status).toBe(200);
    });

    it("leaves the console host's Help alone with no customer host", async () => {
      delete env.CUSTOMER_ORIGIN;
      expect((await get(`${API}/docs/help/`)).status).toBe(200);
      expect((await get(`${API}/help`)).headers.get("location")).toBe(
        "/docs/help/",
      );
    });
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
