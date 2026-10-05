/**
 * LX-05 (S-19 §7.4, decision 15): reserved entitlement names at the Worker.
 *
 * - `GET /api/platform/reserved-names`: the severity, the reserved keys and prefixes, and every
 *   registered product whose active catalog declares a reserved name, compatible or not.
 * - The console catalog writes (Config's catalog publish, manual product create) accept an
 *   incompatible declaration in `warn` mode and refuse it in `error` mode.
 * - The A-13 setting `LICENSING_RESERVED_NAMES` decides the mode: a console row wins over
 *   `[vars]`, which wins over the code default `warn`.
 *
 * Manifest ingest (link, resync) is covered in `linkRepo.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { reservedNamesMode } from "../src/core/reservedNames.js";
import {
  invalidatePlatformSettings,
  writePlatformSetting,
} from "../src/core/platformSettings.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

const DJDL_CATALOG = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "..", "products", "djdl", "catalog.json"),
    "utf8",
  ),
) as unknown;

const flag = (key: string, schema: Record<string, unknown>) => ({
  key,
  kind: "flag",
  category: "Policy",
  label: key,
  description: "",
  schema,
});

const INCOMPATIBLE = {
  schemaVersion: 1,
  entries: [
    flag("acmeVpn", { type: "boolean" }),
    flag("channels", { type: "boolean" }),
  ],
};

function envWith(extra: Record<string, unknown> = {}): Env {
  return Object.assign(makeEnv(new KvMock(), ["djdl", "acme", "plain"]), {
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    PLATFORM_ADMIN_GROUP: PLATFORM_GROUP,
    ...extra,
  }) as Env;
}

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
    [CSRF_HEADER]: session.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(`https://key.plrs.im/manage${path}`, init);
  const res = await handleAdmin(req, env, db, path.split("?")[0]!, {
    now: NOW,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function seeded(): Promise<Db> {
  const db = makeTestDb();
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  await seedProduct(db, "acme", { catalog: INCOMPATIBLE });
  await seedProduct(db, "plain", {
    catalog: {
      schemaVersion: 1,
      entries: [flag("acmeVpn", { type: "boolean" })],
    },
  });
  return db;
}

describe("GET /api/platform/reserved-names", () => {
  it("lists every registered product that declares a reserved name, compatible or not", async () => {
    const db = await seeded();
    const res = await call(
      envWith(),
      db,
      "GET",
      "/api/platform/reserved-names",
    );
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("warn");
    expect(res.body.keys.map((k: { key: string }) => k.key)).toEqual([
      "channels",
      "deviceLimit",
      "app.minVersion",
      "app.maxVersion",
      "license.tier",
      "license.tierLabel",
    ]);
    expect(res.body.prefixes).toEqual(["license.", "app.", "pkey."]);
    const bySlug = Object.fromEntries(
      res.body.products.map((p: { slug: string }) => [p.slug, p]),
    );
    // `plain` declares no reserved name, so it is not listed.
    expect(Object.keys(bySlug).sort()).toEqual(["acme", "djdl"]);
    expect(
      bySlug.djdl.declarations.every(
        (d: { compatible: boolean }) => d.compatible,
      ),
    ).toBe(true);
    expect(bySlug.djdl.declarations).toHaveLength(4);
    expect(bySlug.acme.declarations).toEqual([
      {
        key: "channels",
        compatible: false,
        problem: expect.stringContaining('schema.type must be "array"'),
      },
    ]);
  });

  it("is platform-admin only and read-only", async () => {
    const db = await seeded();
    const env = envWith();
    expect(
      (await call(env, db, "POST", "/api/platform/reserved-names", {})).status,
    ).toBe(405);
  });

  it("reports the mode the platform setting resolves to", async () => {
    const db = await seeded();
    const env = envWith({ LICENSING_RESERVED_NAMES: "error" });
    expect(
      (await call(env, db, "GET", "/api/platform/reserved-names")).body.mode,
    ).toBe("error");
  });
});

describe("LICENSING_RESERVED_NAMES resolution", () => {
  it("console row > [vars] > default warn; an unrecognised var is ignored", async () => {
    const db = makeTestDb();
    expect(await reservedNamesMode({}, db)).toBe("warn");
    expect(
      await reservedNamesMode({ LICENSING_RESERVED_NAMES: "nope" }, db),
    ).toBe("warn");
    const env = { LICENSING_RESERVED_NAMES: "error" };
    expect(await reservedNamesMode(env, db)).toBe("error");
    const write = await writePlatformSetting(
      db,
      "LICENSING_RESERVED_NAMES",
      "warn",
      0,
      NOW,
      "u1",
    );
    expect(write.ok).toBe(true);
    invalidatePlatformSettings(env, db);
    expect(await reservedNamesMode(env, db)).toBe("warn");
  });

  it("the settings API accepts warn and error only, and confirms the switch to error", async () => {
    const db = makeTestDb();
    const env = envWith();
    const list = await call(env, db, "GET", "/api/platform/settings");
    const row = list.body.settings.find(
      (s: { key: string }) => s.key === "LICENSING_RESERVED_NAMES",
    );
    expect(row).toMatchObject({
      area: "licensing",
      kind: "choice",
      value: "warn",
      source: "default",
      options: [
        { value: "warn", label: "Warn" },
        { value: "error", label: "Refuse" },
      ],
      confirm: { warn: "L0", error: "L1" },
    });
    const bad = await call(
      env,
      db,
      "PATCH",
      "/api/platform/settings/LICENSING_RESERVED_NAMES",
      { value: "strict", expectedVersion: 0 },
    );
    expect(bad.status).toBe(422);
    const ok = await call(
      env,
      db,
      "PATCH",
      "/api/platform/settings/LICENSING_RESERVED_NAMES",
      { value: "error", expectedVersion: 0 },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ value: "error", source: "runtime" });
  });
});

describe("console catalog writes", () => {
  const publish = (env: Env, db: Db, catalog: unknown) =>
    call(env, db, "PUT", "/api/products/plain/config/catalog", { catalog });

  it("Config's catalog publish accepts an incompatible declaration in warn mode", async () => {
    const db = await seeded();
    const res = await publish(envWith(), db, INCOMPATIBLE);
    expect(res.status).toBeLessThan(300);
  });

  it("and refuses it in error mode, naming the entry; a compatible one still publishes", async () => {
    const db = await seeded();
    const env = envWith({ LICENSING_RESERVED_NAMES: "error" });
    const res = await publish(env, db, INCOMPATIBLE);
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe("incompatible_reserved_name");
    expect(res.body.fields).toEqual(["catalog/entries/1/key"]);
    const ok = await publish(env, db, DJDL_CATALOG);
    expect(ok.status).toBeLessThan(300);
  });

  it("manual product create refuses it in error mode only", async () => {
    const db = makeTestDb();
    const create = (env: Env, slug: string) =>
      call(env, db, "POST", "/api/products", {
        slug,
        name: slug,
        schema: INCOMPATIBLE,
      });
    const strict = await create(
      envWith({ LICENSING_RESERVED_NAMES: "error" }),
      "strict-one",
    );
    expect(strict.status).toBe(422);
    expect(strict.body.reason).toBe("incompatible_reserved_name");
    const lenient = await create(envWith(), "lenient-one");
    expect(lenient.status).toBeLessThan(300);
  });
});
