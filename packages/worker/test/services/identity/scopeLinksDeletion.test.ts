/**
 * I-14.13: developer-scoped sign-in links (`apple-team:`, `pgs-app:`, `google-client:`) do not
 * outlive the product that declared the scope. A product that later claims the same id starts with
 * no links under it; a scope another live product still declares keeps its links.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { SERVICES } from "../../../src/mount.js";
import type { Db } from "../../../src/db/types.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";

const TEAM = "ABCDE12345";
const TEAM_KEY = "identity.platformSignIn.apple.teamId";
const APP_KEY = "identity.platformSignIn.playGames.applicationId";
const APP = "123456789012";
const GC_SCOPE = `apple-team:${TEAM}`;
const PGS_SCOPE = `pgs-app:${APP}`;

void SERVICES;

async function declare(db: Db, product: string, key: string, value: string) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', 1, ?, 'test')`,
    product,
    key,
    JSON.stringify(value),
    NOW,
  );
}

const identity = (kind: string, tenantScope: string, subject: string) => ({
  issuerKey: kind,
  tenantScope,
  subject,
  kind,
});

async function link(db: Db, product: string, scope: string, kind: string) {
  const r = await signIn(db, identity(kind, scope, "player-1"), NOW, {
    unfenced: true,
    product: { slug: product, tenantScopes: [scope] },
  });
  expect(r.status).toBe("signed_in");
}

/** Does the player sign in to `product` through an existing link only? */
async function resolves(db: Db, product: string, scope: string, kind: string) {
  const r = await signIn(db, identity(kind, scope, "player-1"), NOW + 1, {
    unfenced: true,
    linkedOnly: true,
    product: { slug: product, tenantScopes: [scope] },
  });
  return r.status === "signed_in";
}

async function world() {
  const db = makeTestDb();
  for (const slug of ["alpha", "beta"]) await seedProduct(db, slug);
  return db;
}

describe("developer-scoped links and product deletion (I-14.13)", () => {
  it("a link under a deleted product's scope does not resolve for a later product with the same ids", async () => {
    const db = await world();
    await declare(db, "alpha", TEAM_KEY, TEAM);
    await declare(db, "alpha", APP_KEY, APP);
    await link(db, "alpha", GC_SCOPE, "gamecenter");
    await link(db, "alpha", PGS_SCOPE, "pgs");
    expect(await resolves(db, "alpha", GC_SCOPE, "gamecenter")).toBe(true);

    await deleteProduct(db, "alpha", NOW + 2);
    await declare(db, "beta", TEAM_KEY, TEAM);
    await declare(db, "beta", APP_KEY, APP);

    expect(await resolves(db, "beta", GC_SCOPE, "gamecenter")).toBe(false);
    expect(await resolves(db, "beta", PGS_SCOPE, "pgs")).toBe(false);
    // A fresh link works for the new product.
    await link(db, "beta", GC_SCOPE, "gamecenter");
    expect(await resolves(db, "beta", GC_SCOPE, "gamecenter")).toBe(true);
  });

  it("keeps a scope another live product still declares", async () => {
    const db = await world();
    await declare(db, "alpha", TEAM_KEY, TEAM);
    await declare(db, "beta", TEAM_KEY, TEAM.toLowerCase());
    await link(db, "beta", GC_SCOPE, "gamecenter");

    await deleteProduct(db, "alpha", NOW + 2);

    expect(await resolves(db, "beta", GC_SCOPE, "gamecenter")).toBe(true);
    const audits = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'identity.scope_links.cleared'",
    );
    expect(audits[0]!.n).toBe(0);
  });

  it("leaves global links alone and writes one neutral audit row with no subject", async () => {
    const db = await world();
    await declare(db, "alpha", TEAM_KEY, TEAM);
    await link(db, "alpha", GC_SCOPE, "gamecenter");
    await link(db, "alpha", "", "email");

    await deleteProduct(db, "alpha", NOW + 2);

    const left = await db.all<{ tenant_scope: string }>(
      "SELECT tenant_scope FROM account_links",
    );
    expect(left.map((l) => l.tenant_scope)).toEqual([""]);
    const rows = await db.all<{ product: string; summary: string }>(
      "SELECT product, summary FROM audit WHERE action = 'identity.scope_links.cleared'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.product).toBe("alpha");
    expect(rows[0]!.summary).not.toContain("player-1");
    expect(rows[0]!.summary).not.toContain(TEAM);
  });
});
