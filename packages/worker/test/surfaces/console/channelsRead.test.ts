/**
 * A-20.4: `GET /manage/api/products/:slug/distribution/channels` and the one-product summary's
 * `platforms[]` / `channels[]`, through the real admin dispatcher. The delivery facet's own rules
 * are `channelFacts.test.ts`; this proves the composition: the area gate, scope, the commerce
 * facet and that no credential-derived value reaches the body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeServices } from "../../../src/core/services.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { NOW, seedProduct } from "../../seed.js";
import { ascP8 } from "../../ascWorld.js";
import { CONSOLE, enableServices, envFor } from "../../releaseRoutesFixture.js";
import { setServices } from "../../../src/core/products/store.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  commerceWorld,
  SETTINGS,
  type CommerceWorld,
} from "../../commerceWorld.js";
import { BUNDLE_ID } from "../../commerceFake.js";
import { SLUG as WORLD_SLUG } from "../../releaseRoutesFixture.js";
import { afterEach } from "vitest";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { syntheticKey } from "../../syntheticPrincipals.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";

import type { Principal } from "../../../src/core/rbac/can.js";

// A principal narrowed to one area, for a sub the test names; every other sub resolves for real.
const SYNTHETIC = new Map<string, Principal>();
vi.mock("../../../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../../src/core/rbac/principal.js")
    >();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) =>
      SYNTHETIC.get(syntheticKey(args[2].sub)) ??
      real.resolvePrincipal(...args),
  };
});

const SLUG = "diceroll";
const ISSUER = "69a6de7f-0000-47e3-e053-5b8c7c11a4d1";
const KEY_ID = "TEAMKEY123";
const APP_NAME = "Secret Dice Deluxe";

let db: Db;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface JsonResponse extends Response {
  json(): Promise<Loose>;
}

async function admin(
  method: string,
  path: string,
  groups = ["platform-admins"],
  sub = "u1",
  database: Db = db,
): Promise<JsonResponse> {
  const { token, session } = await consoleTestSession(
    env,
    database,
    { sub, name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  return (await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      },
    }),
    env,
    database,
    full.split("?")[0]!,
    { now: NOW },
  )) as JsonResponse;
}

const read = () => admin("GET", `/products/${SLUG}/distribution/channels`);

async function planned(platforms: string[]) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, 'distribution.intendedPlatforms', ?, 'console', 1, ?, 'test')`,
    SLUG,
    JSON.stringify(platforms),
    NOW,
  );
}

async function outlet(id: string, kind: string, identity: unknown) {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

async function commerce(enabled: boolean) {
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: false },
        sync: { enabled: false },
        commerce: { enabled },
        connect: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

const row = (body: Loose, id: string) =>
  body.channels.find((c: { id: string }) => c.id === id);

describe("the channels read (A-20.4)", () => {
  it("a member narrowed to the license area is refused with 403 for the ship area", async () => {
    await planned(["windows"]);
    SYNTHETIC.set("u-license", {
      memberId: "u-license",
      grants: [
        {
          role: "product_admin",
          scope: `product:${SLUG}`,
          areas: ["license"],
          source: "grant",
        },
      ],
    });
    const res = await admin(
      "GET",
      `/products/${SLUG}/distribution/channels`,
      ["platform-admins"],
      "u-license",
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.area).toBe("ship");
    // The same member still reads the record (anyArea), with only the compact fields.
    const rec = await admin(
      "GET",
      `/products/${SLUG}`,
      ["platform-admins"],
      "u-license",
    );
    expect(rec.status).toBe(200);
  });

  it("an unknown product is a 404", async () => {
    const res = await admin("GET", "/products/nope/distribution/channels");
    expect(res.status).toBe(404);
  });

  it("a Windows-only product lists no Apple channel and labels from the catalogue", async () => {
    await planned(["windows"]);
    const res = await read();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.channels.map((c: { id: string }) => c.id);
    for (const gone of ["app-store", "testflight", "altstore", "homebrew"])
      expect(ids).not.toContain(gone);
    expect(ids).toEqual(expect.arrayContaining(["winget", "scoop"]));
    expect(body.platforms.map((p: { platform: string }) => p.platform)).toEqual(
      ["windows"],
    );
    expect(row(body, "winget").label).toBe("winget");
    expect(row(body, "winget").delivery.state).toBe("not_set_up");
  });

  it("the commerce facet is null without one, and off while Commerce is off", async () => {
    await planned(["macos", "windows"]);
    const body = await (await read()).json();
    expect(row(body, "winget").commerce).toBeNull();
    expect(row(body, "app-store").commerce).toEqual({
      state: "not_set_up",
      reason: "commerce_off",
      attention: [],
    });
  });

  it("with Commerce on and no settings, the store is not set up with a reason code", async () => {
    await planned(["macos"]);
    await commerce(true);
    const body = await (await read()).json();
    expect(row(body, "app-store").commerce).toEqual({
      state: "not_set_up",
      reason: "no_settings",
      attention: [],
    });
  });

  it("a declared out-of-scope outlet is listed with out_of_scope attention", async () => {
    await planned(["windows"]);
    await outlet("o1", "app-store", {});
    const body = await (await read()).json();
    expect(row(body, "app-store").delivery.attention).toContainEqual({
      code: "out_of_scope",
    });
    expect(row(body, "app-store").delivery.state).toBe("attention");
  });

  it("no key id, issuer, credential or app name is in the body", async () => {
    await planned(["macos", "ios"]);
    (env as Record<string, unknown>).PLATFORM_ASC_API_KEY = JSON.stringify({
      keyId: KEY_ID,
      issuerId: ISSUER,
      p8: ascP8(),
    });
    await outlet("o1", "app-store", {
      bundleId: "com.example.dice",
      appName: APP_NAME,
      appAppleId: "1234567890",
    });
    const res = await read();
    const text = await res.text();
    const body = JSON.parse(text);
    // The team key is held, so the facts show as booleans only.
    expect(row(body, "testflight").oneClick).toBe(true);
    for (const secret of [
      KEY_ID,
      ISSUER,
      APP_NAME,
      "com.example.dice",
      "1234567890",
      "BEGIN",
    ])
      expect(text).not.toContain(secret);
    // Every key the body carries is one of the documented ones.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(body);
    for (const k of keys)
      expect([
        "product",
        "now",
        "platforms",
        "kinds",
        "channels",
        "platform",
        "arches",
        "formats",
        "sources",
        "id",
        "label",
        "inScope",
        "declared",
        "oneClick",
        "notUsing",
        "delivery",
        "commerce",
        "state",
        "attention",
        "reason",
        "reasons",
        "code",
        "identity",
        "field",
        "fields",
        "source",
      ]).toContain(k);
  });

  it("is read-only", async () => {
    const res = await admin("POST", `/products/${SLUG}/distribution/channels`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the one-product summary (A-20.4)", () => {
  it("carries platforms[] and compact channels[]; the list does not", async () => {
    await planned(["windows"]);
    const one = (await (await admin("GET", `/products/${SLUG}`)).json())
      .product;
    expect(one.platforms.map((p: { platform: string }) => p.platform)).toEqual([
      "windows",
    ]);
    const winget = one.channels.find((c: { id: string }) => c.id === "winget");
    expect(winget).toEqual({
      id: "winget",
      label: "winget",
      inScope: true,
      delivery: "not_set_up",
      notUsing: false,
    });
    const list = await (await admin("GET", "/products")).json();
    for (const p of list.products ?? []) {
      expect(p.channels).toBeUndefined();
      expect(p.platforms).toBeUndefined();
    }
  });
});

describe("the summary's cost and robustness (A-20.4)", () => {
  /** A Db that sees every statement, counts it, and may fail one. */
  function watched(
    inner: Db,
    failOn?: string,
  ): { db: Db; count: () => number } {
    let n = 0;
    const see = (sql: string) => {
      n++;
      if (failOn && sql.includes(failOn)) throw new Error("boom");
    };
    return {
      count: () => n,
      db: {
        all: (sql, ...p) => (see(sql), inner.all(sql, ...p)),
        first: (sql, ...p) => (see(sql), inner.first(sql, ...p)),
        run: (sql, ...p) => (see(sql), inner.run(sql, ...p)),
        runChanges: (sql, ...p) => (see(sql), inner.runChanges(sql, ...p)),
        batch: (st) => (n++, inner.batch(st)),
      },
    };
  }

  it("the one-product read stays within a D1 read budget", async () => {
    await planned(["macos", "windows", "linux"]);
    const w = watched(db);
    // Sign in and warm the console's 30 s live check on the plain Db first, so the count is the
    // product read alone (the live check is the session's, not the read's).
    const { token } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const path = `/api/products/${SLUG}`;
    const get = (database: Db) =>
      handleAdmin(
        new Request(`${CONSOLE}/manage${path}`, {
          headers: { cookie: `${ADMIN_COOKIE}=${token}` },
        }),
        env,
        database,
        path,
        { now: NOW },
      );
    expect((await get(db)).status).toBe(200);
    const res = await get(w.db);
    expect(res.status).toBe(200);
    // The whole record, channels included: 35 statements now, 65 before the cost fix (platforms
    // and live builds were computed two or three times; three queries per credential slot).
    expect(w.count()).toBeLessThanOrEqual(40);
  });

  it("a throw in the channels read leaves the fields out and the record 200", async () => {
    await planned(["windows"]);
    const w = watched(db, "dist_availability");
    const res = await admin("GET", `/products/${SLUG}`, undefined, "u1", w.db);
    expect(res.status).toBe(200);
    const { product } = await res.json();
    expect(product.slug).toBe(SLUG);
    expect(product.channels).toBeUndefined();
    expect(product.platforms).toBeUndefined();
  });
});

describe("identity in the channels read (A-28.7)", () => {
  let w: CommerceWorld | null = null;
  afterEach(() => {
    w?.close();
    w = null;
  });
  const OTHER = "gg.other.app";
  const MISMATCHED = {
    appStore: { bundleId: OTHER, appAppleId: 1234567890, acceptSandbox: true },
    play: SETTINGS.play,
    steam: SETTINGS.steam,
  };

  function grant(sub: string, areas: string[]) {
    SYNTHETIC.set(sub, {
      memberId: sub,
      grants: [
        {
          role: "product_admin",
          scope: `product:${WORLD_SLUG}`,
          areas,
          source: "grant",
        },
      ],
    } as Principal);
  }

  async function channels(cw: CommerceWorld, sub = "u1") {
    const res = await admin(
      "GET",
      `/products/${WORLD_SLUG}/distribution/channels`,
      ["platform-admins"],
      sub,
      cw.db,
    );
    return { status: res.status, body: await res.json() };
  }

  async function world() {
    w = await commerceWorld({ settings: MISMATCHED });
    env = w.env;
    await w.db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, 'o-apple', 'app-store', ?, ?, ?)`,
      WORLD_SLUG,
      JSON.stringify({ bundleId: "gg.declared.app" }),
      NOW,
      NOW,
    );
    return w;
  }

  it("shows the mismatch on both facets, with the identity in force", async () => {
    const cw = await world();
    const { status, body } = await channels(cw);
    expect(status).toBe(200);
    const apple = row(body, "app-store");
    expect(apple.identity).toEqual({
      fields: { bundleId: OTHER },
      source: "typed",
    });
    expect(apple.commerce).toMatchObject({
      state: "attention",
      attention: [{ code: "identity_mismatch" }],
    });
    expect(apple.delivery.state).toBe("attention");
    expect(apple.delivery.attention).toContainEqual({
      code: "identity_mismatch",
      field: "bundleId",
    });
    // The assigned app and the declared value never ride the attention.
    expect(JSON.stringify(apple.delivery.attention)).not.toContain(BUNDLE_ID);
    expect(JSON.stringify(apple.delivery.attention)).not.toContain(
      "gg.declared.app",
    );
    // A channel that is not a store has no identity.
    expect(row(body, "winget")?.identity ?? null).toBeNull();
  });

  it("holds the pins back from a session without the commerce area", async () => {
    const cw = await world();
    grant("m-ship", ["ship"]);
    const { status, body } = await channels(cw, "m-ship");
    expect(status).toBe(200);
    for (const c of body.channels) expect(c.identity).toBeNull();
    const apple = row(body, "app-store");
    expect(apple.commerce.attention).toEqual([]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(BUNDLE_ID);
    // The delivery attention (ship) still shows, as a code and a field name.
    expect(apple.delivery.attention).toContainEqual({
      code: "identity_mismatch",
      field: "bundleId",
    });
    // A member with commerce but not ship cannot read the route at all.
    grant("m-commerce", ["commerce"]);
    expect((await channels(cw, "m-commerce")).status).toBe(403);
  });
});
