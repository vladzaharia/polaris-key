/**
 * P2-11: `GET /manage/api/products/:slug/distribution/updaters`, through the real admin
 * dispatcher: the area gate, the 404, and a product's shipped platforms mapped to their updaters.
 * The Verified rules are `updaterModel.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { NOW, seedProduct } from "../../seed.js";
import { CONSOLE, enableServices, envFor } from "../../releaseRoutesFixture.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
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

const read = () => admin("GET", `/products/${SLUG}/distribution/updaters`);

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

describe("the updaters read (P2-11)", () => {
  it("a member narrowed to the license area is refused with 403 for the ship area", async () => {
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
      `/products/${SLUG}/distribution/updaters`,
      ["platform-admins"],
      "u-license",
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.area).toBe("ship");
  });

  it("an unknown product is a 404 and a write is refused", async () => {
    expect(
      (await admin("GET", "/products/nope/distribution/updaters")).status,
    ).toBe(404);
    expect(
      (await admin("POST", `/products/${SLUG}/distribution/updaters`)).status,
    ).toBe(405);
  });

  it("a product that ships nothing yet has no platform cards, and a planned platform has none", async () => {
    await planned(["windows"]);
    const res = await read();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product).toBe(SLUG);
    expect(body.platforms).toEqual([]);
  });

  it("a platform a direct outlet names gets its updaters and is not seen until a device reports", async () => {
    await outlet("direct", "direct", { platforms: ["windows"] });
    const body = await (await read()).json();
    expect(body.platforms).toHaveLength(1);
    const [win] = body.platforms;
    expect(win.platform).toBe("windows");
    expect(win.updaters).toEqual([
      "winsparkle",
      "velopack",
      "app-installer",
      "godot",
      "signed-feed",
    ]);
    // No UPDATE_HEALTH binding in the test env, so there is no data, never "not seen".
    expect(win.state).toBe("unavailable");
    expect(win.checks).toBe(0);
  });
});
