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
  approveEdgeMintRecipe,
  seedProductSecret,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { generateEd25519 } from "../src/keyvault.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleJwks } from "../src/core/trust.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { handleMintToken } from "../src/services/config/mint.js";
import { SERVICES } from "../src/mount.js";
import { SERVICE_SLUGS, serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";

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

/** The discovery document's shape, as a consumer sees it. */
interface DiscoveryBody {
  version: number;
  protocolVersion: number;
  product: string;
  name: string;
  core: {
    registration: string;
    compat: { min: string; max: string };
    endpoints: Record<string, string>;
  };
  trust: {
    pinnedKeys: Record<string, string>;
    signingKid: string;
    signingPub: string;
    jwksUrl: string;
    keys: Array<{ kid: string; publicKey: string }>;
  };
  services: Record<string, Record<string, unknown>>;
}

/** Fetch `/.well-known/polaris.json` through the real handler + the real service registry —
 *  the fragments must come from the descriptors, not from a test double. */
async function discover(
  env: Env,
  db: Db,
  product: Product,
): Promise<DiscoveryBody> {
  const res = await handleDiscovery(
    new Request(
      "https://key.plrs.im/djdl/.well-known/polaris.json",
    ) as unknown as Request,
    env,
    db,
    product,
    // The real mount table, not a hand-built double: a fragment that stopped being registered
    // would otherwise silently become `{enabled:false}` and this suite would still pass.
    SERVICES,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("max-age=300");
  return (await res.json()) as DiscoveryBody;
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

  it("product discovery is assembled from the enabled services' fragments", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      "UPDATE products SET release_source = ? WHERE slug = ?",
      "github",
      "djdl",
    );
    // Enablement is the single authority (spec §2.2): a `release_config` row is CONFIGURATION,
    // and no longer doubles as consent. Release/Update must be turned on for the document to
    // advertise them, however many rows exist.
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
          identity: { enabled: true },
        },
      }),
      "manifest",
      NOW,
    );
    await db.run(
      `INSERT INTO oidc_config
         (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "custom",
      "https://id.example",
      "client-123",
      "OIDC_SECRET",
      JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
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

    const body = await discover(env, db, product);

    expect(body.version).toBe(2);
    expect(body.product).toBe("djdl");
    expect(body.name).toBe("djdl");

    // ── Core: the always-on device/trust/platform block ────────────────────────
    expect(body.core.registration).toBe("requires-license");
    expect(body.core.compat).toEqual({ min: "0.0.0", max: "99.0.0" });
    expect(body.core.endpoints).toMatchObject({
      jwks: "https://key.plrs.im/djdl/.well-known/jwks.json",
      trustManifest: "https://key.plrs.im/djdl/.well-known/polaris-trust.jws",
      devices: "https://key.plrs.im/djdl/devices",
      report: "https://key.plrs.im/djdl/devices/report",
    });
    // A `requires-license` product's register endpoint is defined to refuse everybody, so the
    // document does not publish a URL that could only ever produce a 403.
    expect(body.core.endpoints).not.toHaveProperty("register");
    expect(body.trust).toMatchObject({
      signingKid: TEST_KID,
      signingPub: TEST_PUB,
      pinnedKeys: { [TEST_KID]: TEST_PUB },
      jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
    });
    expect(body.trust.keys[0]).toMatchObject({
      kid: TEST_KID,
      publicKey: TEST_PUB,
    });

    // ── Services: one fragment per slug, contributed by the service that owns it ──
    // (The exact bytes, key order included, are pinned by discoveryGolden.test.ts.)
    expect(Object.keys(body.services)).toEqual([...SERVICE_SLUGS]);
    expect(body.services.license).toEqual({
      enabled: true,
      endpoints: {
        activate: "https://key.plrs.im/djdl/license/activate",
        enroll: "https://key.plrs.im/djdl/license/enroll",
        token: "https://key.plrs.im/djdl/license/token",
        deauthorize: "https://key.plrs.im/djdl/license/deauthorize",
        document: "https://key.plrs.im/djdl/license/document",
      },
    });
    expect(body.services.config).toEqual({
      enabled: true,
      schemaVersion: 1,
      endpoints: {
        document: "https://key.plrs.im/djdl/config/document",
        schema: "https://key.plrs.im/djdl/config/schema",
      },
      // No recipes seeded for this product, so the capability reads honestly.
      mint: { available: false },
    });
    // P2.T1: these two fragments are now the SERVICES' own, not Core stand-ins, and they
    // advertise the CANONICAL §R1 paths. The four permanent aliases still answer — that is what
    // `router.test.ts` pins — but discovery is where a compatibility spelling stops being taught
    // to new clients.
    expect(body.services.release).toEqual({
      enabled: true,
      configured: true,
      binaryName: "djdl",
      repository: { owner: "acme", name: "djdl" },
      endpoints: {
        changelog: "https://key.plrs.im/djdl/release/changelog",
        install: "https://key.plrs.im/djdl/release/install.sh",
        download: "https://key.plrs.im/djdl/release/dl",
        builds: "https://key.plrs.im/djdl/release/builds/{selector}/{buildId}",
        blobs: "https://key.plrs.im/djdl/release/blobs/sha256/{sha256}",
        // P3-03: a CI-signed release record by its hash.
        record: "https://key.plrs.im/djdl/release/records/{sha256}",
      },
      releaseKeyFingerprints: [],
      // P4-02: this Worker ingests pack records and mirrors pins.
      packs: true,
      // P4-22: chunk indexes are ingested and their bundles kept.
      chunks: true,
      // P4-13: revocation records are ingested and served.
      revocations: true,
      // P4-19: delegations are ingested and served.
      delegations: true,
    });
    expect(body.services.update).toEqual({
      enabled: true,
      configured: true,
      channels: ["stable", "beta", "nightly"],
      sparkleEd25519PublicKey: "SPARKLEPUB",
      endpoints: {
        version: "https://key.plrs.im/djdl/update/version",
        appcast: "https://key.plrs.im/djdl/update/appcast.xml",
        channelAppcast: "https://key.plrs.im/djdl/update/{channel}/appcast.xml",
        // P3-03: the signed channel feed.
        feed: "https://key.plrs.im/djdl/update/{channel}/feed.jws",
        winsparkle: "https://key.plrs.im/djdl/update/{channel}/winsparkle.xml",
        velopack:
          "https://key.plrs.im/djdl/update/{channel}/velopack/releases.{velopackChannel}.json",
        appInstaller:
          "https://key.plrs.im/djdl/update/{channel}/app.appinstaller",
        zsync:
          "https://key.plrs.im/djdl/update/{channel}/{buildId}.AppImage.zsync",
      },
      archParameter: ["arm64", "x86_64"],
    });
    // P3: identity's fragment is the SERVICE's own too, and every URL in it moved under the
    // namespace. `configured` reports the `oidc_config` row — which is no longer what decides
    // `enabled`; that is `services_json` and only `services_json`.
    expect(body.services.identity).toMatchObject({
      enabled: true,
      configured: true,
      endpoints: {
        session: "https://key.plrs.im/djdl/identity/session",
        sessionLicense: "https://key.plrs.im/djdl/identity/session/license",
        authStart: "https://key.plrs.im/djdl/identity/auth/start",
        authCallback: "https://key.plrs.im/djdl/identity/auth/callback",
        authPoll: "https://key.plrs.im/djdl/identity/auth/poll",
        authLogout: "https://key.plrs.im/djdl/identity/auth/logout",
        authDeviceStart: "https://key.plrs.im/djdl/identity/auth/device/start",
        authDeviceEntry: "https://key.plrs.im/djdl/identity/auth/device",
        authDeviceVerify:
          "https://key.plrs.im/djdl/identity/auth/device/verify",
        authDevicePoll: "https://key.plrs.im/djdl/identity/auth/device/poll",
      },
    });
    // The IdP's own configuration is never published: an anonymous reader learns that login
    // exists and where to start it, not who the provider is or which client id it uses.
    const identity = body.services.identity as Record<string, unknown>;
    for (const leak of ["provider", "issuer", "clientId"])
      expect(identity).not.toHaveProperty(leak);
    // §R1 drops `/auth/login` as a redundant alias of `/auth/start`; discovery is where a
    // retired alias stops being advertised first.
    expect(
      (identity.endpoints as Record<string, unknown>).authLogin,
    ).toBeUndefined();

    // `modules` is gone outright — pre-launch, no compatibility alias (wire v3 §9).
    expect(body).not.toHaveProperty("modules");
  });

  it("a disabled service is `{enabled:false}` and NOTHING else", async () => {
    // Spec §4.3: the document must not let an anonymous reader recover a disabled service's
    // configuration, nor let an operator mistake "advertised" for "reachable".
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO release_config
         (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
          manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "djdl",
      "secret-org",
      "secret-repo",
      42,
      "release.yml",
      "main",
      null,
      "djdl",
      null,
      "SPARKLEPUB",
      "pkey:summary",
    );
    // Default enablement: license + config on, everything else off — while the release row
    // above exists and is fully populated.
    const product = (await loadProduct(env, db, "djdl"))!;
    const body = await discover(env, db, product);

    for (const slug of ["release", "update", "identity"] as const) {
      expect(body.services[slug]).toEqual({ enabled: false });
    }
    // The repo coordinates are in D1 and must not be anywhere in the document.
    expect(JSON.stringify(body)).not.toContain("secret-org");
    expect(JSON.stringify(body)).not.toContain("SPARKLEPUB");
  });

  it("a config-only product advertises registration and hides License", async () => {
    // The D-08 shape end-to-end at the discovery layer: no License fragment at all, and the
    // keyless mint path published because the derived policy can actually say yes.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const body = await discover(env, db, product);

    expect(body.services.license).toEqual({ enabled: false });
    expect(body.services.config).toMatchObject({ enabled: true });
    expect(body.core.registration).toBe("open");
    expect(body.core.endpoints.register).toBe(
      "https://key.plrs.im/djdl/devices/register",
    );
  });

  it("edge-mint signs an ES256 token for a licensed device (key from the KEK store)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    // Mint key is now KEK-custodied in product_secrets, addressed by the recipe's NAME.
    await seedProductSecret(
      db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };

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
    await approveEdgeMintRecipe(db, "djdl", "applemusic");

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
    await seedProductSecret(
      db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };

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
    await approveEdgeMintRecipe(db, "djdl", "applemusic");

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
    await seedProductSecret(db, "djdl", "rs256_key", pem, "edge-mint");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };

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
    await approveEdgeMintRecipe(db, "djdl", "rsa");

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
    await seedProductSecret(
      db,
      "djdl",
      "ed25519_key",
      privatePkcs8Pem,
      "edge-mint",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };

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
    await approveEdgeMintRecipe(db, "djdl", "eddsa");

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
