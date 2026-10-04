/// <reference types="@cloudflare/workers-types" />
// A-11: `d1_migrations` is readable through the D1 binding (notes/S-13 §10, the [U] the spike
// left open). `setup.ts` applies the migrations with `applyD1Migrations`, which records them in
// `d1_migrations` exactly as `wrangler d1 migrations apply` does (same table, same columns), so
// this reads the real thing through the real D1 binding API in workerd. What it cannot prove is
// Cloudflare's hosted D1 authorizer; that is confirmed on the first deploy (DEPLOYMENT.md).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import {
  appliedMigrations,
  LATEST_MIGRATION,
} from "../src/core/deployIdentity.js";

describe("deploy identity in workerd", () => {
  it("reads every applied migration from d1_migrations through the binding", async () => {
    const applied = await appliedMigrations(new D1Db(env.DB));
    expect(applied).not.toBeNull();
    const names = applied!.map((m) => m.name);
    expect(names.length).toBe(env.TEST_MIGRATIONS.length);
    expect(names).toContain(LATEST_MIGRATION);
    expect(applied!.every((m) => typeof m.appliedAt === "string")).toBe(true);
  });
});
