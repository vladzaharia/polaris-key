/**
 * What the console SPA reads to decide what to show (ST-29): `/me.permissions` (`useCan`'s one
 * source) and `GET /access/admins` (NoAccessPage's "who can give you access"). Both are views of
 * `can()`; neither authorizes anything, and the matrix test proves every route checks on its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import type { Principal } from "../../../src/core/rbac/can.js";
import { handleAdminApi } from "../../../src/console/api.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { appendPlatformAudit } from "../../../src/core/audit.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import { PRINCIPALS } from "../../rbacFixtures.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";

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
    ) => SYNTHETIC.get(args[2].sub) ?? real.resolvePrincipal(...args),
  };
});
for (const p of Object.values(PRINCIPALS)) if (p) SYNTHETIC.set(p.memberId, p);

let env: Env;
let db: Db;

beforeEach(async () => {
  env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "access-test-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
});

async function get(
  sub: string,
  path: string,
  groups: string[] = [],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub, name: sub, email: `${sub}@example.test`, groups },
    NOW,
  );
  // The console resolves the member id from the account; the seam is keyed by it.
  const synthetic = SYNTHETIC.get(sub);
  if (synthetic) SYNTHETIC.set(session.sub, synthetic);
  const res = await handleAdminApi(
    new Request(`https://key.plrs.im/manage/api${path}`, {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    env,
    db,
    `/api${path}`,
    NOW,
  );
  return { status: res.status, body: (await res.json()) as never };
}

const PRODUCT_TEN = [
  "members",
  "core",
  "license",
  "config",
  "ship",
  "signin",
  "sync",
  "commerce",
  "keys",
  "settings",
];

describe("/me.permissions", () => {
  it("gives today's operator (the root rule) every platform area and all ten areas of every product", async () => {
    const r = await get("op", "/me", ["admins"]);
    expect(r.status).toBe(200);
    expect(r.body.platformAdmin).toBe(true);
    expect(r.body.permissions).toEqual({
      roles: [
        { role: "superadmin", scope: "platform", areas: null, source: "root" },
      ],
      platform: {
        view: ["console", "platform", "members", "docs"],
        edit: ["console", "platform", "members", "docs"],
      },
      products: {
        alpha: { view: PRODUCT_TEN, edit: PRODUCT_TEN },
        beta: { view: PRODUCT_TEN, edit: PRODUCT_TEN },
      },
    });
    expect((r.body.products as { slug: string }[]).map((p) => p.slug)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("lists only the products a narrowed admin holds, with only its areas", async () => {
    const r = await get(PRINCIPALS.alphaShip.memberId, "/me");
    expect(r.status).toBe(200);
    expect(r.body.platformAdmin).toBe(false);
    expect((r.body.products as { slug: string }[]).map((p) => p.slug)).toEqual([
      "alpha",
    ]);
    expect(r.body.permissions).toMatchObject({
      platform: { view: ["console"], edit: ["console"] },
      products: {
        alpha: { view: ["ship", "commerce"], edit: ["ship", "commerce"] },
      },
    });
    expect(Object.keys((r.body.permissions as never)["products"])).toEqual([
      "alpha",
    ]);
  });

  it("shows Console access no product, and the product list and attention agree", async () => {
    const who = PRINCIPALS.consoleOnly.memberId;
    const me = await get(who, "/me");
    expect(me.body.products).toEqual([]);
    expect((me.body.permissions as never)["products"]).toEqual({});
    expect((await get(who, "/products")).body.products).toEqual([]);
    // Home's attention read lists nothing for a product the member does not hold.
    expect((await get(who, "/attention")).body.items).toEqual([]);
    // A member who holds a product sees it in all three.
    const alpha = PRINCIPALS.alphaAdmin.memberId;
    expect(
      ((await get(alpha, "/products")).body.products as { slug: string }[]).map(
        (p) => p.slug,
      ),
    ).toEqual(["alpha"]);
  });

  it("lets every holder of any of a product's areas read its record, and no one else", async () => {
    // The shell draws a product's chrome from it, so a Ship-builds-only admin needs it too.
    expect(
      (await get(PRINCIPALS.alphaShip.memberId, "/products/alpha")).status,
    ).toBe(200);
    expect(
      (await get(PRINCIPALS.alphaAdmin.memberId, "/products/alpha")).status,
    ).toBe(200);
    for (const who of [
      PRINCIPALS.consoleOnly.memberId,
      PRINCIPALS.alphaAdmin.memberId,
      PRINCIPALS.platformAdmin.memberId,
    ]) {
      const r = await get(who, "/products/beta");
      expect(r.status, who).toBe(403);
      expect(r.body).toMatchObject({
        error: { reason: "no_access", scope: "product:beta", area: "core" },
      });
    }
  });

  it("refuses a session that resolves to no grant everywhere but /me and /logout", async () => {
    const r = await get("nobody", "/products", ["staff"]);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      error: { code: "forbidden", reason: "no_access", area: "console" },
    });
    // Who they are, so the console can say so, and no product listed.
    const me = await get("nobody", "/me", ["staff"]);
    expect(me.status).toBe(200);
    expect(me.body.products).toEqual([]);
    expect(me.body.platformAdmin).toBe(false);
  });

  it("lets a session with no grant sign out, behind the CSRF check", async () => {
    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "nobody",
        name: "nobody",
        email: "n@example.test",
        groups: ["staff"],
      },
      NOW,
    );
    const post = (headers: Record<string, string>) =>
      handleAdminApi(
        new Request("https://key.plrs.im/manage/api/logout", {
          method: "POST",
          headers: { cookie: `${ADMIN_COOKIE}=${token}`, ...headers },
        }),
        env,
        db,
        "/api/logout",
        NOW,
      );
    expect((await post({})).status).toBe(403);
    expect((await post({ [CSRF_HEADER]: session.csrf })).status).toBe(200);
  });
});

describe("GET /access/admins", () => {
  async function signedIn(
    sub: string,
    at: number,
    named?: { name: string; email: string },
  ) {
    await appendPlatformAudit(db, {
      id: `paud_${sub}_${at}`,
      at,
      actor_sub: sub,
      actor_name: null,
      actor_email: null,
      action: "admin.signin",
      target_kind: null,
      target_id: null,
      summary: "Admin sign-in",
      before_json: null,
      after_json: null,
    });
    if (named)
      await appendPlatformAudit(db, {
        id: `paud_${sub}_${at}_act`,
        at: at + 1,
        actor_sub: sub,
        actor_name: named.name,
        actor_email: named.email,
        action: "platform.setting.set",
        target_kind: null,
        target_id: null,
        summary: "Changed a setting",
        before_json: null,
        after_json: null,
      });
  }

  it("names nobody for a synthetic principal when no account holds Superadmin (an audit sign-in is not a Superadmin)", async () => {
    await signedIn("op-a", NOW - 60, {
      name: "Ana",
      email: "ana@example.test",
    });
    const r = await get(
      PRINCIPALS.alphaShip.memberId,
      "/access/admins?scope=product:alpha&area=license",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      scope: "product:alpha",
      area: "license",
      incomplete: false,
      admins: [],
    });
  });

  it("answers a product that does not exist exactly as one that does (no slug oracle)", async () => {
    await signedIn("op-a", NOW - 60, {
      name: "Ana",
      email: "ana@example.test",
    });
    const who = PRINCIPALS.consoleOnly.memberId;
    const real = await get(who, "/access/admins?scope=product:alpha&area=core");
    const fake = await get(who, "/access/admins?scope=product:zzz&area=core");
    expect(fake.status).toBe(200);
    expect(fake.body.admins).toEqual(real.body.admins);
  });

  it("refuses a malformed scope or an area outside AREAS", async () => {
    const who = PRINCIPALS.consoleOnly.memberId;
    for (const q of [
      "scope=everything&area=core",
      "scope=product:Bad Slug&area=core",
      "scope=platform&area=billing",
    ]) {
      const r = await get(who, `/access/admins?${q}`);
      expect(r.status, q).toBe(400);
    }
  });
});
