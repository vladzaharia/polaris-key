/**
 * plans/P3-01.md §2.2, "Keeping the signer total" — every write path and every signing route
 * (P3-12).
 *
 * The signer guards (`signerGuard.test.ts`) make the Worker refuse to sign what a wire-v4
 * verifier refuses. This suite proves the other half: stored operator data cannot trip them.
 *
 *  - the admin handlers refuse a value the manifest would refuse (`422 bad_request`) or that no
 *    signed document could carry (`422 value_not_representable`);
 *  - a stored config value that predates the checks is pruned from the config document;
 *  - OIDC sign-in stores an unsignable name or email as null;
 *  - every route that signs answers a guard refusal as `500 document_not_representable` in its
 *    own body shape, never as a throw.
 */

import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { bindFlow } from "./flowBinderHelper.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type KeyLike,
} from "jose";
import { verifyConfigDoc } from "@polaris-key/client-core";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq as deviceReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
  approveEdgeMintRecipe,
  TEST_KID,
  TEST_PEM,
  TEST_PUB,
} from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { handleTrustManifest } from "../src/core/trust/trust.js";
import { handleMintToken } from "../src/services/config/mint.js";
import { flowKey, handleAuthCallback } from "../src/services/identity/oidc.js";
import { getLicenseBySub } from "../src/core/repo.js";
import { artefacts } from "./singleUseMock.js";

// The OIDC suite swaps only the IdP's remote key getter, as `oidcEdge` and `R8-oidc` do, so the
// real `jwtVerify` still runs over the ID token.
const idpKey = vi.hoisted(() => ({
  getKey: null as null | (() => Promise<unknown>),
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => {
      if (!idpKey.getKey) throw new Error("no test IdP key installed");
      return idpKey.getKey();
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

const SLUG = "djdl";
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const TRUST = { [TEST_KID]: TEST_PUB };

/** A catalog with one key of each shape the vectors need. */
const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "app.blob",
      kind: "config",
      category: "App",
      label: "Blob",
      description: "Any object.",
      schema: { type: "object" },
    },
    {
      key: "app.label",
      kind: "config",
      category: "App",
      label: "Label",
      description: "Any string.",
      schema: { type: "string" },
    },
    {
      key: "app.ratio",
      kind: "config",
      category: "App",
      label: "Ratio",
      description: "Any number.",
      schema: { type: "number" },
    },
    {
      key: "app.secret",
      kind: "secret",
      category: "App",
      label: "Secret",
      description: "Any string, sealed at rest.",
      schema: { type: "string" },
    },
  ],
};

function nested(levels: number): unknown {
  let v: unknown = {};
  for (let k = 1; k < levels; k++) v = { x: v };
  return v;
}

/** The plan's refused values (§9, "P3-12's PR also shows"), each under the key it fits. */
const UNREPRESENTABLE: [string, string, unknown][] = [
  ["a lone surrogate", "app.label", "\ud800"],
  ["a U+0000 member name", "app.blob", { "a\u0000b": 1 }],
  [
    "canonically equivalent sibling names",
    "app.blob",
    { "\u00e9": 1, "e\u0301": 2 },
  ],
  ["1e-320", "app.ratio", 1e-320],
  ["33 levels", "app.blob", nested(33)],
  [
    "a lone surrogate in a secret, before it is sealed",
    "app.secret",
    "x\udc00",
  ],
];

// ── admin harness ─────────────────────────────────────────────────────────────

interface AdminWorld {
  db: Db;
  env: Env;
  cookie: string;
  csrf: string;
}

async function adminWorld(): Promise<AdminWorld> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG, { catalog: CATALOG });
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  return { db, env, cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

async function call(
  w: AdminWorld,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    cookie: w.cookie,
    [CSRF_HEADER]: w.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await handleAdmin(
    new Request(
      `https://key.plrs.im/manage${path}`,
      init,
    ) as unknown as Request,
    w.env,
    w.db,
    path,
    { now: NOW },
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const LICENSES = `/api/products/${SLUG}/license/licenses`;
const TIERS = `/api/products/${SLUG}/license/tiers`;
const PROFILES = `/api/products/${SLUG}/config/profiles`;

async function createLicense(w: AdminWorld): Promise<string> {
  const res = await call(w, "POST", LICENSES, { name: "Ada", email: "a@x.io" });
  expect(res.status).toBe(201);
  return res.body.licenseId as string;
}

function expectCode(
  res: { status: number; body: Record<string, unknown> },
  code: string,
  field?: string,
): void {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.code).toBe(code);
  if (field !== undefined)
    expect(res.body.fields as string[]).toEqual(
      expect.arrayContaining([expect.stringContaining(field)]),
    );
}

describe("licence overrides and profile payloads refuse an unrepresentable value (422 value_not_representable)", () => {
  let w: AdminWorld;
  beforeEach(async () => {
    w = await adminWorld();
  });

  for (const [name, key, value] of UNREPRESENTABLE) {
    it(`licence override: ${name}`, async () => {
      const id = await createLicense(w);
      const res = await call(w, "PUT", `${LICENSES}/${id}/overrides`, {
        updates: [{ key, value }],
      });
      expectCode(res, "value_not_representable", key);
    });

    it(`profile payload: ${name}`, async () => {
      expect((await call(w, "POST", PROFILES, { id: "base" })).status).toBe(
        201,
      );
      const res = await call(w, "PUT", `${PROFILES}/base`, {
        updates: [{ key, value }],
      });
      expectCode(res, "value_not_representable", key);
    });
  }

  it("a schema failure stays bad_request, and a clean value is stored", async () => {
    const id = await createLicense(w);
    expectCode(
      await call(w, "PUT", `${LICENSES}/${id}/overrides`, {
        updates: [{ key: "app.ratio", value: "seven" }],
      }),
      "bad_request",
    );
    const ok = await call(w, "PUT", `${LICENSES}/${id}/overrides`, {
      updates: [
        { key: "app.blob", value: { é: 1, "a/b": [1e-307, 9.99e307] } },
        { key: "app.label", value: "😀 x\u0000y" },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe("free text a signed document carries refuses a lone surrogate (422 value_not_representable)", () => {
  let w: AdminWorld;
  beforeEach(async () => {
    w = await adminWorld();
  });

  it("licence name and email, on create and on patch", async () => {
    expectCode(
      await call(w, "POST", LICENSES, { name: "Ada \ud800" }),
      "value_not_representable",
      "name",
    );
    const id = await createLicense(w);
    expectCode(
      await call(w, "PATCH", `${LICENSES}/${id}`, { email: "a\udc00@x.io" }),
      "value_not_representable",
      "email",
    );
  });

  it("tier label, on create and on patch", async () => {
    expectCode(
      await call(w, "POST", TIERS, { id: "pro", label: "Pro \ud800" }),
      "value_not_representable",
      "label",
    );
    expect(
      (await call(w, "POST", TIERS, { id: "pro", label: "Pro" })).status,
    ).toBe(201);
    expectCode(
      await call(w, "PATCH", `${TIERS}/pro`, { label: "\udfff" }),
      "value_not_representable",
      "label",
    );
  });

  it("a catalog publish whose default no document could carry", async () => {
    const res = await call(w, "PUT", `/api/products/${SLUG}/config/catalog`, {
      catalog: {
        schemaVersion: 1,
        entries: [{ ...CATALOG.entries[1], default: "\ud800" }],
      },
    });
    expectCode(res, "value_not_representable", "catalog");
  });
});

describe("catalog keys are member names in every document that carries them", () => {
  // A key is a string VALUE inside the catalog but a MEMBER NAME in `config.<key>`,
  // `secrets.<key>` and `entitlements.<key>`. `new Catalog(...)` applies no key rule and the
  // prune checks values, so both catalog write paths check the keys themselves.
  let w: AdminWorld;
  beforeEach(async () => {
    w = await adminWorld();
  });

  const NFC = "\u00e9";
  const NFD = "e\u0301";
  const withKeys = (...keys: string[]) => ({
    schemaVersion: 1,
    entries: keys.map((key) => ({ ...CATALOG.entries[1], key, default: "x" })),
  });
  const publish = (catalog: unknown) =>
    call(w, "PUT", `/api/products/${SLUG}/config/catalog`, { catalog });
  const create = (schema: unknown) =>
    call(w, "POST", "/api/products", { slug: "acme", schema });

  for (const [path, send] of [
    ["catalog publish", publish],
    ["manual product create", create],
  ] as const) {
    it(`${path}: two keys equal after NFC (Swift would keep one of them)`, async () => {
      const res = await send(withKeys(NFC, NFD));
      expectCode(res, "value_not_representable", "catalog/entries/1/key");
      expect(String(res.body.message)).toContain("equivalent-member-names");
    });

    it(`${path}: U+0000 in a key (the signer guard would refuse every config document)`, async () => {
      const res = await send(withKeys("app.ok", "app\u0000x"));
      expectCode(res, "value_not_representable", "catalog/entries/1/key");
      expect(String(res.body.message)).toContain("nul-in-member-name");
    });

    it(`${path}: a key outside the manifest's ID_RE`, async () => {
      expectCode(
        await send(withKeys("app.ok", "app label")),
        "bad_request",
        "catalog/entries/1/key",
      );
    });

    it(`${path}: ordinary keys are stored`, async () => {
      const res = await send(withKeys("app.ok", "app:other_key-2"));
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    });
  }
});

describe("the admin handlers take the manifest's own rules (422 bad_request)", () => {
  let w: AdminWorld;
  beforeEach(async () => {
    w = await adminWorld();
  });

  it("a tier id outside ID_RE", async () => {
    expectCode(
      await call(w, "POST", TIERS, { id: "pro tier!" }),
      "bad_request",
      "id",
    );
  });

  it("a channel outside CHANNEL_RE, on a tier and on a licence", async () => {
    expectCode(
      await call(w, "POST", TIERS, {
        id: "pro",
        channels: ["stable", "Beta Channel"],
      }),
      "bad_request",
      "channels.1",
    );
    expectCode(
      await call(w, "POST", LICENSES, { channels: ["-beta"] }),
      "bad_request",
      "channels.0",
    );
    const id = await createLicense(w);
    expectCode(
      await call(w, "PATCH", `${LICENSES}/${id}`, { channels: [7] }),
      "bad_request",
      "channels.0",
    );
  });

  it("a minVersion or maxVersion outside SEMVER_RE", async () => {
    expectCode(
      await call(w, "POST", TIERS, { id: "pro", minVersion: "1.2" }),
      "bad_request",
      "minVersion",
    );
    expect((await call(w, "POST", TIERS, { id: "pro" })).status).toBe(201);
    expectCode(
      await call(w, "PATCH", `${TIERS}/pro`, { maxVersion: "v2.0.0" }),
      "bad_request",
      "maxVersion",
    );
    expectCode(
      await call(w, "POST", LICENSES, { minVersion: "1.2.3\n" }),
      "bad_request",
      "minVersion",
    );
    const id = await createLicense(w);
    expectCode(
      await call(w, "PATCH", `${LICENSES}/${id}`, { maxVersion: "latest" }),
      "bad_request",
      "maxVersion",
    );
  });

  it("a product signingKid outside KID_RE", async () => {
    expectCode(
      await call(w, "POST", "/api/products", {
        slug: "acme",
        signingKid: "acme key!",
      }),
      "bad_request",
      "signingKid",
    );
    const ok = await call(w, "POST", "/api/products", {
      slug: "acme",
      signingKid: "acme-2026",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("a policyDeviceLimit above MAX_WIRE_INTEGER", async () => {
    expectCode(
      await call(w, "POST", TIERS, { id: "pro", policyDeviceLimit: 2 ** 53 }),
      "bad_request",
      "policyDeviceLimit",
    );
    expect(
      (
        await call(w, "POST", TIERS, {
          id: "pro",
          policyDeviceLimit: 2 ** 53 - 1,
        })
      ).status,
    ).toBe(201);
    expectCode(
      await call(w, "PATCH", `${TIERS}/pro`, { policyDeviceLimit: 1e300 }),
      "bad_request",
      "policyDeviceLimit",
    );
  });

  for (const days of [0, 366, 1.5, -1, "30"]) {
    it(`an offline-day count of ${JSON.stringify(days)} on every path that stores one`, async () => {
      expectCode(
        await call(w, "POST", LICENSES, { maxOfflineDays: days }),
        "bad_request",
        "maxOfflineDays",
      );
      const id = await createLicense(w);
      expectCode(
        await call(w, "PATCH", `${LICENSES}/${id}`, { maxOfflineDays: days }),
        "bad_request",
        "maxOfflineDays",
      );
      expectCode(
        await call(w, "PATCH", `/api/products/${SLUG}`, {
          defaultMaxOfflineDays: days,
        }),
        "bad_request",
        "defaultMaxOfflineDays",
      );
      expectCode(
        await call(w, "POST", "/api/products", {
          slug: "acme",
          defaultMaxOfflineDays: days,
        }),
        "bad_request",
        "defaultMaxOfflineDays",
      );
    });
  }

  it("accepts 1 and 365 offline days", async () => {
    expect(
      (await call(w, "POST", LICENSES, { maxOfflineDays: 1 })).status,
    ).toBe(201);
    expect(
      (
        await call(w, "PATCH", `/api/products/${SLUG}`, {
          defaultMaxOfflineDays: 365,
        })
      ).status,
    ).toBe(200);
  });
});

// ── device harness ────────────────────────────────────────────────────────────

interface DeviceWorld {
  db: SqliteDb;
  env: Env;
  product: Product;
}

async function deviceWorld(): Promise<DeviceWorld> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG, { catalog: CATALOG });
  const product = (await loadProduct(env, db, SLUG))!;
  return { db, env, product };
}

async function activate(
  w: DeviceWorld,
  key: string,
  device: string,
): Promise<string> {
  const res = await handleActivate(
    deviceReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** Write a licence's overrides as raw JSON text, the way a row stored before P3-12 can hold
 *  them: `JSON.stringify` writes a lone surrogate and U+0000 as ASCII escapes, which survive. */
async function storeOverrides(
  w: DeviceWorld,
  licenseId: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  await w.db.run(
    "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
    JSON.stringify({ config: {}, secrets: {}, entitlements: {}, ...overrides }),
    SLUG,
    licenseId,
  );
}

const entry = (value: unknown) => ({
  state: "enforced",
  value,
  updatedAt: NOW,
});

describe("a stored config value that predates the checks is pruned from the config document", () => {
  it("drops each flagged value and keeps the clean one", async () => {
    const w = await deviceWorld();
    const { licenseId, key } = await seedLicenseWithKey(w.db, SLUG);
    await storeOverrides(w, licenseId, {
      config: {
        "app.blob": entry({ "a\u0000b": 1 }),
        "app.label": entry("\ud800"),
        "app.ratio": entry(0.25),
      },
    });
    const token = await activate(w, key, "dev-prune");
    const res = await handleConfigDocument(
      deviceReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    const doc = await verifyConfigDoc(await res.text(), {
      lastAcceptedIssuedAt: null,
      trust: TRUST,
      expectedAud: SLUG,
      deviceId: "dev-prune",
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.config).toEqual({ "app.ratio": entry(0.25) });
  });
});

describe("every signing route answers a guard refusal as 500 document_not_representable", () => {
  it("the licence document (nested body): an entitlement stored with a lone surrogate", async () => {
    const w = await deviceWorld();
    const { licenseId, key } = await seedLicenseWithKey(w.db, SLUG);
    const token = await activate(w, key, "dev-lic");
    await storeOverrides(w, licenseId, {
      entitlements: { "app.flag": entry("\ud800") },
    });
    const res = await handleLicenseDocument(
      deviceReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.0.0",
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "document_not_representable" },
    });
  });

  it("the licence and config documents (nested body): an offline-day count beyond any safe graceUntil", async () => {
    const w = await deviceWorld();
    const { licenseId, key } = await seedLicenseWithKey(w.db, SLUG);
    const token = await activate(w, key, "dev-grace");
    await w.db.run(
      "UPDATE licenses SET max_offline_days = ? WHERE product = ? AND id = ?",
      1e20,
      SLUG,
      licenseId,
    );
    for (const handler of [handleLicenseDocument, handleConfigDocument]) {
      const res = await handler(
        deviceReq("GET", {
          authorization: `Bearer ${token}`,
          "x-pkey-version": "1.0.0",
        }),
        w.env,
        w.db,
        w.product,
        NOW,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: "document_not_representable" },
      });
    }
  });

  it("the trust manifest (nested body): a fractional clock", async () => {
    const w = await deviceWorld();
    const res = await handleTrustManifest(
      new Request(
        `https://key.plrs.im/${SLUG}/.well-known/pkey-trust`,
      ) as unknown as Request,
      w.env,
      w.db,
      w.product,
      NOW + 0.5,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "document_not_representable" },
    });
  });

  it("the offline bundle mint (the console's body): an entitlement stored with a lone surrogate", async () => {
    const w = await adminWorld();
    const id = await createLicense(w);
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: { "app.flag": entry("x\ud800") },
      }),
      SLUG,
      id,
    );
    const res = await call(w, "POST", `/api/products/${SLUG}/bundles`, {
      deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      graceDays: 30,
      licenseId: id,
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("document_not_representable");
    expect((res.body.error as { code: string }).code).toBe(
      "document_not_representable",
    );
  });

  it("the edge mint (flat body): an EdDSA claims template stored with a lone surrogate", async () => {
    const w = await deviceWorld();
    await seedProductSecret(w.db, SLUG, "MINT_KEY", TEST_PEM, "edge-mint");
    await w.db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      SLUG,
      "svc",
      "EdDSA",
      "MINT_KEY",
      "svc-1",
      JSON.stringify({ sub: "\ud800" }),
      600,
      null,
      null,
    );
    await approveEdgeMintRecipe(w.db, SLUG, "svc");
    const { key } = await seedLicenseWithKey(w.db, SLUG);
    const token = await activate(w, key, "dev-mint");
    const res = await handleMintToken(
      deviceReq("POST", {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.9",
      }),
      w.env,
      w.db,
      w.product,
      "svc",
      NOW,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "document_not_representable",
    );
  });
});

// ── OIDC sign-in ──────────────────────────────────────────────────────────────

describe("OIDC sign-in stores an unsignable name or email as null", () => {
  const ISSUER = "https://id.example";
  const AUD = "client-djdl";
  const REDIRECT = `https://key.plrs.im/${SLUG}/identity/auth/callback`;

  async function signIn(claims: Record<string, unknown>): Promise<{
    w: DeviceWorld;
    status: number;
  }> {
    const w = await deviceWorld();
    await w.db.run(
      `INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret,
         redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)`,
      SLUG,
      "custom",
      ISSUER,
      AUD,
      null,
      JSON.stringify([REDIRECT]),
      JSON.stringify({ members: { role: "user" } }),
    );
    const pair = await generateKeyPair("ES256", { extractable: true });
    const pub = await importJWK(
      { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "idp" },
      "ES256",
    );
    idpKey.getKey = async () => pub;
    const idToken = await new SignJWT({
      nonce: "n",
      groups: ["members"],
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "idp" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(pair.privateKey as KeyLike);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) =>
        (await issuerMetadataResponse(String(input), idpKey.getKey, {
          kid: "idp",
        })) ??
        new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await artefacts(w.env).put(
      await flowKey(w.env, SLUG, "S"),
      JSON.stringify({ verifier: "v", nonce: "n", redirectUri: REDIRECT }),
    );
    const res = await handleAuthCallback(
      new Request(
        `https://key.plrs.im/${SLUG}/identity/auth/callback?code=c&state=S`,
        { headers: { cookie: await bindFlow(w.env, SLUG, "S") } },
      ) as unknown as Request,
      w.env,
      w.db,
      w.product,
      NOW,
    );
    return { w, status: res.status };
  }

  it("a lone surrogate in name stores a null name", async () => {
    const { w, status } = await signIn({
      sub: "user-1",
      name: "Ada \ud800",
      email: "ada@x.io",
      email_verified: true,
    });
    expect(status).toBeLessThan(400);
    const lic = await getLicenseBySub(w.db, SLUG, "user-1");
    expect(lic).not.toBeNull();
    expect(lic!.name).toBeNull();
    expect(lic!.email).toBe("ada@x.io");
  });

  it("a lone surrogate in a verified email stores a null email", async () => {
    const { w } = await signIn({
      sub: "user-2",
      name: "Ada",
      email: "a\udc00@x.io",
      email_verified: true,
    });
    const lic = await getLicenseBySub(w.db, SLUG, "user-2");
    expect(lic!.email).toBeNull();
    expect(lic!.name).toBe("Ada");
  });
});
