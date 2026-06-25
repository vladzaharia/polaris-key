import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/product.js";
import { generateEd25519 } from "../src/keyvault.js";
import { handleEnroll } from "../src/licensing.js";
import { handleJwks } from "../src/jwks.js";
import { handleDiscovery } from "../src/discovery.js";
import { handleMintToken } from "../src/edgeMint.js";

const ES_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

function jwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** Generate an RSA-2048 RS256 key in-test; export the PKCS#8 private PEM + a verify key. */
async function generateRs256(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = Buffer.from(bin, "binary").toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

describe("worker surfaces", () => {
  it("jwks exposes the product Ed25519 public key", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const res = await handleJwks(db, product);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{ kid: string; x: string; crv: string }>;
    };
    expect(body.keys[0]?.kid).toBe(TEST_KID);
    expect(body.keys[0]?.x).toBe(TEST_PUB);
    expect(body.keys[0]?.crv).toBe("Ed25519");
  });

  it("product discovery exposes auth/config/release/signing basics", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      "UPDATE products SET release_source = ? WHERE slug = ?",
      "github",
      "djdl",
    );
    await db.run(
      `INSERT INTO oidc_config
         (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?,?,?,?,?,?)`,
      "djdl",
      "https://id.example",
      "client-123",
      "OIDC_SECRET",
      JSON.stringify(["https://key.plrs.im/djdl/auth/callback"]),
      "{}",
    );
    await db.run(
      `INSERT INTO release_config
         (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
          manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "djdl",
      "acme",
      "djdl",
      42,
      "release.yml",
      "main",
      JSON.stringify([
        { name: "nightly", regex: "v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+" },
      ]),
      "djdl",
      null,
      "SPARKLEPUB",
      "pkey:summary",
    );
    const product = (await loadProduct(env, db, "djdl"))!;

    const res = await handleDiscovery(
      new Request(
        "https://key.plrs.im/djdl/.well-known/polaris.json",
      ) as unknown as Request,
      db,
      product,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const body = (await res.json()) as {
      product: string;
      name: string;
      endpoints: {
        config: string;
        jwks: string;
        authDeviceStart: string;
        authDevicePoll: string;
      };
      trust: {
        pinnedKeys: Record<string, string>;
        signingKid: string;
        signingPub: string;
      };
      modules: {
        auth: {
          tokenUrl: string;
          oidc: {
            issuer: string;
            clientId: string;
            deviceStartUrl: string;
            devicePollUrl: string;
          } | null;
        };
        config: { schemaVersion: number; schemaUrl: string };
        release: {
          enabled: boolean;
          source: string;
          channels: string[];
          repository: { owner: string; name: string } | null;
        };
        signing: {
          jwksUrl: string;
          keys: Array<{ kid: string; publicKey: string }>;
        };
      };
    };

    expect(body.product).toBe("djdl");
    expect(body.name).toBe("djdl");
    expect(body.endpoints.config).toBe("https://key.plrs.im/djdl/config");
    expect(body.endpoints.jwks).toBe(
      "https://key.plrs.im/djdl/.well-known/jwks.json",
    );
    expect(body.endpoints.authDeviceStart).toBe(
      "https://key.plrs.im/djdl/auth/device/start",
    );
    expect(body.endpoints.authDevicePoll).toBe(
      "https://key.plrs.im/djdl/auth/device/poll",
    );
    expect(body.trust).toMatchObject({
      signingKid: TEST_KID,
      signingPub: TEST_PUB,
      pinnedKeys: { [TEST_KID]: TEST_PUB },
    });
    expect(body.modules.auth.tokenUrl).toBe("https://key.plrs.im/djdl/token");
    expect(body.modules.auth.oidc).toMatchObject({
      issuer: "https://id.example",
      clientId: "client-123",
      deviceStartUrl: "https://key.plrs.im/djdl/auth/device/start",
      devicePollUrl: "https://key.plrs.im/djdl/auth/device/poll",
    });
    expect(body.modules.config).toMatchObject({
      schemaVersion: 1,
      schemaUrl: "https://key.plrs.im/djdl/schema",
    });
    expect(body.modules.release).toMatchObject({
      enabled: true,
      source: "github",
      repository: { owner: "acme", name: "djdl" },
    });
    expect(body.modules.release.channels).toEqual([
      "stable",
      "beta",
      "nightly",
    ]);
    expect(body.modules.signing.jwksUrl).toBe(
      "https://key.plrs.im/djdl/.well-known/jwks.json",
    );
    expect(body.modules.signing.keys[0]).toMatchObject({
      kid: TEST_KID,
      publicKey: TEST_PUB,
    });
  });

  it("edge-mint signs an ES256 token for a licensed machine (key from the KEK store)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    // Mint key is now KEK-custodied in product_secrets, addressed by the recipe's NAME.
    await seedProductSecret(db, "djdl", "applemusic_devkey", ES_PEM);
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    await db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "applemusic",
      "ES256",
      "applemusic_devkey",
      "KID123",
      JSON.stringify({ iss: "TEAMID123" }),
      3600,
      null,
      null,
    );

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    const [h, p] = body.token.split(".") as [string, string, string];
    expect(jwtPart(h).alg).toBe("ES256");
    expect(jwtPart(h).kid).toBe("KID123");
    const payload = jwtPart(p);
    // iss from the template is preserved; iat/exp are server-set.
    expect(payload.iss).toBe("TEAMID123");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
  });

  it("edge-mint: template iat/exp/nbf/aud are not overridable; aud comes from the trusted column", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedProductSecret(db, "djdl", "applemusic_devkey", ES_PEM);
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    // A hostile template tries to pin iat/exp/nbf and forge `aud`. The recipe's trusted
    // `audience` column ("music.apple.com") must win over the template's "evil.example".
    await db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "applemusic",
      "ES256",
      "applemusic_devkey",
      "KID123",
      JSON.stringify({
        iss: "TEAMID123",
        aud: "evil.example",
        iat: 1,
        exp: 9_999_999_999,
        nbf: 2,
      }),
      3600,
      "music.apple.com",
      null,
    );

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    const payload = jwtPart(body.token.split(".")[1] as string);
    // Server values win regardless of the template; nbf is dropped entirely.
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
    expect(payload.nbf).toBeUndefined();
    expect(body.expiresAt).toBe(NOW + 3600);
    // aud is the trusted recipe column, NOT the template's forged value.
    expect(payload.aud).toBe("music.apple.com");
    // A legitimate non-reserved claim (iss) still flows through.
    expect(payload.iss).toBe("TEAMID123");
  });

  it("edge-mint signs an RS256 token and the signature verifies under the public key", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { pem, publicKey } = await generateRs256();
    await seedProductSecret(db, "djdl", "rs256_key", pem);
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    await db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "rsa",
      "RS256",
      "rs256_key",
      "RKID1",
      JSON.stringify({ iss: "issuer-x" }),
      600,
      "aud-rs",
      null,
    );

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "rsa",
      NOW,
    );
    expect(res.status).toBe(200);
    const { token: jwt } = (await res.json()) as { token: string };
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(jwtPart(h).alg).toBe("RS256");
    expect(jwtPart(h).kid).toBe("RKID1");
    const payload = jwtPart(p);
    expect(payload.iss).toBe("issuer-x");
    expect(payload.aud).toBe("aud-rs");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 600);
    // Verify the RS256 signature over header.payload with the in-test public key.
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(s, "base64url"),
      Buffer.from(`${h}.${p}`, "utf8"),
    );
    expect(ok).toBe(true);
  });

  it("edge-mint signs an EdDSA compact JWS that verifyJws accepts", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    await seedProductSecret(db, "djdl", "ed25519_key", privatePkcs8Pem);
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    await db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "eddsa",
      "EdDSA",
      "ed25519_key",
      "EDKID1",
      JSON.stringify({ sub: "user-7" }),
      900,
      "aud-ed",
      null,
    );

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "eddsa",
      NOW,
    );
    expect(res.status).toBe(200);
    const { token: jws } = (await res.json()) as { token: string };
    expect(jwtPart(jws.split(".")[0] as string).alg).toBe("EdDSA");
    const verified = await verifyJws<Record<string, unknown>>(jws, {
      EDKID1: publicRawB64url,
    });
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe("EDKID1");
    expect(verified!.payload.sub).toBe("user-7");
    expect(verified!.payload.aud).toBe("aud-ed");
    expect(verified!.payload.iat).toBe(NOW);
    expect(verified!.payload.exp).toBe(NOW + 900);
  });

  it("edge-mint rejects an unauthenticated caller", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const res = await handleMintToken(
      mkReq("POST", {}),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(401);
  });
});
