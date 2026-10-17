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
import { getDevice } from "../src/core/devices/store.js";

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

  // The OTHER half of the same hole. `GET /<p>/identity/session` failed closed on a MALFORMED
  // catalog row but skipped the prune entirely when there was NO active row, so a product with
  // no catalog handed its browser an unvalidated payload. It now reads the catalog through the
  // loader Core's prune uses, so both spellings of "no enforceable catalog" get the same 500.
  it("no active catalog row fails CLOSED too, not just a malformed one", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");

    const login = await handleBrowserSessionLicense(
      req("POST", "/djdl/identity/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW,
    );
    const cookie = login.headers.get("set-cookie")!;

    await db.run(
      "UPDATE product_schema SET active = 0 WHERE product = ?",
      "djdl",
    );
    const res = await handleBrowserSession(
      req("GET", "/djdl/identity/session", { cookie }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("catalog_unavailable");
  });

  // A `kind: "config"` entry flagged `secret: true` is a secret too: the config bucket reaches
  // the page, so this is the one filter between the page's JS and that value.
  it("withholds a secret-flagged config entry, and every secret, from the page", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    const entry = (over: Record<string, unknown>) => ({
      category: "General",
      label: "L",
      description: "",
      schema: { type: "string" },
      ...over,
    });
    await seedProduct(db, "djdl", {
      catalog: {
        schemaVersion: 1,
        entries: [
          entry({ key: "ui.theme", kind: "config" }),
          entry({ key: "api.token", kind: "config", secret: true }),
          entry({ key: "vpn.url", kind: "secret", secret: true }),
        ],
      },
    });
    const enforced = (value: string) => ({
      state: "enforced" as const,
      value,
      updatedAt: NOW,
    });
    const { key } = await seedLicenseWithKey(db, "djdl", {
      config: {
        "ui.theme": enforced("dark"),
        "api.token": enforced("CONFIG-SECRET-VALUE"),
      },
      secrets: { "vpn.url": enforced("SECRET-KIND-VALUE") },
    });
    const product = (await loadProduct(env, db, "djdl"))!;
    const login = await handleBrowserSessionLicense(
      req("POST", "/djdl/identity/session/license", { body: { key } }),
      env,
      db,
      product,
      NOW,
    );
    const cookie = login.headers.get("set-cookie")!;

    const res = await handleBrowserSession(
      req("GET", "/djdl/identity/session", { cookie }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("CONFIG-SECRET-VALUE");
    expect(text).not.toContain("SECRET-KIND-VALUE");
    const body = JSON.parse(text) as {
      doc: {
        payload: {
          config: Record<string, { value: unknown }>;
          secrets: Record<string, unknown>;
        };
      };
    };
    expect(Object.keys(body.doc.payload.config)).toEqual(["ui.theme"]);
    expect(body.doc.payload.config["ui.theme"]!.value).toBe("dark");
    expect(body.doc.payload.secrets).toEqual({});
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

  it("reads as no session when the stored bearer is missing, mistyped or not an envelope", async () => {
    // The record's `token` is a sealed envelope. A record that parses but carries no usable one
    // (none at all, the wrong type, a string that is not a v2 envelope) is not a session this
    // code can open, and every caller already answers "no session" rather than throwing.
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
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const slot = kv.keys().find((k) => k.includes(":browser-session:"))!;
    const stored = JSON.parse((await kv.get(slot))!) as Record<string, unknown>;
    const { token: _sealed, ...withoutToken } = stored;

    for (const record of [
      withoutToken,
      { ...stored, token: 42 },
      { ...stored, token: "" },
      { ...stored, token: "pkeyt_not_an_envelope" },
      { ...stored, token: JSON.stringify({ v: 1, ct: "x" }) },
      null,
      [],
    ]) {
      await kv.put(slot, JSON.stringify(record));
      const res = await handleBrowserSession(
        req("GET", "/djdl/identity/session", { cookie }),
        env,
        db,
        product,
        NOW + 1,
      );
      expect(res.status, JSON.stringify(record)).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false, doc: null });
    }
  });
});
