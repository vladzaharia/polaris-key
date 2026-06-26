import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct } from "../src/product.js";
import {
  handleBrowserLogout,
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "../src/browserSession.js";
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
  });
});
