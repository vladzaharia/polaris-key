/**
 * Console claims across a manifest resync (ST-01b; notes/S-18 §2.1, §4.5, owner decision 1:
 * model C).
 *
 * Before ST-01b every resync overwrote the product name, the licence defaults, the web origins,
 * the tiers, the profiles and the catalog with the manifest's values, silently discarding console
 * edits, and its tier and profile refusals ran after the product-row writes. Pinned here:
 *
 *   - a console edit to each claimable field claims it (`product_settings`) and survives every
 *     later resync; an unclaimed field still follows the manifest, with a per-field audit row;
 *   - console-only tiers and profiles survive a resync whose manifest omits them; a console edit
 *     to a manifest row claims the row; a console row holding a NEW manifest id is a conflict;
 *   - a refused resync writes nothing at all;
 *   - Revert drops the claim and re-applies the manifest snapshot (ST-01a) at once, or says
 *     "applies at the next resync" when there is no snapshot;
 *   - console claims on the system product are refused (until ST-20), and the admin group is
 *     manifest-only on a repo-linked product.
 *
 * Every case drives the real path: `linkRepo` registers the product from a stubbed GitHub, the
 * console API (`handleAdmin`) edits it, and `resyncRepo` re-reads a changed `.pkey/`.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES } from "../src/mount.js";
import { stmtClaim } from "../src/core/settingsClaims.js";
import { withDefaultHead } from "./githubHead.js";

const SLUG = "acme";
const PLATFORM_GROUP = "platform-admins";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const entry = (key: string) => ({
  key,
  kind: "config",
  category: "general",
  label: key,
  description: "",
  schema: { type: "string" },
});
const schemaJson = (...keys: string[]): string =>
  JSON.stringify({ schemaVersion: 1, entries: keys.map(entry) });

interface Decl {
  name?: string;
  offline?: number;
  devices?: number;
  adminGroup?: string;
  origins?: string[];
  tiers?: { id: string; label?: string; profileId?: string }[];
  profiles?: string[];
  schema?: string;
}

const BASE: Required<Omit<Decl, "origins">> & { origins?: string[] } = {
  name: "Acme",
  offline: 14,
  devices: 3,
  adminGroup: "acme-admins",
  origins: ["https://app.acme.example"],
  tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
  profiles: ["standard"],
  schema: schemaJson("run.name"),
};

function files(d: Decl = {}): Record<string, string> {
  const m = { ...BASE, ...d };
  return {
    ".pkey/schema.json": m.schema,
    ".pkey/product.json": JSON.stringify({
      slug: SLUG,
      name: m.name,
      compatMin: "1.0.0",
      compatMax: "9.0.0",
      defaultMaxOfflineDays: m.offline,
      defaultDeviceLimit: m.devices,
      adminGroup: m.adminGroup,
      ...(m.origins ? { web: { origins: m.origins } } : {}),
      profiles: m.profiles.map((id) => ({ id, name: id })),
      tiers: m.tiers.map((t) => ({ label: t.id, ...t })),
      provisioning: [],
    }),
    ".pkey/release.json": JSON.stringify({
      release: {
        ghOwner: "acme-org",
        ghRepo: "acme-app",
        binaryName: "acme",
        betaBranch: "main",
        summaryMarker: "pkey:summary",
      },
    }),
  };
}

/** GitHub, stubbed: installation discovery, the token exchange, `.pkey/` contents, releases. */
function github(d: Decl = {}): FetchImpl {
  const docs = files(d);
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(docs)) {
        if (url.includes(`/contents/${path}`)) {
          const content = Buffer.from(body, "utf8").toString("base64");
          return new Response(JSON.stringify({ content, encoding: "base64" }), {
            status: 200,
          });
        }
      }
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function linked(d: Decl = {}) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    github(d),
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
  const full = `/api/products/${SLUG}${path ? `/${path}` : ""}`;
  const req = new Request(`https://key.plrs.im/manage${full}`, init);
  const res = await handleAdmin(req, ctx.env, ctx.db, full, { now: NOW + 1 });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function resync(ctx: Ctx, d: Decl = {}, at = NOW + 60) {
  return resyncRepo(
    ctx.env,
    ctx.db,
    SLUG,
    at,
    github(d),
    manifestIngestFor(SERVICES),
  );
}

async function okResync(ctx: Ctx, d: Decl = {}, at = NOW + 60) {
  const res = await resync(ctx, d, at);
  if (!res.ok) throw new Error(`resync refused: ${res.error}`);
  return res;
}

interface ProductCols {
  name: string;
  default_max_offline_days: number;
  default_device_limit: number;
  admin_group: string | null;
  web_origins_json: string | null;
}
const productRow = (ctx: Ctx) =>
  ctx.db.first<ProductCols>(
    `SELECT name, default_max_offline_days, default_device_limit, admin_group, web_origins_json
       FROM products WHERE slug = ?`,
    SLUG,
  ) as Promise<ProductCols>;

const activeCatalog = async (ctx: Ctx): Promise<string[]> => {
  const row = await ctx.db.first<{ catalog_json: string }>(
    "SELECT catalog_json FROM product_schema WHERE product = ? AND active = 1",
    SLUG,
  );
  return (
    JSON.parse(row!.catalog_json) as { entries: { key: string }[] }
  ).entries.map((e) => e.key);
};

const rows = (ctx: Ctx, table: "tiers" | "profiles") =>
  ctx.db.all<{ id: string; source: string; label?: string; name?: string }>(
    `SELECT * FROM ${table} WHERE product = ? ORDER BY id`,
    SLUG,
  );

const claimRows = (ctx: Ctx) =>
  ctx.db.all<{ key: string; source: string; updated_by: string }>(
    "SELECT key, source, updated_by FROM product_settings WHERE product = ? ORDER BY key",
    SLUG,
  );

const audits = (ctx: Ctx, action: string) =>
  ctx.db.all<{ target_kind: string; target_id: string; summary: string }>(
    "SELECT target_kind, target_id, summary FROM audit WHERE product = ? AND action = ? ORDER BY at, id",
    SLUG,
    action,
  );

// ── A console edit claims each field, and the claim survives a resync ─────────────────────

describe("a console edit to a claimable field survives a following resync (ST-01b)", () => {
  it("core.name", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "PATCH", "", { name: "Acme Console" })).json,
    ).toMatchObject({ ok: true, claimed: ["core.name"] });
    const res = await okResync(ctx, { name: "Acme Two" });
    expect((await productRow(ctx)).name).toBe("Acme Console");
    expect(res.claimed).toContain("core.name");
  });

  it("license.defaults.maxOfflineDays", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "PATCH", "", { defaultMaxOfflineDays: 45 })).status,
    ).toBe(200);
    await okResync(ctx, { offline: 20 });
    expect((await productRow(ctx)).default_max_offline_days).toBe(45);
  });

  it("license.defaults.deviceLimit", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "PATCH", "", { defaultDeviceLimit: 9 })).status,
    ).toBe(200);
    await okResync(ctx, { devices: 2 });
    expect((await productRow(ctx)).default_device_limit).toBe(9);
  });

  it("core.web.origins (claimed as a console write would claim it; ST-08 adds the editor)", async () => {
    const ctx = await linked();
    await ctx.db.batch([
      {
        sql: "UPDATE products SET web_origins_json = ? WHERE slug = ?",
        params: [JSON.stringify(["https://console.acme.example"]), SLUG],
      },
      stmtClaim(SLUG, "core.web.origins", "u1", NOW + 1),
    ]);
    // Omitting `web.origins` clears an UNCLAIMED list (omitClears); a claimed one stays.
    await okResync(ctx, { origins: undefined });
    expect(JSON.parse((await productRow(ctx)).web_origins_json!)).toEqual([
      "https://console.acme.example",
    ]);
  });

  it("config.catalog (one claimable unit)", async () => {
    const ctx = await linked();
    const put = await call(ctx, "PUT", "config/catalog", {
      catalog: JSON.parse(schemaJson("run.name", "console.only")),
      expectedVersion: 1,
    });
    expect(put.status).toBe(200);
    const res = await okResync(ctx, { schema: schemaJson("run.other") });
    expect(await activeCatalog(ctx)).toEqual(["run.name", "console.only"]);
    expect(res.claimed).toContain("config.catalog");
    expect(res.updated).not.toContain("schema");
  });

  it("an unclaimed field still follows the manifest, with one resync audit row per field", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", "", { name: "Acme Console" });
    await okResync(ctx, {
      name: "Acme Two",
      devices: 7,
      adminGroup: "acme-ops",
      schema: schemaJson("run.other"),
    });
    const p = await productRow(ctx);
    expect(p).toMatchObject({
      name: "Acme Console",
      default_device_limit: 7,
      admin_group: "acme-ops",
    });
    expect(await activeCatalog(ctx)).toEqual(["run.other"]);
    const rowsByKey = (await audits(ctx, "setting.resync")).map(
      (a) => a.target_id,
    );
    expect(rowsByKey).toEqual(
      expect.arrayContaining([
        "license.defaults.deviceLimit",
        "core.adminGroup",
        "config.catalog",
      ]),
    );
    // Claimed and unchanged fields are not audited as changed.
    expect(rowsByKey).not.toContain("core.name");
    expect(rowsByKey).not.toContain("license.defaults.maxOfflineDays");
    const limit = (await audits(ctx, "setting.resync")).find(
      (a) => a.target_id === "license.defaults.deviceLimit",
    )!;
    expect(limit.summary).toMatch(/3 → 7/);
  });

  it("a console save that claims a key while the resync is mid-flight still wins (guard in SQL)", async () => {
    // The resync reads the claims early, then makes GitHub round trips before its batch. A
    // console save landing in that window must not be overwritten: the guard is in each write.
    const ctx = await linked();
    const inner = github({
      name: "Acme Two",
      devices: 7,
      schema: schemaJson("run.other"),
    });
    let raced = false;
    const racing: FetchImpl = async (input, init) => {
      if (!raced && String(input).includes("/releases?per_page")) {
        raced = true;
        await ctx.db.batch([
          {
            sql: "UPDATE products SET name = ? WHERE slug = ?",
            params: ["Console", SLUG],
          },
          stmtClaim(SLUG, "core.name", "u1", NOW + 2),
          {
            sql: "UPDATE product_schema SET active = 0 WHERE product = ?",
            params: [SLUG],
          },
          {
            sql: `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
                  VALUES (?, 99, ?, 1, ?)`,
            params: [SLUG, schemaJson("console.only"), NOW + 2],
          },
          stmtClaim(SLUG, "config.catalog", "u1", NOW + 2),
        ]);
      }
      return inner(input, init);
    };
    const res = await resyncRepo(
      ctx.env,
      ctx.db,
      SLUG,
      NOW + 60,
      racing,
      manifestIngestFor(SERVICES),
    );
    expect(res.ok).toBe(true);
    expect(raced).toBe(true);
    const row = await productRow(ctx);
    expect(row.name).toBe("Console");
    // An unclaimed field in the same statement still follows the manifest.
    expect(row.default_device_limit).toBe(7);
    expect(await activeCatalog(ctx)).toEqual(["console.only"]);
    const resyncAudits = (await audits(ctx, "setting.resync")).map(
      (a) => a.target_id,
    );
    expect(resyncAudits).toContain("license.defaults.deviceLimit");
    expect(resyncAudits).not.toContain("core.name");
    expect(resyncAudits).not.toContain("config.catalog");
  });

  it("the console's resync route answers what it kept as claimed", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", "", { name: "Mine" });
    // The manual resync route fetches with the global fetch; serve it the stubbed GitHub.
    const real = globalThis.fetch;
    globalThis.fetch = github({ name: "Acme Two" }) as typeof fetch;
    try {
      const res = await call(ctx, "POST", "release/resync");
      expect(res.status).toBe(200);
      expect(res.json.claimed).toEqual(["core.name"]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("the product view lists the claims", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", "", { defaultDeviceLimit: 9, name: "Mine" });
    const view = (await call(ctx, "GET", "")).json.product as {
      claims: { key: string; claimedBy: string }[];
    };
    expect(view.claims.map((c) => c.key)).toEqual([
      "core.name",
      "license.defaults.deviceLimit",
    ]);
    expect(view.claims[0]!.claimedBy).toBe("u1");
  });
});

// ── Tiers and profiles, per row ──────────────────────────────────────────────────────────

describe("tiers and profiles carry a per-row source (ST-01b)", () => {
  it("a console-only tier and profile survive a resync whose manifest omits them", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "POST", "config/profiles", { id: "console-prof" }))
        .status,
    ).toBe(201);
    expect(
      (
        await call(ctx, "POST", "license/tiers", {
          id: "console-tier",
          label: "Console tier",
          profile: "console-prof",
        })
      ).status,
    ).toBe(201);
    await okResync(ctx);
    expect(await rows(ctx, "tiers")).toEqual([
      expect.objectContaining({ id: "console-tier", source: "console" }),
      expect.objectContaining({ id: "standard", source: "manifest" }),
    ]);
    expect(await rows(ctx, "profiles")).toEqual([
      expect.objectContaining({ id: "console-prof", source: "console" }),
      expect.objectContaining({ id: "standard", source: "manifest" }),
    ]);
  });

  it("a manifest row the manifest drops goes when nothing references it, with an audit row", async () => {
    const ctx = await linked({
      tiers: [
        { id: "standard", profileId: "standard" },
        { id: "legacy", label: "Legacy" },
      ],
    });
    await okResync(ctx);
    expect((await rows(ctx, "tiers")).map((t) => t.id)).toEqual(["standard"]);
    expect(
      (await audits(ctx, "setting.resync")).filter(
        (a) => a.target_kind === "tier" && a.target_id === "legacy",
      ),
    ).toHaveLength(1);
  });

  it("a console edit to a manifest tier claims it; the resync leaves it alone", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "PATCH", "license/tiers/standard", { label: "Mine" }))
        .status,
    ).toBe(200);
    const res = await okResync(ctx, {
      tiers: [
        { id: "standard", label: "Manifest label", profileId: "standard" },
      ],
    });
    expect((await rows(ctx, "tiers"))[0]).toMatchObject({
      id: "standard",
      label: "Mine",
      source: "console",
    });
    expect(res.claimed).toContain("tier:standard");
    expect(res.refused ?? []).toEqual([]);
  });

  it("a console row holding a NEW manifest row's id is kept and reported as a conflict", async () => {
    const ctx = await linked();
    await call(ctx, "POST", "license/tiers", {
      id: "gold",
      label: "Console gold",
    });
    const res = await okResync(ctx, {
      tiers: [
        { id: "standard", profileId: "standard" },
        { id: "gold", label: "Manifest gold" },
      ],
    });
    expect(res.conflicts).toEqual([
      expect.objectContaining({ path: "/tiers/gold" }),
    ]);
    expect(res.refused ?? []).toEqual([]);
    expect(
      (await rows(ctx, "tiers")).find((t) => t.id === "gold"),
    ).toMatchObject({ label: "Console gold", source: "console" });
  });
});

// ── A refused resync writes nothing ──────────────────────────────────────────────────────

describe("a refused resync leaves every row unchanged (ST-01b)", () => {
  const state = async (ctx: Ctx) => ({
    product: await ctx.db.first("SELECT * FROM products WHERE slug = ?", SLUG),
    tiers: await rows(ctx, "tiers"),
    profiles: await rows(ctx, "profiles"),
    schema: await ctx.db.all(
      "SELECT * FROM product_schema WHERE product = ? ORDER BY catalog_version",
      SLUG,
    ),
    snapshot: await ctx.db.first(
      "SELECT * FROM product_manifest_snapshot WHERE product = ?",
      SLUG,
    ),
    audit: await ctx.db.all(
      "SELECT id FROM audit WHERE product = ? ORDER BY id",
      SLUG,
    ),
    oidc: await ctx.db.all("SELECT * FROM oidc_config WHERE product = ?", SLUG),
    release: await ctx.db.first(
      "SELECT * FROM release_config WHERE product = ?",
      SLUG,
    ),
  });

  it("by the referenced-tier guard", async () => {
    const ctx = await linked({
      tiers: [
        { id: "standard", profileId: "standard" },
        { id: "legacy", label: "Legacy" },
      ],
    });
    await seedLicenseWithKey(ctx.db, SLUG, { tierId: "legacy" });
    const before = await state(ctx);
    const res = await resync(ctx, {
      name: "Acme Two",
      offline: 30,
      devices: 8,
      adminGroup: "acme-ops",
      origins: ["https://other.example"],
      schema: schemaJson("run.other"),
    });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot remove tier legacy/),
    });
    expect(await state(ctx)).toEqual(before);
  });

  it("by the referenced-profile guard (a console tier still points at it)", async () => {
    const ctx = await linked({ profiles: ["standard", "extra"] });
    await call(ctx, "POST", "license/tiers", { id: "mine", profile: "extra" });
    const before = await state(ctx);
    const res = await resync(ctx, { name: "Acme Two" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot remove profile extra/),
    });
    expect(await state(ctx)).toEqual(before);
  });
});

// ── Revert ───────────────────────────────────────────────────────────────────────────────

describe("Revert to manifest (ST-01b)", () => {
  it("restores the snapshot value at once and drops the claim", async () => {
    const ctx = await linked({ devices: 3 });
    await call(ctx, "PATCH", "", { defaultDeviceLimit: 9, name: "Mine" });
    const res = await call(
      ctx,
      "DELETE",
      "claims/license.defaults.deviceLimit",
    );
    expect(res).toMatchObject({
      status: 200,
      json: { ok: true, applied: true, value: 3 },
    });
    expect((await productRow(ctx)).default_device_limit).toBe(3);
    expect((await claimRows(ctx)).map((c) => c.key)).toEqual(["core.name"]);
    expect(await audits(ctx, "setting.revert")).toEqual([
      expect.objectContaining({ target_id: "license.defaults.deviceLimit" }),
    ]);
    // With the claim gone, the next resync owns the field again.
    await okResync(ctx, { devices: 4 });
    expect((await productRow(ctx)).default_device_limit).toBe(4);
  });

  it("restores the snapshot's catalog as a new active version", async () => {
    const ctx = await linked();
    await call(ctx, "PUT", "config/catalog", {
      catalog: JSON.parse(schemaJson("console.only")),
    });
    expect(await activeCatalog(ctx)).toEqual(["console.only"]);
    const res = await call(ctx, "DELETE", "claims/config.catalog");
    expect(res.json).toMatchObject({ applied: true });
    expect(await activeCatalog(ctx)).toEqual(["run.name"]);
  });

  it("refuses a snapshot catalog that fails the catalog screen, keeping the claim", async () => {
    // A claimed catalog is not screened by the resync (it is not installed), but the snapshot
    // still records it; Revert must screen it before it becomes the active version.
    const ctx = await linked();
    await call(ctx, "PUT", "config/catalog", {
      catalog: JSON.parse(schemaJson("console.only")),
    });
    const bad = JSON.stringify({
      schemaVersion: 1,
      entries: [
        { ...entry("run.name"), schema: { type: "string", pattern: 42 } },
      ],
    });
    const res = await okResync(ctx, { schema: bad });
    expect(res.claimed).toContain("config.catalog");
    const schemaRows = () =>
      ctx.db.all(
        "SELECT * FROM product_schema WHERE product = ? ORDER BY catalog_version",
        SLUG,
      );
    const before = await schemaRows();
    const revert = await call(ctx, "DELETE", "claims/config.catalog");
    expect(revert.status).toBe(409);
    expect(revert.json).toMatchObject({ reason: "invalid_catalog" });
    expect(await schemaRows()).toEqual(before);
    expect(await activeCatalog(ctx)).toEqual(["console.only"]);
    expect((await claimRows(ctx)).map((c) => c.key)).toEqual([
      "config.catalog",
    ]);
    expect(await audits(ctx, "setting.revert")).toEqual([]);
  });

  it("says it applies at the next resync when the product has no snapshot", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", "", { name: "Mine" });
    await ctx.db.run(
      "DELETE FROM product_manifest_snapshot WHERE product = ?",
      SLUG,
    );
    const res = await call(ctx, "DELETE", "claims/core.name");
    expect(res).toMatchObject({
      status: 200,
      json: { ok: true, applied: false, message: "applies at the next resync" },
    });
    expect((await productRow(ctx)).name).toBe("Mine");
    expect(await claimRows(ctx)).toEqual([]);
    await okResync(ctx, { name: "Acme Two" });
    expect((await productRow(ctx)).name).toBe("Acme Two");
  });

  it("refuses an unclaimed or unknown key", async () => {
    const ctx = await linked();
    expect((await call(ctx, "DELETE", "claims/core.name")).json).toMatchObject({
      reason: "not_claimed",
    });
    expect((await call(ctx, "DELETE", "claims/core.adminGroup")).status).toBe(
      404,
    );
    expect((await call(ctx, "POST", "claims/core.name")).status).toBe(405);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────────────────

describe("claims that are refused (ST-01b)", () => {
  it("a console claim on a system = 1 product is refused", async () => {
    const ctx = await linked();
    await ctx.db.run("UPDATE products SET system = 1 WHERE slug = ?", SLUG);
    const patch = await call(ctx, "PATCH", "", { defaultDeviceLimit: 9 });
    expect(patch).toMatchObject({
      status: 409,
      json: { reason: "manifest_authoritative" },
    });
    const put = await call(ctx, "PUT", "config/catalog", {
      catalog: JSON.parse(schemaJson("console.only")),
    });
    expect(put).toMatchObject({
      status: 409,
      json: { reason: "manifest_authoritative" },
    });
    expect(await claimRows(ctx)).toEqual([]);
    expect((await productRow(ctx)).default_device_limit).toBe(3);
  });

  it("the admin group is manifest-only on a repo-linked product", async () => {
    const ctx = await linked();
    const res = await call(ctx, "PATCH", "", { adminGroup: "console-group" });
    expect(res).toMatchObject({
      status: 409,
      json: { reason: "manifest_only" },
    });
    expect((await productRow(ctx)).admin_group).toBe("acme-admins");
  });

  it("a profile edit that only sets a managed secret does not claim the row", async () => {
    const ctx = await linked({
      schema: JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            key: "api.key",
            kind: "secret",
            category: "api",
            label: "API key",
            description: "",
            schema: { type: "string", minLength: 8 },
          },
        ],
      }),
    });
    const res = await call(ctx, "PUT", "config/profiles/standard", {
      updates: [{ key: "api.key", value: "sk-0123456789", state: "enforced" }],
    });
    expect(res.status).toBe(200);
    expect((await rows(ctx, "profiles"))[0]!.source).toBe("manifest");
  });
});
