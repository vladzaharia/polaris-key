/**
 * What the console SPA reads to decide what to show (ST-29): `/me.permissions` (`useCan`'s one
 * source) and `GET /access/admins` (NoAccessPage's "who can give you access"). Both are views of
 * `can()`; neither authorizes anything, and the matrix test proves every route checks on its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import type { Principal } from "../src/core/rbac/can.js";
import { handleAdminApi } from "../src/console/api.js";
import { ADMIN_COOKIE, issueSession } from "../src/core/console/session.js";
import { appendPlatformAudit } from "../src/core/repo.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { PRINCIPALS } from "./rbacFixtures.js";

const SYNTHETIC = new Map<string, Principal>();
vi.mock("../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/core/rbac/principal.js")>();
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
  const { token } = await issueSession(
    env,
    { sub, name: sub, email: `${sub}@example.test`, groups },
    NOW,
  );
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

  it("shows Console access no product, and the product list and summary agree", async () => {
    const who = PRINCIPALS.consoleOnly.memberId;
    const me = await get(who, "/me");
    expect(me.body.products).toEqual([]);
    expect((me.body.permissions as never)["products"]).toEqual({});
    expect((await get(who, "/products")).body.products).toEqual([]);
    // Home's summary is keyed by slug.
    expect((await get(who, "/summary")).body.products).toEqual({});
    // A member who holds a product sees it in all three.
    const alpha = PRINCIPALS.alphaAdmin.memberId;
    expect(
      ((await get(alpha, "/products")).body.products as { slug: string }[]).map(
        (p) => p.slug,
      ),
    ).toEqual(["alpha"]);
  });

  it("refuses a session that resolves to no grant, /me included", async () => {
    const r = await get("nobody", "/me", ["staff"]);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      error: { code: "forbidden", reason: "no_access", area: "console" },
    });
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

  it("names up to three Superadmins who signed in within the session lifetime, latest first, never the caller", async () => {
    await signedIn("op-a", NOW - 60, {
      name: "Ana",
      email: "ana@example.test",
    });
    await signedIn("op-b", NOW - 120, {
      name: "Ben",
      email: "ben@example.test",
    });
    await signedIn("op-c", NOW - 180, { name: "Cy", email: "cy@example.test" });
    await signedIn("op-d", NOW - 240, {
      name: "Dee",
      email: "dee@example.test",
    });
    // Signed in 9 h ago: past the root rule's freshness.
    await signedIn("op-old", NOW - 9 * 3600, {
      name: "Old",
      email: "old@example.test",
    });
    // Signed in, but no audited action names them: not listed.
    await signedIn("op-quiet", NOW - 30);
    const r = await get(
      PRINCIPALS.alphaShip.memberId,
      "/access/admins?scope=product:alpha&area=license",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      scope: "product:alpha",
      area: "license",
      admins: [
        { name: "Ana", email: "ana@example.test", role: "superadmin" },
        { name: "Ben", email: "ben@example.test", role: "superadmin" },
        { name: "Cy", email: "cy@example.test", role: "superadmin" },
      ],
    });
    // The body names people, never a subject.
    expect(JSON.stringify(r.body)).not.toMatch(/op-[a-z]/);
    // The caller is never on their own list.
    await signedIn(PRINCIPALS.root.memberId, NOW - 10, {
      name: "Me",
      email: "me@example.test",
    });
    const self = await get(PRINCIPALS.root.memberId, "/access/admins");
    expect(
      (self.body.admins as { email: string }[]).map((a) => a.email),
    ).not.toContain("me@example.test");
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
