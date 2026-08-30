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
import { verifyJws } from "@polaris-key/jws";
import { verifyTrustManifest } from "@polaris-key/client-core";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedAnchorKey,
  seedProduct,
  TEST_ANCHOR_KID,
  TEST_ANCHOR_PUB,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleJwks, handleTrustManifest } from "../src/core/trust.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { SERVICES } from "../src/mount.js";
import { generateEd25519, seal } from "../src/keyvault.js";
import type { Env } from "../src/env.js";
import {
  getActiveAnchorKey,
  getActiveProductKey,
  insertProductKey,
  stmtRetireProductKeys,
  stmtSetProductKeyStatus,
} from "../src/repo.js";
import { signDoc } from "../src/core/signing.js";

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

// ── B3-01 — the trust anchor / document-key split (wire v3 §1.1) ──────────────
//
// The defect these pin: the manifest used to be signed by the ACTIVE key, while manifests are
// verified against PINNED keys only. Composed, the first document-key rotation made every
// installed client refuse every later manifest — so trust refresh, the §4.2 clock floor and
// revocation all died at once, for exactly the population a key compromise needs to reach.
//
// The invariant that must NOT move while fixing it: a manifest is still verified against pins
// alone. The anchor is a separate, longer-lived key, not a relaxation of the pinning rule.

/** The `kid` in a compact JWS's protected header — i.e. WHICH key signed it. */
function signerKid(jws: string): string {
  return (
    JSON.parse(
      Buffer.from(jws.split(".")[0]!, "base64url").toString("utf8"),
    ) as { kid: string }
  ).kid;
}

/** Mint + seal a fresh Ed25519 key row, returning its kid and public half. */
async function addKey(
  db: ReturnType<typeof makeTestDb>,
  slug: string,
  kid: string,
  role: "anchor" | "document",
  status: string,
): Promise<{ kid: string; pub: string }> {
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const enc = await seal(
    { PLATFORM_KEK: btoa("\0".repeat(32)) } as Env,
    privatePkcs8Pem,
    { product: slug, kind: "signing-key", id: kid },
  );
  await insertProductKey(db, {
    product: slug,
    kid,
    alg: "Ed25519",
    public_b64url: publicRawB64url,
    enc_private_json: enc,
    status,
    created_at: NOW,
    rotated_at: null,
    revoked_at: null,
    role,
  });
  return { kid, pub: publicRawB64url };
}

describe("trust anchor split (§1.1, B3-01)", () => {
  it("the manifest is signed by the ANCHOR, not by the active document key", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;

    // The two roles really are different keys in this fixture.
    expect(product.signingKid).toBe(TEST_KID);
    expect(product.trustAnchorKid).toBe(TEST_ANCHOR_KID);

    const jws = await (
      await handleTrustManifest(mkReq("GET", {}), db, product, NOW)
    ).text();
    expect(signerKid(jws)).toBe(TEST_ANCHOR_KID);
    // …and it verifies against a client that pins ONLY the anchor.
    const result = await verifyTrustManifest(jws, {
      pinned: { [TEST_ANCHOR_KID]: TEST_ANCHOR_PUB },
      expectedAud: "djdl",
      now: NOW,
    });
    expect(result.doc).not.toBeNull();
  });

  it("a manifest signed by a DOCUMENT key is refused by a client pinning the anchor", async () => {
    // The R2-01 guard, restated for the anchor world. The server never mints this artifact; the
    // point is that if it ever did — or if an attacker who obtained a document key minted one —
    // a correctly-pinned client refuses it, because pins are the only manifest trust source.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;

    const real = await (
      await handleTrustManifest(mkReq("GET", {}), db, product, NOW)
    ).text();
    const payload = JSON.parse(
      Buffer.from(real.split(".")[1]!, "base64url").toString("utf8"),
    ) as TrustManifestDoc;
    // The SAME payload, re-signed by the document key.
    const forged = await signDoc(
      payload,
      (await product.signingKey())!,
      product.signingKid,
      "pkey-trust+jws",
    );
    expect(signerKid(forged)).toBe(TEST_KID);

    const result = await verifyTrustManifest(forged, {
      pinned: { [TEST_ANCHOR_KID]: TEST_ANCHOR_PUB },
      expectedAud: "djdl",
      now: NOW,
    });
    expect(result.doc).toBeNull();
    expect(result.discovered).toEqual({});
  });

  it("rotating a document key does not change the manifest signer, and the client keeps working", async () => {
    // The regression this whole change exists to prevent, end to end against the real server.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    const pinned = { [TEST_ANCHOR_KID]: TEST_ANCHOR_PUB };

    const before = (await loadProduct(env, db, "djdl"))!;
    const manifestBefore = await (
      await handleTrustManifest(mkReq("GET", {}), db, before, NOW)
    ).text();

    // Stage + activate a new DOCUMENT key, exactly as `POST .../keys/{prepare,activate}` does.
    const rotated = await addKey(
      db,
      "djdl",
      "djdl-2027-rotated",
      "document",
      "staged",
    );
    await db.batch([
      stmtRetireProductKeys("djdl", NOW, "document"),
      stmtSetProductKeyStatus("djdl", rotated.kid, "active", NOW),
    ]);

    const after = (await loadProduct(env, db, "djdl"))!;
    expect(after.signingKid).toBe(rotated.kid); // the document key DID move
    expect(after.trustAnchorKid).toBe(TEST_ANCHOR_KID); // the anchor did NOT

    const manifestAfter = await (
      await handleTrustManifest(mkReq("GET", {}), db, after, NOW)
    ).text();
    expect(signerKid(manifestAfter)).toBe(signerKid(manifestBefore));

    // A client provisioned BEFORE the rotation — it holds nothing but the pinned anchor — still
    // verifies the new manifest, learns the rotated key from it, and verifies a document signed
    // by that rotated key. Before the split this is precisely where the client went dark.
    const verified = await verifyTrustManifest(manifestAfter, {
      pinned,
      expectedAud: "djdl",
      now: NOW,
    });
    expect(verified.doc).not.toBeNull();
    expect(verified.discovered[rotated.kid]).toBe(rotated.pub);

    const doc = await signDoc(
      { hello: "world" },
      (await after.signingKey())!,
      after.signingKid,
      "pkey-license+jws",
    );
    const effective = { ...verified.discovered, ...pinned };
    expect(
      await verifyJws(doc, effective, { typ: "pkey-license+jws" }),
    ).not.toBeNull();
  });

  it("activating a document key does not retire the anchor", async () => {
    // `stmtRetireProductKeys` used to retire EVERY active key. Unscoped, the activate batch
    // would have taken the anchor away in the very operation whose point is to leave it alone.
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    await addKey(db, "djdl", "djdl-next", "document", "staged");

    await db.batch([
      stmtRetireProductKeys("djdl", NOW, "document"),
      stmtSetProductKeyStatus("djdl", "djdl-next", "active", NOW),
    ]);

    expect((await getActiveAnchorKey(db, "djdl"))?.kid).toBe(TEST_ANCHOR_KID);
    expect((await getActiveProductKey(db, "djdl"))?.kid).toBe("djdl-next");
  });

  it("revocation still reaches clients across a rotation", async () => {
    // Revocation is the capability B3-01 destroyed, so it gets its own end-to-end check: revoke
    // the OUTGOING document key after a rotation and confirm a client pinning only the anchor
    // both verifies the manifest and reads the explicit `revoked` entry.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    await addKey(db, "djdl", "djdl-2027-rotated", "document", "staged");
    await db.batch([
      stmtRetireProductKeys("djdl", NOW, "document"),
      stmtSetProductKeyStatus("djdl", "djdl-2027-rotated", "active", NOW),
    ]);
    await db.run(
      "UPDATE product_keys SET status = 'revoked', revoked_at = ? WHERE product = 'djdl' AND kid = ?",
      NOW,
      TEST_KID,
    );

    const product = (await loadProduct(env, db, "djdl"))!;
    const jws = await (
      await handleTrustManifest(mkReq("GET", {}), db, product, NOW)
    ).text();
    const verified = await verifyTrustManifest(jws, {
      pinned: { [TEST_ANCHOR_KID]: TEST_ANCHOR_PUB },
      expectedAud: "djdl",
      now: NOW,
    });
    expect(verified.doc).not.toBeNull();
    expect(verified.doc!.keys.find((k) => k.kid === TEST_KID)?.status).toBe(
      "revoked",
    );
    // …and the revoked key is NOT in the set the client will verify documents with.
    expect(verified.discovered[TEST_KID]).toBeUndefined();
  });

  it("publishes `role` on manifest entries as advisory metadata", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;

    const jws = await (
      await handleTrustManifest(mkReq("GET", {}), db, product, NOW)
    ).text();
    const doc = manifestPayload(jws);
    const byKid = Object.fromEntries(doc.keys.map((k) => [k.kid, k.role]));
    expect(byKid[TEST_ANCHOR_KID]).toBe("anchor");
    expect(byKid[TEST_KID]).toBe("document");
  });

  it("discovery advertises the ANCHOR as what to pin, not the document key", async () => {
    // `trust.pinnedKeys` is literally "what should I pin?". Publishing the whole key set — which
    // it used to — is the advice that walks straight back into B3-01.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedAnchorKey(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;

    const res = await handleDiscovery(
      new Request(
        "https://key.plrs.im/djdl/.well-known/polaris.json",
      ) as unknown as Request,
      env,
      db,
      product,
      SERVICES,
    );
    const body = (await res.json()) as {
      trust: {
        pinnedKeys: Record<string, string>;
        anchorKid: string;
        signingKid: string;
        keys: Array<{ kid: string; role?: string }>;
      };
    };
    expect(body.trust.pinnedKeys).toEqual({
      [TEST_ANCHOR_KID]: TEST_ANCHOR_PUB,
    });
    expect(body.trust.anchorKid).toBe(TEST_ANCHOR_KID);
    expect(body.trust.signingKid).toBe(TEST_KID);
    // The verification set is a different question and still lists everything.
    expect(body.trust.keys.map((k) => k.kid).sort()).toEqual(
      [TEST_ANCHOR_KID, TEST_KID].sort(),
    );
    expect(body.trust.keys.find((k) => k.kid === TEST_ANCHOR_KID)?.role).toBe(
      "anchor",
    );
  });

  it("a product carried across 0026 with no anchor row still serves, using its one key for both", async () => {
    // The transitional shape, and the reason `loadProduct` falls back rather than refusing: a
    // product with no anchor row must degrade to its pre-0026 behaviour, not go dark. Going dark
    // would take revocation with it — the very capability this change exists to protect.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl"); // one active key, role 'document', no anchor
    const product = (await loadProduct(env, db, "djdl"))!;
    expect(product.trustAnchorKid).toBe(product.signingKid);

    const jws = await (
      await handleTrustManifest(mkReq("GET", {}), db, product, NOW)
    ).text();
    expect(signerKid(jws)).toBe(TEST_KID);
    const verified = await verifyTrustManifest(jws, {
      pinned: { [TEST_KID]: TEST_PUB },
      expectedAud: "djdl",
      now: NOW,
    });
    expect(verified.doc).not.toBeNull();
  });
});
