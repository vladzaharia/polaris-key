/**
 * Profile secrets across a manifest resync (R2).
 *
 * `resyncRepo` replaces the `profiles` rows from `.pkey/product` on every push. A manifest can
 * never carry a secret VALUE — a sealed envelope is minted by the console under `PLATFORM_KEK`,
 * and a plaintext secret has no business in a repo — so a profile's secret values are set in the
 * console, and the replace used to wipe them on the next push: a product that delivered an API
 * key through a tier profile silently stopped delivering it after any `.pkey/` change.
 *
 * The rule pinned here: for every profile that SURVIVES the push, a stored value is carried forward
 * exactly as stored when the INCOMING catalog still declares its key a managed secret (a `secret`
 * entry, or a `config` entry flagged `secret: true`), the value is a sealed envelope, and the
 * manifest's payload does not declare that key. A plaintext value is never carried, nor is one
 * whose key the new catalog dropped or stopped calling secret. Everything else on the profile still
 * follows the manifest, a profile the manifest drops is still removed with its secrets, and a key
 * the manifest does declare still wins. The carry reads the profiles immediately before the batch,
 * so a console edit made while the push was fetching from GitHub is the one carried.
 *
 * Every case drives the real path: `linkRepo` registers the product from a stubbed GitHub, the
 * console API (`handleAdmin`) sets the value, and `resyncRepo` re-reads a changed `.pkey/`.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  isSealedEnvelope,
  openManagedValue,
} from "../src/core/managedSecrets.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES } from "../src/mount.js";
import { withDefaultHead } from "./githubHead.js";

const SLUG = "acme";
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const API_KEY = "abliteration.apiKey";
const OTHER_SECRET = "backup.token";
const BASE_URL = "abliteration.baseUrl";
const SECRET_CONFIG = "proxy.password";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const ENTRIES: Record<string, unknown>[] = [
  {
    key: API_KEY,
    kind: "secret",
    category: "api",
    label: "API key",
    description: "",
    schema: { type: "string", minLength: 8 },
  },
  {
    key: OTHER_SECRET,
    kind: "secret",
    category: "api",
    label: "Backup token",
    description: "",
    schema: { type: "string", minLength: 8 },
  },
  {
    key: BASE_URL,
    kind: "config",
    category: "api",
    label: "Base URL",
    description: "",
    schema: { type: "string" },
  },
  {
    key: SECRET_CONFIG,
    kind: "config",
    secret: true,
    category: "api",
    label: "Proxy password",
    description: "",
    schema: { type: "string" },
  },
];

/** `.pkey/schema.json` with these entries (every entry by default). */
const schemaJson = (entries = ENTRIES): string =>
  JSON.stringify({ schemaVersion: 1, entries });

/** The catalog with one entry dropped, or replaced by `replacement`. */
const without = (key: string, replacement?: Record<string, unknown>) =>
  schemaJson(
    ENTRIES.flatMap((e) =>
      e.key !== key ? [e] : replacement ? [replacement] : [],
    ),
  );

type Payload = Record<string, unknown>;

interface ProfileDecl {
  id: string;
  payload?: Payload;
}

const baseUrl = (value: string): Payload => ({
  config: { [BASE_URL]: { state: "default", value, updatedAt: 0 } },
});

function productJson(
  profiles: ProfileDecl[],
  modules?: Record<string, { enabled: boolean }>,
): string {
  return JSON.stringify({
    slug: SLUG,
    name: "Acme",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: "acme-admins",
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.id,
      ...(p.payload ? { payload: p.payload } : {}),
    })),
    tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
    provisioning: [],
    ...(modules ? { modules } : {}),
  });
}

const RELEASE_JSON = JSON.stringify({
  release: {
    ghOwner: "acme-org",
    ghRepo: "acme-app",
    binaryName: "acme",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
  },
});

interface PushOptions {
  /** `.pkey/schema.json`; the full catalog when absent. */
  schema?: string;
  /** Runs when the resync makes its LAST GitHub read (the releases list), i.e. after the
   *  profile statements are built and before the batch is written. */
  onReleases?: () => Promise<void>;
}

/** GitHub, stubbed: installation discovery, the token exchange, `.pkey/` contents, releases. */
function pkey(product: string, opts: PushOptions = {}): FetchImpl {
  const files: Record<string, string> = {
    ".pkey/schema.json": opts.schema ?? schemaJson(),
    ".pkey/product.json": product,
    ".pkey/release.json": RELEASE_JSON,
  };
  // ST-01a: the pinned manifest fetch asks for the default branch's head first.
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) {
          const content = Buffer.from(body, "utf8").toString("base64");
          return new Response(JSON.stringify({ content, encoding: "base64" }), {
            status: 200,
          });
        }
      }
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page")) {
      await opts.onReleases?.();
      return new Response("[]", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** A linked product, as `.pkey/` first described it, plus a console session to edit it with. */
async function linked(profiles: ProfileDecl[]) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    pkey(productJson(profiles)),
    manifestIngestFor(SERVICES),
  );
  expect(res.ok).toBe(true);
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  return { db, env, cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

type Ctx = Awaited<ReturnType<typeof linked>>;

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: ctx.cookie };
  if (method !== "GET") headers[CSRF_HEADER] = ctx.csrf;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const full = `/api/products/${SLUG}/${path}`;
  const req = new Request(`https://key.plrs.im/manage${full}`, init);
  const res = await handleAdmin(req, ctx.env, ctx.db, full, { now: NOW });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

/** The console's "set a value on a profile" edit (`PUT config/profiles/<id>`). */
async function setOnProfile(
  ctx: Ctx,
  profile: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await call(ctx, "PUT", `config/profiles/${profile}`, {
    updates: [{ key, value, state: "enforced" }],
  });
  expect(res.status).toBe(200);
}

async function resync(
  ctx: Ctx,
  profiles: ProfileDecl[],
  at = NOW + 60,
  opts: PushOptions = {},
) {
  const res = await resyncRepo(
    ctx.env,
    ctx.db,
    SLUG,
    at,
    pkey(productJson(profiles), opts),
    manifestIngestFor(SERVICES),
  );
  if (!res.ok) throw new Error(`resync refused: ${res.error}`);
  return res;
}

interface StoredPayload {
  config?: Record<string, { state: string; value: unknown; updatedAt: number }>;
  secrets?: Record<
    string,
    { state: string; value: unknown; updatedAt: number }
  >;
  entitlements?: Record<string, unknown>;
}

/** The profile's stored payload, straight from D1 — sealed values as they are at rest. */
async function stored(ctx: Ctx, id: string): Promise<StoredPayload | null> {
  const row = await ctx.db.first<{ payload_json: string }>(
    "SELECT payload_json FROM profiles WHERE product = ? AND id = ?",
    SLUG,
    id,
  );
  return row ? (JSON.parse(row.payload_json) as StoredPayload) : null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("a profile secret set in the console survives a resync (R2)", () => {
  it("keeps the sealed secret byte-for-byte while the rest of the profile follows the manifest", async () => {
    const ctx = await linked([
      { id: "standard", payload: baseUrl("https://a.example/v1") },
    ]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-plan-key-0001");
    const before = (await stored(ctx, "standard"))!.secrets![API_KEY]!;
    expect(isSealedEnvelope(before.value)).toBe(true);

    // A push that changes the profile's manifest-owned baseline.
    const res = await resync(ctx, [
      { id: "standard", payload: baseUrl("https://b.example/v1") },
    ]);
    expect(res.updated).toContain("profiles");

    const after = (await stored(ctx, "standard"))!;
    // Carried forward exactly as stored: still sealed, same ciphertext, same metadata.
    expect(after.secrets![API_KEY]).toEqual(before);
    expect(
      await openManagedValue(
        ctx.env,
        SLUG,
        API_KEY,
        after.secrets![API_KEY]!.value,
      ),
    ).toBe("sk-plan-key-0001");
    // The manifest still owns the rest of the payload.
    expect(after.config![BASE_URL]!.value).toBe("https://b.example/v1");

    // The console still reports the secret as configured, and never echoes it.
    const detail = await call(ctx, "GET", "config/profiles/standard");
    expect(detail.status).toBe(200);
    const payload = detail.json.payload as {
      secrets: Record<string, { state: string; configured: boolean }>;
    };
    expect(payload.secrets[API_KEY]).toMatchObject({
      state: "enforced",
      configured: true,
    });
    expect(JSON.stringify(detail.json)).not.toContain("sk-plan-key-0001");
  });

  it("survives repeated pushes, including one whose manifest payload is empty", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-plan-key-0001");
    const before = (await stored(ctx, "standard"))!.secrets![API_KEY]!;

    await resync(ctx, [{ id: "standard" }], NOW + 60);
    await resync(ctx, [{ id: "standard", payload: {} }], NOW + 120);
    await resync(
      ctx,
      [{ id: "standard", payload: baseUrl("https://c.example/v1") }],
      NOW + 180,
    );

    expect((await stored(ctx, "standard"))!.secrets![API_KEY]).toEqual(before);
  });

  it("keeps a sealed value under a config key flagged secret, and a secret-only edit leaves the manifest the owner", async () => {
    const ctx = await linked([
      { id: "standard", payload: baseUrl("https://a.example/v1") },
    ]);
    await setOnProfile(ctx, "standard", SECRET_CONFIG, "hunter2-proxy");
    const sealed = (await stored(ctx, "standard"))!.config![SECRET_CONFIG]!;
    expect(isSealedEnvelope(sealed.value)).toBe(true);

    await resync(ctx, [
      { id: "standard", payload: baseUrl("https://b.example/v1") },
    ]);

    const after = (await stored(ctx, "standard"))!;
    expect(after.config![SECRET_CONFIG]).toEqual(sealed);
    // Setting only a secret is not a claim (ST-01b): the manifest's new plain value applies.
    expect(after.config![BASE_URL]!.value).toBe("https://b.example/v1");
  });

  it("a plain config value set in the console claims the profile, which the resync then leaves alone (ST-01b)", async () => {
    const ctx = await linked([
      { id: "standard", payload: baseUrl("https://a.example/v1") },
    ]);
    await setOnProfile(ctx, "standard", SECRET_CONFIG, "hunter2-proxy");
    // A plain config value is not a secret: setting it is a console edit, so it claims the row.
    await setOnProfile(ctx, "standard", BASE_URL, "https://console.example/v1");
    const sealed = (await stored(ctx, "standard"))!.config![SECRET_CONFIG]!;

    await resync(ctx, [
      { id: "standard", payload: baseUrl("https://b.example/v1") },
    ]);

    const after = (await stored(ctx, "standard"))!;
    expect(after.config![SECRET_CONFIG]).toEqual(sealed);
    expect(after.config![BASE_URL]!.value).toBe("https://console.example/v1");
  });

  it("keeps each profile's own secrets, on every surviving profile", async () => {
    const ctx = await linked([{ id: "standard" }, { id: "team" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-standard-0001");
    await setOnProfile(ctx, "team", API_KEY, "sk-team-key-0002");

    await resync(ctx, [{ id: "standard" }, { id: "team" }]);

    const standard = (await stored(ctx, "standard"))!.secrets![API_KEY]!;
    const team = (await stored(ctx, "team"))!.secrets![API_KEY]!;
    expect(await openManagedValue(ctx.env, SLUG, API_KEY, standard.value)).toBe(
      "sk-standard-0001",
    );
    expect(await openManagedValue(ctx.env, SLUG, API_KEY, team.value)).toBe(
      "sk-team-key-0002",
    );
  });
});

describe("what a resync still owns (R2)", () => {
  it("removes a profile the manifest drops, secrets and all, and a re-added id starts empty", async () => {
    const ctx = await linked([{ id: "standard" }, { id: "spare" }]);
    await setOnProfile(ctx, "spare", API_KEY, "sk-spare-key-0003");

    const res = await resync(ctx, [{ id: "standard" }]);
    expect(res.updated).toContain("profiles");
    expect(await stored(ctx, "spare")).toBeNull();

    // The secret went with the row: re-adding the id later does not resurrect it.
    await resync(ctx, [{ id: "standard" }, { id: "spare" }], NOW + 120);
    const readded = await stored(ctx, "spare");
    expect(readded).not.toBeNull();
    expect(readded!.secrets?.[API_KEY]).toBeUndefined();
  });

  it("lets a secrets entry the manifest declares win, and still carries the ones it does not", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-console-0001");
    await setOnProfile(ctx, "standard", OTHER_SECRET, "backup-console-01");
    const other = (await stored(ctx, "standard"))!.secrets![OTHER_SECRET]!;

    const declared = {
      state: "default",
      value: "from-the-manifest",
      updatedAt: 7,
    };
    await resync(ctx, [
      { id: "standard", payload: { secrets: { [API_KEY]: declared } } },
    ]);

    const after = (await stored(ctx, "standard"))!;
    expect(after.secrets![API_KEY]).toEqual(declared);
    expect(after.secrets![OTHER_SECRET]).toEqual(other);
  });
});

describe("the carry follows the incoming catalog, never the value's shape (R2)", () => {
  it("does not carry a value whose key the new catalog drops", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-plan-key-0001");
    await setOnProfile(ctx, "standard", OTHER_SECRET, "backup-console-01");
    const other = (await stored(ctx, "standard"))!.secrets![OTHER_SECRET]!;

    await resync(ctx, [{ id: "standard" }], NOW + 60, {
      schema: without(API_KEY),
    });

    const after = (await stored(ctx, "standard"))!;
    expect(after.secrets?.[API_KEY]).toBeUndefined();
    // The key the catalog still declares is carried, byte for byte.
    expect(after.secrets![OTHER_SECRET]).toEqual(other);
  });

  it("does not carry a sealed config value once the new catalog stops flagging the key secret", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", SECRET_CONFIG, "hunter2-proxy");
    expect(
      isSealedEnvelope(
        (await stored(ctx, "standard"))!.config![SECRET_CONFIG]!.value,
      ),
    ).toBe(true);

    await resync(ctx, [{ id: "standard" }], NOW + 60, {
      schema: without(SECRET_CONFIG, {
        key: SECRET_CONFIG,
        kind: "config",
        category: "api",
        label: "Proxy password",
        description: "",
        schema: { type: "string" },
      }),
    });

    expect((await stored(ctx, "standard"))!.config?.[SECRET_CONFIG]).toBe(
      undefined,
    );
  });

  it("never carries a plaintext value, even under a key the catalog still calls secret", async () => {
    const ctx = await linked([{ id: "standard" }]);
    // A row written before sealing existed (R12-02): the value sits in D1 as plaintext.
    await ctx.db.run(
      "UPDATE profiles SET payload_json = ? WHERE product = ? AND id = 'standard'",
      JSON.stringify({
        config: {
          [SECRET_CONFIG]: {
            state: "enforced",
            value: "plain-proxy",
            updatedAt: NOW,
          },
        },
        secrets: {
          [API_KEY]: {
            state: "enforced",
            value: "sk-legacy-plain",
            updatedAt: NOW,
          },
        },
        entitlements: {},
      }),
      SLUG,
    );

    await resync(ctx, [{ id: "standard" }]);

    const after = (await stored(ctx, "standard"))!;
    expect(after.secrets?.[API_KEY]).toBeUndefined();
    expect(after.config?.[SECRET_CONFIG]).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("sk-legacy-plain");
  });

  it("lets a config value the manifest declares beat a stored sealed one", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", SECRET_CONFIG, "hunter2-proxy");

    const declared = {
      state: "default",
      value: "from-the-manifest",
      updatedAt: 9,
    };
    await resync(ctx, [
      { id: "standard", payload: { config: { [SECRET_CONFIG]: declared } } },
    ]);

    expect((await stored(ctx, "standard"))!.config![SECRET_CONFIG]).toEqual(
      declared,
    );
  });
});

describe("the carry reads the profiles immediately before the batch (R2)", () => {
  it("carries a console edit made while the push was still fetching from GitHub", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-before-push-01");

    // The operator rotates the key while the resync is mid-flight: after the profile rows were
    // built, during the last GitHub read, before the batch lands.
    await resync(ctx, [{ id: "standard" }], NOW + 60, {
      onReleases: () =>
        setOnProfile(ctx, "standard", API_KEY, "sk-rotated-mid-push"),
    });

    const after = (await stored(ctx, "standard"))!.secrets![API_KEY]!;
    expect(await openManagedValue(ctx.env, SLUG, API_KEY, after.value)).toBe(
      "sk-rotated-mid-push",
    );
  });
});

describe("a catalog the resync cannot build (R2)", () => {
  it("is a structured refusal, not a throw, and leaves the stored secrets alone", async () => {
    const ctx = await linked([{ id: "standard" }]);
    await setOnProfile(ctx, "standard", API_KEY, "sk-plan-key-0001");
    const before = await ctx.db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = ? AND id = 'standard'",
      SLUG,
    );

    // Config turned off, and a catalog whose entry is not an object: the manifest validator
    // lets it through, and the catalog constructor cannot read it. On a webhook a throw here
    // would abort the per-product loop and record no sync-state row at all.
    const res = await resyncRepo(
      ctx.env,
      ctx.db,
      SLUG,
      NOW + 60,
      pkey(
        productJson([{ id: "standard" }], {
          license: { enabled: true },
          config: { enabled: false },
        }),
        { schema: JSON.stringify({ schemaVersion: 1, entries: [null] }) },
      ),
      manifestIngestFor(SERVICES),
    );

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/^invalid catalog in manifest: /);
    const after = await ctx.db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = ? AND id = 'standard'",
      SLUG,
    );
    expect(after!.payload_json).toBe(before!.payload_json);
  });
});
