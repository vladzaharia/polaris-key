// LK-04 (plans/LK-00.md §7.8): the bind hop. With the customer host on, `authorize` (API host)
// sets no cookie and 303s to `<customer>/signin?request=&bind=`; the customer host redeems the
// token once, sets `__Host-pk_req` itself and 303s to `/signin?request=`. Each property has a
// positive case and a negative control.
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import { handlePortalApi as portalApi } from "../src/services/identity/portal/api.js";
import { SETTINGS } from "../src/mount.js";
import { portalHooksFor } from "./portalHarness.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const SLUG = "tidewater";
const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const APP = "https://app.example";
const CB = `${APP}/auth/callback`;
const STATE = "s".repeat(24);
const CHALLENGE = createHash("sha256")
  .update("v".repeat(48))
  .digest("base64url");

let db: SqliteDb;
let env: Env;

async function setMode(mode: string) {
  await db.run(
    "INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('CUSTOMER_HOST', ?, 1, ?, 'test')",
    JSON.stringify(mode),
    NOW,
  );
  invalidatePlatformSettings(env, db);
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.CONSOLE_ORIGIN = API;
  env.CUSTOMER_ORIGIN = CUSTOMER;
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([APP]),
    SLUG,
  );
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.redirectPaths', ?, 'manifest', ?, 'test')`,
    SLUG,
    JSON.stringify(["/auth/callback"]),
    NOW,
  );
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [
      s,
      { enabled: ["license", "config", "identity"].includes(s) },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    SLUG,
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
});

const go = (
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) => dispatchWith(new Request(url, { method, headers }), env, db, NOW);

const authorize = () => {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: CB,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  return go(`${API}/${SLUG}/identity/authorize?${q}`);
};

describe("authorize with the customer host on", () => {
  it("off: unchanged, a cookie on the API host and no bind token", async () => {
    const res = await authorize();
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(API);
    expect(loc.searchParams.has("bind")).toBe(false);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-pk_req=/);
  });

  it("on: no cookie here, a bind URL on the customer host", async () => {
    await setMode("on");
    const res = await authorize();
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(CUSTOMER);
    expect(loc.pathname).toBe("/signin");
    expect(loc.searchParams.get("request")).toMatch(/^rq_[A-Za-z0-9_-]{22}$/);
    expect(loc.searchParams.get("bind")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The app's state, challenge and redirect URI never ride in the bind URL (R1-07).
    const raw = res.headers.get("location")!;
    for (const secret of [
      STATE,
      CHALLENGE,
      encodeURIComponent(CB),
      "app.example",
    ])
      expect(raw).not.toContain(secret);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the hop on the customer host", () => {
  async function bindUrl() {
    await setMode("on");
    return (await authorize()).headers.get("location")!;
  }

  it("redeems once, sets the binder on its own host and lands on the card address", async () => {
    const url = await bindUrl();
    const hop = await go(url);
    expect(hop.status).toBe(303);
    const handle = new URL(url).searchParams.get("request")!;
    expect(hop.headers.get("location")).toBe(`/signin?request=${handle}`);
    expect(hop.headers.get("cache-control")).toBe("no-store");
    expect(hop.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = hop.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^__Host-pk_req=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    // The binder opens the card's read on this host; without it the same read is a 404.
    const read = (cookieHeader?: string) =>
      portalApi(
        new Request(`${CUSTOMER}/api/signin/requests/${handle}`, {
          headers: cookieHeader ? { cookie: cookieHeader } : {},
        }),
        env,
        db,
        `/api/signin/requests/${handle}`,
        NOW,
        portalHooksFor(env, db),
        SETTINGS,
      );
    expect((await read(cookie.split(";")[0]!)).status).toBe(200);
    expect((await read()).status).toBe(404);
  });

  it("replay: the second visit is the plain not-found and sets nothing", async () => {
    const url = await bindUrl();
    expect((await go(url)).status).toBe(303);
    const again = await go(url);
    expect(again.status).toBe(404);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("HEAD does not spend the token", async () => {
    const url = await bindUrl();
    expect((await go(url, {}, "HEAD")).status).toBe(404);
    expect((await go(url)).status).toBe(303);
  });

  it("a token for another handle, a malformed token and an unknown token are refused alike", async () => {
    const url = new URL(await bindUrl());
    const other = new URL(url);
    other.searchParams.set("request", "rq_" + "A".repeat(22));
    expect((await go(other.toString())).status).toBe(404);
    // The mismatched attempt consumed the token (fail closed): the real visit is refused too.
    expect((await go(url.toString())).status).toBe(404);
    for (const bind of ["short", "x".repeat(43), "%0d%0a"]) {
      const u = new URL(url);
      u.searchParams.set("bind", bind);
      expect((await go(u.toString())).status, bind).toBe(404);
    }
  });

  it("never redirects anywhere the query names", async () => {
    const url = new URL(await bindUrl());
    url.searchParams.set("return_to", "https://evil.example/");
    url.searchParams.set("next", "//evil.example");
    const hop = await go(url.toString());
    expect(hop.headers.get("location")).toMatch(/^\/signin\?request=rq_/);
  });

  it("is not offered on the API host, or with no bind", async () => {
    const url = new URL(await bindUrl());
    const onApi = await go(`${API}${url.pathname}${url.search}`);
    expect(onApi.status).toBe(404);
    expect(onApi.headers.get("set-cookie")).toBeNull();
    url.searchParams.delete("bind");
    expect((await go(url.toString())).status).toBe(404);
  });
});
