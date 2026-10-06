import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  handleBrowserLogout,
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "../src/services/identity/browserSession.js";
import { getDevice } from "../src/repo.js";

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`https://key.plrs.im${path}`, init) as unknown as Request;
}

describe("browser sessions", () => {
  it("reuses one browser device and deauthorizes it on logout", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");

    const first = await handleBrowserSessionLicense(
      req("POST", "/djdl/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW,
    );
    const firstCookie = first.headers.get("set-cookie");
    expect(first.status).toBe(201);
    expect(firstCookie).toBeTruthy();

    const second = await handleBrowserSessionLicense(
      req("POST", "/djdl/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW + 1,
    );
    const secondCookie = second.headers.get("set-cookie");
    expect(second.status).toBe(201);
    expect(secondCookie).toBeTruthy();

    const deviceId = `browser:${licenseId}`;
    const device = await getDevice(db, "djdl", deviceId);
    expect(device?.status).toBe("authorized");
    expect(device?.token_hash).toBeTruthy();
    expect(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND license_id = ?",
          "djdl",
          licenseId,
        )
      )?.n,
    ).toBe(1);

    const session = await handleBrowserSession(
      req("GET", "/djdl/session", { cookie: secondCookie! }),
      env,
      db,
      product,
      NOW + 2,
    );
    const sessionBody = (await session.json()) as {
      csrfToken: string;
    };
    // U-02: an account signed in on the browser device; logging out clears the binding.
    await db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
      "ps_AAAAAAAAAAAAAAAAAAAAAA",
      "djdl",
      deviceId,
    );
    const logout = await handleBrowserLogout(
      req("POST", "/djdl/auth/logout", {
        cookie: secondCookie!,
        csrf: sessionBody.csrfToken,
      }),
      env,
      db,
      product,
    );
    expect(logout.status).toBe(200);
    const after = await getDevice(db, "djdl", deviceId);
    expect(after?.status).toBe("deauthorized");
    expect(await env.HOT.get(`p:djdl:token:${device!.token_hash}`)).toBeNull();
    expect(after?.subject ?? null).toBeNull();
  });

  // FIXED: `GET /<p>/session` used to swallow a catalog-construction failure and then skip
  // `validatePayload` entirely — i.e. deliver to a BROWSER exactly the unvalidated payload
  // the catalog exists to prune. Its comment claimed this was "aligned with /config"; /config
  // returns 500 `catalog_unavailable`. It now does the same.
  it("a malformed active catalog fails CLOSED, matching /config", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");

    const login = await handleBrowserSessionLicense(
      req("POST", "/djdl/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW,
    );
    const cookie = login.headers.get("set-cookie")!;

    // Sanity: a healthy catalog still serves the doc.
    const ok = await handleBrowserSession(
      req("GET", "/djdl/session", { cookie }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { doc: unknown }).toHaveProperty("doc");

    // Corrupt the active catalog row the same way R11-06 describes.
    await db.run(
      "UPDATE product_schema SET catalog_json = '{not json' WHERE product = ? AND active = 1",
      "djdl",
    );
    const broken = await handleBrowserSession(
      req("GET", "/djdl/session", { cookie }),
      env,
      db,
      product,
      NOW + 2,
    );
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain("catalog_unavailable");
  });
});

describe("a corrupt session record", () => {
  it("reads as no session rather than a 500 (R11-06's rule, applied here)", async () => {
    // `POST /<p>/devices/register` now consults this same resolver for a `requires-identity`
    // product, so an uncaught SyntaxError here would 500 a credential-mint path. A garbled KV
    // value is indistinguishable from an absent one for every caller, so it takes that branch.
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");

    const created = await handleBrowserSessionLicense(
      req("POST", "/djdl/identity/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW,
    );
    expect(created.status).toBe(201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;

    const sessionKeys = kv
      .keys()
      .filter((k) => k.includes(":browser-session:"));
    expect(sessionKeys).toHaveLength(1);
    await kv.put(sessionKeys[0]!, "{not json");

    const res = await handleBrowserSession(
      req("GET", "/djdl/identity/session", { cookie }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, doc: null });
  });
});
