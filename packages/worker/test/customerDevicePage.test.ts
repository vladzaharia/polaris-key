// LK-04 (plans/LK-00.md §7.9, A1): the device entry on the customer host. `/device` and `/tv` find
// the product through the global index and hand the browser to the product's device page on the
// API host, where the confirmation, the IdP leg and the callback stay in one browser on one host:
// the flow's binder is set by the confirming browser (R1-07). A device confirmation never
// crosses hosts, so a forwarded link cannot complete a flow in another browser.
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

describe("the device entry on the customer host", () => {
  it("start hands out the customer host's page", async () => {
    const f = await start();
    expect(f.verificationUri).toBe(`${CUSTOMER}/device`);
    expect(f.verificationUriComplete).toBe(
      `${CUSTOMER}/device?user_code=${f.userCode}`,
    );
  });

  it("hands a live code to the product's page on the API host", async () => {
    const f = await start();
    for (const path of ["/device", "/tv"]) {
      const res = await send(
        `${CUSTOMER}${path}?user_code=${f.userCode.toLowerCase()}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `${API}/djdl/identity/auth/device?user_code=${f.userCode}`,
      );
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("serves the form with no code, names no product on a miss, and takes no POST", async () => {
    await start();
    expect((await send(`${CUSTOMER}/device`)).status).toBe(200);
    const miss = await send(`${CUSTOMER}/device?user_code=BBBBBBBB`);
    expect(miss.status).toBe(404);
    expect((await miss.text()).toLowerCase()).not.toContain("djdl");
    expect(
      (
        await send(`${CUSTOMER}/device`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "user_code=BBBBBBBB",
        })
      ).status,
    ).toBe(405);
  });

  it("lets the form submit to the API host its code redirects to", async () => {
    await start();
    // Browsers apply `form-action` to every redirect a submission follows, so the customer page
    // must name the API host or a found code goes nowhere.
    for (const path of ["/device", "/tv", "/device?user_code=BBBBBBBB"]) {
      const res = await send(`${CUSTOMER}${path}`);
      expect(res.headers.get("content-security-policy")).toContain(
        `form-action 'self' ${API};`,
      );
    }
  });

  it("the product path stays unreachable on the customer host", async () => {
    expect((await send(`${CUSTOMER}/djdl/identity/auth/device`)).status).toBe(
      404,
    );
  });

  it("a confirmation binds the confirming browser on the API host; a forwarded link cannot", async () => {
    const f = await start();
    const url = `${API}/djdl/identity/auth/device?user_code=${f.userCode}`;
    // The API host's page is not redirected away and its form allows only the IdP.
    const page = await send(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://id.example",
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const confirm = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: f.userCode, csrf }),
    });
    expect(confirm.status).toBe(303);
    const idp = new URL(confirm.headers.get("location")!);
    expect(idp.origin).toBe("https://id.example");
    // The binder cookie is set on the response to the confirming browser only.
    expect(confirm.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=[A-Za-z0-9_-]{43}/,
    );
    // Another browser holding the IdP leg's URL has no binder: the callback refuses it.
    const stranger = await send(
      `${API}/djdl/identity/auth/callback?code=x&state=${idp.searchParams.get("state")}`,
    );
    expect(stranger.status).not.toBe(200);
    expect(stranger.headers.get("set-cookie") ?? "").not.toContain("pkeyt_");
    // The retired continue route that would have set a binder for a link holder is gone.
    for (const bind of ["x", "A".repeat(43)])
      expect(
        (await send(`${API}/djdl/identity/auth/device/continue?bind=${bind}`))
          .status,
      ).toBe(404);
  });

  it("no customer origin: the old behaviour, a relative 302 to the product's page", async () => {
    delete env.CUSTOMER_ORIGIN;
    const f = await start();
    const res = await send(`${API}/device?user_code=${f.userCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    const form = await send(`${API}/device`);
    expect(form.headers.get("content-security-policy")).toContain(
      "form-action 'self';",
    );
  });
});
