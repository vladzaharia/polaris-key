/**
 * `core.setup` (ST-39): the wizard kit's explicit choices are one operator-owned product setting,
 * served by the product settings routes and written through `writeSetting()`. No new table, no
 * new route: the audit row, the version guard and Revert come with the registry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import { envFor, seedReleaseProduct, SLUG } from "./releaseRoutesFixture.js";
import { ROOT_PRINCIPAL } from "./rbacFixtures.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { SETTINGS } from "../src/mount.js";
import { fitsValueSpec } from "../src/core/settings/rules.js";
import {
  EMPTY_SETUP,
  isSetupChoices,
} from "../src/core/settings/setupShape.js";
import {
  isRowServed,
  readRowSettings,
  revertRowSetting,
  writeRowSetting,
} from "../src/core/rowSettings.js";
import { getProduct } from "../src/core/repo.js";

const stamp = { at: 1_700_000_000, by: "ana@example.com" };
const ACTOR = { sub: "admin-1", name: "Ana", email: "ana@example.com" };

describe("core.setup", () => {
  const def = SETTINGS.get("core.setup", "product")!;

  it("is an operator scalar with no manifest path, served by the settings routes", () => {
    expect(def.ownership).toBe("operator");
    expect(def.storage.kind).toBe("scalar");
    expect(def.manifest).toBeUndefined();
    expect(isRowServed(def)).toBe(true);
    expect(def.defaultValue).toEqual(EMPTY_SETUP);
  });

  it("accepts the four choices and nothing else", () => {
    expect(fitsValueSpec(def.value, EMPTY_SETUP)).toBe(true);
    expect(
      fitsValueSpec(def.value, {
        integrationHidden: stamp,
        notUsing: ["apple-app-store"],
        runnerConsent: stamp,
        skipped: ["storefronts.verify"],
      }),
    ).toBe(true);
    for (const bad of [
      {},
      { ...EMPTY_SETUP, extra: 1 },
      { ...EMPTY_SETUP, notUsing: ["a", "a"] },
      { ...EMPTY_SETUP, notUsing: ["not a channel!"] },
      { ...EMPTY_SETUP, skipped: "x" },
      { ...EMPTY_SETUP, integrationHidden: { at: "now", by: "x" } },
      { ...EMPTY_SETUP, runnerConsent: { at: 1, by: "x", more: true } },
      [],
      "on",
    ])
      expect(isSetupChoices(bad)).toBe(false);
  });
});

describe("writing core.setup", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedReleaseProduct(db);
  });

  it("goes through writeSetting(): audited, versioned, shape-checked, revertable", async () => {
    const def = SETTINGS.get("core.setup", "product")!;
    const product = (await getProduct(db, SLUG))!;
    const ctx = { env: envFor(), db, registry: SETTINGS };
    const read = async () =>
      (await readRowSettings(db, product, [def], NOW + 100))[0]!;

    expect(await read()).toMatchObject({ value: EMPTY_SETUP, version: 0 });

    const next = { ...EMPTY_SETUP, notUsing: ["google-play"] };
    const ok = await writeRowSetting(
      ctx,
      product,
      def,
      { value: next, expectedVersion: 0 },
      ACTOR,
      NOW + 10,
      ROOT_PRINCIPAL,
    );
    expect(ok).toMatchObject({ ok: true, claimed: false });
    expect(await read()).toMatchObject({ value: next, version: 1 });
    const audit = await db.all<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit WHERE product = ? AND target_id = 'core.setup'",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toEqual(["setting.update"]);

    // A shape the registry refuses, and a stale version, change nothing.
    const bad = await writeRowSetting(
      ctx,
      product,
      def,
      { value: { notUsing: [] }, expectedVersion: 1 },
      ACTOR,
      NOW + 20,
      ROOT_PRINCIPAL,
    );
    expect(bad.ok).toBe(false);
    const stale = await writeRowSetting(
      ctx,
      product,
      def,
      { value: EMPTY_SETUP, expectedVersion: 0 },
      ACTOR,
      NOW + 30,
      ROOT_PRINCIPAL,
    );
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect((await read()).value).toEqual(next);

    const back = await revertRowSetting(
      ctx,
      product,
      def,
      { expectedVersion: 1 },
      ACTOR,
      NOW + 40,
      ROOT_PRINCIPAL,
    );
    expect(back).toMatchObject({ ok: true, applied: true });
    expect(await read()).toMatchObject({
      value: EMPTY_SETUP,
      source: "default",
    });
  });
});
