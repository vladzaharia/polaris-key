// I-13.9: a Google web client id or an Apple team id names a native-link scope, so one owner holds
// it at a time. Another owner's product that names it is refused at the settings write and at
// manifest ingest (create, apply and resync run the same check); products of one owner may share.

import { describe, expect, it } from "vitest";
import type { ParsedManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { ROOT_PRINCIPAL } from "../../rbacFixtures.js";
import { SETTINGS } from "../../../src/mount.js";
import { writeSetting } from "../../../src/core/settings/write.js";
import { identityManifest } from "../../../src/services/identity/ingest.js";
import type { Db } from "../../../src/db/types.js";

const WEB = "1234-web.apps.googleusercontent.com";
const TEAM = "ABCDE12345";
const SERVER = "identity.platformSignIn.google.serverClientId";
const TEAM_KEY = "identity.platformSignIn.apple.teamId";

async function world() {
  const db = makeTestDb();
  await seedProduct(db, "victim");
  await seedProduct(db, "other");
  return db;
}

const hold = (db: Db, product: string, key: string, value: string) =>
  db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', ?, 'test')`,
    product,
    key,
    JSON.stringify(value),
    NOW,
  );

const owner = (db: Db, product: string, ghOwner: string) =>
  db.run(
    "INSERT INTO release_config (product, gh_owner, gh_repo) VALUES (?, ?, 'r')",
    product,
    ghOwner,
  );

const write = (db: Db, key: string, value: string) =>
  writeSetting(
    { env: {}, db, registry: SETTINGS },
    { key, value, expectedVersion: 0, reason: "own client" },
    {
      actor: { sub: "u1", name: "Una", email: "una@example.test" },
      origin: "console",
      principal: ROOT_PRINCIPAL,
      now: NOW,
      product: "other",
    },
  );

/** The check reads only `identity.platformSignIn`. */
const manifest = (slug: string, platformSignIn: unknown): ParsedManifest =>
  ({ product: { slug }, identity: { platformSignIn } }) as never;

async function audienceCheck(db: Db, m: ParsedManifest, mode = "apply") {
  const checks = identityManifest.checks!({
    env: {},
    db,
    mode,
    slug: m.product.slug,
    manifest: m,
  } as never);
  const c = checks.find((x) => x.check === "audience")!;
  return c.run();
}

describe("audience ownership across products (I-13.9)", () => {
  it("refuses another owner's Google server client id and Apple team id at the settings write", async () => {
    const db = await world();
    await hold(db, "victim", SERVER, WEB);
    await hold(db, "victim", TEAM_KEY, TEAM);
    for (const [key, value] of [
      [SERVER, WEB],
      [TEAM_KEY, TEAM],
    ] as const) {
      expect(await write(db, key, value)).toMatchObject({
        ok: false,
        status: 422,
        reason: "value_claimed",
      });
    }
    expect(
      await db.first("SELECT 1 FROM product_settings WHERE product = 'other'"),
    ).toBeNull();
  });

  it("takes a value nobody else declares, and a value the same owner declares", async () => {
    const db = await world();
    expect(
      await write(db, SERVER, "7777-mine.apps.googleusercontent.com"),
    ).toMatchObject({
      ok: true,
    });
    await hold(db, "victim", TEAM_KEY, TEAM);
    await owner(db, "victim", "Acme");
    await owner(db, "other", "acme");
    expect(await write(db, TEAM_KEY, TEAM)).toMatchObject({ ok: true });
  });

  it("two different GitHub owners, or an owner and none, do not share", async () => {
    const db = await world();
    await hold(db, "victim", TEAM_KEY, TEAM);
    await owner(db, "victim", "acme");
    await owner(db, "other", "mallory");
    expect(await write(db, TEAM_KEY, TEAM)).toMatchObject({
      reason: "value_claimed",
    });
    await db.run("DELETE FROM release_config WHERE product = 'other'");
    expect(await write(db, TEAM_KEY, TEAM)).toMatchObject({
      reason: "value_claimed",
    });
  });

  it("a deleted product holds nothing", async () => {
    const db = await world();
    await hold(db, "victim", SERVER, WEB);
    await db.run(
      "UPDATE products SET status = 'deleted' WHERE slug = 'victim'",
    );
    expect(await write(db, SERVER, WEB)).toMatchObject({ ok: true });
  });

  it("manifest ingest refuses the same values and takes the same owner's", async () => {
    const db = await world();
    await hold(db, "victim", SERVER, WEB);
    await hold(db, "victim", TEAM_KEY, TEAM);
    const google = manifest("other", { google: { serverClientId: WEB } });
    const apple = manifest("other", {
      apple: { teamId: TEAM, bundleIds: ["com.other.mac"] },
    });
    expect(await audienceCheck(db, google)).toMatchObject({
      check: "audience",
      path: "/identity/platformSignIn/google/serverClientId",
    });
    expect(await audienceCheck(db, apple, "create")).toMatchObject({
      path: "/identity/platformSignIn/apple/teamId",
    });
    await owner(db, "victim", "acme");
    await owner(db, "other", "acme");
    expect(await audienceCheck(db, google)).toBeNull();
    expect(await audienceCheck(db, apple)).toBeNull();
  });
});
