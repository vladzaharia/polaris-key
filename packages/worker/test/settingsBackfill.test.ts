/**
 * The settings backfill (ST-01c; notes/S-18 §4.14, owner decision D19 "Revert all console
 * values").
 *
 * ST-01b gave every claimable setting an owner but left existing products as they were: existing
 * tier and profile rows read `manifest` (the column default) and an edit made before ST-01b has no
 * claim. The backfill moves a linked product onto the claim model once. Pinned here:
 *
 *   - the classification of S-18 §4.14.1 over fixtures: equal, differs (with the audit evidence),
 *     not declared, an unlinked product, a product with no `commit_sha` (and none of the bounds the
 *     evidence prefers) and a `.pkey/` that cannot be read;
 *   - the apply: every declared field equals the manifest afterwards, its console claim gone, and
 *     every undeclared row is `console`; one `setting.backfill` audit row; the report is stored and
 *     readable after the apply; a second apply changes nothing and stores an empty report;
 *   - a live break-glass claim (ST-20) is kept; the system product's bootstrap services marker is
 *     reset only when its services equal the root `.pkey/`;
 *   - a console edit landing while the backfill reads GitHub aborts the whole apply (409);
 *   - the corroborating read at the stored push sha is compare-only;
 *   - the platform batch, and the migration replays on a populated database.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, TEST_KEK } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "./githubHead.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { parseManifest } from "../src/services/release/manifest.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES } from "../src/mount.js";
import { stmtClaim } from "../src/core/settingsClaims.js";
import { isSealedEnvelope } from "../src/admin/lib/managedSecrets.js";
import {
  ensureSystemProduct,
  linkSystemProduct,
} from "../src/admin/systemProduct.js";
import { parseServices, serializeServices } from "../src/core/services.js";
import {
  runPlatformBackfill,
  runSettingsBackfill,
  type BackfillRunOptions,
} from "../src/admin/settingsBackfill.js";
import {
  planBackfill,
  REDACTED,
  type BackfillItem,
  type BackfillManifest,
  type BackfillReport,
} from "../src/core/settingsBackfill.js";
import type { ProductSettingRow } from "../src/core/settingsClaims.js";

const SLUG = "acme";
const PLATFORM_GROUP = "platform-admins";
const ACTOR = { sub: "u1", name: "Ada", email: "ada@x.io" };
const PUSH_SHA = "f".repeat(40);

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
  /** `licensing.*` (LX-06's row-backed settings), when declared. */
  licensing?: Record<string, unknown>;
}

const BASE = {
  name: "Acme",
  offline: 14,
  devices: 3,
  adminGroup: "acme-admins",
  origins: ["https://app.acme.example"] as string[] | undefined,
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
      ...(d.licensing ? { licensing: d.licensing } : {}),
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

interface GithubOpts {
  /** The documents at the default branch's head. */
  head?: Decl;
  /** The documents at other commits (the corroborating read), by sha. */
  at?: Record<string, Decl>;
  /** Fail every Contents read (the repository is gone, the App uninstalled). */
  failContents?: boolean;
  /** Runs once, on the first Contents read: a console edit landing mid-backfill. */
  during?: () => Promise<void>;
}

/** GitHub, stubbed: installation discovery, the token exchange, `.pkey/` contents by ref. */
function github(opts: GithubOpts = {}): FetchImpl & { refs: string[] } {
  const refs: string[] = [];
  let during = opts.during;
  const impl = withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      if (during) {
        const run = during;
        during = undefined;
        await run();
      }
      if (opts.failContents) return new Response("boom", { status: 500 });
      const ref = new URL(url).searchParams.get("ref") ?? "";
      refs.push(ref);
      const docs = files(
        ref === HEAD_SHA ? opts.head : (opts.at?.[ref] ?? opts.head),
      );
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
  }) as FetchImpl & { refs: string[] };
  impl.refs = refs;
  return impl;
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** A product linked from `d` (writes the `link` snapshot, ST-01a). */
async function linked(d: Decl = {}) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    github({ head: d }),
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
  at = NOW + 1,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: ctx.cookie };
  if (method !== "GET") headers[CSRF_HEADER] = ctx.csrf;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const full = `/api/${path}`;
  const req = new Request(`https://key.plrs.im/manage${full}`, init);
  // The dispatcher is handed the path; the query stays on the request's URL.
  const res = await handleAdmin(req, ctx.env, ctx.db, full.split("?")[0]!, {
    now: at,
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

function run(
  ctx: { env: Env; db: Db },
  opts: Partial<BackfillRunOptions> & { github?: GithubOpts } = {},
  slug = SLUG,
) {
  return runSettingsBackfill(ctx.env, ctx.db, slug, {
    dryRun: false,
    actor: ACTOR,
    now: NOW + 100,
    fetchImpl: github(opts.github),
    ...opts,
  });
}

async function okRun(
  ctx: { env: Env; db: Db },
  opts: Partial<BackfillRunOptions> & { github?: GithubOpts } = {},
  slug = SLUG,
): Promise<BackfillReport> {
  const res = await run(ctx, opts, slug);
  if (!res.ok) throw new Error(`backfill refused: ${res.message}`);
  return res.report;
}

const item = (
  report: BackfillReport,
  kind: BackfillItem["kind"],
  key: string,
): BackfillItem => {
  const found = report.items.find((i) => i.kind === kind && i.key === key);
  if (!found) throw new Error(`no ${kind} ${key} in the report`);
  return found;
};

interface ProductCols {
  name: string;
  default_max_offline_days: number;
  default_device_limit: number;
  admin_group: string | null;
  web_origins_json: string | null;
  services_json: string | null;
  services_source: string | null;
}
const productRow = (db: Db, slug = SLUG) =>
  db.first<ProductCols>(
    `SELECT name, default_max_offline_days, default_device_limit, admin_group, web_origins_json,
            services_json, services_source
       FROM products WHERE slug = ?`,
    slug,
  ) as Promise<ProductCols>;

const rows = (db: Db, table: "tiers" | "profiles") =>
  db.all<{ id: string; source: string; label?: string; name?: string }>(
    `SELECT * FROM ${table} WHERE product = ? ORDER BY id`,
    SLUG,
  );

const claimRows = (db: Db, slug = SLUG) =>
  db.all<{ key: string; source: string; expires_at: number | null }>(
    "SELECT key, source, expires_at FROM product_settings WHERE product = ? ORDER BY key",
    slug,
  );

const audits = (db: Db, action: string, slug = SLUG) =>
  db.all<{ actor_sub: string; target_id: string; summary: string }>(
    "SELECT actor_sub, target_id, summary FROM audit WHERE product = ? AND action = ? ORDER BY at, id",
    slug,
    action,
  );

const reportRows = (db: Db, slug = SLUG) =>
  db.all<{ id: string; mode: string; outcome: string; changes: number }>(
    "SELECT id, mode, outcome, changes FROM settings_backfill_reports WHERE product = ? ORDER BY at, id",
    slug,
  );

const activeCatalogKeys = async (db: Db): Promise<string[]> => {
  const row = await db.first<{ catalog_json: string }>(
    "SELECT catalog_json FROM product_schema WHERE product = ? AND active = 1",
    SLUG,
  );
  return (
    JSON.parse(row!.catalog_json) as { entries: { key: string }[] }
  ).entries.map((e) => e.key);
};

/** Edits made in the console BEFORE ST-01b: values changed, no claim, rows still `manifest`. */
async function preClaimConsoleEdits(db: Db, at = NOW + 10): Promise<void> {
  await db.batch([
    {
      sql: "UPDATE products SET name = ?, default_device_limit = ?, modified_at = ? WHERE slug = ?",
      params: ["Acme (console)", 9, at, SLUG],
    },
    {
      sql: "UPDATE tiers SET label = ?, modified_at = ? WHERE product = ? AND id = ?",
      params: ["Standard (console)", at, SLUG, "standard"],
    },
    {
      // A console-created tier from before ST-01b: the column default made it `manifest`.
      sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
              modified_by, modified_at)
            VALUES (?, 'legacy', 'Legacy', NULL, NULL, NULL, 'u1', ?)`,
      params: [SLUG, at],
    },
    {
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            VALUES (?, 'aud_1', ?, 'u1', 'Ada', NULL, 'product.update', 'product', ?, NULL,
                    'Updated product acme')`,
      params: [SLUG, at, SLUG],
    },
    {
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            VALUES (?, 'aud_2', ?, 'u1', 'Ada', NULL, 'tier.update', 'tier', 'standard', NULL,
                    'Updated tier standard')`,
      params: [SLUG, at],
    },
  ]);
}

// ── Classification (S-18 §4.14.1, §4.14.2 steps 1–5) ──────────────────────────────────────

describe("classification over fixtures", () => {
  it("equal: a product the manifest describes exactly classifies equal and needs nothing", async () => {
    const ctx = await linked();
    const report = await okRun(ctx, { dryRun: true });
    expect(report).toMatchObject({
      mode: "dry-run",
      outcome: "planned",
      changes: 0,
      source: {
        kind: "github",
        repository: "acme-org/acme-app",
        commit: HEAD_SHA,
      },
    });
    for (const i of report.items.filter((x) => x.kind !== "marker")) {
      expect(i.class, `${i.kind} ${i.key}`).toBe("equal");
      expect(i.action, `${i.kind} ${i.key}`).toBe("none");
    }
    expect(item(report, "setting", "config.catalog").class).toBe("equal");
  });

  it("differs: a pre-ST-01b console edit is listed with its audit evidence; a manifest change without one says so", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    const report = await okRun(ctx, {
      dryRun: true,
      github: { head: { offline: 21 } },
    });
    const name = item(report, "setting", "core.name");
    expect(name).toMatchObject({
      class: "differs",
      owner: "manifest",
      before: "Acme (console)",
      manifest: "Acme",
      action: "revert",
      evidence: { verdict: "console-edit" },
    });
    expect(name.evidence!.rows[0]).toMatchObject({
      action: "product.update",
      actor: "Ada",
    });
    // The manifest moved (14 → 21) with no console edit to the field since the last apply.
    expect(
      item(report, "setting", "license.defaults.maxOfflineDays"),
    ).toMatchObject({
      class: "differs",
      before: 14,
      manifest: 21,
      action: "revert",
    });
    const tier = item(report, "tier", "standard");
    expect(tier).toMatchObject({
      class: "differs",
      owner: "manifest",
      changed: ["label"],
      action: "revert",
      evidence: { verdict: "console-edit" },
    });
    // The evidence is bound by the last apply (the link's snapshot).
    expect(report.evidence).toEqual({
      basis: "snapshot",
      since: NOW,
      weak: false,
    });
  });

  it("differs, claimed: a console claim on a differing field is listed and dropped by the apply", async () => {
    const ctx = await linked();
    expect(
      (await call(ctx, "PATCH", `products/${SLUG}`, { name: "Acme Claimed" }))
        .status,
    ).toBe(200);
    const report = await okRun(ctx, { dryRun: true });
    expect(item(report, "setting", "core.name")).toMatchObject({
      class: "differs",
      owner: "console",
      claim: { by: "u1" },
      action: "revert",
      evidence: { verdict: "console-edit" },
    });
  });

  it("equal but claimed: only the claim goes (release-claim)", async () => {
    const ctx = await linked();
    await ctx.db.batch([stmtClaim(SLUG, "core.name", "u1", NOW + 5)]);
    const report = await okRun(ctx, { dryRun: true });
    expect(item(report, "setting", "core.name")).toMatchObject({
      class: "equal",
      owner: "console",
      action: "release-claim",
    });
    expect(report.changes).toBe(1);
  });

  it("not declared: an undeclared manifest row becomes console, an undeclared console row stays", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    expect(
      (
        await call(ctx, "POST", `products/${SLUG}/license/tiers`, {
          id: "pro",
          label: "Pro",
        })
      ).status,
    ).toBe(201);
    const report = await okRun(ctx, { dryRun: true });
    expect(item(report, "tier", "legacy")).toMatchObject({
      class: "not-declared",
      owner: "manifest",
      action: "mark-console",
    });
    expect(item(report, "tier", "pro")).toMatchObject({
      class: "not-declared",
      owner: "console",
      action: "none",
    });
    expect(item(report, "tier", "legacy").manifest).toBeUndefined();
  });

  it("unlinked: a manual product gets an `unlinked` report and nothing else", async () => {
    const db = makeTestDb();
    const env = envFor();
    await seedProduct(db, "manual");
    const fetchImpl = github();
    const report = await okRun({ env, db }, { fetchImpl }, "manual");
    expect(report).toMatchObject({
      outcome: "unlinked",
      items: [],
      changes: 0,
    });
    expect(report.message).toMatch(/not linked/);
    expect(fetchImpl.refs).toEqual([]);
    expect(await claimRows(db, "manual")).toEqual([]);
    expect(await audits(db, "setting.backfill", "manual")).toEqual([]);
    expect(await reportRows(db, "manual")).toHaveLength(1);
  });

  it("no commit_sha and no last apply on record: the evidence falls back to the product's creation and says it is weak", async () => {
    const ctx = await linked();
    // Linked before ST-01a and never resynced since: no snapshot, no sync state.
    await ctx.db.run(
      "DELETE FROM product_manifest_snapshot WHERE product = ?",
      SLUG,
    );
    await ctx.db.run("DELETE FROM product_sync_state WHERE product = ?", SLUG);
    await preClaimConsoleEdits(ctx.db);
    const report = await okRun(ctx, { dryRun: true });
    expect(report.evidence).toEqual({
      basis: "created",
      since: NOW,
      weak: true,
    });
    expect(report.corroboration).toMatchObject({ commitSha: null });
    expect(item(report, "setting", "core.name")).toMatchObject({
      class: "differs",
      evidence: { verdict: "console-edit" },
    });
  });

  it("fetch failure: `cannot read .pkey/`, nothing written but the report", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    const before = await productRow(ctx.db);
    for (const dryRun of [true, false]) {
      const report = await okRun(ctx, {
        dryRun,
        github: { failContents: true },
      });
      expect(report).toMatchObject({ outcome: "unreadable", items: [] });
      expect(report.message).toMatch(/^cannot read \.pkey\//);
    }
    expect(await productRow(ctx.db)).toEqual(before);
    expect(await audits(ctx.db, "setting.backfill")).toEqual([]);
    expect((await reportRows(ctx.db)).map((r) => r.outcome)).toEqual([
      "unreadable",
      "unreadable",
    ]);
  });
});

// ── The corroborating read at the stored push sha (S-18 §4.14.2 step 2) ───────────────────

describe("corroboration", () => {
  async function withPush(ctx: Ctx, sha: string | null) {
    await ctx.db.run(
      `INSERT INTO product_sync_state (product, source, status, last_checked_at, last_synced_at, commit_sha)
       VALUES (?, 'webhook', 'ok', ?, ?, ?)
       ON CONFLICT(product) DO UPDATE SET commit_sha = excluded.commit_sha`,
      SLUG,
      NOW,
      NOW,
      sha,
    );
  }

  it("reads the push's documents, compares their digest, and never applies them", async () => {
    const ctx = await linked();
    await withPush(ctx, PUSH_SHA);
    const fetchImpl = github({
      at: { [PUSH_SHA]: { name: "Feature Branch" } },
    });
    const report = await okRun(ctx, { fetchImpl });
    expect(fetchImpl.refs).toContain(PUSH_SHA);
    expect(report.corroboration).toEqual({
      commitSha: PUSH_SHA,
      matches: false,
    });
    expect((await productRow(ctx.db)).name).toBe("Acme");

    const same = await okRun(ctx, { dryRun: true });
    expect(same.corroboration).toEqual({ commitSha: PUSH_SHA, matches: true });
  });

  it("a malformed stored sha is never used as a ref", async () => {
    const ctx = await linked();
    await withPush(ctx, "main; rm -rf /");
    const fetchImpl = github();
    const report = await okRun(ctx, { dryRun: true, fetchImpl });
    expect(report.corroboration).toMatchObject({ commitSha: null });
    expect(new Set(fetchImpl.refs)).toEqual(new Set([HEAD_SHA]));
  });
});

// ── The apply ──────────────────────────────────────────────────────────────────────────────

describe("the apply", () => {
  it("every declared field equals the manifest and every undeclared console row is `console`", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    // Post-ST-01b claims too: a claimed name would otherwise survive every resync.
    await ctx.db.batch([
      stmtClaim(SLUG, "license.defaults.maxOfflineDays", "u1", NOW + 20),
      {
        sql: "UPDATE products SET default_max_offline_days = 60, web_origins_json = ? WHERE slug = ?",
        params: [JSON.stringify(["https://console.example"]), SLUG],
      },
      stmtClaim(SLUG, "core.web.origins", "u1", NOW + 20),
      {
        sql: "UPDATE profiles SET name = 'Console profile', source = 'console' WHERE product = ? AND id = 'standard'",
        params: [SLUG],
      },
    ]);
    const next = {
      adminGroup: "acme-ops",
      schema: schemaJson("run.name", "run.added"),
    };
    const report = await okRun(ctx, { github: { head: next } });
    expect(report).toMatchObject({ mode: "apply", outcome: "applied" });
    expect(report.changes).toBeGreaterThan(0);

    const p = await productRow(ctx.db);
    expect(p).toMatchObject({
      name: "Acme",
      default_max_offline_days: 14,
      default_device_limit: 3,
      admin_group: "acme-ops",
    });
    expect(JSON.parse(p.web_origins_json!)).toEqual([
      "https://app.acme.example",
    ]);
    expect(await activeCatalogKeys(ctx.db)).toEqual(["run.name", "run.added"]);
    expect(await claimRows(ctx.db)).toEqual([]);
    expect(await rows(ctx.db, "tiers")).toEqual([
      expect.objectContaining({ id: "legacy", source: "console" }),
      expect.objectContaining({
        id: "standard",
        source: "manifest",
        label: "Standard",
      }),
    ]);
    expect(await rows(ctx.db, "profiles")).toEqual([
      expect.objectContaining({
        id: "standard",
        source: "manifest",
        name: "standard",
      }),
    ]);

    // One audit row, the operator as actor, every change with before and after.
    const rowsOut = await audits(ctx.db, "setting.backfill");
    expect(rowsOut).toHaveLength(1);
    expect(rowsOut[0]!.actor_sub).toBe("u1");
    expect(rowsOut[0]!.summary).toContain(`"Acme (console)" → "Acme"`);
    expect(rowsOut[0]!.summary).toContain("tier legacy: kept as a console row");
    expect(rowsOut[0]!.summary).toContain(`report ${report.id}`);

    // The snapshot now describes the manifest the backfill applied (origin `backfill`).
    const snap = await ctx.db.first<{ origin: string; applied_sha: string }>(
      "SELECT origin, applied_sha FROM product_manifest_snapshot WHERE product = ?",
      SLUG,
    );
    expect(snap).toEqual({ origin: "backfill", applied_sha: HEAD_SHA });
    expect(report.snapshot).toBe("written");

    // A resync afterwards keeps the console-only tier it would otherwise delete.
    const { resyncRepo } = await import("../src/services/release/resync.js");
    const res = await resyncRepo(
      ctx.env,
      ctx.db,
      SLUG,
      NOW + 200,
      github({ head: next }),
      manifestIngestFor(SERVICES),
    );
    expect(res.ok).toBe(true);
    expect((await rows(ctx.db, "tiers")).map((t) => t.id)).toEqual([
      "legacy",
      "standard",
    ]);
  });

  it("the dry-run report is stored and readable after the apply", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    // The routes read GitHub through the global fetch, as Release's resync route does.
    const original = globalThis.fetch;
    globalThis.fetch = github() as typeof fetch;
    onTestFinished(() => {
      globalThis.fetch = original;
    });
    const dry = await call(
      ctx,
      "POST",
      `products/${SLUG}/settings/backfill?dryRun=1`,
    );
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, outcome: "planned" });
    // The dry run wrote nothing but its report.
    expect((await productRow(ctx.db)).name).toBe("Acme (console)");

    const applied = await call(
      ctx,
      "POST",
      `products/${SLUG}/settings/backfill?dryRun=0&expectReport=${dry.json.reportId as string}`,
      undefined,
      NOW + 2,
    );
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ dryRun: false, outcome: "applied" });
    expect((applied.json.report as BackfillReport).basedOn).toBe(
      dry.json.reportId,
    );
    // The same dry run cannot be applied twice: the apply changed the product's state.
    const again = await call(
      ctx,
      "POST",
      `products/${SLUG}/settings/backfill?dryRun=0&expectReport=${dry.json.reportId as string}`,
      undefined,
      NOW + 3,
    );
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "backfill_stale" });

    const list = await call(ctx, "GET", `products/${SLUG}/settings/backfill`);
    const reports = list.json.reports as { id: string; mode: string }[];
    expect(reports.map((r) => r.mode)).toEqual(["apply", "dry-run"]);
    const one = await call(
      ctx,
      "GET",
      `products/${SLUG}/settings/backfill/${dry.json.reportId as string}`,
    );
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ mode: "dry-run", outcome: "planned" });
    const stored = one.json.report as BackfillReport;
    expect(item(stored, "setting", "core.name")).toMatchObject({
      class: "differs",
      before: "Acme (console)",
      manifest: "Acme",
    });
  });

  it("a second apply is a no-op and records an empty report", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    await okRun(ctx);
    const after = {
      product: await productRow(ctx.db),
      tiers: await rows(ctx.db, "tiers"),
      profiles: await rows(ctx.db, "profiles"),
      catalog: await activeCatalogKeys(ctx.db),
      snapshot: await ctx.db.first(
        "SELECT * FROM product_manifest_snapshot WHERE product = ?",
        SLUG,
      ),
    };
    const second = await okRun(ctx, { now: NOW + 500 });
    expect(second).toMatchObject({
      outcome: "unchanged",
      changes: 0,
      snapshot: "current",
    });
    expect(
      second.items.every((i) => i.action === "none" || i.action === "keep"),
    ).toBe(true);
    expect({
      product: await productRow(ctx.db),
      tiers: await rows(ctx.db, "tiers"),
      profiles: await rows(ctx.db, "profiles"),
      catalog: await activeCatalogKeys(ctx.db),
      snapshot: await ctx.db.first(
        "SELECT * FROM product_manifest_snapshot WHERE product = ?",
        SLUG,
      ),
    }).toEqual(after);
    expect(await audits(ctx.db, "setting.backfill")).toHaveLength(1);
    expect(
      (await reportRows(ctx.db)).map((r) => [r.outcome, r.changes]),
    ).toEqual([
      ["applied", expect.any(Number)],
      ["unchanged", 0],
    ]);
  });

  it("reverting a console-edited profile keeps its sealed secret values, and the report never holds one", async () => {
    const withSecret = JSON.stringify({
      schemaVersion: 1,
      entries: [
        entry("run.name"),
        {
          key: "api.key",
          kind: "secret",
          category: "api",
          label: "API key",
          description: "",
          schema: { type: "string", minLength: 8 },
        },
      ],
    });
    const ctx = await linked({ schema: withSecret });
    const put = async (key: string, value: string) =>
      expect(
        (
          await call(ctx, "PUT", `products/${SLUG}/config/profiles/standard`, {
            updates: [{ key, value, state: "enforced" }],
          })
        ).status,
      ).toBe(200);
    await put("api.key", "sk-secret-0001");
    await put("run.name", "console value");
    expect((await rows(ctx.db, "profiles"))[0]!.source).toBe("console");

    const report = await okRun(ctx, {
      github: { head: { schema: withSecret } },
    });
    expect(item(report, "profile", "standard")).toMatchObject({
      class: "differs",
      owner: "console",
      action: "revert",
      changed: ["config.run.name"],
    });
    expect(JSON.stringify(report)).not.toContain("sk-secret-0001");
    const stored = await ctx.db.first<{ payload_json: string; source: string }>(
      "SELECT payload_json, source FROM profiles WHERE product = ? AND id = 'standard'",
      SLUG,
    );
    expect(stored!.source).toBe("manifest");
    const payload = JSON.parse(stored!.payload_json) as {
      config?: Record<string, unknown>;
      secrets?: Record<string, { value?: unknown }>;
    };
    expect(payload.config?.["run.name"]).toBeUndefined();
    expect(isSealedEnvelope(payload.secrets?.["api.key"]?.value)).toBe(true);
    const row = await ctx.db.first<{ report_json: string }>(
      "SELECT report_json FROM settings_backfill_reports WHERE product = ?",
      SLUG,
    );
    expect(row!.report_json).not.toContain("sk-secret-0001");
  });

  it("a live break-glass claim is kept; an expired one ends (ST-20) and its field reverts", async () => {
    const ctx = await linked();
    await ctx.db.batch([
      {
        sql: "UPDATE products SET name = 'Incident', default_device_limit = 8 WHERE slug = ?",
        params: [SLUG],
      },
      {
        sql: `INSERT INTO product_settings (product, key, value_json, source, version, updated_at,
                updated_by, reason, expires_at)
              VALUES (?, 'core.name', NULL, 'console', 1, ?, 'u1', 'incident 42', ?),
                     (?, 'license.defaults.deviceLimit', NULL, 'console', 1, ?, 'u1', 'old', ?)`,
        params: [SLUG, NOW, NOW + 7 * 86400, SLUG, NOW, NOW + 50],
      },
    ]);
    const report = await okRun(ctx);
    expect(item(report, "setting", "core.name")).toMatchObject({
      owner: "break-glass",
      action: "keep",
      claim: { reason: "incident 42" },
    });
    expect(
      item(report, "setting", "license.defaults.deviceLimit"),
    ).toMatchObject({
      owner: "break-glass",
      action: "revert",
      note: expect.stringMatching(/expired/),
    });
    const p = await productRow(ctx.db);
    expect(p.name).toBe("Incident");
    expect(p.default_device_limit).toBe(3);
    expect((await claimRows(ctx.db)).map((c) => c.key)).toEqual(["core.name"]);
    expect(
      (await audits(ctx.db, "setting.breakGlass.end")).map((a) => a.target_id),
    ).toEqual(["license.defaults.deviceLimit"]);
  });

  it("a break-glass claim whose field this manifest changes ends, and the field takes the manifest's value", async () => {
    const ctx = await linked();
    await ctx.db.batch([
      {
        sql: "UPDATE products SET name = 'Incident' WHERE slug = ?",
        params: [SLUG],
      },
      {
        sql: `INSERT INTO product_settings (product, key, value_json, source, version, updated_at,
                updated_by, reason, expires_at)
              VALUES (?, 'core.name', NULL, 'console', 1, ?, 'u1', 'incident 42', ?)`,
        params: [SLUG, NOW, NOW + 7 * 86400],
      },
    ]);
    // The link applied "Acme"; this manifest says "Acme Two": the claim's field changed.
    const report = await okRun(ctx, {
      github: { head: { name: "Acme Two" } },
    });
    expect(item(report, "setting", "core.name")).toMatchObject({
      owner: "break-glass",
      action: "revert",
      before: "Incident",
      manifest: "Acme Two",
      note: expect.stringMatching(/manifest changed the field/),
    });
    expect((await productRow(ctx.db)).name).toBe("Acme Two");
    expect(await claimRows(ctx.db)).toEqual([]);
    expect(
      (await audits(ctx.db, "setting.breakGlass.end")).map((a) => a.target_id),
    ).toEqual(["core.name"]);
  });

  it("under a live break-glass catalog, a reverted profile keeps the secrets that catalog declares", async () => {
    const opsToken = {
      key: "ops.token",
      kind: "secret",
      category: "ops",
      label: "Ops token",
      description: "",
      schema: { type: "string", minLength: 8 },
    };
    const ctx = await linked();
    // The console publishes a catalog adding `ops.token` (an ordinary claim on a linked
    // product), made break-glass as ST-20's manifest-authoritative mode would.
    const put = await call(ctx, "PUT", `products/${SLUG}/config/catalog`, {
      catalog: {
        schemaVersion: 1,
        entries: [entry("run.name"), opsToken],
      },
      expectedVersion: 1,
    });
    expect(put.status).toBe(200);
    await ctx.db.run(
      `UPDATE product_settings SET reason = 'incident 7', expires_at = ?
        WHERE product = ? AND key = 'config.catalog'`,
      NOW + 7 * 86400,
      SLUG,
    );
    const setOn = async (key: string, value: string) =>
      expect(
        (
          await call(ctx, "PUT", `products/${SLUG}/config/profiles/standard`, {
            updates: [{ key, value, state: "enforced" }],
          })
        ).status,
      ).toBe(200);
    await setOn("ops.token", "ops-secret-0001");
    await setOn("run.name", "console value");

    const report = await okRun(ctx);
    expect(item(report, "setting", "config.catalog")).toMatchObject({
      owner: "break-glass",
      action: "keep",
    });
    expect(item(report, "profile", "standard")).toMatchObject({
      action: "revert",
      changed: ["config.run.name"],
    });
    const stored = await ctx.db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = ? AND id = 'standard'",
      SLUG,
    );
    const payload = JSON.parse(stored!.payload_json) as {
      config?: Record<string, unknown>;
      secrets?: Record<string, { value?: unknown }>;
    };
    expect(payload.config?.["run.name"]).toBeUndefined();
    expect(isSealedEnvelope(payload.secrets?.["ops.token"]?.value)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("ops-secret-0001");
  });

  it("the report records the values a profile revert replaced, and redacts every secret", async () => {
    const schema = JSON.stringify({
      schemaVersion: 1,
      entries: [
        entry("run.name"),
        entry("run.other"),
        {
          ...entry("proxy.password"),
          secret: true,
        },
      ],
    });
    const ctx = await linked({ schema });
    const sealedShape = JSON.stringify({ v: 2, ct: "c2VhbGVkLWJ5dGVz" });
    await ctx.db.run(
      `UPDATE profiles SET source = 'console', payload_json = ? WHERE product = ? AND id = 'standard'`,
      JSON.stringify({
        config: {
          "run.name": {
            state: "enforced",
            value: "console value",
            updatedAt: 1,
          },
          // A legacy plaintext value of a managed secret, and a sealed value under a plain key.
          "proxy.password": {
            state: "enforced",
            value: "plain-pass-0001",
            updatedAt: 1,
          },
          "run.other": { state: "enforced", value: sealedShape, updatedAt: 1 },
        },
        secrets: {
          "gone.key": {
            state: "enforced",
            value: "plain-secret-0001",
            updatedAt: 1,
          },
        },
      }),
      SLUG,
    );
    const report = await okRun(ctx, {
      dryRun: true,
      github: { head: { schema } },
    });
    const profile = item(report, "profile", "standard");
    expect(profile.changed).toEqual([
      "config.proxy.password",
      "config.run.name",
      "config.run.other",
      "secrets.gone.key",
    ]);
    expect(profile.values).toEqual({
      "config.run.name": {
        before: { state: "enforced", value: "console value", updatedAt: 1 },
        manifest: null,
      },
      "config.proxy.password": { before: REDACTED, manifest: REDACTED },
      "config.run.other": { before: REDACTED, manifest: REDACTED },
      "secrets.gone.key": { before: REDACTED, manifest: REDACTED },
    });
    const row = await ctx.db.first<{ report_json: string }>(
      "SELECT report_json FROM settings_backfill_reports WHERE product = ?",
      SLUG,
    );
    for (const secret of ["plain-pass-0001", "plain-secret-0001", sealedShape])
      expect(row!.report_json).not.toContain(secret);
  });

  it("a catalog the validator refuses is not published: the product is refused, nothing written", async () => {
    const ctx = await linked();
    const bad = JSON.stringify({
      schemaVersion: 1,
      entries: [
        // Not a string: the manifest validator lets it through, the catalog compiler refuses it.
        { ...entry("run.bad"), schema: { type: "string", pattern: 42 } },
      ],
    });
    const report = await okRun(ctx, {
      github: { head: { schema: bad, name: "New" } },
    });
    expect(report.outcome).toBe("refused");
    expect(report.message).toMatch(/catalog/);
    expect((await productRow(ctx.db)).name).toBe("Acme");
    expect(await activeCatalogKeys(ctx.db)).toEqual(["run.name"]);
  });

  it("a console edit landing while the backfill reads GitHub aborts the whole apply (409)", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    const res = await run(ctx, {
      github: {
        during: async () => {
          await ctx.db.batch([
            {
              sql: "UPDATE products SET default_max_offline_days = 77, modified_at = ? WHERE slug = ?",
              params: [NOW + 99, SLUG],
            },
            stmtClaim(SLUG, "license.defaults.maxOfflineDays", "u2", NOW + 99),
          ]);
        },
      },
    });
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      reason: "backfill_conflict",
    });
    const p = await productRow(ctx.db);
    expect(p.name).toBe("Acme (console)");
    expect(p.default_max_offline_days).toBe(77);
    expect(await reportRows(ctx.db)).toEqual([]);
    expect(await audits(ctx.db, "setting.backfill")).toEqual([]);
  });

  it("an apply pinned to a dry run applies exactly what it showed, or refuses as stale", async () => {
    const ctx = await linked();
    await preClaimConsoleEdits(ctx.db);
    const dry = await okRun(ctx, { dryRun: true });
    expect(dry.stateToken).toEqual(expect.any(String));

    // The manifest moved (a push to the default branch) since the dry run.
    const moved = await run(ctx, {
      expectReport: dry.id,
      fetchImpl: withDefaultHead(github(), "e".repeat(40)),
    });
    expect(moved).toMatchObject({
      ok: false,
      status: 409,
      reason: "backfill_stale",
    });
    if (!moved.ok) expect(moved.message).toMatch(/manifest moved/);

    // A console edit since the dry run.
    await ctx.db.run(
      "UPDATE products SET default_device_limit = 4, modified_at = ? WHERE slug = ?",
      NOW + 50,
      SLUG,
    );
    const edited = await run(ctx, { expectReport: dry.id });
    expect(edited).toMatchObject({ ok: false, reason: "backfill_stale" });
    if (!edited.ok) expect(edited.message).toMatch(/settings changed/);

    // Not a dry run of this product.
    expect(await run(ctx, { expectReport: "sbf_nope" })).toMatchObject({
      ok: false,
      reason: "backfill_stale",
    });
    expect((await productRow(ctx.db)).default_device_limit).toBe(4);
    expect(await audits(ctx.db, "setting.backfill")).toEqual([]);

    // Read again, then apply: it writes what that dry run listed.
    const fresh = await okRun(ctx, { dryRun: true, now: NOW + 60 });
    const applied = await okRun(ctx, { expectReport: fresh.id });
    expect(applied.outcome).toBe("applied");
    expect(applied.items.map((i) => [i.kind, i.key, i.action])).toEqual(
      fresh.items.map((i) => [i.kind, i.key, i.action]),
    );
    expect((await productRow(ctx.db)).default_device_limit).toBe(3);
  });

  it("the routes require an explicit dryRun, and an apply the dry run it applies", async () => {
    const ctx = await linked();
    for (const q of [
      "",
      "?dryRun=yes",
      "?dryRun=0",
      "?dryRun=0&expectReport=HEAD",
      "?dryRun=0&expectCommit=" + "a".repeat(40),
    ]) {
      const res = await call(
        ctx,
        "POST",
        `products/${SLUG}/settings/backfill${q}`,
      );
      expect(res.status, q).toBe(400);
    }
    const wrongMethod = await call(
      ctx,
      "PUT",
      `products/${SLUG}/settings/backfill`,
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.json).toMatchObject({ code: "method_not_allowed" });
    expect(await reportRows(ctx.db)).toEqual([]);
  });

  it("the routes refuse a non-admin session (403) and a write without the CSRF header (403)", async () => {
    const ctx = await linked();
    const { token } = await issueSession(
      ctx.env,
      { sub: "u9", name: "Eve", email: "eve@x.io", groups: ["users"] },
      NOW,
    );
    const outsider = { ...ctx, cookie: `${ADMIN_COOKIE}=${token}` };
    for (const [method, path] of [
      ["GET", `products/${SLUG}/settings/backfill`],
      ["POST", `products/${SLUG}/settings/backfill?dryRun=1`],
      ["GET", "platform/settings/backfill"],
      ["POST", "platform/settings/backfill?dryRun=1"],
    ] as const) {
      const res = await call(outsider, method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    for (const path of [
      `products/${SLUG}/settings/backfill?dryRun=1`,
      "platform/settings/backfill?dryRun=1",
    ]) {
      const req = new Request(`https://key.plrs.im/manage/api/${path}`, {
        method: "POST",
        headers: { cookie: ctx.cookie },
      });
      const res = await handleAdmin(
        req,
        ctx.env,
        ctx.db,
        `/api/${path.split("?")[0]!}`,
        { now: NOW + 1 },
      );
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("forbidden");
    }
    expect(await reportRows(ctx.db)).toEqual([]);
  });
});

// ── Row-backed claimable settings (LX-06), through the pure planner ──────────────────────────

describe("row-backed claimable settings (the value is the product_settings row)", () => {
  const product = {
    slug: SLUG,
    name: "Acme",
    signing_kid: "k",
    signing_pub: null,
    compat_min: "0.0.0",
    compat_max: "99.0.0",
    default_max_offline_days: 14,
    default_device_limit: 3,
    admin_group: "acme-admins",
    branding_json: null,
    release_source: "github",
    web_origins_json: null,
    services_json: null,
    services_source: "manifest",
    created_at: NOW,
    modified_at: NOW,
  };
  const manifest = {
    product: {
      slug: SLUG,
      name: "Acme",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
      adminGroup: "acme-admins",
    },
    catalog: { schemaVersion: 1, entries: [] },
    tiers: [],
    profiles: [],
    webOrigins: [],
    services: parseServices(null).services,
  } as unknown as BackfillManifest;
  const row = (
    key: string,
    value: unknown,
    source: "manifest" | "console",
    expiresAt: number | null = null,
  ): ProductSettingRow => ({
    product: SLUG,
    key,
    value_json: JSON.stringify(value),
    source,
    version: 3,
    updated_at: NOW,
    updated_by: source === "console" ? "u1" : "resync",
    reason: expiresAt ? "incident" : null,
    expires_at: expiresAt,
  });

  it("classifies and plans each case", () => {
    const plan = planBackfill(
      manifest,
      {
        product,
        settings: [
          row("a.equalManifest", 1, "manifest"),
          row("a.claimedEqual", 2, "console"),
          row("a.claimedDiffers", 9, "console"),
          row("a.manifestDiffers", 9, "manifest"),
          row("a.breakGlass", 9, "console", NOW + 3600),
          row("a.undeclaredConsole", 5, "console"),
          row("a.undeclaredManifest", 5, "manifest"),
          row("a.secret", "old-token", "console"),
        ],
        tiers: [],
        profiles: [],
        activeSchema: {
          product: SLUG,
          catalog_version: 1,
          catalog_json: JSON.stringify({ schemaVersion: 1, entries: [] }),
          active: 1,
          created_at: NOW,
        },
        evidence: [],
      },
      {
        now: NOW + 100,
        system: false,
        profilePayload: (p) => p.payload,
        rowSettings: [
          { key: "a.equalManifest", declared: 1, fits: true },
          { key: "a.claimedEqual", declared: 2, fits: true },
          { key: "a.claimedDiffers", declared: 3, fits: true },
          { key: "a.manifestDiffers", declared: 4, fits: true },
          { key: "a.absent", declared: 5, fits: true },
          { key: "a.breakGlass", declared: 6, fits: true },
          { key: "a.outOfBounds", declared: 7, fits: false },
          { key: "a.undeclaredConsole", declared: undefined, fits: true },
          { key: "a.undeclaredManifest", declared: undefined, fits: true },
          { key: "a.undeclaredNone", declared: undefined, fits: true },
          { key: "a.secret", declared: "new-token", fits: true, secret: true },
        ],
      },
    );
    const byKey = new Map(
      plan.items.filter((i) => i.key.startsWith("a.")).map((i) => [i.key, i]),
    );
    const view = (k: string) => {
      const i = byKey.get(k);
      return i && [i.class, i.owner, i.action];
    };
    expect(view("a.equalManifest")).toEqual(["equal", "manifest", "none"]);
    expect(view("a.claimedEqual")).toEqual([
      "equal",
      "console",
      "release-claim",
    ]);
    expect(view("a.claimedDiffers")).toEqual(["differs", "console", "revert"]);
    expect(view("a.manifestDiffers")).toEqual([
      "differs",
      "manifest",
      "revert",
    ]);
    expect(view("a.absent")).toEqual(["differs", "manifest", "revert"]);
    expect(view("a.breakGlass")).toEqual(["differs", "break-glass", "keep"]);
    expect(view("a.outOfBounds")).toEqual(["differs", "manifest", "keep"]);
    expect(view("a.undeclaredConsole")).toEqual([
      "not-declared",
      "console",
      "none",
    ]);
    expect(view("a.undeclaredManifest")).toEqual([
      "not-declared",
      "manifest",
      "none",
    ]);
    expect(byKey.has("a.undeclaredNone")).toBe(false);
    // `sensitivity: "secret"`: compared and reverted like any other, shown only as REDACTED.
    expect(byKey.get("a.secret")).toMatchObject({
      class: "differs",
      action: "revert",
      before: REDACTED,
      manifest: REDACTED,
    });
    expect(JSON.stringify(plan.items)).not.toMatch(/old-token|new-token/);
    // One upsert per revert or released claim, each to `manifest` with the manifest's value.
    const upserts = plan.writes.filter((w) =>
      /INSERT INTO product_settings/.test(w.sql),
    );
    expect(upserts.map((w) => [w.params[1], w.params[2]])).toEqual([
      ["a.claimedEqual", "2"],
      ["a.claimedDiffers", "3"],
      ["a.manifestDiffers", "4"],
      ["a.absent", "5"],
      ["a.secret", '"new-token"'],
    ]);
  });
});

describe("LX-06 row-backed settings, end to end", () => {
  it("a console claim on a declared licensing setting is reverted; an undeclared console row stays", async () => {
    const decl = { licensing: { refundGraceHours: 24 } };
    const ctx = await linked(decl);
    await ctx.db.run(
      `UPDATE product_settings SET value_json = '48', source = 'console', updated_by = 'u1'
        WHERE product = ? AND key = 'licensing.refundGraceHours'`,
      SLUG,
    );
    await ctx.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES (?, 'licensing.anchorPolicy', '"oldest"', 'console', 1, ?, 'u1')`,
      SLUG,
      NOW,
    );
    const report = await okRun(ctx, { github: { head: decl } });
    expect(item(report, "setting", "licensing.refundGraceHours")).toMatchObject(
      {
        class: "differs",
        owner: "console",
        before: 48,
        manifest: 24,
        action: "revert",
      },
    );
    expect(item(report, "setting", "licensing.anchorPolicy")).toMatchObject({
      class: "not-declared",
      owner: "console",
      action: "none",
    });
    const rowsNow = await ctx.db.all<{
      key: string;
      value_json: string;
      source: string;
    }>(
      "SELECT key, value_json, source FROM product_settings WHERE product = ? ORDER BY key",
      SLUG,
    );
    expect(rowsNow).toEqual([
      {
        key: "licensing.anchorPolicy",
        value_json: '"oldest"',
        source: "console",
      },
      {
        key: "licensing.refundGraceHours",
        value_json: "24",
        source: "manifest",
      },
    ]);
    const again = await okRun(ctx, { github: { head: decl }, now: NOW + 300 });
    expect(again.outcome).toBe("unchanged");
  });
});

// ── The system product ────────────────────────────────────────────────────────────────────

describe("the system product (its manifest is the deploy hook's snapshot)", () => {
  const root = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "..",
    "..",
    ".pkey",
  );
  const rootFiles = () => ({
    product: readFileSync(join(root, "product.yaml"), "utf8"),
    schema: readFileSync(join(root, "schema.yaml"), "utf8"),
    release: readFileSync(join(root, "release.yaml"), "utf8"),
  });

  async function deployed(opts: { link?: boolean } = {}) {
    const db = makeTestDb();
    const env = envFor();
    env.PLATFORM_KEK = TEST_KEK;
    expect((await ensureSystemProduct(env, db, "u1", NOW)).ok).toBe(true);
    if (opts.link !== false) {
      const parsed = parseManifest(rootFiles());
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      const res = await linkSystemProduct(
        db,
        parsed.manifest,
        {
          repository: "vladzaharia/polaris-key",
          repositoryId: 1,
          repositoryOwnerId: 2,
        },
        { files: rootFiles(), sha: "c".repeat(40) },
        NOW + 1,
      );
      expect(res.ok).toBe(true);
    }
    return { db, env };
  }

  it("classifies against the deployed root .pkey/, never GitHub, and never writes its snapshot", async () => {
    const ctx = await deployed();
    const fetchImpl = github();
    const report = await okRun(ctx, { fetchImpl }, SYSTEM_PRODUCT_SLUG);
    expect(fetchImpl.refs).toEqual([]);
    expect(report.source).toEqual({
      kind: "deploy-snapshot",
      commit: "c".repeat(40),
      appliedAt: NOW + 1,
    });
    expect(report.snapshot).toBe("not-applicable");
    expect(item(report, "setting", "core.name").class).toBe("equal");
    // The bootstrap's empty catalog and the root schema differ only in the document header.
    expect(item(report, "setting", "config.catalog").class).toBe("equal");
    // The bootstrap wrote no admin group; the root .pkey/ declares the parser's default.
    expect(item(report, "setting", "core.adminGroup")).toMatchObject({
      class: "differs",
      before: null,
      action: "revert",
    });
    const snap = await ctx.db.first<{ origin: string }>(
      "SELECT origin FROM product_manifest_snapshot WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(snap?.origin).toBe("deploy-hook");
  });

  it("the bootstrap's services marker is kept while the services differ, and reset once they match", async () => {
    const ctx = await deployed();
    // The bootstrap starts from the default services (License and Config on) plus Release and
    // Distribution; the root .pkey/ turns License and Config off.
    const first = await okRun(ctx, { dryRun: true }, SYSTEM_PRODUCT_SLUG);
    expect(item(first, "marker", "services")).toMatchObject({
      class: "differs",
      owner: "console",
      action: "keep",
    });
    // The operator switches them to match (still an `admin` write), then applies.
    const services = parseServices(
      (await productRow(ctx.db, SYSTEM_PRODUCT_SLUG)).services_json,
    );
    services.services.license = { enabled: false };
    services.services.config = { enabled: false };
    await ctx.db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      serializeServices(services),
      SYSTEM_PRODUCT_SLUG,
    );
    const applied = await okRun(ctx, {}, SYSTEM_PRODUCT_SLUG);
    expect(item(applied, "marker", "services")).toMatchObject({
      class: "equal",
      action: "reset-marker",
    });
    expect(
      (await productRow(ctx.db, SYSTEM_PRODUCT_SLUG)).services_source,
    ).toBe("manifest");
    expect((await productRow(ctx.db, SYSTEM_PRODUCT_SLUG)).admin_group).toBe(
      "admin",
    );
  });

  it("bootstrapped but never deployed: unlinked; linked with no snapshot: cannot read .pkey/", async () => {
    const fresh = await deployed({ link: false });
    expect((await okRun(fresh, {}, SYSTEM_PRODUCT_SLUG)).outcome).toBe(
      "unlinked",
    );
    const ctx = await deployed();
    await ctx.db.run(
      "DELETE FROM product_manifest_snapshot WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    const report = await okRun(ctx, {}, SYSTEM_PRODUCT_SLUG);
    expect(report.outcome).toBe("unreadable");
    expect(report.message).toMatch(/^cannot read \.pkey\//);
  });
});

// ── The platform batch ─────────────────────────────────────────────────────────────────────

describe("the platform batch", () => {
  it("runs every product, stores each report under the batch id and audits the batch once", async () => {
    const ctx = await linked();
    await seedProduct(ctx.db, "manual");
    await preClaimConsoleEdits(ctx.db);
    const res = await runPlatformBackfill(ctx.env, ctx.db, {
      dryRun: true,
      actor: ACTOR,
      now: NOW + 100,
      fetchImpl: github(),
    });
    expect(res.products).toEqual([
      expect.objectContaining({ product: SLUG, outcome: "planned" }),
      expect.objectContaining({ product: "manual", outcome: "unlinked" }),
    ]);
    expect(res.next).toBeNull();
    const batchIds = await ctx.db.all<{ batch_id: string }>(
      "SELECT batch_id FROM settings_backfill_reports",
    );
    expect(new Set(batchIds.map((b) => b.batch_id))).toEqual(
      new Set([res.batchId]),
    );
  });

  it("the batch apply runs exactly the products its dry run covered, each pinned to its report", async () => {
    const ctx = await linked();
    await seedProduct(ctx.db, "manual");
    await preClaimConsoleEdits(ctx.db);
    const opts = {
      actor: ACTOR,
      now: NOW + 100,
      fetchImpl: github(),
    };
    const dry = await runPlatformBackfill(ctx.env, ctx.db, {
      ...opts,
      dryRun: true,
    });
    // Without the dry run's batch id the apply touches nothing.
    expect(
      (await runPlatformBackfill(ctx.env, ctx.db, { ...opts, dryRun: false }))
        .products,
    ).toEqual([]);
    // A product registered after the dry run is not in it.
    await seedProduct(ctx.db, "later");
    const applied = await runPlatformBackfill(ctx.env, ctx.db, {
      ...opts,
      dryRun: false,
      expectBatch: dry.batchId,
    });
    expect(applied.products).toEqual([
      expect.objectContaining({ product: SLUG, outcome: "applied" }),
      expect.objectContaining({ product: "manual", outcome: "stale" }),
    ]);
    expect((await productRow(ctx.db)).name).toBe("Acme");
    expect(await reportRows(ctx.db, "later")).toEqual([]);
    // A second apply of the same batch is stale: the first one moved the product.
    const again = await runPlatformBackfill(ctx.env, ctx.db, {
      ...opts,
      dryRun: false,
      expectBatch: dry.batchId,
    });
    expect(again.products.map((p) => p.outcome)).toEqual(["stale", "stale"]);
  });

  it("the routes: POST runs the batch (dryRun required), GET lists every product's newest report", async () => {
    const ctx = await linked();
    await seedProduct(ctx.db, "manual");
    for (const q of ["", "?dryRun=0", "?dryRun=0&expectBatch=sbf_wrongkind"])
      expect(
        (await call(ctx, "POST", `platform/settings/backfill${q}`)).status,
        q,
      ).toBe(400);
    const original = globalThis.fetch;
    globalThis.fetch = github() as typeof fetch;
    try {
      const res = await call(
        ctx,
        "POST",
        "platform/settings/backfill?dryRun=1",
      );
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, dryRun: true });
    } finally {
      globalThis.fetch = original;
    }
    const platformRows = await ctx.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM platform_audit WHERE action = 'settings.backfill.batch'",
    );
    expect(platformRows).toHaveLength(1);
    expect(platformRows[0]!.summary).toMatch(/1 planned, 1 unlinked/);
    const list = await call(ctx, "GET", "platform/settings/backfill");
    expect(
      (list.json.products as { product: string; outcome: string }[]).map(
        (p) => [p.product, p.outcome],
      ),
    ).toEqual([
      [SLUG, "planned"],
      ["manual", "unlinked"],
    ]);
  });
});

// ── The migration ──────────────────────────────────────────────────────────────────────────

describe("the migration", () => {
  it("replays as a no-op on a populated database", async () => {
    const ctx = await linked();
    await okRun(ctx, { dryRun: true });
    const dir = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "migrations",
    );
    const { readdirSync } = await import("node:fs");
    const file = readdirSync(dir).find((f) =>
      f.endsWith("_settings_backfill_reports.sql"),
    );
    expect(file).toBeDefined();
    const sql = readFileSync(join(dir, file!), "utf8").replace(/--.*$/gm, "");
    for (const stmt of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await ctx.db.run(stmt);
    expect(await reportRows(ctx.db)).toHaveLength(1);
  });
});
