import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
} from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleActivate } from "../src/licensing.js";
import {
  getEdgeMintConfig,
  handleMintAuth,
  handleMintToken,
} from "../src/edgeMint.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

// A throwaway ES256 (P-256 PKCS#8) private key for tests only.
const ES_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

function jwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function activate(
  env: Env,
  db: SqliteDb,
  product: Product,
): Promise<string> {
  const { key } = await seedLicenseWithKey(db, "djdl");
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
    env,
    db,
    product,
    NOW,
  );
  return ((await res.json()) as { token: string }).token;
}

async function seedRecipe(
  db: SqliteDb,
  over: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    id: "applemusic",
    alg: "ES256",
    signing_key_secret: "applemusic_devkey",
    kid: "KID123",
    claims_template_json: JSON.stringify({ iss: "TEAMID123" }),
    ttl_seconds: 3600,
    audience: null as string | null,
    auth_page_template: null as string | null,
    ...over,
  };
  await db.run(
    "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
    "djdl",
    row.id,
    row.alg,
    row.signing_key_secret,
    row.kid,
    row.claims_template_json,
    row.ttl_seconds,
    row.audience,
    row.auth_page_template,
  );
}

describe("edge-mint token", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    // Mint key now lives sealed in product_secrets, addressed by the recipe's NAME.
    await seedProductSecret(db, "djdl", "applemusic_devkey", ES_PEM);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("requires a licensed bearer token (401 without one)", async () => {
    await seedRecipe(db);
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

  it("rejects an unknown / forged bearer token", async () => {
    await seedRecipe(db);
    const res = await handleMintToken(
      mkReq("POST", { authorization: "Bearer pkeyt_forged" }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("mints an ES256 token, server-setting iat/exp from the recipe ttl", async () => {
    const token = await activate(env, db, product);
    await seedRecipe(db);
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
    expect(payload.iss).toBe("TEAMID123");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
    expect(body.expiresAt).toBe(NOW + 3600);
  });

  it("does not let the template override the reserved iat/exp claims", async () => {
    const token = await activate(env, db, product);
    // Malicious template tries to pin a far-future exp and a fake iat.
    await seedRecipe(db, {
      claims_template_json: JSON.stringify({
        iss: "T",
        iat: 1,
        exp: 99999999999,
      }),
    });
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    const body = (await res.json()) as { token: string };
    const payload = jwtPart(body.token.split(".")[1]!);
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
  });

  it("404s for an unknown recipe id", async () => {
    const token = await activate(env, db, product);
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "does-not-exist",
      NOW,
    );
    expect(res.status).toBe(404);
  });

  it("500s when the recipe uses an unsupported alg", async () => {
    const token = await activate(env, db, product);
    await seedRecipe(db, { alg: "HS256" });
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(500);
  });

  it("500s when the mint signing key secret is absent", async () => {
    const token = await activate(env, db, product);
    await seedRecipe(db, { signing_key_secret: "EDGE_MINT__DJDL__MISSING" });
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(500);
  });

  // FIXED (R11-06): `JSON.parse(cfg.claims_template_json)` was unguarded, so a corrupt column
  // escaped as an uncaught SyntaxError. It now takes the same fail-closed `misconfigured`
  // branch as an unsupported alg or a missing key — never a token minted with a silently
  // emptied claims template.
  it("500s `misconfigured` (not an uncaught SyntaxError) on a corrupt claims template", async () => {
    const token = await activate(env, db, product);
    await seedRecipe(db, { claims_template_json: "{not json" });
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
  });
});

describe("edge-mint auth page + config lookup", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("serves the recipe's HTML auth page", async () => {
    await seedRecipe(db, { auth_page_template: "<html>MusicKit</html>" });
    const res = await handleMintAuth(db, product, "applemusic");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("MusicKit");
  });

  it("404s when the recipe has no auth page", async () => {
    await seedRecipe(db, { auth_page_template: null });
    expect((await handleMintAuth(db, product, "applemusic")).status).toBe(404);
  });

  it("404s for an unknown recipe", async () => {
    expect((await handleMintAuth(db, product, "ghost")).status).toBe(404);
  });

  it("getEdgeMintConfig is product-scoped", async () => {
    await seedProduct(db, "acme");
    await seedRecipe(db);
    expect(await getEdgeMintConfig(db, "djdl", "applemusic")).not.toBeNull();
    expect(await getEdgeMintConfig(db, "acme", "applemusic")).toBeNull();
  });
});
