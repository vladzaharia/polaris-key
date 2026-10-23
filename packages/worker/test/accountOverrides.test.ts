/**
 * U-03: the account override layer (notes/S-17 §5.5; plans/U-01.md §6.3; decisions 3, 4, 20 and
 * 21). The licence-override migration these tests once ran is gone (U-27.4): the licence layer is
 * always read (U-27.1), so no test moves values between layers.
 *
 *   3. a signed-in device on a licence another account owns receives its own account's layer;
 *   6. PUT /licenses/<id>/overrides accepts config, secrets and entitlements, on owned and
 *      floating licences (U-27.1);
 *   7. an account merge copies and reports colliding account overrides (§5.5);
 *
 * and around them: product deletion, the layer's place in the merge and its ETag, the console
 * editor, and the OIDC provisioning writer's account-row secrets.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { getLicense } from "../src/core/licensing/store.js";
import { getDevice } from "../src/core/devices/store.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices } from "../src/core/services.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  setDeviceSubject,
  subjectFor,
} from "../src/core/accounts/accountSubjects.js";
import {
  applyProvisionedAccountSecrets,
  getAccountOverrides,
  overrideSubject,
  parseAccountOverridePayload,
  putAccountOverrides,
} from "../src/core/accounts/accountOverrides.js";
import { resolveMergedPayload } from "../src/core/licensing/payload.js";
import { sealManagedValue } from "../src/core/managedSecrets.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import {
  attachLicense,
  detachLicense,
} from "../src/services/identity/accounts/claim.js";
import { handleAdmin } from "../src/console/index.js";
import { deleteProduct } from "../src/core/products/store.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { consoleTestSession, consoleActor } from "./consoleSessionHelper.js";

const SLUG = "djdl";
const PLATFORM_GROUP = "platform-admins";

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "theme",
      kind: "config",
      category: "UI",
      label: "Theme",
      description: "The colour theme.",
      schema: { type: "string" },
      default: "system",
    },
    {
      key: "volume",
      kind: "config",
      category: "Audio",
      label: "Volume",
      description: "The master volume.",
      schema: { type: "number" },
    },
    {
      key: "lang",
      kind: "config",
      category: "UI",
      label: "Language",
      description: "The interface language.",
      schema: { type: "string" },
    },
    {
      key: "cfg.password",
      kind: "config",
      secret: true,
      category: "Secrets",
      label: "Password",
      description: "A config key the catalog flags secret.",
      schema: { type: "string" },
    },
    {
      key: "api.token",
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "API token",
      description: "A managed secret.",
      schema: { type: "string" },
    },
    {
      key: "pro",
      kind: "flag",
      category: "Plans",
      label: "Pro",
      description: "The pro features.",
      schema: { type: "boolean" },
    },
  ],
};

interface World {
  db: Db;
  env: Env;
  product: Product;
  call: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { now?: number; authAt?: number; db?: Db },
  ) => Promise<Response>;
}

async function world(
  opts: { identity?: boolean; products?: string[] } = {},
): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  for (const slug of opts.products ?? [SLUG]) {
    await seedProduct(db, slug, { catalog: CATALOG });
    await setServices(
      db,
      slug,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: opts.identity ?? true },
          sync: { enabled: false },
          commerce: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
  }
  const product = (await loadProduct(env, db, SLUG))!;
  const call: World["call"] = async (method, path, body, o = {}) => {
    const now = o.now ?? NOW;
    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "op-1",
        name: "Ada Operator",
        email: "ops@studio.example",
        groups: [PLATFORM_GROUP],
        authTime: o.authAt ?? now,
        stepUp: true,
      },
      now,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
    };
    if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const full = `/api${path}`;
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      o.db ?? db,
      full.split("?")[0]!,
      { now },
    );
  };
  return { db, env, product, call };
}

async function account(
  db: Db,
  email: string,
): Promise<{ id: string; subject: string }> {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id, subject: r.subject! };
}

const entry = (value: unknown, updatedAt = NOW, state = "enforced") =>
  ({ state, value, updatedAt }) as ManagedEntry;

/** A licence with overrides, an owner (account id) or none, and its email. */
async function licence(
  w: World,
  id: string,
  opts: {
    config?: Record<string, ManagedEntry>;
    secrets?: Record<string, ManagedEntry>;
    entitlements?: Record<string, ManagedEntry>;
    owner?: string | null;
    email?: string | null;
    product?: string;
  } = {},
): Promise<string> {
  const product = opts.product ?? SLUG;
  const { key } = await seedLicenseWithKey(w.db, product, {
    id,
    config: opts.config,
    secrets: opts.secrets,
    entitlements: opts.entitlements,
  });
  await w.db.run(
    "UPDATE licenses SET account_id = ?, email = ? WHERE product = ? AND id = ?",
    opts.owner ?? null,
    opts.email === undefined ? "buyer@example.com" : opts.email,
    product,
    id,
  );
  return key;
}

/** Licence-key activation through the real route; answers the device token. */
async function activate(
  w: World,
  key: string,
  deviceId: string,
): Promise<string> {
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": deviceId,
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** The signed config document a device receives, its content without the per-request
 *  timestamps, and its ETag. */
async function configDoc(
  w: World,
  token: string,
  now = NOW,
): Promise<{ doc: ConfigDoc; content: string; etag: string | null }> {
  const res = await handleConfigDocument(
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag");
  const verified = await verifyJws<ConfigDoc>(await res.text(), {
    [TEST_KID]: TEST_PUB,
  });
  const doc = verified!.payload;
  const { issuedAt: _i, expiresAt: _e, graceUntil: _g, ...content } = doc;
  void _i;
  void _e;
  void _g;
  return { doc, content: JSON.stringify(content), etag };
}

// ── The eight tests (S-17 §5.12) ──────────────────────────────────────────────────────────────

describe("U-03 §5.12: the account override layer", () => {
  it("3. a signed-in device on a licence another account owns receives its own account's layer", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const key = await licence(w, "lic-ada", {
      owner: ada.id,
      config: { theme: entry("dark") },
    });
    const tKey = await activate(w, key, "dev-key");
    const tBo = await activate(w, key, "dev-bo");
    expect(
      await setDeviceSubject(w.env, w.db, SLUG, "dev-bo", bo.subject),
    ).toBe(true);
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      { config: { theme: entry("blue"), lang: entry("de") }, secrets: {} },
      "op-1",
      NOW,
    );
    const boDoc = (await configDoc(w, tBo)).doc;
    expect(boDoc.config.theme?.value).toBe("blue");
    expect(boDoc.config.lang?.value).toBe("de");
    // The key-entry device on the same licence gets the licence's own layer.
    const keyDoc = (await configDoc(w, tKey)).doc;
    expect(keyDoc.config.theme?.value).toBe("dark");
    expect(keyDoc.config.lang).toBeUndefined();
  });

  it("6. PUT /licenses/<id>/overrides accepts config, secret and flag keys, owned and floating (U-27.1)", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-owned", { owner: ada.id });
    await licence(w, "lic-float", { owner: null, email: null });
    const put = (id: string, updates: unknown[], now = NOW) =>
      w.call(
        "PUT",
        `/products/${SLUG}/license/licenses/${id}/overrides`,
        { updates },
        { now },
      );
    expect(
      (await put("lic-owned", [{ key: "theme", value: "dark" }])).status,
    ).toBe(200);
    for (const id of ["lic-owned", "lic-float"]) {
      for (const update of [
        { key: "theme", value: "dark" },
        { key: "api.token", value: "tok-x" },
        { key: "pro", value: true },
      ]) {
        expect((await put(id, [update])).status).toBe(200);
      }
      const lic = (await getLicense(w.db, SLUG, id))!;
      const stored = JSON.parse(lic.overrides_json!);
      expect(stored.config.theme.value).toBe("dark");
      expect(stored.entitlements.pro.value).toBe(true);
      expect(lic.overrides_json).not.toContain("tok-x");
    }
    const detail = (await (
      await w.call("GET", `/products/${SLUG}/license/licenses/lic-float`)
    ).json()) as { configOverrides: Record<string, unknown> };
    expect(detail.configOverrides).toMatchObject({
      owned: false,
      ownerSubject: null,
      signUpUrl: `https://key.plrs.im/activate?product=${SLUG}`,
    });
    // U-27 (L-U6): no phase and no run date, so an old cached console reads `license`.
    expect(detail.configOverrides).not.toHaveProperty("phase");
    expect(detail.configOverrides).not.toHaveProperty("runNotBefore");
  });

  it("7. an account merge copies the absorbed account's overrides and reports the collisions (§5.5)", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const sealedBo = await sealManagedValue(w.env, SLUG, "api.token", "tok-bo");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("dark"), volume: entry(3) }, secrets: {} },
      "op-1",
      NOW,
    );
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      {
        config: { theme: entry("light"), volume: entry(3), lang: entry("fr") },
        secrets: { "api.token": entry(sealedBo, NOW, "hidden") },
      },
      "op-1",
      NOW,
    );
    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: ada.id, authenticatedAt: NOW },
        absorbed: { accountId: bo.id, authenticatedAt: NOW },
      },
    );
    expect(merged.ok).toBe(true);
    const survivor = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(survivor.config.theme?.value).toBe("dark"); // the survivor's value wins
    expect(survivor.config.lang?.value).toBe("fr"); // copied
    expect(survivor.config.volume?.value).toBe(3); // equal: not a collision
    expect(survivor.secrets["api.token"]?.value).toBe(sealedBo); // copied sealed
    expect(await getAccountOverrides(w.db, SLUG, bo.subject)).toBeNull();
    const audit = await w.db.all<{
      action: string;
      target_id: string;
      summary: string;
    }>(
      "SELECT action, target_id, summary FROM audit WHERE product = ? AND action = 'user.overrides.merge'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(ada.subject);
    expect(audit[0]!.summary).toContain('theme (kept "dark", dropped "light")');
    expect(audit[0]!.summary).not.toContain("volume");
    expect(audit[0]!.summary).not.toContain("tok-bo");
    // A bo-bound device now resolves to the survivor's layer (the alias, D21).
    const key = await licence(w, "lic-bo", { owner: ada.id });
    await activate(w, key, "dev-bo");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-bo'",
      bo.subject,
      SLUG,
    );
    const device = (await getDevice(w.db, SLUG, "dev-bo"))!;
    const lic = (await getLicense(w.db, SLUG, "lic-bo"))!;
    expect(await overrideSubject(w.db, SLUG, lic, device)).toBe(ada.subject);
    // Idempotent: a retried hook finds no absorbed row and changes nothing.
    const { accountOverrideStore } =
      await import("../src/services/config/accountOverrideStore.js");
    await accountOverrideStore.merge(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, from: bo.subject, to: ada.subject },
    );
    expect(
      parseAccountOverridePayload(
        (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
      ),
    ).toEqual(survivor);
  });
});

describe("U-03: product deletion", () => {
  it("removes the product's account overrides, and only the product's", async () => {
    const w = await world({ products: [SLUG, "beta"] });
    const ada = await account(w.db, "ada@example.com");
    const adaBeta = await subjectFor(w.db, ada.id, "beta", NOW);
    for (const [product, subject] of [
      [SLUG, ada.subject],
      ["beta", adaBeta],
    ] as const) {
      await putAccountOverrides(
        w.db,
        product,
        subject,
        { config: { theme: entry("dark") }, secrets: {} },
        "op-1",
        NOW,
      );
    }
    await deleteProduct(w.db, SLUG, NOW);
    const left = async (table: string) =>
      (
        await w.db.all<{ product: string }>(
          `SELECT product FROM ${table} ORDER BY product`,
        )
      ).map((r) => r.product);
    expect(await left("account_overrides")).toEqual(["beta"]);
  });
});

// ── The layer itself ─────────────────────────────────────────────────────────────────────────

describe("U-03: the account override layer", () => {
  it("sits after the licence overrides and before the device's; the ETag follows it", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const key = await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark"), volume: entry(1) },
    });
    const token = await activate(w, key, "dev-1");
    const first = await configDoc(w, token);
    // Expand phase: both layers are read, the account's above the licence's.
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("blue") }, secrets: {} },
      "op-1",
      NOW,
    );
    const second = await configDoc(w, token);
    expect(second.doc.config.theme?.value).toBe("blue");
    expect(second.doc.config.volume?.value).toBe(1);
    expect(second.etag).not.toBe(first.etag);
    // A device override still wins.
    await w.db.run(
      "UPDATE devices SET overrides_json = ? WHERE product = ? AND device_id = 'dev-1'",
      JSON.stringify({
        config: { theme: entry("green") },
        secrets: {},
        entitlements: {},
      }),
      SLUG,
    );
    expect((await configDoc(w, token)).doc.config.theme?.value).toBe("green");
    // Entitlement-only callers never read it, and their answer is unchanged.
    const lic = (await getLicense(w.db, SLUG, "lic-1"))!;
    const full = await resolveMergedPayload(w.db, SLUG, lic, null, NOW);
    const ents = await resolveMergedPayload(w.db, SLUG, lic, null, NOW, {
      entitlementsOnly: true,
    });
    expect(ents.payload.entitlements).toEqual(full.payload.entitlements);
  });

  it("applies outside the licence: a licence-less signed-in device gets its account's layer", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("blue") }, secrets: {} },
      "op-1",
      NOW,
    );
    const device = {
      product: SLUG,
      status: "authorized",
      license_id: "",
      subject: ada.subject,
    };
    expect(await overrideSubject(w.db, SLUG, null, device)).toBe(ada.subject);
    const merged = await resolveMergedPayload(
      w.db,
      SLUG,
      null,
      device as never,
      NOW,
    );
    expect(merged.payload.config.theme?.value).toBe("blue");
    // A malformed or unknown binding gives no layer.
    expect(
      await overrideSubject(w.db, SLUG, null, { ...device, subject: "nope" }),
    ).toBeNull();
    expect(
      await overrideSubject(w.db, SLUG, null, { ...device, status: "revoked" }),
    ).toBeNull();
  });
});

describe("U-03: Remove from my library drops the account's layer for that licence (S-24 D19)", () => {
  it("a device bound to the removing account loses its layer for the licence; other accounts keep theirs; re-adding restores it", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const key = await licence(w, "lic-ada", {
      owner: ada.id,
      email: "ada@example.com",
    });
    const tAda = await activate(w, key, "dev-ada");
    const tBo = await activate(w, key, "dev-bo");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-ada", ada.subject);
    await setDeviceSubject(w.env, w.db, SLUG, "dev-bo", bo.subject);
    for (const [subject, theme] of [
      [ada.subject, "ada-blue"],
      [bo.subject, "bo-green"],
    ] as const)
      await putAccountOverrides(
        w.db,
        SLUG,
        subject,
        { config: { theme: entry(theme) }, secrets: {} },
        "op-1",
        NOW,
      );
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("ada-blue");

    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    expect(
      (
        await detachLicense(ctx, {
          accountId: ada.id,
          product: SLUG,
          licenseId: "lic-ada",
        })
      ).ok,
    ).toBe(true);
    // The licence keeps its email (assigned, waiting), so it is not floating; but for Ada's
    // devices it is as if it were: no account layer from it, and no owner to fall back to.
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("system");
    expect((await configDoc(w, tBo)).doc.config.theme?.value).toBe("bo-green");

    // Adding it back with its key lifts the block.
    const back = await attachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: "lic-ada",
      via: "key",
    });
    expect(back.ok).toBe(true);
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("ada-blue");
  });
});

// ── The console editor ───────────────────────────────────────────────────────────────────────

describe("U-03: GET and PUT users/<subject>/overrides", () => {
  it("edits config and secrets for one subject, seals secrets, refuses flags, audits key names only", async () => {
    const w = await world({ identity: false });
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-1", { owner: ada.id });
    const path = `/products/${SLUG}/users/${ada.subject}/overrides`;
    const empty = (await (await w.call("GET", path)).json()) as Record<
      string,
      unknown
    >;
    expect(empty).toMatchObject({
      subject: ada.subject,
      configOn: true,
      overrides: { config: {}, secrets: {} },
      updatedAt: null,
    });
    // U-27: the licence layer is always read, so there is nothing to retire.
    expect(empty).not.toHaveProperty("licenseLayerRetired");
    const flag = await w.call("PUT", path, {
      updates: [{ key: "pro", value: true }],
    });
    expect(flag.status).toBe(422);
    expect(((await flag.json()) as { fields: string[] }).fields[0]).toContain(
      "entitlement overrides stay on the license",
    );
    const bad = await w.call("PUT", path, {
      updates: [{ key: "volume", value: "loud" }],
    });
    expect(bad.status).toBe(422);
    const ok = await w.call("PUT", path, {
      updates: [
        { key: "theme", value: "dark", state: "enforced" },
        { key: "api.token", value: "tok-EDITOR" },
        { key: "cfg.password", value: "pw-EDITOR" },
      ],
    });
    expect(ok.status).toBe(200);
    const stored = (await getAccountOverrides(w.db, SLUG, ada.subject))!;
    expect(stored.updated_by).toBe(await consoleActor(w.env, w.db, "op-1"));
    expect(stored.payload_json).not.toContain("tok-EDITOR");
    expect(stored.payload_json).not.toContain("pw-EDITOR");
    const got = await w.call("GET", path);
    const text = await got.text();
    expect(text).not.toContain("tok-EDITOR");
    expect(text).not.toContain("pw-EDITOR");
    expect(JSON.parse(text).overrides).toMatchObject({
      config: { theme: { value: "dark" }, "cfg.password": { value: "" } },
      secrets: { "api.token": { configured: true } },
    });
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = ? AND action = 'user.overrides'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("theme, api.token, cfg.password");
    expect(audit[0]!.summary).not.toContain("dark");
    // The key-entry device of Ada's licence does NOT receive her secrets.
    const key = await licence(w, "lic-2", { owner: ada.id });
    const token = await activate(w, key, "dev-1");
    const { doc } = await configDoc(w, token);
    expect(doc.secrets["api.token"]).toBeUndefined();
    expect(doc.config["cfg.password"]).toBeUndefined();
    // A device signed in as Ada gets them, opened.
    const key2 = await licence(w, "lic-3", { owner: ada.id });
    const token2 = await activate(w, key2, "dev-2");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-2'",
      ada.subject,
      SLUG,
    );
    const signed = (await configDoc(w, token2)).doc;
    expect(signed.secrets["api.token"]?.value).toBe("tok-EDITOR");
    expect(signed.config["cfg.password"]?.value).toBe("pw-EDITOR");
    // Clearing every key removes the row.
    await w.call("PUT", path, {
      updates: [
        { key: "theme" },
        { key: "api.token" },
        { key: "cfg.password" },
      ],
    });
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).toBeNull();
    // An unknown subject is a 404, like every Users route.
    expect(
      (
        await w.call(
          "GET",
          `/products/${SLUG}/users/ps_AAAAAAAAAAAAAAAAAAAAAA/overrides`,
        )
      ).status,
    ).toBe(404);
  });
});

// ── The OIDC provisioning writer and the nightly job ─────────────────────────────────────────

describe("U-03: provisioned secrets", () => {
  it("applyProvisionedAccountSecrets rewrites only the declared keys, sealed, keeping an operator's", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      {
        config: { theme: entry("dark") },
        secrets: { "api.token": entry("old") },
      },
      "op-1",
      NOW,
    );
    await applyProvisionedAccountSecrets(
      w.env,
      w.db,
      SLUG,
      ada.id,
      { "proxy.url": entry("https://proxy.example/u/ada", NOW, "hidden") },
      new Set(["proxy.url"]),
      NOW,
    );
    let row = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(row.config.theme?.value).toBe("dark");
    expect(row.secrets["api.token"]?.value).toBe("old");
    expect(String(row.secrets["proxy.url"]?.value)).not.toContain(
      "proxy.example",
    );
    // The claim disappeared: the declared key goes, nothing else does.
    await applyProvisionedAccountSecrets(
      w.env,
      w.db,
      SLUG,
      ada.id,
      {},
      new Set(["proxy.url"]),
      NOW,
    );
    row = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(Object.keys(row.secrets)).toEqual(["api.token"]);
  });

  it("provisioning writes only while the signing-in identity is linked to the owner account", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const args = [
      w.env,
      w.db,
      SLUG,
      ada.id,
      { "proxy.url": entry("https://proxy.example/prev", NOW, "hidden") },
      new Set(["proxy.url"]),
      NOW,
    ] as const;
    // The previous owner's OIDC sub is not linked to the current owner: nothing is written.
    await applyProvisionedAccountSecrets(...args, "oidc-sub-previous-owner");
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).toBeNull();
    await w.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, display_name, amr_json, created_at, last_used_at)
       VALUES ('lnk-oidc', ?, 'iss', '', 'oidc-sub-ada', 'oidc', NULL, 0, NULL, '[]', ?, ?)`,
      ada.id,
      NOW,
      NOW,
    );
    await applyProvisionedAccountSecrets(...args, "oidc-sub-ada");
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).not.toBeNull();
  });
});
