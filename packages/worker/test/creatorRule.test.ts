import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  LIVE_CHECK_SECONDS,
} from "../src/core/console/session.js";
import {
  newBindingId,
  stmtDeleteBinding,
  stmtInsertBinding,
} from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import { tokenSession } from "../src/console/apiTokens.js";
import { importHmacKey } from "../src/platform/hash.js";
import { signHmacToken } from "../src/platform/hmacToken.js";
import { resolvePrincipal } from "../src/core/rbac/principal.js";

const GROUP = "platform-admins";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { withDefaultHead } from "./githubHead.js";
import { grantCreator } from "../src/console/creatorGrant.js";

const ISSUER = "https://id.example";

type Db = ReturnType<typeof makeTestDb>;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  return env;
}

interface Person {
  token: string;
  accountId: string;
  csrf: string;
}

/** Sign in through the real gate (as a root group member), then drop the stored groups. */
async function person(
  env: Env,
  db: Db,
  who: string,
  opts: { keepRoot?: boolean; stepUp?: boolean } = {},
): Promise<Person> {
  const start = await handleAdminLogin(
    new Request(
      "https://key.plrs.im/manage/login?go=1" +
        (opts.stepUp ? "&stepUp=1" : ""),
    ) as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: `idp-${who}`,
      email: `${who}@example.com`,
      emailVerified: true,
      name: who,
      groups: [GROUP],
      ...(opts.stepUp ? { authTime: NOW } : {}),
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    NOW,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string; csrf: string };
  if (!opts.keepRoot) {
    await db.run(
      "UPDATE account_links SET groups_json = '[]' WHERE account_id = ?",
      claims.aid,
    );
  }
  return { token, accountId: claims.aid, csrf: claims.csrf };
}

async function bind(
  db: Db,
  accountId: string | null,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
  extra: { emailNorm?: string; source?: "grant" | "invite" } = {},
): Promise<string> {
  const id = newBindingId();
  const s = stmtInsertBinding({
    id,
    accountId,
    emailNorm: extra.emailNorm ?? null,
    role,
    scope,
    areas,
    source: extra.source ?? "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
    ...(accountId === null ? { expiresAt: NOW + 3600 } : {}),
  });
  await db.run(s.sql, ...s.params);
  return id;
}

async function call(
  env: Env,
  db: Db,
  p: Person,
  method: string,
  path: string,
  now = NOW + 1,
  body?: unknown,
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${p.token}`,
        ...(method !== "GET" ? { [CSRF_HEADER]: p.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

function creatorEnv(): { env: Env; mail: { to: string; subject: string }[] } {
  const e = adminEnv();
  const mail: { to: string; subject: string }[] = [];
  e.EMAIL = {
    send: async (m: { to: string; subject: string }) => {
      mail.push(m);
    },
  } as unknown as Env["EMAIL"];
  e.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  e.GITHUB_APP_ID = "12345";
  e.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return { env: e, mail };
}

let env: Env;
let db: Db;
let mail: { to: string; subject: string }[];

beforeEach(async () => {
  resetConsoleSessionCache();
  ({ env, mail } = creatorEnv());
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, SYSTEM_PRODUCT_SLUG);
  await db.run(
    "UPDATE products SET system = 1 WHERE slug = ?",
    SYSTEM_PRODUCT_SLUG,
  );
});
afterEach(() => vi.unstubAllGlobals());

const creatorRows = (slug: string) =>
  db.all<{
    account_id: string;
    role: string;
    scope: string;
    areas_json: string | null;
    source: string;
  }>(
    "SELECT account_id, role, scope, areas_json, source FROM console_role_bindings WHERE source = 'creator' AND scope = ?",
    `product:${slug}`,
  );

const create = (p: Person, slug: string) =>
  call(env, db, p, "POST", "/api/products", NOW + 1, { slug, name: slug });

describe("G6: a creator manages what they made", () => {
  it("a Platform admin who creates a product gets product_admin on it alone, audited on both trails", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    // Before: platform admin reaches no product area of the new slug.
    expect((await create(ann, "gamma")).status).toBe(201);
    expect(await creatorRows("gamma")).toEqual([
      {
        account_id: ann.accountId,
        role: "product_admin",
        scope: "product:gamma",
        areas_json: null,
        source: "creator",
      },
    ]);
    // Reaches every area of gamma ...
    expect(
      allowed(
        await call(
          env,
          db,
          ann,
          "GET",
          "/api/products/gamma/distribution/feeds",
        ),
      ),
    ).toBe(true);
    expect(
      allowed(
        await call(env, db, ann, "GET", "/api/products/gamma/license/licenses"),
      ),
    ).toBe(true);
    // ... and nothing else: not alpha, not the system product, no widening of platform rights.
    expect(
      (await call(env, db, ann, "GET", "/api/products/alpha/license/licenses"))
        .status,
    ).toBe(403);
    expect(
      await db.all(
        "SELECT 1 FROM console_role_bindings WHERE account_id = ?",
        ann.accountId,
      ),
    ).toHaveLength(2);
    expect(
      await db.all(
        "SELECT 1 FROM console_role_bindings WHERE scope IN ('products:*', ?)",
        `product:${SYSTEM_PRODUCT_SLUG}`,
      ),
    ).toHaveLength(0);
    // Audited on the platform trail and the product's, naming a member id and never the account id.
    const plat = await db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM platform_audit WHERE action = 'rbac.grant'",
    );
    const prod = await db.all<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = 'gamma' AND action = 'rbac.grant'",
    );
    expect(plat).toHaveLength(1);
    expect(prod).toHaveLength(1);
    expect(JSON.stringify([plat, prod])).not.toContain(ann.accountId);
    expect(plat[0]!.summary).toMatch(
      /^Gave the creator Product admin on product:gamma: mbr_/,
    );
  });

  it("a person who is not the creator gets nothing from it", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "platform_admin", "platform", null);
    await create(ann, "gamma");
    expect(
      (await call(env, db, bob, "GET", "/api/products/gamma/license/licenses"))
        .status,
    ).toBe(403);
    expect(
      await db.all(
        "SELECT 1 FROM console_role_bindings WHERE account_id = ?",
        bob.accountId,
      ),
    ).toHaveLength(1);
  });

  it("a Superadmin creator gets no binding (already covered)", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    expect((await create(root, "gamma")).status).toBe(201);
    expect(await creatorRows("gamma")).toEqual([]);
    expect(
      await db.all("SELECT 1 FROM platform_audit WHERE action = 'rbac.grant'"),
    ).toHaveLength(0);
    expect(mail).toEqual([]);
  });

  it("an existing products:* grant covers it, so no row is written", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    await bind(db, ann.accountId, "product_admin", "products:*", null);
    expect((await create(ann, "gamma")).status).toBe(201);
    expect(await creatorRows("gamma")).toEqual([]);
  });

  it("an existing narrowed grant on the slug is neither widened nor duplicated", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    await bind(db, ann.accountId, "product_admin", "product:gamma", ["ship"]);
    expect((await create(ann, "gamma")).status).toBe(201);
    expect(await creatorRows("gamma")).toEqual([]);
    const rows = await db.all<{ areas_json: string }>(
      "SELECT areas_json FROM console_role_bindings WHERE scope = 'product:gamma'",
    );
    expect(rows).toEqual([{ areas_json: '["ship"]' }]);
  });

  it("a plain console member cannot create, and so gets nothing", async () => {
    const cat = await person(env, db, "cat");
    await bind(db, cat.accountId, "console_access", "platform", null);
    expect((await create(cat, "gamma")).status).toBe(403);
    expect(await creatorRows("gamma")).toEqual([]);
  });

  it("a session with no account (token, v1 cookie, break-glass) never gets a binding", async () => {
    const ann = await person(env, db, "ann");
    const bare = {
      sub: "mbr_x",
      aid: undefined,
      principal: {
        memberId: `mbr_${"a".repeat(22)}`,
        grants: [
          {
            role: "platform_admin",
            scope: "platform",
            areas: null,
            source: "root",
          },
        ],
      },
    };
    expect(
      await grantCreator(env, db, bare as never, "gamma", "Gamma", NOW),
    ).toBe("skipped");
    expect(await creatorRows("gamma")).toEqual([]);
    void ann;
  });

  it("never writes for the system product", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    const session = {
      aid: ann.accountId,
      principal: {
        memberId: `mbr_${"a".repeat(22)}`,
        grants: [
          {
            role: "platform_admin",
            scope: "platform",
            areas: null,
            source: "grant",
          },
        ],
      },
    };
    expect(
      await grantCreator(
        env,
        db,
        session as never,
        SYSTEM_PRODUCT_SLUG,
        null,
        NOW,
      ),
    ).toBe("skipped");
    expect(await creatorRows(SYSTEM_PRODUCT_SLUG)).toEqual([]);
  });

  it("an erased account (the ledger) gets nothing", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    const session = {
      aid: ann.accountId,
      principal: {
        memberId: `mbr_${"a".repeat(22)}`,
        grants: [
          {
            role: "platform_admin",
            scope: "platform",
            areas: null,
            source: "grant",
          },
        ],
      },
    };
    const ledger = await import("../src/core/accounts/erasureFence.js");
    const spy = vi.spyOn(ledger, "erasureVerdict").mockResolvedValue("erased");
    expect(
      await grantCreator(env, db, session as never, "gamma", null, NOW),
    ).toBe("skipped");
    spy.mockRestore();
    expect(await creatorRows("gamma")).toEqual([]);
  });

  it("tells every other Superadmin, never the creator", async () => {
    const root = await person(env, db, "root", { keepRoot: true });
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    await create(ann, "gamma");
    const to = mail.map((m) => m.to);
    expect(to).toContain("root@example.com");
    expect(to).not.toContain("ann@example.com");
    void root;
  });

  it("link-repo gives the creator the same binding", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    vi.stubGlobal("fetch", linkFetch());
    const res = await call(
      env,
      db,
      ann,
      "POST",
      "/api/products/link-repo",
      NOW + 1,
      {
        repoUrl: "acme/tonebox",
      },
    );
    expect(res.status).toBe(201);
    expect(await creatorRows("tonebox")).toHaveLength(1);
    expect(
      allowed(
        await call(
          env,
          db,
          ann,
          "GET",
          "/api/products/tonebox/distribution/feeds",
        ),
      ),
    ).toBe(true);
    // A dry run writes nothing.
    vi.stubGlobal("fetch", linkFetch());
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "platform_admin", "platform", null);
    await call(
      env,
      db,
      bob,
      "POST",
      "/api/products/link-repo?dryRun=1",
      NOW + 1,
      { repoUrl: "acme/tonebox" },
    );
    expect(
      await db.all(
        "SELECT 1 FROM console_role_bindings WHERE account_id = ? AND source = 'creator'",
        bob.accountId,
      ),
    ).toHaveLength(0);
  });

  it("a refused create writes no binding", async () => {
    const ann = await person(env, db, "ann");
    await bind(db, ann.accountId, "platform_admin", "platform", null);
    expect((await create(ann, "alpha")).status).toBe(409);
    expect((await create(ann, "kek")).status).toBe(422);
    expect(await creatorRows("alpha")).toEqual([]);
  });
});

// ── link-repo fixtures (as createDefaults.test.ts) ──────────────────────────────────────────
function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}
function linkFetch() {
  const files: Record<string, string> = {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": JSON.stringify({
      slug: "tonebox",
      name: "Tonebox",
      compatMin: "1.0.0",
      compatMax: "9.0.0",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
      tiers: [],
      provisioning: [],
    }),
  };
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation") && !url.includes("/installations/"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, text] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(text);
      return new Response("nf", { status: 404 });
    }
    if (/\/repos\/acme\/tonebox$/.test(url))
      return new Response(
        JSON.stringify({ id: 77, full_name: "acme/tonebox", owner: { id: 9 } }),
        { status: 200 },
      );
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("nf", { status: 404 });
  });
}

// Reached the handler: not refused (401/403), not a missing route (404) and not a crash (500).
const allowed = (res: Response) => ![401, 403, 404, 500].includes(res.status);
