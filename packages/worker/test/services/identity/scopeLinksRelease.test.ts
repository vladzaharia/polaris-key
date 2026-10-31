/**
 * I-14.13 (C10 note 6): a developer-scoped sign-in link does not outlive the setting value that
 * scopes it. Releasing the value by a settings edit (set, reset) or by a manifest ingest (changed
 * or dropped) clears the links under it; an unchanged value, a console claim the manifest leaves
 * alone, and a value another live product still declares keep theirs.
 */

import { describe, expect, it } from "vitest";
import type { ParsedManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { ROOT_PRINCIPAL } from "../../rbacFixtures.js";
import { SETTINGS, SERVICES } from "../../../src/mount.js";
import { writeSetting } from "../../../src/core/settings/write.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { identityHookStatements } from "../../../src/services/identity/ingest.js";
import type { Db } from "../../../src/db/types.js";

void SERVICES;
const TEAM = "ABCDE12345";
const OTHER = "QQQQQ11111";
const TEAM_KEY = "identity.platformSignIn.apple.teamId";
const SCOPE = `apple-team:${TEAM}`;

const hold = (db: Db, product: string, value: string, source = "manifest") =>
  db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, ?, 'test')`,
    product,
    TEAM_KEY,
    JSON.stringify(value),
    source,
    NOW,
  );
const edit = (
  db: Db,
  product: string,
  op: { value: string } | { op: "reset" },
  expectedVersion = 1,
) =>
  writeSetting(
    { env: {}, db, registry: SETTINGS },
    { key: TEAM_KEY, ...op, expectedVersion, reason: "test" } as never,
    {
      actor: { sub: "u1", name: "Una", email: "una@example.test" },
      origin: "console",
      principal: ROOT_PRINCIPAL,
      now: NOW + 10,
      product,
    },
  );
const ingest = (db: Db, product: string, teamId?: string) =>
  db.batch(
    identityHookStatements({
      manifest: {
        identity: teamId ? { platformSignIn: { apple: { teamId } } } : {},
      } as unknown as ParsedManifest,
      slug: product,
      now: NOW + 10,
      enabled: true,
    }),
  );
const identity = (scope: string) => ({
  issuerKey: "gamecenter",
  tenantScope: scope,
  subject: "p1",
  kind: "gamecenter",
});
const mk = (db: Db, product: string) =>
  signIn(db, identity(SCOPE), NOW, {
    unfenced: true,
    product: { slug: product, tenantScopes: [SCOPE] },
  });
const resolves = async (db: Db, product: string) =>
  (
    await signIn(db, identity(SCOPE), NOW + 20, {
      unfenced: true,
      linkedOnly: true,
      product: { slug: product, tenantScopes: [SCOPE] },
    })
  ).status === "signed_in";
const audits = (db: Db) =>
  db.all<{ summary: string }>(
    "SELECT summary FROM audit WHERE action = 'identity.scope_links.cleared'",
  );
async function world() {
  const db = makeTestDb();
  for (const s of ["alpha", "beta"]) await seedProduct(db, s);
  await hold(db, "alpha", TEAM);
  await mk(db, "alpha");
  return db;
}

describe("scopeLinksClearedWhenSettingReleased", () => {
  it("a settings edit that re-points the value clears the links; a new claimant inherits none", async () => {
    const db = await world();
    expect((await edit(db, "alpha", { value: OTHER })).ok).toBe(true);
    await hold(db, "beta", TEAM);
    expect(await resolves(db, "beta")).toBe(false);
    const rows = await audits(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).not.toMatch(new RegExp(`${TEAM}|p1`));
  });
  it("a reset that drops the stored value clears the links", async () => {
    const db = await world();
    expect((await edit(db, "alpha", { op: "reset" as const })).ok).toBe(true);
    await hold(db, "beta", TEAM);
    expect(await resolves(db, "beta")).toBe(false);
  });
  it("a manifest ingest that changes the value clears the links", async () => {
    const db = await world();
    await ingest(db, "alpha", OTHER);
    await hold(db, "beta", TEAM);
    expect(await resolves(db, "beta")).toBe(false);
    expect(await audits(db)).toHaveLength(1);
  });
  it("a manifest ingest that drops the value clears the links", async () => {
    const db = await world();
    await ingest(db, "alpha");
    await hold(db, "beta", TEAM);
    expect(await resolves(db, "beta")).toBe(false);
  });
});

describe("a value that is not released keeps its links", () => {
  it("an unchanged value clears nothing (resync and a same-value edit)", async () => {
    const db = await world();
    await ingest(db, "alpha", TEAM);
    expect((await edit(db, "alpha", { value: TEAM }, 1)).ok).toBe(true);
    expect(await resolves(db, "alpha")).toBe(true);
    expect(await audits(db)).toHaveLength(0);
  });
  it("a value another live product still declares keeps its links (edit and ingest)", async () => {
    const db = await world();
    await hold(db, "beta", TEAM); // out-of-band: two live products hold the value
    expect((await edit(db, "alpha", { value: OTHER })).ok).toBe(true);
    expect(await resolves(db, "beta")).toBe(true);
    await db.run(
      "UPDATE product_settings SET value_json = ? WHERE product = 'alpha'",
      JSON.stringify(TEAM),
    );
    await ingest(db, "alpha", OTHER);
    expect(await resolves(db, "beta")).toBe(true);
    expect(await audits(db)).toHaveLength(0);
  });
  it("a console claim the manifest leaves alone keeps its links when the manifest drops the key", async () => {
    const db = makeTestDb();
    for (const s of ["alpha", "beta"]) await seedProduct(db, s);
    await hold(db, "alpha", TEAM, "console");
    await mk(db, "alpha");
    await ingest(db, "alpha");
    expect(await resolves(db, "alpha")).toBe(true);
  });
});
