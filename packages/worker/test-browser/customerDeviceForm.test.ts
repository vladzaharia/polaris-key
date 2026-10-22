// LXF-DEV-fix B2: a code typed on polaris.locker/device reaches the IdP in a real browser, through
// the Worker's real responses and CSP. The form is GET /device under `form-action 'self'`, and
// browsers check that directive on every redirect of the submission's chain, so the Worker answers
// a form-started sign-in with a 200 whose `<meta refresh>` moves on. Chromium and WebKit; the
// pre-fix 303 chain left the page on /device in both (the review's csp/run.mjs).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const IDP = "https://id.example";

async function world() {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
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
    IDP,
    "client-djdl",
    null,
    JSON.stringify([`${API}/djdl/identity/auth/callback`]),
    JSON.stringify({ members: { role: "user", tier: "pro" } }),
  );
  return { db, env };
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
  afterAll(() => undefined);

  it("reaches the IdP page through the real CSP", async () => {
    const started = await dispatchWith(
      new Request(`${API}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "tv-1" }),
      }),
      w.env,
      w.db,
      NOW,
    );
    const { userCode } = (await started.json()) as { userCode: string };
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      // The Worker answers for both of its hosts; the IdP is a stub page.
      await page.route(
        /^https:\/\/(polaris\.locker|key\.plrs\.im)\//,
        async (route) => {
          const req = route.request();
          const headers: Record<string, string> = { ...req.headers() };
          const res = await dispatchWith(
            new Request(req.url(), {
              method: req.method(),
              headers,
              redirect: "manual",
            }),
            w.env,
            w.db,
            NOW,
          );
          const out: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            if (k !== "set-cookie") out[k] = v;
          });
          await route.fulfill({
            status: res.status,
            headers: out,
            body: Buffer.from(await res.arrayBuffer()),
          });
        },
      );
      await page.route(`${IDP}/**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<title>IDP</title><p id=idp>IDP OK</p>",
        }),
      );
      await page.goto(`${CUSTOMER}/device`);
      await page.fill("#user_code", userCode);
      await page.click("button[type=submit]");
      await page.waitForURL((u) => u.origin === IDP, { timeout: 15_000 });
      expect(await page.textContent("#idp")).toBe("IDP OK");
    } finally {
      await browser.close();
    }
  });
});
