// LK-04 (plans/LK-00.md §7.9, A1): the device page on the customer host. The platform index
// (`/device`, `/tv`) finds the product; the product's own handler then runs ON the customer host,
// so the confirmation, its CSRF token and the sign-in binder never leave it. The old product page
// hands a GET over.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  env.CONSOLE_ORIGIN = API;
  env.CUSTOMER_ORIGIN = CUSTOMER;
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
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify([`${API}/djdl/identity/auth/callback`]),
    "{}",
  );
});

const send = (url: string, init: RequestInit = {}) =>
  dispatchWith(new Request(url, init), env, db, NOW);

async function start() {
  const res = await send(`${API}/djdl/identity/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "tv-1" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
  };
}

describe("the device page on the customer host", () => {
  it("start hands out the customer host's page", async () => {
    const f = await start();
    expect(f.verificationUri).toBe(`${CUSTOMER}/device`);
    expect(f.verificationUriComplete).toBe(
      `${CUSTOMER}/device?user_code=${f.userCode}`,
    );
  });

  it("renders the confirmation on the customer host, posting back to /device", async () => {
    const f = await start();
    for (const path of ["/device", "/tv"]) {
      const res = await send(
        `${CUSTOMER}${path}?user_code=${f.userCode.toLowerCase()}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      expect(html).toContain(`action="${CUSTOMER}/device"`);
      expect(html).toContain(f.userCode);
      expect(html).toMatch(/name="csrf" value="[A-Za-z0-9_-]+"/);
      expect(html).not.toContain(API);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain(`form-action 'self' ${API} https://id.example`);
      // The binder is the customer host's own cookie.
      expect(res.headers.get("set-cookie")).toMatch(/^__Host-pk_req=/);
    }
  });

  it("confirms with a POST to /device and hands on to the IdP", async () => {
    const f = await start();
    const page = await (
      await send(`${CUSTOMER}/device?user_code=${f.userCode}`)
    ).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const post = (fields: Record<string, string>, origin = CUSTOMER) =>
      send(`${CUSTOMER}/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams(fields),
      });
    // Negative controls: a wrong CSRF token and a foreign Origin confirm nothing.
    expect((await post({ user_code: f.userCode, csrf: "nope" })).status).toBe(
      403,
    );
    expect(
      (await post({ user_code: f.userCode, csrf }, "https://evil.example"))
        .status,
    ).toBe(403);
    const ok = await post({ user_code: f.userCode, csrf });
    expect(ok.status).toBe(303);
    // The IdP calls back on the API host, so the binder is set there, through a bind hop: no
    // cookie from the customer host, and the page's form-action allows the API host's hop.
    expect(ok.headers.get("set-cookie")).toBeNull();
    const hopUrl = new URL(ok.headers.get("location")!);
    expect(hopUrl.origin).toBe(API);
    expect(hopUrl.pathname).toBe("/djdl/identity/auth/device/continue");
    expect(page).toContain("device"); // the page rendered
    const hop = await send(hopUrl.toString());
    expect(hop.status).toBe(303);
    expect(hop.headers.get("location")).toMatch(/^https:\/\/id\.example\//);
    expect(hop.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure/,
    );
    // Single use, and nothing else redeems it: a replay and a request-supplied target both fail.
    expect((await send(hopUrl.toString())).status).toBe(404);
    expect(
      (
        await send(
          `${API}/djdl/identity/auth/device/continue?bind=x&to=https://evil.example`,
        )
      ).status,
    ).toBe(404);
    // A confirmation for a code that has gone away is refused, naming nothing.
    expect((await post({ user_code: f.userCode, csrf })).status).toBe(403);
  });

  it("answers a miss with the form, naming no product; POST is not offered on the API host", async () => {
    await start();
    const miss = await send(`${CUSTOMER}/device?user_code=BBBBBBBB`);
    expect(miss.status).toBe(404);
    expect((await miss.text()).toLowerCase()).not.toContain("djdl");
    expect(
      (
        await send(`${API}/device`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "user_code=BBBBBBBB",
        })
      ).status,
    ).toBe(405);
  });

  it("the product's own page on the API host hands a GET over, keeping the code", async () => {
    const f = await start();
    const res = await send(
      `${API}/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `${CUSTOMER}/device?user_code=${f.userCode}`,
    );
    const bare = await send(`${API}/djdl/identity/auth/device`);
    expect(bare.headers.get("location")).toBe(`${CUSTOMER}/device`);
    // A junk code is not carried into the Location.
    const junk = await send(
      `${API}/djdl/identity/auth/device?user_code=%3Cx%3E`,
    );
    expect(junk.headers.get("location")).toBe(`${CUSTOMER}/device`);
  });

  it("the product path stays unreachable on the customer host", async () => {
    expect((await send(`${CUSTOMER}/djdl/identity/auth/device`)).status).toBe(
      404,
    );
  });

  it("no customer origin: the old behaviour, a relative 302 to the product's page", async () => {
    delete env.CUSTOMER_ORIGIN;
    const f = await start();
    const res = await send(`${API}/device?user_code=${f.userCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    const page = await send(
      `${API}/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    expect(page.status).toBe(200);
  });
});
