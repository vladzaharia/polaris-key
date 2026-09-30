import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  UNKNOWN_DEVICE_TOKEN,
  approveEdgeMintRecipe,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
  TEST_KEK,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import {
  getApprovedEdgeMintConfig,
  getEdgeMintConfig,
  handleMintAuth,
  handleMintToken,
} from "../src/services/config/mint.js";
import { configService } from "../src/services/config/index.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { seal } from "../src/keyvault.js";
import { SqliteDb } from "../src/db/sqlite.js";
import { listAudit } from "../src/repo.js";
import type { Env } from "../src/env.js";

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
  device = "dev-1",
): Promise<string> {
  const { key } = await seedLicenseWithKey(db, "djdl", {
    id: `lic_djdl_${device}`,
  });
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
    }),
    env,
    db,
    product,
    NOW,
  );
  return ((await res.json()) as { token: string }).token;
}

/**
 * Seed a recipe row as a manifest ingest writes it. `approve` (default true) also records an
 * operator approval of exactly these values, so the signing tests below exercise signing; the
 * approval gate itself is pinned by the P0-12 suites further down.
 */
async function seedRecipe(
  db: SqliteDb,
  over: Record<string, unknown> = {},
  opts: { approve?: boolean } = {},
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
  if (opts.approve ?? true) await approveEdgeMintRecipe(db, "djdl", row.id);
}

describe("edge-mint token", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    // Mint key now lives sealed in product_secrets, addressed by the recipe's NAME, and an
    // operator has marked it as edge-mint key material (P0-12).
    await seedProductSecret(
      db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
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
      mkReq("POST", { authorization: `Bearer ${UNKNOWN_DEVICE_TOKEN}` }),
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

// ── P0-12: scope signing secrets and authorise minting ──────────────────────────────────────

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** Call the admin API as a platform admin (session cookie + CSRF, as the console does). */
async function admin(
  env: Env,
  db: SqliteDb,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, session } = await issueSession(
    env,
    { sub: "op-1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
    [CSRF_HEADER]: session.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const req = new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
  const res = await handleAdmin(req, env, db, path, { now: NOW });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

interface RecipeView {
  id: string;
  alg: string;
  signingKeySecret: string;
  kid: string | null;
  claimsTemplateJson: string | null;
  ttlSeconds: number;
  audience: string | null;
  status: string;
  secretUsage: string;
  changedFields: string[];
}

async function listRecipes(
  env: Env,
  db: SqliteDb,
): Promise<{ registration: string; recipes: RecipeView[] }> {
  const res = await admin(env, db, "GET", "/api/products/djdl/config/mint");
  expect(res.status).toBe(200);
  return res.body as unknown as { registration: string; recipes: RecipeView[] };
}

/** The approve body an operator's console sends: the recipe exactly as it was shown. */
function echoOf(r: RecipeView): Record<string, unknown> {
  return {
    alg: r.alg,
    signingKeySecret: r.signingKeySecret,
    kid: r.kid,
    claimsTemplateJson: r.claimsTemplateJson,
    ttlSeconds: r.ttlSeconds,
    audience: r.audience,
  };
}

async function mint(
  env: Env,
  db: SqliteDb,
  product: Product,
  token: string,
  id = "applemusic",
  ip = "203.0.113.1",
): Promise<Response> {
  return handleMintToken(
    mkReq("POST", {
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": ip,
    }),
    env,
    db,
    product,
    id,
    NOW,
  );
}

describe("P0-12 secret usage: edge-mint signs only with an edge-mint secret", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = adminEnv();
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("a recipe naming a general-usage secret returns 500 misconfigured and mints nothing", async () => {
    // A perfectly valid P-256 key, sealed as an ordinary (general) secret — e.g. something a
    // repo writer found in the secret list and pointed a recipe at. Approved, so the ONLY thing
    // standing in the way is the secret's usage.
    await seedProductSecret(db, "djdl", "OIDC_SECRET", ES_PEM);
    await seedRecipe(db, { signing_key_secret: "OIDC_SECRET" });
    const token = await activate(env, db, product);

    const res = await mint(env, db, product, token);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("misconfigured");
    expect(text).not.toContain('token":');
    expect(text).not.toContain("eyJ");
  });

  it("an explicit general usage (null) behaves the same as never having set one", async () => {
    await seedProductSecret(db, "djdl", "applemusic_devkey", ES_PEM, null);
    await seedRecipe(db);
    const token = await activate(env, db, product);
    expect((await mint(env, db, product, token)).status).toBe(500);
  });

  it("the admin PUT marks a secret edge-mint, audits the change, and keeps usage on a re-upload", async () => {
    await seedRecipe(db);
    const token = await activate(env, db, product);

    // General by default: the recipe cannot sign.
    const put1 = await admin(
      env,
      db,
      "PUT",
      "/api/products/djdl/secrets/applemusic_devkey",
      { value: ES_PEM },
    );
    expect(put1.status).toBe(200);
    expect(put1.body.usage).toBe("general");
    expect((await mint(env, db, product, token)).status).toBe(500);

    // The operator marks it for edge-minting.
    const put2 = await admin(
      env,
      db,
      "PUT",
      "/api/products/djdl/secrets/applemusic_devkey",
      { value: ES_PEM, usage: "edge-mint" },
    );
    expect(put2.status).toBe(200);
    expect(put2.body.usage).toBe("edge-mint");
    expect(JSON.stringify(put2.body)).not.toContain("PRIVATE KEY");
    expect((await mint(env, db, product, token)).status).toBe(200);

    // A rotated key uploaded WITHOUT a usage keeps the one it had.
    const put3 = await admin(
      env,
      db,
      "PUT",
      "/api/products/djdl/secrets/applemusic_devkey",
      { value: ES_PEM },
    );
    expect(put3.body.usage).toBe("edge-mint");
    expect((await mint(env, db, product, token)).status).toBe(200);

    // Demoting it back to general stops minting again.
    await admin(
      env,
      db,
      "PUT",
      "/api/products/djdl/secrets/applemusic_devkey",
      {
        value: ES_PEM,
        usage: "general",
      },
    );
    expect((await mint(env, db, product, token)).status).toBe(500);

    const actions = (await listAudit(db, "djdl", {})).map((r) => r.action);
    expect(actions.filter((a) => a === "secret.usage")).toHaveLength(2);
  });

  it("the admin PUT refuses an unknown usage", async () => {
    const res = await admin(env, db, "PUT", "/api/products/djdl/secrets/X", {
      value: "v",
      usage: "outlet",
    });
    expect(res.status).toBe(422);
    expect(res.body.fields).toEqual(["usage"]);
  });
});

describe("P0-12 recipe approval via the Config admin API", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = adminEnv();
    await seedProduct(db, "djdl");
    await seedProductSecret(
      db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("an unapproved recipe answers exactly like an unknown one, then mints once approved", async () => {
    await seedRecipe(db, {}, { approve: false });
    const token = await activate(env, db, product);

    const pending = await mint(env, db, product, token);
    const unknown = await mint(env, db, product, token, "does-not-exist");
    expect(pending.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Indistinguishable on the wire: same status, same body.
    expect(await pending.text()).toBe(await unknown.text());

    const listed = await listRecipes(env, db);
    expect(listed.registration).toBe("requires-license");
    expect(listed.recipes).toHaveLength(1);
    expect(listed.recipes[0]).toMatchObject({
      id: "applemusic",
      status: "pending",
      secretUsage: "edge-mint",
    });

    const approved = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      echoOf(listed.recipes[0]!),
    );
    expect(approved.status).toBe(200);
    expect((await listRecipes(env, db)).recipes[0]!.status).toBe("approved");
    expect((await mint(env, db, product, token)).status).toBe(200);

    // Revoke puts it straight back to 404.
    const revoked = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/revoke",
    );
    expect(revoked.status).toBe(200);
    expect((await mint(env, db, product, token)).status).toBe(404);

    const actions = (await listAudit(db, "djdl", {})).map((r) => r.action);
    expect(actions).toContain("config.mint.approve");
    expect(actions).toContain("config.mint.revoke");
  });

  it("refuses an approval whose echoed fields no longer match the recipe", async () => {
    await seedRecipe(db, {}, { approve: false });
    const shown = (await listRecipes(env, db)).recipes[0]!;
    // A push lands between the operator loading the console and clicking Approve.
    await db.run(
      "UPDATE edge_mint_config SET claims_template_json = ? WHERE product = 'djdl' AND id = 'applemusic'",
      JSON.stringify({ iss: "ATTACKER" }),
    );
    const res = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      echoOf(shown),
    );
    expect(res.status).toBe(409);
    expect(res.body.fields).toEqual(["claimsTemplateJson"]);
    expect(
      await getApprovedEdgeMintConfig(
        db,
        "djdl",
        "applemusic",
        product.registration,
      ),
    ).toBeNull();
  });

  it("refuses an approval that omits the echoed fields", async () => {
    await seedRecipe(db, {}, { approve: false });
    const res = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      {},
    );
    expect(res.status).toBe(422);
    expect(
      await getApprovedEdgeMintConfig(
        db,
        "djdl",
        "applemusic",
        product.registration,
      ),
    ).toBeNull();
  });

  it("on an open-registration product, refuses approval without acknowledgeOpenRegistration", async () => {
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({ registration: "open" }),
    );
    await seedRecipe(db, {}, { approve: false });
    const listed = await listRecipes(env, db);
    expect(listed.registration).toBe("open");
    const shown = listed.recipes[0]!;

    const refused = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      echoOf(shown),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.fields).toEqual(["acknowledgeOpenRegistration"]);
    expect(
      await getApprovedEdgeMintConfig(
        db,
        "djdl",
        "applemusic",
        product.registration,
      ),
    ).toBeNull();

    const accepted = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      { ...echoOf(shown), acknowledgeOpenRegistration: true },
    );
    expect(accepted.status).toBe(200);
    const row = (await listAudit(db, "djdl", {})).find(
      (r) => r.action === "config.mint.approve",
    );
    expect(row?.summary).toContain("open registration acknowledged");
  });

  it("an approval given under requires-license stops matching when registration opens, until re-approved with the acknowledgement", async () => {
    await seedRecipe(db, {}, { approve: false });
    const token = await activate(env, db, product);
    const shown = (await listRecipes(env, db)).recipes[0]!;
    // Closed policy: no acknowledgement is asked for, and none is recorded.
    expect(
      (
        await admin(
          env,
          db,
          "POST",
          "/api/products/djdl/config/mint/applemusic/approve",
          echoOf(shown),
        )
      ).status,
    ).toBe(200);
    expect((await mint(env, db, product, token)).status).toBe(200);

    // A push (or an operator edit) opens registration without touching the recipe.
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({ registration: "open" }),
    );
    const opened = (await loadProduct(env, db, "djdl"))!;
    expect(opened.registration).toBe("open");
    expect((await mint(env, db, opened, token)).status).toBe(404);
    const fragment = (await configService.discoveryFragment!({
      product: opened,
      env,
      db,
      base: "https://key.plrs.im/djdl",
    })) as { mint: { available: boolean } };
    expect(fragment.mint.available).toBe(false);

    const listed = await listRecipes(env, db);
    expect(listed.registration).toBe("open");
    expect(listed.recipes[0]).toMatchObject({
      status: "changed",
      changedFields: ["registration"],
      approval: { openRegistrationAcknowledged: false },
    });

    const refused = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      echoOf(listed.recipes[0]!),
    );
    expect(refused.status).toBe(422);
    const accepted = await admin(
      env,
      db,
      "POST",
      "/api/products/djdl/config/mint/applemusic/approve",
      { ...echoOf(listed.recipes[0]!), acknowledgeOpenRegistration: true },
    );
    expect(accepted.status).toBe(200);
    expect((await mint(env, db, opened, token)).status).toBe(200);
    expect((await listRecipes(env, db)).recipes[0]).toMatchObject({
      status: "approved",
      changedFields: [],
      approval: { openRegistrationAcknowledged: true },
    });
  });

  it("reports a changed recipe with the fields that changed", async () => {
    await seedRecipe(db);
    await db.run(
      "UPDATE edge_mint_config SET ttl_seconds = 86400 WHERE product = 'djdl' AND id = 'applemusic'",
    );
    const r = (await listRecipes(env, db)).recipes[0]!;
    expect(r.status).toBe("changed");
    expect(r.changedFields).toEqual(["ttlSeconds"]);
  });

  it("404s approve/revoke for an unknown recipe id", async () => {
    for (const action of ["approve", "revoke"]) {
      const res = await admin(
        env,
        db,
        "POST",
        `/api/products/djdl/config/mint/ghost/${action}`,
        {},
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("P0-12 per-device mint budget", () => {
  it("returns 429 after 30 mints in a minute from one device, while another device still mints", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedProductSecret(
      db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    await seedRecipe(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const one = await activate(env, db, product, "dev-1");
    const two = await activate(env, db, product, "dev-2");

    // Each request from a DIFFERENT IP, so the per-IP bucket (60/60s) can never be what trips.
    for (let i = 0; i < 30; i++) {
      const res = await mint(
        env,
        db,
        product,
        one,
        "applemusic",
        `198.51.100.${i}`,
      );
      expect(res.status).toBe(200);
    }
    const over = await mint(
      env,
      db,
      product,
      one,
      "applemusic",
      "198.51.100.200",
    );
    expect(over.status).toBe(429);
    expect(await over.text()).toContain("rate_limited");

    // The budget is the DEVICE's, not the product's.
    expect(
      (await mint(env, db, product, two, "applemusic", "198.51.100.201"))
        .status,
    ).toBe(200);
  });
});

describe("P0-12 discovery: config.mint.available", () => {
  it("is false while every recipe is pending, and true once one is approved", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const fragment = async () =>
      (await configService.discoveryFragment!({
        product,
        env,
        db,
        base: "https://key.plrs.im/djdl",
      })) as { mint: { available: boolean } };

    expect((await fragment()).mint.available).toBe(false);
    await seedRecipe(db, {}, { approve: false });
    await seedRecipe(db, { id: "other" }, { approve: false });
    expect((await fragment()).mint.available).toBe(false);

    await approveEdgeMintRecipe(db, "djdl", "other");
    expect((await fragment()).mint.available).toBe(true);

    // A later change to the approved recipe takes the bit away again.
    await db.run(
      "UPDATE edge_mint_config SET alg = 'RS256' WHERE product = 'djdl' AND id = 'other'",
    );
    expect((await fragment()).mint.available).toBe(false);
  });
});

describe("P0-12 migration backfill keeps deployed products minting", () => {
  const MIGRATIONS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sqlFor = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");
  const [beforeUsage, fromUsage] = [
    files.filter((f) => f < "0025"),
    files.filter((f) => f >= "0025"),
  ];

  it("a djdl-shaped fixture (recipe + secret) mints exactly as before", async () => {
    // A database as production has it the moment before this change deploys.
    const handle = new Database(":memory:");
    const runScript = handle.exec.bind(handle);
    for (const f of beforeUsage) runScript(sqlFor(f));
    const db = new SqliteDb(handle);
    await seedProduct(db, "djdl");

    // djdl's real recipe (products/djdl/product.json) and its sealed signing secret, written
    // with the pre-0025 column set — there is no `usage` yet.
    const djdl = JSON.parse(
      readFileSync(
        join(
          MIGRATIONS_DIR,
          "..",
          "..",
          "..",
          "products",
          "djdl",
          "product.json",
        ),
        "utf8",
      ),
    ) as {
      edgeMint: Array<{
        id: string;
        alg: string;
        signingKeySecret: string;
        kid: string;
        claimsTemplate: Record<string, unknown>;
        ttlSeconds: number;
      }>;
    };
    const recipe = djdl.edgeMint[0]!;
    const sealed = await seal({ PLATFORM_KEK: TEST_KEK } as Env, ES_PEM, {
      product: "djdl",
      kind: "product-secret",
      id: recipe.signingKeySecret,
    });
    await db.run(
      "INSERT INTO product_secrets (product, name, enc_value_json, created_at, modified_at) VALUES (?,?,?,?,?)",
      "djdl",
      recipe.signingKeySecret,
      sealed,
      NOW,
      NOW,
    );
    // An unrelated general secret must NOT be swept into edge-mint by the backfill.
    await db.run(
      "INSERT INTO product_secrets (product, name, enc_value_json, created_at, modified_at) VALUES ('djdl','OIDC_SECRET','x',?,?)",
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO edge_mint_config
         (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
      "djdl",
      recipe.id,
      recipe.alg,
      recipe.signingKeySecret,
      recipe.kid,
      JSON.stringify(recipe.claimsTemplate),
      recipe.ttlSeconds,
    );

    // Deploy: apply 0025 onward. Then replay the (idempotent) backfill file once more — it must
    // converge rather than duplicate or fail.
    for (const f of fromUsage) runScript(sqlFor(f));
    const backfill = fromUsage.find((f) => f.includes("edge_mint_approvals"))!;
    runScript(sqlFor(backfill));

    expect(
      handle
        .prepare(
          "SELECT product, name FROM product_secrets WHERE usage = 'edge-mint'",
        )
        .all(),
    ).toEqual([{ product: "djdl", name: recipe.signingKeySecret }]);
    expect(
      handle
        .prepare(
          "SELECT id, approved_by, open_registration_acknowledged FROM edge_mint_approvals WHERE product = 'djdl'",
        )
        .all(),
    ).toEqual([
      // The backfill carries today's behaviour, including under open registration.
      {
        id: recipe.id,
        approved_by: "migration",
        open_registration_acknowledged: 1,
      },
    ]);

    const env = makeEnv(new KvMock(), ["djdl"]);
    const product = (await loadProduct(env, db, "djdl"))!;
    const token = await activate(env, db, product);
    const res = await mint(env, db, product, token, recipe.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    const [h, p] = body.token.split(".") as [string, string, string];
    expect(jwtPart(h)).toMatchObject({ alg: "ES256", kid: recipe.kid });
    expect(jwtPart(p)).toMatchObject({
      ...recipe.claimsTemplate,
      iat: NOW,
      exp: NOW + recipe.ttlSeconds,
    });
    expect(body.expiresAt).toBe(NOW + recipe.ttlSeconds);

    // A product already running open registration keeps minting too: the backfill recorded the
    // acknowledgement, because that recipe was already a public mint before the upgrade.
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({ registration: "open" }),
    );
    const opened = (await loadProduct(env, db, "djdl"))!;
    expect(opened.registration).toBe("open");
    expect((await mint(env, db, opened, token, recipe.id)).status).toBe(200);
  });
});
