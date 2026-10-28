/**
 * LX-33.6: every new licence gets a tier.
 *
 * `issueTierFor` answers the requested tier, else the product's implicit Default tier, else NULL
 * (release N only: the `license.limits-materialise` job has not seeded the tier yet, and the old
 * chain reads NULL and the implicit tier alike). Every `INSERT INTO licenses` goes through it;
 * a scan fails on a new insert site that does not.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../../seed.js";
import type { SqliteDb } from "../../../src/db/sqlite.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import {
  customerTierOf,
  issueTierFor,
} from "../../../src/core/licensing/implicitTier.js";
import { licenseDeviceLimit } from "../../../src/core/licensing/authz.js";
import { getLicense, getTier } from "../../../src/core/licensing/store.js";
import { issueAccountLicense } from "../../../src/core/licensing/issueAccount.js";
import { insertAccount } from "../../../src/services/identity/accounts/repo.js";
import { activateFromIdentity } from "../../../src/services/identity/oidc.js";
import { TEST_ROOT } from "../../paths.js";

const SLUG = "tonebox";
const GROUP = "admins";
const IDENTITY = {
  sub: "user-1",
  email: "ada@example.com",
  name: "Ada",
  groups: ["members"],
  claims: {},
};

let db: SqliteDb;
let env: Env;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

async function seedImplicit(): Promise<void> {
  await seedTier(db, SLUG, "default", { deviceLimit: 5 });
  await db.run(
    "UPDATE tiers SET label = 'Default', implicit = 1 WHERE product = ? AND id = 'default'",
    SLUG,
  );
}

async function product(): Promise<Product> {
  return (await loadProduct(env, db, SLUG))!;
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.KEY_HASH_PEPPER = "lx33-6-pepper";
  await seedProduct(db, SLUG);
  await seedTier(db, SLUG, "pro", { deviceLimit: 3 });
  // A group that maps to a role and no tier, so an entitled identity maps to none.
  await db.run(
    `INSERT INTO oidc_config (product, issuer, client_id, group_role_map_json, provider)
     VALUES (?, ?, ?, ?, 'platform')`,
    SLUG,
    "https://id.example",
    "client",
    JSON.stringify({ members: { role: "user" } }),
  );
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "op-1", name: "Op", email: "op@x.io", groups: [GROUP] },
    NOW,
  );
  call = async (method, path, body) => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      full,
      { now: NOW },
    );
  };
});

describe("issueTierFor", () => {
  it("answers the requested tier, else the implicit tier, else null", async () => {
    expect(await issueTierFor(db, SLUG, "pro")).toBe("pro");
    expect(await issueTierFor(db, SLUG, null)).toBeNull();
    await seedImplicit();
    expect(await issueTierFor(db, SLUG, null)).toBe("default");
    expect(await issueTierFor(db, SLUG, undefined)).toBe("default");
    expect(await issueTierFor(db, SLUG, "pro")).toBe("pro");
  });

  it("answers only its own product's implicit tier", async () => {
    await seedImplicit();
    await seedProduct(db, "other");
    expect(await issueTierFor(db, "other", null)).toBeNull();
  });
});

describe("every issuing path with no tier", () => {
  async function adminCreate(body: Record<string, unknown>) {
    const res = await call("POST", "/license/licenses", body);
    expect(res.status).toBe(201);
    const { license } = (await res.json()) as { license: { id: string } };
    return (await getLicense(db, SLUG, license.id))!;
  }

  it("admin create lands on the implicit tier, and renders as a tierless licence", async () => {
    await seedImplicit();
    const row = await adminCreate({ name: "A" });
    expect(row.tier_id).toBe("default");
    // The document is unchanged: no customer tier, and the same effective limit as a NULL tier.
    const tier = await getTier(db, SLUG, "default");
    expect(customerTierOf(row, tier)).toBeNull();
    const { licenseId: bare } = await seedLicenseWithKey(db, SLUG, {
      id: "lic_bare",
      tierId: null,
    });
    expect(await licenseDeviceLimit(db, await product(), row, NOW)).toEqual(
      await licenseDeviceLimit(
        db,
        await product(),
        (await getLicense(db, SLUG, bare))!,
        NOW,
      ),
    );
  });

  it("admin create names its own tier when it has one", async () => {
    await seedImplicit();
    expect((await adminCreate({ tier: "pro" })).tier_id).toBe("pro");
  });

  it("batch create takes the implicit tier when none is named", async () => {
    await seedImplicit();
    const res = await call("POST", "/license/batches", {
      label: "Keys",
      count: 2,
    });
    expect(res.status).toBe(201);
    const rows = await db.all<{ tier_id: string }>(
      "SELECT tier_id FROM licenses WHERE product = ? AND batch_id IS NOT NULL",
      SLUG,
    );
    expect(rows.map((r) => r.tier_id)).toEqual(["default", "default"]);
  });

  it("OIDC sign-in lands on the implicit tier", async () => {
    await seedImplicit();
    const made = await activateFromIdentity(db, await product(), IDENTITY, NOW);
    const id = (made as { licenseId: string }).licenseId;
    expect((await getLicense(db, SLUG, id))?.tier_id).toBe("default");
  });

  it("account issuance lands on the implicit tier", async () => {
    await seedImplicit();
    const account = await insertAccount(
      db,
      {
        primaryEmail: "ada@example.com",
        primaryEmailVerified: true,
        displayName: "Ada",
      },
      NOW,
    );
    const made = await issueAccountLicense(
      db,
      await product(),
      account.id,
      IDENTITY,
      { kind: "oidc", env },
      NOW,
    );
    const id = (made as { licenseId: string }).licenseId;
    expect((await getLicense(db, SLUG, id))?.tier_id).toBe("default");
  });
});

describe("before the job has run (no implicit tier)", () => {
  it("the tier stays NULL on every path", async () => {
    const res = await call("POST", "/license/licenses", { name: "A" });
    expect(res.status).toBe(201);
    const { license } = (await res.json()) as { license: { id: string } };
    expect((await getLicense(db, SLUG, license.id))?.tier_id).toBeNull();
    const made = await activateFromIdentity(db, await product(), IDENTITY, NOW);
    const id = (made as { licenseId: string }).licenseId;
    expect((await getLicense(db, SLUG, id))?.tier_id).toBeNull();
    const batch = await call("POST", "/license/batches", {
      label: "Keys",
      count: 1,
    });
    expect(batch.status).toBe(422);
    expect(await batch.json()).toMatchObject({ fields: ["tier"] });
  });
});

describe("a claim keeps the enrolled licence's tier when the identity maps to none", () => {
  it("keeps the existing tier", async () => {
    await seedImplicit();
    await seedLicenseWithKey(db, SLUG, { id: "lic_enrolled", tierId: "pro" });
    await db.run(
      "UPDATE licenses SET origin = 'enroll', sub = NULL WHERE product = ? AND id = 'lic_enrolled'",
      SLUG,
    );
    const made = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
      {
        enrolledLicenseId: "lic_enrolled",
      },
    );
    expect(made).toMatchObject({
      licenseId: "lic_enrolled",
      merged: "claimed",
    });
    expect((await getLicense(db, SLUG, "lic_enrolled"))?.tier_id).toBe("pro");
  });
});

describe("refusals", () => {
  it("PATCH tier: null is a 422 naming the field", async () => {
    await seedImplicit();
    await seedLicenseWithKey(db, SLUG, { id: "lic_1", tierId: "pro" });
    const res = await call("PATCH", "/license/licenses/lic_1", { tier: null });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["tier"] });
    expect((await getLicense(db, SLUG, "lic_1"))?.tier_id).toBe("pro");
  });

  it("deleting the last tier is a 422; with another tier it goes", async () => {
    const last = await call("DELETE", "/license/tiers/pro");
    expect(last.status).toBe(422);
    expect(await last.json()).toMatchObject({ fields: ["tier"] });
    await seedImplicit();
    expect((await call("DELETE", "/license/tiers/pro")).status).toBe(200);
  });

  it("deleting a tier a licence still uses stays a 409", async () => {
    await seedImplicit();
    await seedLicenseWithKey(db, SLUG, { id: "lic_1", tierId: "pro" });
    expect((await call("DELETE", "/license/tiers/pro")).status).toBe(409);
  });
});

describe("scan: every licence insert goes through issueTierFor", () => {
  const SRC = join(TEST_ROOT, "..", "src");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  })(SRC);

  /** Where the tier is decided for a file whose insert SQL lives elsewhere. */
  const FEEDER: Record<string, string> = {
    "services/license/batches.ts": "services/license/admin/batches.ts",
  };
  /** Inserts that always carry a tier row they were handed (`/enroll` resolves it first). */
  const GIVEN_A_TIER = new Set(["services/license/enroll.ts"]);
  /** The statement builders themselves. */
  const BUILDERS = new Set(["core/licensing/store.ts"]);

  it("finds the insert sites it is guarding", () => {
    const sites = files
      .filter((f) =>
        /INSERT INTO licenses\b|\binsertLicense\(|\bstmtInsertLicense\(/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(SRC, f));
    expect(sites).toEqual(
      expect.arrayContaining([
        "core/licensing/issue.ts",
        "core/licensing/issueAccount.ts",
        "services/license/admin/licenses.ts",
        "services/license/batches.ts",
      ]),
    );
  });

  it("no site writes a tier without issueTierFor", () => {
    const strays: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      const text = readFileSync(f, "utf8");
      if (
        !/INSERT INTO licenses\b|\binsertLicense\(|\bstmtInsertLicense\(/.test(
          text,
        )
      )
        continue;
      if (BUILDERS.has(rel) || GIVEN_A_TIER.has(rel)) continue;
      const decider = FEEDER[rel] ?? rel;
      const decided = readFileSync(join(SRC, decider), "utf8");
      if (!/\bissueTierFor\(/.test(decided)) strays.push(rel);
    }
    expect(strays).toEqual([]);
  });
});
