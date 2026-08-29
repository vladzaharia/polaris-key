// Trust-manifest key emission (wire contract §2.3, the audit's B2).
//
// Absence-is-revocation already works — a key that vanishes from the manifest stops being
// trusted when the discovered set is replaced. What §2.3 ADDITIONALLY asks of the server is
// a POSITIVE signal: a revoked key SHOULD stay listed with `status: "revoked"` for at least
// 2× `cacheSeconds` after revocation, so every client that could still hold it cached reads
// an explicit removal instead of inferring one. Clients already drop `revoked` entries on
// merge (client-core `mergeTrust`); this suite pins the server half: fresh revocations are
// emitted, stale ones age out, and the surfaces that build TRUSTED key sets (JWKS,
// discovery) never include a revoked key at all.

import { describe, expect, it } from "vitest";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleJwks, handleTrustManifest } from "../src/core/trust.js";

const TRUST_WINDOW = 2 * 300; // 2 × cacheSeconds

async function seedRevokedKey(
  db: ReturnType<typeof makeTestDb>,
  kid: string,
  revokedAt: number | null,
): Promise<void> {
  await db.run(
    `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at, rotated_at, revoked_at)
     VALUES ('djdl', ?, 'Ed25519', ?, '{}', 'revoked', ?, ?, ?)`,
    kid,
    `pub-${kid}`,
    NOW - 86400,
    revokedAt ?? NOW - 86400,
    revokedAt,
  );
}

function manifestPayload(jws: string): TrustManifestDoc {
  return JSON.parse(
    Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"),
  ) as TrustManifestDoc;
}

describe("trust manifest — explicit revoked-key emission (§2.3)", () => {
  it("emits a fresh revocation with status revoked, ages a stale one out", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedRevokedKey(db, "pkey-fresh-revoked", NOW - TRUST_WINDOW + 60);
    await seedRevokedKey(db, "pkey-stale-revoked", NOW - TRUST_WINDOW - 60);
    // A key revoked before the column existed: no timestamp, long past any cache window.
    await seedRevokedKey(db, "pkey-legacy-revoked", null);
    const product = (await loadProduct(env, db, "djdl"))!;

    const res = await handleTrustManifest(mkReq("GET", {}), db, product, NOW);
    expect(res.status).toBe(200);
    const doc = manifestPayload(await res.text());
    const byKid = Object.fromEntries(doc.keys.map((k) => [k.kid, k.status]));

    expect(byKid["pkey-fresh-revoked"]).toBe("revoked");
    expect(byKid["pkey-stale-revoked"]).toBeUndefined();
    expect(byKid["pkey-legacy-revoked"]).toBeUndefined();
    // The active signing key is untouched by the window logic.
    expect(byKid[product.signingKid]).toBe("active");
  });

  it("JWKS never lists a revoked key, however fresh", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedRevokedKey(db, "pkey-fresh-revoked", NOW - 10);
    const product = (await loadProduct(env, db, "djdl"))!;

    const res = await handleJwks(db, product);
    const body = (await res.json()) as { keys: Array<{ kid: string }> };
    expect(body.keys.map((k) => k.kid)).not.toContain("pkey-fresh-revoked");
  });
});
