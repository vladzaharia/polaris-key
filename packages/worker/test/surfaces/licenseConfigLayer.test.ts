/**
 * U-27.1: the licence override layer (layer 4) is read for every licence and is writable for
 * config, secret and flag keys, whatever `override_migration` holds. Built on the real document
 * builders with a fixed `now` and the test key.
 */
import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { getLicense } from "../../src/core/licensing/store.js";
import { setServices } from "../../src/core/products/store.js";
import { serializeServices } from "../../src/core/services.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { subjectFor } from "../../src/core/accounts/accountSubjects.js";
import { putAccountOverrides } from "../../src/core/accounts/accountOverrides.js";
import { sealManagedValue } from "../../src/core/managedSecrets.js";
import { handleActivate } from "../../src/services/license/activation.js";
import { handleConfigDocument } from "../../src/services/config/document.js";
import { signIn } from "../../src/services/identity/accounts/signIn.js";
import { handleAdmin } from "../../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../../src/core/console/session.js";
import { consoleTestSession } from "../consoleSessionHelper.js";

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
          connect: { enabled: false },
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

const MIGRATED = NOW + 40 * 86_400;

/** An `override_migration` row whose run started and completed (the retired state of U-03). */
async function markMigrationComplete(db: Db): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO override_migration
       (id, notice_started_at, run_id, run_started_at, run_completed_at, updated_at)
     VALUES ('platform', ?, 'ovm_done', ?, ?, ?)`,
    NOW,
    MIGRATED - 100,
    MIGRATED - 50,
    MIGRATED,
  );
}

describe.each([
  ["no migration row", false],
  ["a completed migration run", true],
])("U-27.1: the licence layer with %s", (_label, migrated) => {
  const at = migrated ? MIGRATED : NOW;

  it("(a) a floating licence's config and secret overrides reach the config document", async () => {
    const w = await world();
    if (migrated) await markMigrationComplete(w.db);
    const sealed = await sealManagedValue(w.env, SLUG, "api.token", "tok-f");
    const key = await licence(w, "lic-float", {
      owner: null,
      email: null,
      config: { theme: entry("dark", NOW - 50) },
      secrets: { "api.token": entry(sealed, NOW - 40, "hidden") },
    });
    const token = await activate(w, key, "dev-float");
    const { doc } = await configDoc(w, token, at);
    expect(doc.config.theme?.value).toBe("dark");
    expect(doc.secrets["api.token"]?.value).toBe("tok-f");
  });

  it("(b) an owned licence's own key reaches key-entry and owner devices; the account row wins", async () => {
    const w = await world();
    if (migrated) await markMigrationComplete(w.db);
    const ada = await account(w.db, "ada@example.com");
    const key = await licence(w, "lic-ada", {
      owner: ada.id,
      config: { theme: entry("dark", NOW - 50), volume: entry(7, NOW - 40) },
    });
    const keyToken = await activate(w, key, "dev-key");
    const ownerToken = await activate(w, key, "dev-owner");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-owner'",
      ada.subject,
      SLUG,
    );
    for (const t of [keyToken, ownerToken]) {
      const { doc } = await configDoc(w, t, at);
      expect(doc.config.theme?.value).toBe("dark");
      expect(doc.config.volume?.value).toBe(7);
    }
    const subject = await subjectFor(w.db, ada.id, SLUG, NOW);
    await putAccountOverrides(
      w.db,
      SLUG,
      subject,
      { config: { theme: entry("light", NOW) }, secrets: {} },
      "op-1",
      NOW,
    );
    for (const t of [keyToken, ownerToken]) {
      const { doc } = await configDoc(w, t, at);
      expect(doc.config.theme?.value).toBe("light"); // the account row wins
      expect(doc.config.volume?.value).toBe(7); // the licence-only key stays
    }
  });

  it("(c) PUT overrides of a config key and a secret key answers 200 and seals the secret", async () => {
    const w = await world();
    if (migrated) await markMigrationComplete(w.db);
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-owned", { owner: ada.id });
    await licence(w, "lic-float", { owner: null, email: null });
    for (const id of ["lic-owned", "lic-float"]) {
      const res = await w.call(
        "PUT",
        `/products/${SLUG}/license/licenses/${id}/overrides`,
        {
          updates: [
            { key: "theme", value: "dark" },
            { key: "api.token", value: "tok-secret" },
          ],
        },
        { now: at },
      );
      expect(res.status).toBe(200);
      const raw = (await getLicense(w.db, SLUG, id))!.overrides_json!;
      expect(raw).not.toContain("tok-secret");
      const stored = JSON.parse(raw);
      expect(stored.config.theme.value).toBe("dark");
      expect(typeof stored.secrets["api.token"].value).toBe("string");
    }
  });
});

it("(d) catalog used-by lists a licence for a config key it sets, with a completed migration", async () => {
  const w = await world();
  await markMigrationComplete(w.db);
  await licence(w, "lic-1", {
    owner: null,
    email: null,
    config: { theme: entry("dark") },
  });
  await licence(w, "lic-2", { owner: null, email: null });
  const res = await w.call(
    "GET",
    `/products/${SLUG}/config/catalog/usage?key=theme`,
    undefined,
    { now: MIGRATED },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    keys: Record<string, { licenses: { id: string }[] }>;
  };
  expect(body.keys.theme!.licenses.map((l) => l.id)).toEqual(["lic-1"]);
});
