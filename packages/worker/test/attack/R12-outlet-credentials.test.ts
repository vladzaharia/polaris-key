/**
 * R12 (continued) — outlet credentials must be unreachable from the product-secret paths (P5-01).
 *
 * The finding this closes (report §0.4 item 5): edge-mint opens a product secret by name for
 * any device of the product, and under open registration anyone can be a device. Stored as a
 * product secret, an App Store Connect `.p8` would be one approval away from a public App Store
 * Connect token mint. Outlet credentials therefore live in their own table under their own AAD
 * kind, and these attacks try to cross that line from both sides. Each `it()` REFUTES an attack:
 * the assertion encodes the safe behaviour.
 */

import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  approveEdgeMintRecipe,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
} from "../seed.js";
import type { Env } from "../../src/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { open } from "../../src/keyvault.js";
import {
  loadProduct,
  openProductSecret,
  type Product,
} from "../../src/core/products.js";
import {
  openOutletCredential,
  putOutletCredential,
} from "../../src/core/outletCredentials.js";
import { handleMintToken } from "../../src/services/config/mint.js";
import { handleActivate } from "../../src/services/license/activation.js";
import { upsertProductSecret } from "../../src/repo.js";

const P8 = (
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string
).trim();

const CRED_ID = "asc-team-key";

async function deviceToken(
  env: Env,
  db: SqliteDb,
  product: Product,
): Promise<string> {
  const { key } = await seedLicenseWithKey(db, "djdl", { id: "lic_djdl_r12" });
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": "dev-r12",
    }),
    env,
    db,
    product,
    NOW,
  );
  return ((await res.json()) as { token: string }).token;
}

/** A recipe naming `secret` as its key, approved by an operator exactly as it stands. */
async function approvedRecipe(db: SqliteDb, secret: string): Promise<void> {
  await db.run(
    "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES ('djdl','asc','ES256',?,'ABC123DEFG',?,1200,'appstoreconnect-v1',NULL)",
    secret,
    JSON.stringify({ iss: "issuer" }),
  );
  await approveEdgeMintRecipe(db, "djdl", "asc");
}

describe("R12 outlet credentials vs the product-secret paths", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const put = await putOutletCredential(env, db, {
      product: "djdl",
      credentialId: CRED_ID,
      kind: "asc-api-key",
      outletId: "app-store",
      value: { keyId: "ABC123DEFG", issuerId: "issuer", p8: P8 },
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(put.ok).toBe(true);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  async function outletBlob(): Promise<string> {
    const row = await db.first<{ enc_value_json: string }>(
      "SELECT enc_value_json FROM outlet_credentials WHERE product = 'djdl' AND credential_id = ?",
      CRED_ID,
    );
    return row!.enc_value_json;
  }

  it("REFUTES: an edge-mint recipe naming an outlet credential id mints with it (500 misconfigured)", async () => {
    const token = await deviceToken(env, db, product);
    await approvedRecipe(db, CRED_ID);
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "asc",
      NOW,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "misconfigured",
    );
  });

  it("REFUTES: a sealed outlet credential copied into product_secrets (marked edge-mint) opens there", async () => {
    // The strongest form of the copy: same name, the edge-mint usage an operator would have to
    // grant, and the exact ciphertext. The AAD kind differs, so AES-GCM refuses it.
    await upsertProductSecret(db, {
      product: "djdl",
      name: CRED_ID,
      enc_value_json: await outletBlob(),
      usage: "edge-mint",
      created_at: NOW,
      modified_at: NOW,
    });
    expect(
      await openProductSecret(db, env, "djdl", CRED_ID, "edge-mint"),
    ).toBeUndefined();
    await expect(
      open(env, await outletBlob(), {
        product: "djdl",
        kind: "product-secret",
        id: CRED_ID,
      }),
    ).rejects.toThrow();

    // …and the edge-mint route, which reads through openProductSecret, answers misconfigured.
    const token = await deviceToken(env, db, product);
    await approvedRecipe(db, CRED_ID);
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "asc",
      NOW,
    );
    expect(res.status).toBe(500);
  });

  it("REFUTES: a product secret copied into outlet_credentials opens as an outlet credential", async () => {
    await seedProductSecret(
      db,
      "djdl",
      "forged",
      JSON.stringify({ keyId: "X", issuerId: "Y", p8: P8 }),
      "edge-mint",
    );
    const row = await db.first<{ enc_value_json: string }>(
      "SELECT enc_value_json FROM product_secrets WHERE product = 'djdl' AND name = 'forged'",
    );
    await db.run(
      "INSERT INTO outlet_credentials (product, credential_id, kind, enc_value_json, created_at, created_by) VALUES ('djdl', 'forged', 'asc-api-key', ?, ?, 'attacker')",
      row!.enc_value_json,
      NOW,
    );
    expect(
      await openOutletCredential(env, db, "djdl", "forged", "asc:poll", {
        now: NOW,
      }),
    ).toBeNull();
  });

  it("REFUTES: another product's credential opens under a product the caller controls", async () => {
    await seedProduct(db, "evil");
    await db.run(
      "INSERT INTO outlet_credentials (product, credential_id, kind, enc_value_json, created_at, created_by) VALUES ('evil', ?, 'asc-api-key', ?, ?, 'attacker')",
      CRED_ID,
      await outletBlob(),
      NOW,
    );
    expect(
      await openOutletCredential(env, db, "evil", CRED_ID, "asc:poll", {
        now: NOW,
      }),
    ).toBeNull();
  });
});
