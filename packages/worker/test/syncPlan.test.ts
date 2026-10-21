/**
 * ST-17 (S-18 §4.5 items 4–5): resync, link and the deploy hook apply through the core ingest
 * pipeline, which records the plan it applies in `product_sync_state.plan_json`, in the apply's
 * own batch, from the one function the dry runs call (`planManifest`).
 *
 *   - a resync records the very plan its dry run showed (apply, skipClaimed, delete, conflicts);
 *   - a link records its plan, and the webhook's later sync-state write leaves it in place;
 *   - the deploy hook records one too;
 *   - a console claim shows up as `skipClaimed` in the recorded plan;
 *   - the validator's warnings (a deprecated spelling) ride in the plan, in the dry run and in
 *     the stored one, and never block the apply;
 *   - the drift read lists every claim against the snapshot, and the stored plan.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest, SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { ingestFor } from "../src/core/ingest/pipeline.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, TEST_KEK } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "./githubHead.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  linkExistingProduct,
  planResync,
  prepareLink,
} from "../src/services/release/linkExisting.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import {
  ensureSystemProduct,
  linkSystemProduct,
} from "../src/console/systemProduct.js";
import { getProductSyncState, getProduct } from "../src/core/products/store.js";
import { handleProductSettings } from "../src/console/handlers/productSettings.js";
import { planManifest } from "../src/core/ingest/plan.js";
import { driftView } from "../src/core/settingsDrift.js";
import type { StoredSyncPlan } from "../src/core/ingest/types.js";

const SLUG = "tonebox";
const URL_ = "https://github.com/acme/tonebox";
const WEBHOOK_SECRET = "webhook-secret";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.OIDC_ISSUER_ALLOWLIST = "id.example";
  env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  return env;
}

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

function stubFetch(files: Record<string, string>): FetchImpl {
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(body);
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });

/** The flat `slug` / `name` spelling is deprecated (spellings row 1): it warns, never refuses. */
function productJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    slug: SLUG,
    name: "Tonebox",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    tiers: [{ id: "pro", label: "Pro", profileId: null }],
    provisioning: [],
    ...over,
  });
}

const RELEASE = JSON.stringify({
  release: { ghOwner: "acme", ghRepo: "tonebox", binaryName: "tonebox" },
});

function files(product = productJson()): Record<string, string> {
  return {
    ".pkey/schema.json": SCHEMA,
    ".pkey/product.json": product,
    ".pkey/release.json": RELEASE,
  };
}

async function linkedProduct(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  const env = envFor();
  await seedProduct(db, SLUG);
  const fetchImpl = stubFetch(files());
  const check = await prepareLink(
    env,
    db,
    SLUG,
    URL_,
    NOW,
    fetchImpl,
    ingestFor(SERVICES),
  );
  if (!check.ok) throw new Error(check.error);
  const res = await linkExistingProduct(
    env,
    db,
    SLUG,
    URL_,
    check.manifestDigest,
    NOW,
    fetchImpl,
    ingestFor(SERVICES),
  );
  if (!res.ok) throw new Error(res.error);
  return { db, env };
}

async function stored(db: Db, slug = SLUG): Promise<StoredSyncPlan> {
  const row = await getProductSyncState(db, slug);
  expect(row?.plan_json).toBeTruthy();
  return JSON.parse(row!.plan_json!) as StoredSyncPlan;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function push(env: Env, db: Db, fetchImpl: FetchImpl, now: number) {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "abc123",
    installation: { id: 4242 },
    repository: {
      name: "tonebox",
      full_name: "acme/tonebox",
      default_branch: "main",
      owner: { login: "acme" },
    },
    head_commit: { modified: [".pkey/product.json"] },
    commits: [],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body) as BufferSource,
    ),
  );
  const req = new Request("https://key.plrs.im/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${hex(sig)}`,
      "x-github-delivery": crypto.randomUUID(),
    },
    body,
  }) as unknown as Request;
  return handleGithubWebhook(req, env, db, now, fetchImpl);
}

describe("the apply records the plan it applies (ST-17)", () => {
  it("link records its plan, with the validator's warnings", async () => {
    const { db } = await linkedProduct();
    const plan = await stored(db);
    expect(plan).toMatchObject({
      v: 1,
      origin: "resync",
      commit: HEAD_SHA,
      plannedAt: NOW,
    });
    expect(plan.plan.apply.map((i) => i.area)).toContain("tiers");
    expect(plan.plan.conflicts).toEqual([]);
    // The flat spelling is a warning, in the plan; the link was not blocked by it.
    expect(plan.plan.warnings?.map((w) => w.code)).toContain(
      "deprecated_spelling",
    );
    expect((await getProduct(db, SLUG))?.release_source).toBe("github");
  });

  it("a resync records the plan its dry run showed", async () => {
    const { db, env } = await linkedProduct();
    const changed = stubFetch(
      files(
        productJson({
          name: "Tonebox 2",
          tiers: [
            { id: "pro", label: "Pro", profileId: null },
            { id: "team", label: "Team", profileId: null },
          ],
        }),
      ),
    );
    const dry = await planResync(
      env,
      db,
      SLUG,
      NOW + 10,
      changed,
      ingestFor(SERVICES),
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.plan.apply.some((i) => i.id === "team")).toBe(true);
    // The dry run wrote nothing: still the link's plan.
    expect((await stored(db)).plannedAt).toBe(NOW);

    const applied = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 10,
      changed,
      ingestFor(SERVICES),
    );
    expect(applied.ok).toBe(true);
    const recorded = await stored(db);
    expect(recorded.plannedAt).toBe(NOW + 10);
    expect(recorded.plan).toEqual(dry.plan);
  });

  it("a console claim is skipClaimed in the plan, and the webhook leaves its plan in place", async () => {
    const { db, env } = await linkedProduct();
    // The console claims the display name (what a settings save does on a linked product).
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES (?, 'core.name', '"Console name"', 'console', 1, ?, 'u1')`,
      SLUG,
      NOW + 1,
    );
    await db.run(
      "UPDATE products SET name = 'Console name' WHERE slug = ?",
      SLUG,
    );
    const fetchImpl = stubFetch(files(productJson({ name: "Manifest name" })));
    const dry = await planResync(
      env,
      db,
      SLUG,
      NOW + 20,
      fetchImpl,
      ingestFor(SERVICES),
    );
    if (!dry.ok) throw new Error(dry.error);
    expect(dry.plan.skipClaimed.map((i) => i.summary).join(" ")).toContain(
      "name",
    );

    const res = await push(env, db, fetchImpl, NOW + 20);
    expect(res.status).toBe(200);
    const row = await getProductSyncState(db, SLUG);
    // The webhook's own write (status, commit, paths) did not clobber the recorded plan.
    expect(row).toMatchObject({
      source: "webhook",
      status: "ok",
      commit_sha: "abc123",
    });
    const recorded = JSON.parse(row!.plan_json!) as StoredSyncPlan;
    expect(recorded.plannedAt).toBe(NOW + 20);
    expect(recorded.plan).toEqual(dry.plan);
    expect((await getProduct(db, SLUG))?.name).toBe("Console name");
  });

  it("the deploy hook records its plan", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.PLATFORM_KEK = TEST_KEK;
    expect((await ensureSystemProduct(env, db, "u1", NOW)).ok).toBe(true);
    const root = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "..",
      ".pkey",
    );
    const docs = {
      product: readFileSync(join(root, "product.yaml"), "utf8"),
      schema: readFileSync(join(root, "schema.yaml"), "utf8"),
      release: readFileSync(join(root, "release.yaml"), "utf8"),
    };
    const parsed = parseManifest(docs);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const deploySha = "c".repeat(40);
    const res = await linkSystemProduct(
      env,
      db,
      parsed.manifest,
      {
        repository: "vladzaharia/polaris-key",
        repositoryId: 1,
        repositoryOwnerId: 2,
      },
      { files: docs, sha: deploySha, warnings: parsed.warnings },
      NOW + 1,
      ingestFor(SERVICES),
    );
    expect(res.ok).toBe(true);
    const recorded = await stored(db, SYSTEM_PRODUCT_SLUG);
    expect(recorded).toMatchObject({
      v: 1,
      origin: "deploy-hook",
      commit: deploySha,
      plannedAt: NOW + 1,
    });
    expect(recorded.plan.conflicts).toEqual([]);
  });
});

describe("the resync dry run carries the warnings (ST-17)", () => {
  it("lists a deprecated spelling in the plan and does not block", async () => {
    const { db, env } = await linkedProduct();
    const dry = await planResync(
      env,
      db,
      SLUG,
      NOW + 5,
      stubFetch(files()),
      ingestFor(SERVICES),
    );
    if (!dry.ok) throw new Error(dry.error);
    expect(dry.plan.warnings?.[0]).toMatchObject({
      code: "deprecated_spelling",
      file: "product",
    });
    expect(dry.plan.conflicts).toEqual([]);
  });

  it("a plan built without warnings has no warnings key", async () => {
    const { db } = await linkedProduct();
    const parsed = parseManifest({
      product: productJson(),
      schema: SCHEMA,
      release: RELEASE,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const plan = await planManifest(db, SLUG, parsed.manifest, NOW + 5);
    expect("warnings" in plan).toBe(false);
  });
});

describe("the drift read (ST-17)", () => {
  it("lists every claim against the snapshot, with the last plan", async () => {
    const { db, env } = await linkedProduct();
    const claim = (key: string, value: string) =>
      db.run(
        `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
         VALUES (?, ?, ?, 'console', 1, ?, 'u1')`,
        SLUG,
        key,
        value,
        NOW + 1,
      );
    await claim("core.name", '"Console name"');
    await db.run(
      "UPDATE products SET name = 'Console name' WHERE slug = ?",
      SLUG,
    );
    await claim("license.defaults.deviceLimit", "3");

    const product = (await getProduct(db, SLUG))!;
    const view = await driftView(
      { env, db, registry: SETTINGS },
      product,
      (await getProductSyncState(db, SLUG))?.plan_json,
      NOW + 2,
    );
    expect(view.snapshot).toMatchObject({
      origin: "resync",
      appliedSha: HEAD_SHA,
    });
    expect(view.items.map((i) => i.key)).toEqual([
      "core.name",
      "license.defaults.deviceLimit",
    ]);
    const name = view.items.find((i) => i.key === "core.name")!;
    expect(name).toMatchObject({
      console: "Console name",
      manifest: "Tonebox",
      manifestKnown: true,
      differs: true,
      revert: "claim",
    });
    // Equal to the manifest: still listed, not drifting.
    expect(
      view.items.find((i) => i.key === "license.defaults.deviceLimit"),
    ).toMatchObject({ differs: false, manifestKnown: true });
    expect(view.lastPlan?.v).toBe(1);
  });
});

describe("the drift route filters by area (ST-17)", () => {
  async function drift(areas: readonly string[] | null) {
    const { db, env } = await linkedProduct();
    const at = (key: string, value: string) =>
      db.run(
        `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
         VALUES (?, ?, ?, 'console', 1, ?, 'u1')`,
        SLUG,
        key,
        value,
        NOW + 1,
      );
    await at("core.name", '"Console name"');
    await at("licensing.anchorPolicy", '"owner"');
    const res = await handleProductSettings(
      new Request(
        `https://key.plrs.im/manage/api/products/${SLUG}/settings/drift`,
      ),
      env,
      db,
      {
        principal: {
          memberId: "m",
          grants: [
            {
              role: "product_admin",
              scope: `product:${SLUG}`,
              areas: areas as never,
              source: "grant",
            },
          ],
        },
      } as never,
      (await getProduct(db, SLUG))!,
      ["drift"],
      NOW + 2,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      items: { key: string }[];
      lastPlan: unknown;
    };
  }

  it("a member without an item's area does not see it, nor the plan without Settings", async () => {
    const coreOnly = await drift(["core"]);
    expect(coreOnly.items.map((i) => i.key)).toEqual(["core.name"]);
    expect(coreOnly.lastPlan).toBeNull();
  });

  it("a member holding the areas sees both and the plan", async () => {
    const all = await drift(null);
    expect(all.items.map((i) => i.key)).toEqual([
      "core.name",
      "licensing.anchorPolicy",
    ]);
    expect(all.lastPlan).not.toBeNull();
  });
});
