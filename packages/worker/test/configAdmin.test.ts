/**
 * Config's admin additions for the console's Config chunk (docs/design/ADMIN.md §7.3):
 *
 * - A-6: catalog version history (`catalog/versions[/<n>]`) and the `expectedVersion` publish
 *   guard (409 `catalog_version_conflict`).
 * - A-7: `PATCH config/profiles/<id>` for name and description.
 * - A-7b: `catalog/usage?key=…` — the profiles, tiers and licenses that set a key.
 * - Profile `usedBy`, and create refusing a taken id (it used to overwrite the payload).
 *
 * Admin routes are narrative-only (rule 10 does not apply); every write here audits.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

const ENTRY = (key: string) => ({
  key,
  kind: "config",
  category: "general",
  label: key,
  description: "",
  schema: { type: "string" },
});

async function setup(): Promise<{
  db: Db;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, "djdl", {
    catalog: { schemaVersion: 1, entries: [ENTRY("theme")] },
  });
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const full = `/api/products/djdl/${path}`;
    const req = new Request(`https://key.plrs.im/manage${full}`, init);
    return handleAdmin(req, env, db, full.split("?")[0]!, { now: NOW });
  };
  return { db, env, call };
}

const publish = (
  call: Awaited<ReturnType<typeof setup>>["call"],
  keys: string[],
  expectedVersion?: number,
) =>
  call("PUT", "config/catalog", {
    catalog: { schemaVersion: 0, entries: keys.map(ENTRY) },
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });

describe("catalog history and the expectedVersion guard (A-6)", () => {
  it("lists every version newest first, marking the active one and who published it", async () => {
    const { call } = await setup();
    expect((await publish(call, ["theme", "proxy.url"])).status).toBe(200);
    const res = await call("GET", "config/catalog/versions");
    expect(res.status).toBe(200);
    const { versions } = (await res.json()) as {
      versions: {
        version: number;
        active: boolean;
        entryCount: number;
        source: string;
        publishedBy: string | null;
      }[];
    };
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      active: true,
      entryCount: 2,
      source: "admin",
      publishedBy: "ada@x.io",
    });
    // v1 was seeded (no console publish): the manifest wrote it.
    expect(versions[1]).toMatchObject({
      active: false,
      entryCount: 1,
      source: "manifest",
      publishedBy: null,
    });
  });

  it("returns one version's catalog, active or not, and 404s an unknown or malformed one", async () => {
    const { call } = await setup();
    await publish(call, ["proxy.url"]);
    const v1 = await call("GET", "config/catalog/versions/1");
    expect(v1.status).toBe(200);
    expect(
      ((await v1.json()) as { entries: { key: string }[] }).entries.map(
        (e) => e.key,
      ),
    ).toEqual(["theme"]);
    expect((await call("GET", "config/catalog/versions/9")).status).toBe(404);
    expect((await call("GET", "config/catalog/versions/0")).status).toBe(404);
    expect((await call("GET", "config/catalog/versions/x")).status).toBe(404);
    expect((await call("POST", "config/catalog/versions")).status).toBe(405);
  });

  it("publishes when expectedVersion matches the active version", async () => {
    const { call } = await setup();
    const res = await publish(call, ["theme", "a"], 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ schemaVersion: 2 });
  });

  it("refuses a stale draft with 409 catalog_version_conflict and the current version", async () => {
    const { db, call } = await setup();
    await publish(call, ["theme", "a"]); // a teammate publishes v2
    const res = await publish(call, ["theme", "b"], 1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      reason: string;
      currentVersion: number;
    };
    expect(body.reason).toBe("catalog_version_conflict");
    expect(body.currentVersion).toBe(2);
    // Nothing was written: v2 is still active and only one publish is audited.
    const active = await call("GET", "config/catalog");
    expect(
      ((await active.json()) as { entries: { key: string }[] }).entries.map(
        (e) => e.key,
      ),
    ).toEqual(["theme", "a"]);
    const audits = (await listAudit(db, "djdl")).filter(
      (a) => a.action === "schema.publish",
    );
    expect(audits).toHaveLength(1);
  });

  it("treats expectedVersion 0 as 'no catalog yet' for a first publish", async () => {
    const { db, call } = await setup();
    await db.run("DELETE FROM product_schema WHERE product = ?", "djdl");
    expect((await call("GET", "config/catalog")).status).toBe(404);
    expect((await publish(call, ["theme"], 0)).status).toBe(200);
    // and 0 is stale once a catalog exists
    expect((await publish(call, ["theme"], 0)).status).toBe(409);
  });

  it("rejects a malformed expectedVersion", async () => {
    const { call } = await setup();
    const res = await call("PUT", "config/catalog", {
      catalog: { schemaVersion: 0, entries: [ENTRY("theme")] },
      expectedVersion: "1",
    });
    expect(res.status).toBe(422);
  });

  it("keeps last-writer-wins for a publish without expectedVersion", async () => {
    const { call } = await setup();
    await publish(call, ["a"]);
    expect((await publish(call, ["b"])).status).toBe(200);
  });
});

describe("Cloud Sync declarations on a console publish (U-04)", () => {
  const SETTING = {
    ...ENTRY("audio.volume"),
    schema: { type: "number", minimum: 0, maximum: 1 },
    default: 0.8,
    user: { sync: "user", conflict: "max" },
  };
  const CLOUD_SYNC = {
    collections: [{ name: "progress", access: "owner" }],
    migrations: [
      { toSchemaVersion: 2, rename: { "audio.vol": "audio.volume" } },
    ],
  };
  const active = async (
    call: Awaited<ReturnType<typeof setup>>["call"],
  ): Promise<Record<string, unknown>> =>
    (await (await call("GET", "config/catalog")).json()) as Record<
      string,
      unknown
    >;

  it("keeps a user block and stores the catalog's cloudSync block", async () => {
    const { call } = await setup();
    const res = await call("PUT", "config/catalog", {
      catalog: { schemaVersion: 0, entries: [SETTING], cloudSync: CLOUD_SYNC },
    });
    expect(res.status).toBe(200);
    const catalog = await active(call);
    expect(catalog.cloudSync).toEqual(CLOUD_SYNC);
    expect((catalog.entries as { user?: unknown }[])[0]!.user).toEqual(
      SETTING.user,
    );
  });

  it("carries the active cloudSync block forward when the body has none (the console's editor)", async () => {
    const { call } = await setup();
    await call("PUT", "config/catalog", {
      catalog: { schemaVersion: 0, entries: [SETTING], cloudSync: CLOUD_SYNC },
    });
    expect((await publish(call, ["theme", "audio.volume"])).status).toBe(200);
    expect((await active(call)).cloudSync).toEqual(CLOUD_SYNC);
  });

  it("refuses a user block that breaks a rule, and writes nothing", async () => {
    const { db, call } = await setup();
    for (const entry of [
      { ...ENTRY("a"), kind: "secret", user: { sync: "user" } },
      { ...ENTRY("a"), managementDefault: "enforced", user: { sync: "user" } },
      { ...ENTRY("a"), user: { sync: "user", conflict: "max" } },
      { ...ENTRY("a"), user: { sync: "user", conflict: "union" } },
      { ...ENTRY("a"), user: { sync: "everywhere" } },
    ]) {
      const res = await call("PUT", "config/catalog", {
        catalog: { schemaVersion: 0, entries: [entry] },
      });
      expect(res.status, JSON.stringify(entry)).toBe(422);
      const body = (await res.json()) as { fields: string[] };
      expect(body.fields[0]).toMatch(/^\/entries\/0\/user/);
    }
    const audits = (await listAudit(db, "djdl")).filter(
      (a) => a.action === "schema.publish",
    );
    expect(audits).toHaveLength(0);
  });

  it("refuses a publish that leaves the carried cloudSync block pointing at nothing", async () => {
    const { call } = await setup();
    await call("PUT", "config/catalog", {
      catalog: {
        schemaVersion: 0,
        entries: [
          SETTING,
          {
            ...ENTRY("cloudSaves"),
            kind: "flag",
            schema: { type: "boolean" },
          },
        ],
        cloudSync: { saves: { requiresFlag: "cloudSaves" } },
      },
    });
    // The console drops the flag; the carried block still names it.
    const res = await publish(call, ["theme"]);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: string[] }).fields[0]).toMatch(
      /^\/cloudSync\/saves\/requiresFlag/,
    );
  });
});

describe("catalog usage (A-7b)", () => {
  it("names the profiles, inheriting tiers and licenses that set each key, never a value", async () => {
    const { db, call } = await setup();
    await call("POST", "config/profiles", { id: "base", name: "Base" });
    await call("PUT", "config/profiles/base", {
      updates: [{ key: "theme", value: "dark", state: "enforced" }],
    });
    await seedTier(db, "djdl", "pro");
    await db.run(
      "UPDATE tiers SET profile_id = 'base' WHERE product = 'djdl' AND id = 'pro'",
    );
    await seedLicenseWithKey(db, "djdl", {
      id: "lic_1",
      config: { theme: { value: "light", state: "default", updatedAt: NOW } },
    });
    await seedLicenseWithKey(db, "djdl", { id: "lic_2" });
    // U-03: an account's override of the key counts too, by subject.
    await db.run(
      `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
       VALUES ('djdl', 'ps_AAAAAAAAAAAAAAAAAAAAAA', ?, ?, 'op')`,
      JSON.stringify({
        config: {
          theme: { value: "sepia", state: "enforced", updatedAt: NOW },
        },
        secrets: {},
      }),
      NOW,
    );

    const res = await call(
      "GET",
      "config/catalog/usage?key=theme&key=missing&key=theme",
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("dark");
    expect(text).not.toContain("light");
    expect(text).not.toContain("sepia");
    const { keys } = JSON.parse(text) as {
      keys: Record<
        string,
        {
          profiles: { id: string }[];
          tiers: { id: string; profile: string }[];
          licenses: { id: string }[];
          accounts: { subject: string }[];
        }
      >;
    };
    expect(Object.keys(keys)).toEqual(["theme", "missing"]);
    expect(keys.theme!.profiles.map((p) => p.id)).toEqual(["base"]);
    expect(keys.theme!.tiers).toEqual([
      { id: "pro", label: "pro", profile: "base" },
    ]);
    expect(keys.theme!.licenses.map((l) => l.id)).toEqual(["lic_1"]);
    expect(keys.theme!.accounts).toEqual([
      { subject: "ps_AAAAAAAAAAAAAAAAAAAAAA" },
    ]);
    expect(keys.missing).toEqual({
      profiles: [],
      tiers: [],
      licenses: [],
      accounts: [],
    });
  });

  it("requires at least one key", async () => {
    const { call } = await setup();
    expect((await call("GET", "config/catalog/usage")).status).toBe(422);
  });
});

describe("profiles: details, references and create (A-7)", () => {
  it("edits name and description with PATCH, audited, leaving the payload alone", async () => {
    const { db, call } = await setup();
    await call("POST", "config/profiles", { id: "base", name: "Base" });
    await call("PUT", "config/profiles/base", {
      updates: [{ key: "theme", value: "dark", state: "default" }],
    });
    const res = await call("PATCH", "config/profiles/base", {
      name: "Baseline",
      description: "For every new license",
    });
    expect(res.status).toBe(200);
    const detail = (await (
      await call("GET", "config/profiles/base")
    ).json()) as {
      name: string;
      description?: string;
      payload: { config: Record<string, { value: unknown }> };
    };
    expect(detail.name).toBe("Baseline");
    expect(detail.description).toBe("For every new license");
    expect(detail.payload.config.theme!.value).toBe("dark");
    const audit = (await listAudit(db, "djdl")).find(
      (a) => a.action === "profile.update",
    );
    expect(audit?.target_id).toBe("base");

    // A blank description clears it; a blank name is refused.
    await call("PATCH", "config/profiles/base", { description: "" });
    const cleared = (await (
      await call("GET", "config/profiles/base")
    ).json()) as { description?: string };
    expect(cleared.description).toBeUndefined();
    const bad = await call("PATCH", "config/profiles/base", { name: " " });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual([
      "name",
    ]);
    expect(
      (await call("PATCH", "config/profiles/nope", { name: "x" })).status,
    ).toBe(404);
  });

  it("refuses a create whose id is taken instead of overwriting that profile", async () => {
    const { call } = await setup();
    await call("POST", "config/profiles", { id: "base", name: "Base" });
    await call("PUT", "config/profiles/base", {
      updates: [{ key: "theme", value: "dark", state: "default" }],
    });
    const again = await call("POST", "config/profiles", {
      id: "base",
      name: "Other",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason: string }).reason).toBe(
      "profile_exists",
    );
    const detail = (await (
      await call("GET", "config/profiles/base")
    ).json()) as {
      name: string;
      payload: { config: Record<string, unknown> };
    };
    expect(detail.name).toBe("Base");
    expect(Object.keys(detail.payload.config)).toEqual(["theme"]);
  });

  it("reports what uses each profile, and names the delete refusal", async () => {
    const { db, call } = await setup();
    await call("POST", "config/profiles", { id: "base", name: "Base" });
    await call("POST", "config/profiles", { id: "spare", name: "Spare" });
    await seedTier(db, "djdl", "pro");
    await db.run(
      "UPDATE tiers SET profile_id = 'base' WHERE product = 'djdl' AND id = 'pro'",
    );
    await seedLicenseWithKey(db, "djdl", { id: "lic_1" });
    await db.run(
      "INSERT INTO license_profiles (product, license_id, profile_id, sort_order) VALUES ('djdl', 'lic_1', 'base', 0)",
    );

    const list = (await (await call("GET", "config/profiles")).json()) as {
      profiles: { id: string; usedBy: { tiers: number; licenses: number } }[];
    };
    expect(list.profiles).toEqual([
      expect.objectContaining({
        id: "base",
        usedBy: { tiers: 1, licenses: 1 },
      }),
      expect.objectContaining({
        id: "spare",
        usedBy: { tiers: 0, licenses: 0 },
      }),
    ]);
    const detail = (await (
      await call("GET", "config/profiles/base")
    ).json()) as {
      usedBy: {
        tiers: { id: string; label: string }[];
        licenses: { id: string; name?: string; email?: string }[];
      };
    };
    expect(detail.usedBy.tiers).toEqual([{ id: "pro", label: "pro" }]);
    expect(detail.usedBy.licenses).toEqual([
      { id: "lic_1", name: "Ada Lovelace", email: "ada@example.com" },
    ]);

    const del = await call("DELETE", "config/profiles/base");
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({
      reason: "profile_in_use",
      references: 2,
    });
    expect((await call("DELETE", "config/profiles/spare")).status).toBe(200);
  });

  it("names a payload edit without a catalog", async () => {
    const { db, call } = await setup();
    await call("POST", "config/profiles", { id: "base" });
    await db.run("DELETE FROM product_schema WHERE product = ?", "djdl");
    const res = await call("PUT", "config/profiles/base", { updates: [] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no_active_catalog",
    );
  });
});
