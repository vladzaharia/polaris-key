import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleAuthDeviceEntry,
  handleAuthDeviceStart,
} from "../src/services/identity/oidc.js";
import {
  claimUserCode,
  deleteUserCodeIndex,
} from "../src/services/identity/productOidc/userCode.js";
import { handleDeviceEntry } from "../src/core/deviceEntry.js";
import {
  claimDeviceCode,
  deviceCodeIndexKey,
  lookupDeviceCode,
} from "../src/core/deviceCodeIndex.js";
import { matchRoute } from "../src/router.js";
import { artefacts, singleUseMock } from "./singleUseMock.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const ORIGIN = "https://key.plrs.im";
const MISS =
  "No device is waiting for that code. Check your device's screen: codes last 10 minutes.";

describe("the platform device-code entry pages", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
      "djdl",
      "custom",
      "https://id.example",
      "client-djdl",
      null,
      JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
      "{}",
    );
    product = (await loadProduct(env, db, "djdl"))!;
  });
  afterEach(() => vi.useRealTimers());

  async function start(): Promise<{ userCode: string; deviceCode: string }> {
    const res = await handleAuthDeviceStart(
      new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "tv-1" }),
      }),
      env,
      db,
      product,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { userCode: string; deviceCode: string };
  }

  const get = (path: string, ip = "203.0.113.7", tv = path.startsWith("/tv")) =>
    handleDeviceEntry(
      new Request(`${ORIGIN}${path}`, {
        headers: { "cf-connecting-ip": ip },
      }),
      env,
      tv,
    );

  it("routes /device and /tv as platform pages, not products", () => {
    expect(matchRoute("/device")).toEqual({ kind: "deviceEntry", tv: false });
    expect(matchRoute("/tv")).toEqual({ kind: "deviceEntry", tv: true });
    expect(matchRoute("/tv/")).toEqual({ kind: "deviceEntry", tv: true });
  });

  it("renders a script-free form with no code, and a larger one for /tv", async () => {
    for (const path of ["/device", "/tv"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("script-src");
      const html = await res.text();
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain("Enter the code from your device");
      // The anti-phishing line and the footer (identity.device-code).
      expect(html).toContain("not one somebody sent you.");
      expect(html).toContain(
        "signs you in on the device that shows this code.",
      );
      expect(html).toContain(`<form method="get" action="${path}">`);
      expect(html.includes('<body class="tv">')).toBe(path === "/tv");
    }
  });

  it("redirects a live code to its product's page, whatever the typing", async () => {
    const { userCode } = await start();
    const target = `/djdl/identity/auth/device?user_code=${userCode}`;
    const typed = [
      userCode,
      userCode.toLowerCase(),
      userCode.replace("-", ""),
      ` ${userCode.toLowerCase().replace("-", " ")} `,
    ];
    for (const raw of typed) {
      for (const path of ["/device", "/tv"]) {
        const res = await get(`${path}?user_code=${encodeURIComponent(raw)}`);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
          path === "/tv" ? `${target}&tv=1` : target,
        );
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      }
    }
  });

  it("indexes the code in the platform store with the flow's lifetime, under a hashed key", async () => {
    const { userCode } = await start();
    const code = userCode.replace("-", "");
    const key = await deviceCodeIndexKey(env, code);
    expect(await artefacts(env).get(key)).toBe("djdl");
    expect(singleUseMock(env).ttlOf(key)).toBe(600);
    for (const k of singleUseMock(env).keys()) expect(k).not.toContain(code);
  });

  it("answers a miss with the form and the same line for unknown, malformed and expired codes, naming no product", async () => {
    await start();
    for (const raw of ["BBBBBBBB", "short", "AEIOU-AEIOU", "x".repeat(200)]) {
      const res = await get(`/device?user_code=${raw}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain(MISS.replace("'", "&#x27;"));
      expect(html).toContain('<form method="get"');
      // The reason sits under the field, not in an alert above the form, and the field is flagged.
      expect(html).not.toContain('role="alert"');
      expect(html).toContain(
        'aria-invalid="true" aria-describedby="user_code-err"',
      );
      expect(html.toLowerCase()).not.toContain("djdl");
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("stops resolving a code once its flow expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const { userCode } = await start();
    expect((await get(`/device?user_code=${userCode}`)).status).toBe(302);
    vi.setSystemTime(new Date("2026-10-19T10:10:01Z"));
    const res = await get(`/device?user_code=${userCode}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("djdl");
  });

  it("redirects even when the product's identity is off or the product is unknown to the page", async () => {
    // The index entry is all the page reads: nothing about the product's state is consulted.
    await db.run("DELETE FROM oidc_config WHERE product = ?", "djdl");
    await db
      .run("UPDATE products SET disabled = 1 WHERE slug = ?", "djdl")
      .catch(() => undefined);
    await claimDeviceCode(env, "CDFGHJKL", "djdl", 600);
    const res = await get("/device?user_code=CDFG-HJKL");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/djdl/identity/auth/device?user_code=CDFG-HJKL",
    );
  });

  it("redraws a code that a live flow already holds, platform-wide", async () => {
    // Another product holds BBBBBBBB.
    expect(await claimDeviceCode(env, "BBBBBBBB", "other", 600)).toBe(true);
    const draws = ["BBBBBBBB", "BBBBBBBB", "CCCCCCCC"];
    const code = await claimUserCode(
      env,
      "djdl",
      "dc-1",
      600,
      () => draws.shift()!,
    );
    expect(code).toBe("CCCCCCCC");
    expect(await lookupDeviceCode(env, "BBBBBBBB")).toBe("other");
    expect(await lookupDeviceCode(env, "CCCCCCCC")).toBe("djdl");
  });

  it("gives up after the attempts when every draw collides", async () => {
    await claimDeviceCode(env, "BBBBBBBB", "other", 600);
    expect(
      await claimUserCode(env, "djdl", "dc-1", 600, () => "BBBBBBBB"),
    ).toBeNull();
  });

  it("removes the platform entry with the per-product one, and never another product's", async () => {
    const { userCode } = await start();
    await deleteUserCodeIndex(env, "djdl", userCode);
    expect(await lookupDeviceCode(env, userCode.replace("-", ""))).toBeNull();
    // A product that never held the code cannot delete its entry.
    await claimDeviceCode(env, "DDDDDDDD", "other", 600);
    await deleteUserCodeIndex(env, "djdl", "DDDD-DDDD");
    expect(await lookupDeviceCode(env, "DDDDDDDD")).toBe("other");
  });

  it("does not resolve a code after the flow is confirmed on the product page", async () => {
    const { userCode } = await start();
    const page = await handleAuthDeviceEntry(
      new Request(`${ORIGIN}/djdl/identity/auth/device?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
      product,
    );
    expect(page.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await handleAuthDeviceEntry(
      new Request(`${ORIGIN}/djdl/identity/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.9",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ user_code: userCode, csrf }).toString(),
      }),
      env,
      product,
    );
    expect(res.status).toBe(303);
    expect((await get(`/device?user_code=${userCode}`)).status).toBe(404);
  });

  it("limits lookups per client network (30 a minute) and not other networks", async () => {
    let first429 = -1;
    for (let i = 0; i < 40 && first429 < 0; i++) {
      const res = await get("/device?user_code=BBBBBBBB", "198.51.100.1");
      if (res.status === 429) {
        first429 = i;
        expect(res.headers.get("retry-after")).toBe("60");
        expect(await res.text()).not.toContain("djdl");
      }
    }
    expect(first429).toBe(30);
    expect(
      (await get("/device?user_code=BBBBBBBB", "198.51.100.2")).status,
    ).toBe(404);
  });

  it("refuses other methods", async () => {
    const res = await handleDeviceEntry(
      new Request(`${ORIGIN}/device`, { method: "POST" }),
      env,
      false,
    );
    expect(res.status).toBe(405);
  });
});
