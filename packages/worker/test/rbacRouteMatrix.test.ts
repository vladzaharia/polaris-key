/**
 * The route × principal matrix (ST-29; ST-28 plan §6, security checklist item 1): EVERY row of the
 * admin route table, driven through the real dispatcher with each of the eight synthetic
 * principals (`rbacFixtures.ts`), against a hand-written oracle. The oracle is a table of names
 * written out below, never `can()`'s own matrix, so a wrong rule in `can()` and a wrong area in
 * the route table both fail here.
 *
 * ST-29 mints only the root principal from a real session (the platform admin group). To drive the
 * others through the same dispatcher, the principal resolver is replaced for subjects this test
 * names; any other subject still resolves through the real root rule.
 *
 * Negative controls, beside the matrix: no session (401), a member without a role (403 before any
 * route), the wrong area (the narrowed admin on every non-Ship route), a step-up that is missing or
 * expired (403 `step_up_required` on every step-up row), and a mutation without the CSRF token
 * (403 on every mutating row).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { Principal } from "../src/core/rbac/can.js";
import { handleAdminApi } from "../src/console/api.js";
import { STEP_UP_ROUTES } from "../src/console/stepUp.js";
import { ADMIN_ROUTES, isProductRoute } from "../src/console/routes.js";
import { routeKey, type Method } from "../src/console/routeMatch.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import {
  PRINCIPAL_NAMES,
  PRINCIPALS,
  type PrincipalName,
} from "./rbacFixtures.js";

// ── The principal seam ──────────────────────────────────────────────────────────────────────

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

for (const name of PRINCIPAL_NAMES) {
  const p = PRINCIPALS[name];
  if (p) SYNTHETIC.set(p.memberId, p);
}

// ── The oracle (hand-written) ───────────────────────────────────────────────────────────────

const MEMBERS: PrincipalName[] = [
  "consoleOnly",
  "alphaAdmin",
  "alphaShip",
  "allProducts",
  "platformAdmin",
  "root",
];

/** Platform-scope rows: who may call a row of each area. */
const PLATFORM_ORACLE: Partial<Record<AreaId, PrincipalName[]>> = {
  console: MEMBERS,
  platform: ["platformAdmin", "root"],
  members: ["platformAdmin", "root"],
  docs: ["platformAdmin", "root"],
};

const ALPHA_FULL: PrincipalName[] = ["alphaAdmin", "allProducts", "root"];
const ALPHA_SHIP: PrincipalName[] = [
  "alphaAdmin",
  "alphaShip",
  "allProducts",
  "root",
];

/** Rows on the ordinary product `alpha`, by area. */
const ALPHA_ORACLE: Partial<Record<AreaId, PrincipalName[]>> = {
  core: ALPHA_FULL,
  license: ALPHA_FULL,
  config: ALPHA_FULL,
  signin: ALPHA_FULL,
  sync: ALPHA_FULL,
  keys: ALPHA_FULL,
  settings: ALPHA_FULL,
  members: ALPHA_FULL,
  ship: ALPHA_SHIP,
  commerce: ALPHA_SHIP,
};

/** Every row on the system product is the platform's: Platform admin and Superadmin only. */
const SYSTEM_ORACLE: PrincipalName[] = ["platformAdmin", "root"];

/** The keys the two `byKey` rows are driven with, and the area each key has. */
const BY_KEY: Record<string, { key: string; area: AreaId }> = {
  "/products/:slug/settings/:key": {
    key: "licensing.anchorPolicy",
    area: "license",
  },
  "/products/:slug/claims/:key": { key: "core.web.origins", area: "keys" },
};

// ── Driving the dispatcher ──────────────────────────────────────────────────────────────────

const ADMIN_GROUP = "admins";
let env: Env;
let db: Db;

beforeAll(async () => {
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, SYSTEM_PRODUCT_SLUG);
  await db.run(
    "UPDATE products SET system = 1 WHERE slug = ?",
    SYSTEM_PRODUCT_SLUG,
  );
  // No row may reach the network: an allowed handler that calls out gets a refusal.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("offline", { status: 599 })),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function freshEnv(): Env {
  const e = makeEnv(new KvMock(), ["alpha"]);
  e.ADMIN_SESSION_SECRET = "matrix-admin-secret";
  e.PLATFORM_ADMIN_GROUP = ADMIN_GROUP;
  return e;
}

/** A concrete request path for a row, on `slug` for a product row. */
function concrete(path: string, slug: string): string {
  const byKey = BY_KEY[path];
  return path
    .replace(":slug", slug)
    .replace(":key", byKey?.key ?? "probe-key")
    .replace(/:[a-zA-Z]+/g, "x1")
    .replace("/**", "/probe");
}

/** The area the oracle reads for a row; the product record's refusal names `core`. */
function oracleArea(route: { path: string; area: string }): AreaId {
  if (route.area === "anyArea") return "core";
  return route.area === "byKey"
    ? BY_KEY[route.path]!.area
    : (route.area as AreaId);
}

/** Who may read the product record on `alpha`: anyone holding any of its areas. */
const ALPHA_ANY: PrincipalName[] = ALPHA_SHIP;

interface Outcome {
  status: number;
  code?: string;
  reason?: string;
  area?: string;
  scope?: string;
}

async function call(
  e: Env,
  name: PrincipalName,
  method: Method,
  path: string,
  opts: { csrf?: boolean; stepUpAt?: number } = {},
): Promise<Outcome> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const p = PRINCIPALS[name];
  if (p) {
    const { token, session } = await issueSession(
      e,
      {
        sub: p.memberId,
        name: name,
        email: `${name}@example.test`,
        groups: [],
        ...(opts.stepUpAt !== undefined
          ? { authTime: opts.stepUpAt, stepUp: true }
          : {}),
      },
      opts.stepUpAt ?? NOW,
    );
    headers.cookie = `${ADMIN_COOKIE}=${token}`;
    if (opts.csrf !== false) headers[CSRF_HEADER] = session.csrf;
  }
  const res = await handleAdminApi(
    new Request(`https://key.plrs.im/manage/api${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: "{}" }),
    }),
    e,
    db,
    `/api${path}`,
    NOW,
  );
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    error?: { code?: string; reason?: string; area?: string; scope?: string };
  };
  return {
    status: res.status,
    code: body.error?.code ?? body.code,
    reason: body.error?.reason,
    area: body.error?.area,
    scope: body.error?.scope,
  };
}

const isNoAccess = (o: Outcome) => o.status === 403 && o.reason === "no_access";

// ── The matrix ──────────────────────────────────────────────────────────────────────────────

// Logout revokes the member's sessions server-side, so it is driven last.
const PLATFORM_ROWS = ADMIN_ROUTES.filter((r) => !isProductRoute(r)).sort(
  (a, b) => Number(a.path === "/logout") - Number(b.path === "/logout"),
);
const PRODUCT_ROWS = ADMIN_ROUTES.filter((r) => isProductRoute(r));

describe("the route × principal matrix", () => {
  it("covers every row of the route table", () => {
    expect(PLATFORM_ROWS.length + PRODUCT_ROWS.length).toBe(
      ADMIN_ROUTES.length,
    );
    expect(ADMIN_ROUTES.length).toBeGreaterThan(100);
    // Every area a row names has an oracle row.
    for (const r of PLATFORM_ROWS)
      expect(PLATFORM_ORACLE[oracleArea(r)], routeKey(r)).toBeDefined();
    for (const r of PRODUCT_ROWS)
      expect(ALPHA_ORACLE[oracleArea(r)], routeKey(r)).toBeDefined();
  });

  for (const name of PRINCIPAL_NAMES) {
    it(`platform rows, as ${name}`, async () => {
      const e = freshEnv();
      const wrong: string[] = [];
      for (const r of PLATFORM_ROWS) {
        const o = await call(e, name, r.method, concrete(r.path, "alpha"));
        const allowed = PLATFORM_ORACLE[oracleArea(r)]!.includes(name);
        const what = `${routeKey(r)} → ${o.status} ${o.code ?? ""} ${o.reason ?? ""}`;
        if (name === "none") {
          if (o.status !== 401) wrong.push(what);
        } else if (name === "stranger") {
          if (!isNoAccess(o) || o.area !== "console") wrong.push(what);
        } else if (allowed) {
          if (o.status === 401 || isNoAccess(o)) wrong.push(what);
          else if (r.stepUp && o.code !== "step_up_required") wrong.push(what);
        } else if (
          !isNoAccess(o) ||
          o.area !== oracleArea(r) ||
          o.scope !== "platform"
        )
          wrong.push(what);
      }
      expect(wrong).toEqual([]);
    }, 120_000);

    for (const [slug, oracle] of [
      [
        "alpha",
        (r: (typeof PRODUCT_ROWS)[number]) =>
          r.area === "anyArea" ? ALPHA_ANY : ALPHA_ORACLE[oracleArea(r)]!,
      ],
      [SYSTEM_PRODUCT_SLUG, () => SYSTEM_ORACLE],
    ] as const) {
      it(`product rows on ${slug}, as ${name}`, async () => {
        const e = freshEnv();
        const wrong: string[] = [];
        for (const r of PRODUCT_ROWS) {
          const o = await call(e, name, r.method, concrete(r.path, slug));
          const allowed = oracle(r).includes(name);
          const what = `${routeKey(r)} → ${o.status} ${o.code ?? ""} ${o.reason ?? ""} ${o.area ?? ""}`;
          if (name === "none") {
            if (o.status !== 401) wrong.push(what);
          } else if (name === "stranger") {
            if (!isNoAccess(o) || o.area !== "console") wrong.push(what);
          } else if (allowed) {
            if (o.status === 401 || isNoAccess(o)) wrong.push(what);
            else if (r.stepUp && o.code !== "step_up_required")
              wrong.push(what);
          } else if (
            !isNoAccess(o) ||
            o.area !== oracleArea(r) ||
            o.scope !== `product:${slug}`
          )
            wrong.push(what);
        }
        expect(wrong).toEqual([]);
      }, 180_000);
    }
  }
});

// ── Negative controls ───────────────────────────────────────────────────────────────────────

describe("negative controls", () => {
  it("a narrowed admin is refused every area of its product but the two it holds (and the record)", async () => {
    const e = freshEnv();
    let refused = 0;
    for (const r of PRODUCT_ROWS) {
      const area = oracleArea(r);
      if (area === "ship" || area === "commerce" || r.area === "anyArea")
        continue;
      const o = await call(e, "alphaShip", r.method, concrete(r.path, "alpha"));
      expect(isNoAccess(o), routeKey(r)).toBe(true);
      expect(o.area, routeKey(r)).toBe(area);
      refused++;
    }
    expect(refused).toBeGreaterThan(50);
  }, 120_000);

  it("every mutating row refuses a request without the CSRF token, before it is matched or authorized", async () => {
    const e = freshEnv();
    for (const r of ADMIN_ROUTES.filter((x) => x.method !== "GET")) {
      const o = await call(e, "root", r.method, concrete(r.path, "alpha"), {
        csrf: false,
      });
      expect(o.status, routeKey(r)).toBe(403);
      expect(o.reason, routeKey(r)).toBeUndefined();
    }
  }, 120_000);

  it("every step-up row refuses a missing or expired step-up, and admits a fresh one", async () => {
    const steps = ADMIN_ROUTES.filter((r) => r.stepUp);
    expect(steps.map(routeKey).sort()).toEqual(
      [
        "DELETE /products/:slug",
        "POST /products/kek",
        "POST /platform/override-migration/run",
        "GET /products/:slug/users/:subject/export",
        "POST /products/:slug/users/:subject/data/delete",
        "POST /products/:slug/users/:subject/licenses/:id/detach",
        "POST /products/:slug/users/:subject/licenses/:id/relink",
        "POST /products/:slug/users/licenses/:id/make-floating",
        "POST /products/:slug/users/licenses/:id/reassign",
        "POST /products/:slug/users/relinks/:id/undo",
      ].sort(),
    );
    for (const r of steps) {
      const path = concrete(r.path, "alpha");
      const e = freshEnv();
      const missing = await call(e, "root", r.method, path);
      expect(missing.code, routeKey(r)).toBe("step_up_required");
      // A step-up six minutes old is past the five-minute window.
      const stale = await call(e, "root", r.method, path, {
        stepUpAt: NOW - 6 * 60,
      });
      expect(stale.code, routeKey(r)).toBe("step_up_required");
      const fresh = await call(e, "root", r.method, path, { stepUpAt: NOW });
      expect(fresh.code, routeKey(r)).not.toBe("step_up_required");
      expect(isNoAccess(fresh), routeKey(r)).toBe(false);
    }
  }, 120_000);

  it("enforces exactly the step-up routes STEP_UP_ROUTES lists, but the body-conditional one", () => {
    const listed = STEP_UP_ROUTES.flatMap((r) => {
      if (r.path.endsWith(" (breakGlass)")) return [];
      const alt = /\(([a-z|-]+)\)$/.exec(r.path);
      return alt
        ? alt[1]!
            .split("|")
            .map((v) => `${r.method} ${r.path.replace(alt[0], v)}`)
        : [`${r.method} ${r.path}`];
    });
    expect(
      ADMIN_ROUTES.filter((r) => r.stepUp)
        .map(routeKey)
        .sort(),
    ).toEqual(listed.sort());
  });

  it("a session the real resolver roots (the platform group) is a Superadmin; dropping the group drops it", async () => {
    const e = freshEnv();
    const mint = async (groups: string[]) => {
      const { token } = await issueSession(
        e,
        { sub: "op-real", name: "Op", email: "op@example.test", groups },
        NOW,
      );
      return handleAdminApi(
        new Request("https://key.plrs.im/manage/api/platform/version", {
          headers: { cookie: `${ADMIN_COOKIE}=${token}` },
        }),
        e,
        db,
        "/api/platform/version",
        NOW,
      );
    };
    expect((await mint([ADMIN_GROUP])).status).toBe(200);
    expect((await mint(["staff"])).status).toBe(403);
  });

  it("answers an unknown path 404 and a known path with the wrong method 405 with Allow", async () => {
    const e = freshEnv();
    const nope = await call(e, "root", "GET", "/products/alpha/nope");
    expect(nope.status).toBe(404);
    const { token, session } = await issueSession(
      e,
      { sub: "m-root", name: "r", email: "r@x", groups: [] },
      NOW,
    );
    const res = await handleAdminApi(
      new Request(
        "https://key.plrs.im/manage/api/products/alpha/trust-policy",
        {
          method: "POST",
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
          },
          body: "{}",
        },
      ),
      e,
      db,
      "/api/products/alpha/trust-policy",
      NOW,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT, DELETE");
  });

  it("answers no session 401, and an expired one too", async () => {
    const e = freshEnv();
    expect((await call(e, "none", "GET", "/me")).status).toBe(401);
    const { token } = await issueSession(
      e,
      { sub: "m-root", name: "r", email: "r@x", groups: [] },
      NOW - 9 * 60 * 60,
    );
    const res = await handleAdminApi(
      new Request("https://key.plrs.im/manage/api/me", {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
      e,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(401);
  });
});
