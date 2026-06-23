import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedLicenseWithKey, seedProduct, TEST_KID, TEST_PUB } from "./seed.js";
import { loadProduct } from "../src/product.js";
import { handleEnroll } from "../src/licensing.js";
import { handleJwks } from "../src/jwks.js";
import { handleMintToken } from "../src/edgeMint.js";

const ES_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

function jwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("worker surfaces", () => {
  it("jwks exposes the product Ed25519 public key", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const res = handleJwks(product);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<{ kid: string; x: string; crv: string }> };
    expect(body.keys[0]?.kid).toBe(TEST_KID);
    expect(body.keys[0]?.x).toBe(TEST_PUB);
    expect(body.keys[0]?.crv).toBe("Ed25519");
  });

  it("edge-mint signs an ES256 token for a licensed machine", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    env["EDGE_MINT__DJDL__APPLEMUSIC"] = ES_PEM;
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, product, NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    await db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,auth_page_template) VALUES (?,?,?,?,?,?,?,?)",
      "djdl", "applemusic", "ES256", "EDGE_MINT__DJDL__APPLEMUSIC", "KID123", JSON.stringify({ iss: "TEAMID123" }), 3600, null,
    );

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env, db, product, "applemusic", NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    const [h, p] = body.token.split(".") as [string, string, string];
    expect(jwtPart(h).alg).toBe("ES256");
    expect(jwtPart(h).kid).toBe("KID123");
    const payload = jwtPart(p);
    expect(payload.iss).toBe("TEAMID123");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
  });

  it("edge-mint rejects an unauthenticated caller", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const res = await handleMintToken(mkReq("POST", {}), env, db, product, "applemusic", NOW);
    expect(res.status).toBe(401);
  });
});
