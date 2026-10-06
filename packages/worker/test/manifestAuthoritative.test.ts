/**
 * Manifest-authoritative mode and break-glass claims (ST-20; notes/S-18 §4.5 items 7–8, owner
 * decision D2). Pinned here, through the real console API, `resyncRepo` and the GitHub webhook:
 *
 *   - `core.manifest.authoritative` is off by default, offered on a repo-linked product, refused
 *     on a manual one, and on and locked for the system product (a registry rule, not a row);
 *   - in the mode, a console write to a claimable setting is refused unless it is a break-glass
 *     claim, which needs a reason and expires after 7 days or at the first apply that changes the
 *     field, whichever is first; an apply that leaves the field alone keeps it, and every resync
 *     lists the live ones;
 *   - a resync of the system product from the webhook or the console is refused: the deploy hook
 *     is its single writer (the deploy-hook half is in `deployHook.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
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
import { resyncNotes, resyncRepo } from "../src/services/release/resync.js";
import { planResync } from "../src/services/release/linkExisting.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES } from "../src/mount.js";
import {
  BREAK_GLASS_MAX_SECONDS,
  claimedKeys,
  claimsForApply,
  endBreakGlassStatements,
  RESYNC_ACTOR,
  stmtClaim,
  SYSTEM_RESYNC_REFUSAL,
} from "../src/core/settingsClaims.js";
import { getManifestSnapshot } from "../src/core/manifestSnapshot.js";
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

const KEY = "license.defaults.deviceLimit";
const REASON = "incident 42: raise the limit while the fix ships";
/** The console API's clock (`call`): a claim made through it expires at this. */
const EXPIRES = NOW + 1 + BREAK_GLASS_MAX_SECONDS;

async function authoritative(d: Decl = {}): Promise<Ctx> {
  const ctx = await linked(d);
  expect(
    (await call(ctx, "PATCH", "", { manifestAuthoritative: true })).status,
  ).toBe(200);
  return ctx;
}

async function breakGlass(ctx: Ctx, devices = 9) {
  const res = await call(ctx, "PATCH", "", {
    defaultDeviceLimit: devices,
    breakGlass: { reason: REASON },
  });
  expect(res).toMatchObject({
    status: 200,
    json: { ok: true, claimed: [KEY], breakGlass: { expiresAt: EXPIRES } },
  });
  return res;
}

const settingRows = (ctx: Ctx) =>
  ctx.db.all<{
    key: string;
    source: string;
    value_json: string | null;
    reason: string | null;
    expires_at: number | null;
  }>(
    "SELECT key, source, value_json, reason, expires_at FROM product_settings WHERE product = ? ORDER BY key",
    SLUG,
  );

const productJson = async (ctx: Ctx) =>
  (await call(ctx, "GET", "")).json.product as Record<string, unknown>;

// ── The mode ─────────────────────────────────────────────────────────────────────────────

describe("core.manifest.authoritative (ST-20)", () => {
  it("is off by default and offered on a repo-linked product", async () => {
    const ctx = await linked();
    expect((await productJson(ctx)).manifestAuthoritative).toEqual({
      value: false,
      locked: false,
    });
    expect(
      (await call(ctx, "PATCH", "", { manifestAuthoritative: "yes" })).status,
    ).toBe(422);
    expect(
      (await call(ctx, "PATCH", "", { manifestAuthoritative: true })).json,
    ).toMatchObject({ ok: true });
    expect((await productJson(ctx)).manifestAuthoritative).toEqual({
      value: true,
      locked: false,
    });
    expect(await settingRows(ctx)).toEqual([
      {
        key: "core.manifest.authoritative",
        source: "console",
        value_json: "true",
        reason: null,
        expires_at: null,
      },
    ]);
    expect(
      (await audits(ctx, "product.update")).map((a) => a.summary),
    ).toContainEqual("Updated product acme; manifest-authoritative mode on");
    // Off again: an ordinary console edit claims as before.
    await call(ctx, "PATCH", "", { manifestAuthoritative: false });
    expect(
      (await call(ctx, "PATCH", "", { defaultDeviceLimit: 4 })).json,
    ).toMatchObject({ ok: true, claimed: [KEY] });
  });

  it("is refused on a manual product, which has no manifest", async () => {
    const ctx = await linked();
    await ctx.db.run(
      "UPDATE products SET release_source = NULL WHERE slug = ?",
      SLUG,
    );
    expect(
      await call(ctx, "PATCH", "", { manifestAuthoritative: true }),
    ).toMatchObject({ status: 409, json: { reason: "not_linked" } });
  });

  it("is on and locked for the system product", async () => {
    const ctx = await linked();
    await ctx.db.run("UPDATE products SET system = 1 WHERE slug = ?", SLUG);
    expect((await productJson(ctx)).manifestAuthoritative).toEqual({
      value: true,
      locked: true,
    });
    expect(
      await call(ctx, "PATCH", "", { manifestAuthoritative: false }),
    ).toMatchObject({ status: 409, json: { reason: "locked" } });
    // Asking for what it already is changes nothing, and writes no row an operator could delete.
    expect(
      (await call(ctx, "PATCH", "", { manifestAuthoritative: true })).status,
    ).toBe(200);
    expect(await settingRows(ctx)).toEqual([]);
  });
});

// ── Break-glass claims ───────────────────────────────────────────────────────────────────

describe("a break-glass claim (ST-20)", () => {
  it("is the only console write a manifest-authoritative product takes, and needs a reason", async () => {
    const ctx = await authoritative();
    expect(
      await call(ctx, "PATCH", "", { defaultDeviceLimit: 9 }),
    ).toMatchObject({
      status: 409,
      json: {
        reason: "manifest_authoritative",
        fields: ["defaultDeviceLimit"],
      },
    });
    for (const reason of ["   ", "x".repeat(501), 42])
      expect(
        await call(ctx, "PATCH", "", {
          name: "Acme Incident",
          breakGlass: { reason },
        }),
      ).toMatchObject({
        status: 422,
        json: { reason: "reason_required", fields: ["breakGlass.reason"] },
      });
    expect((await productRow(ctx)).default_device_limit).toBe(3);
    expect((await productRow(ctx)).name).toBe("Acme");
    expect(await claimRows(ctx)).toEqual([
      expect.objectContaining({ key: "core.manifest.authoritative" }),
    ]);
  });

  it("carries its reason and an expiry 7 days out, and the console shows both", async () => {
    const ctx = await authoritative();
    await breakGlass(ctx);
    expect((await productRow(ctx)).default_device_limit).toBe(9);
    expect((await settingRows(ctx)).find((r) => r.key === KEY)).toEqual({
      key: KEY,
      source: "console",
      value_json: null,
      reason: REASON,
      expires_at: EXPIRES,
    });
    expect((await productJson(ctx)).claims).toEqual([
      expect.objectContaining({
        key: KEY,
        claimedBy: "u1",
        breakGlass: { reason: REASON, expiresAt: EXPIRES },
      }),
    ]);
    expect(
      (await audits(ctx, "product.update")).map((a) => a.summary),
    ).toContainEqual(
      `Updated product acme; break-glass claim until ${new Date(EXPIRES * 1000).toISOString()} on ${KEY}: ${REASON}`,
    );
  });

  it("survives a resync that leaves the field alone, and every resync lists it", async () => {
    const ctx = await authoritative();
    await breakGlass(ctx);
    // The push changes the name, not the device limit: an unrelated push cannot undo the fix.
    const res = await okResync(ctx, { name: "Acme Two" });
    expect((await productRow(ctx)).name).toBe("Acme Two");
    expect((await productRow(ctx)).default_device_limit).toBe(9);
    expect(res.claimed).toContain(KEY);
    expect(res.breakGlass).toEqual([
      {
        key: KEY,
        claimedBy: "u1",
        claimedAt: NOW + 1,
        reason: REASON,
        expiresAt: EXPIRES,
      },
    ]);
    expect(res.breakGlassEnded).toBeUndefined();
    expect(resyncNotes(res).message).toContain(
      `break-glass claim on ${KEY} until ${new Date(EXPIRES * 1000).toISOString()}`,
    );
    expect(await claimedKeys(ctx.db, SLUG, NOW + 120)).toContain(KEY);
  });

  it("ends at the first resync whose manifest changes the field, before its 7 days", async () => {
    const ctx = await authoritative();
    await breakGlass(ctx);
    const res = await okResync(ctx, { devices: 4 });
    expect(res.breakGlassEnded).toEqual([{ key: KEY, why: "changed" }]);
    expect(res.breakGlass).toBeUndefined();
    expect(res.claimed ?? []).not.toContain(KEY);
    expect((await productRow(ctx)).default_device_limit).toBe(4);
    expect((await settingRows(ctx)).map((r) => r.key)).toEqual([
      "core.manifest.authoritative",
    ]);
    expect((await audits(ctx, "setting.breakGlass.end"))[0]).toMatchObject({
      target_id: KEY,
      summary: expect.stringContaining(
        `Break-glass claim on ${KEY} ended: the manifest changed it`,
      ),
    });
    expect(
      (await audits(ctx, "setting.resync")).some((a) => a.target_id === KEY),
    ).toBe(true);
  });

  it("expires after 7 days although no apply changed the field, and the next resync applies the manifest", async () => {
    const ctx = await authoritative();
    await breakGlass(ctx);
    // At its expiry it no longer counts, with no job to run.
    expect(await claimedKeys(ctx.db, SLUG, EXPIRES - 1)).toContain(KEY);
    expect(await claimedKeys(ctx.db, SLUG, EXPIRES)).not.toContain(KEY);
    const res = await okResync(ctx, {}, EXPIRES + 60);
    expect(res.breakGlassEnded).toEqual([{ key: KEY, why: "expired" }]);
    expect((await productRow(ctx)).default_device_limit).toBe(3);
    expect((await settingRows(ctx)).map((r) => r.key)).toEqual([
      "core.manifest.authoritative",
    ]);
  });

  it("the dry run plans the ending and lists the live claims", async () => {
    const ctx = await authoritative();
    await breakGlass(ctx);
    const keep = await planResync(ctx.env, ctx.db, SLUG, NOW + 60, github());
    if (!keep.ok) throw new Error(keep.error);
    expect(keep.breakGlass.map((b) => b.key)).toEqual([KEY]);
    const end = await planResync(
      ctx.env,
      ctx.db,
      SLUG,
      NOW + 60,
      github({ devices: 4 }),
    );
    if (!end.ok) throw new Error(end.error);
    expect(end.breakGlass).toEqual([]);
    expect(end.plan.apply.map((i) => i.summary)).toEqual(
      expect.arrayContaining([
        `Ends the break-glass claim on ${KEY}: the manifest changed it`,
        "Sets device limit 4",
      ]),
    );
  });

  it("an ordinary claim made before the mode was turned on stays until reverted", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", "", { name: "Acme Console" });
    await call(ctx, "PATCH", "", { manifestAuthoritative: true });
    const res = await okResync(ctx, { name: "Acme Two" });
    expect((await productRow(ctx)).name).toBe("Acme Console");
    expect(res.breakGlass).toBeUndefined();
  });

  it("a claim re-taken between the apply's read and its batch survives, and the batch neither writes nor throws", async () => {
    const ctx = await authoritative();
    const consoleCatalog = JSON.parse(schemaJson("run.name", "console.only"));
    await call(ctx, "PUT", "config/catalog", {
      catalog: consoleCatalog,
      breakGlass: { reason: REASON },
    });
    // An apply whose manifest changes the catalog reads the claim as ended…
    const snapshot = await getManifestSnapshot(ctx.db, SLUG);
    const next = {
      ...(JSON.parse(snapshot!.manifest_json) as Record<string, unknown>),
      catalog: JSON.parse(schemaJson("run.other")),
    };
    const at = NOW + 60;
    const { ended } = await claimsForApply(ctx.db, SLUG, next, at);
    expect(ended.map((e) => e.key)).toEqual(["config.catalog"]);
    // …an operator re-takes it before the batch runs…
    await ctx.db.batch([
      stmtClaim(SLUG, "config.catalog", "u2", at, "again", at + 600),
    ]);
    // …and the batch (the deploy hook's form, which writes the value) leaves everything alone.
    const statements = await endBreakGlassStatements(ctx.db, SLUG, ended, {
      actor: RESYNC_ACTOR,
      sha: null,
      now: at,
      apply: next,
    });
    await expect(ctx.db.batch(statements)).resolves.not.toThrow();
    expect(await activeCatalog(ctx)).toEqual(["run.name", "console.only"]);
    expect(
      (await settingRows(ctx)).find((r) => r.key === "config.catalog"),
    ).toMatchObject({ reason: "again", expires_at: at + 600 });
    expect(await audits(ctx, "setting.breakGlass.end")).toEqual([]);
  });

  it("a catalog publish is a break-glass claim too", async () => {
    const ctx = await authoritative();
    const catalog = JSON.parse(schemaJson("run.name", "console.only"));
    expect(await call(ctx, "PUT", "config/catalog", { catalog })).toMatchObject(
      { status: 409, json: { reason: "manifest_authoritative" } },
    );
    expect(
      await call(ctx, "PUT", "config/catalog", {
        catalog,
        breakGlass: { reason: REASON },
      }),
    ).toMatchObject({
      status: 200,
      json: { ok: true, breakGlass: { expiresAt: EXPIRES } },
    });
    expect(await activeCatalog(ctx)).toEqual(["run.name", "console.only"]);
    expect(
      (await settingRows(ctx)).find((r) => r.key === "config.catalog"),
    ).toMatchObject({ reason: REASON, expires_at: EXPIRES });
    // A push that changes the catalog ends it.
    const res = await okResync(ctx, { schema: schemaJson("run.other") });
    expect(res.breakGlassEnded).toEqual([
      { key: "config.catalog", why: "changed" },
    ]);
    expect(await activeCatalog(ctx)).toEqual(["run.other"]);
  });
});

// ── The system product ───────────────────────────────────────────────────────────────────

describe("the system product (ST-20, S-18 §4.5 item 8)", () => {
  async function system(): Promise<Ctx> {
    const ctx = await linked();
    await ctx.db.run("UPDATE products SET system = 1 WHERE slug = ?", SLUG);
    return ctx;
  }

  it("takes console edits only as break-glass claims; its name and admin group stay the manifest's", async () => {
    const ctx = await system();
    const refused = await call(ctx, "PATCH", "", { defaultDeviceLimit: 9 });
    expect(refused).toMatchObject({
      status: 409,
      json: { reason: "manifest_authoritative" },
    });
    expect(JSON.stringify(refused.json)).toContain("deploy hook");
    await breakGlass(ctx);
    expect((await productRow(ctx)).default_device_limit).toBe(9);
    expect(
      await call(ctx, "PATCH", "", {
        name: "Other",
        breakGlass: { reason: REASON },
      }),
    ).toMatchObject({ status: 409, json: { reason: "system_product" } });
    // A same-name save claims nothing on the name (F-03): no apply could end a claim on it and
    // rename the system product.
    expect(
      (
        await call(ctx, "PATCH", "", {
          name: "Acme",
          defaultMaxOfflineDays: 20,
          breakGlass: { reason: REASON },
        })
      ).json,
    ).toMatchObject({
      ok: true,
      claimed: ["license.defaults.maxOfflineDays"],
    });
    expect(
      (await settingRows(ctx)).map((r) => r.key).includes("core.name"),
    ).toBe(false);
    expect(await call(ctx, "PATCH", "", { adminGroup: "x" })).toMatchObject({
      status: 409,
      json: { reason: "manifest_only" },
    });
  });

  it("refuses a webhook resync: the deploy hook is its single writer", async () => {
    const ctx = await system();
    ctx.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    let contents = 0;
    const gh = github({ name: "Pushed Name" });
    const counting: FetchImpl = async (input, init) => {
      if (String(input).includes("/contents/")) contents++;
      return gh(input, init);
    };
    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      installation: { id: 4242 },
      repository: {
        name: "acme-app",
        full_name: "acme-org/acme-app",
        default_branch: "main",
        owner: { login: "acme-org" },
      },
      head_commit: { modified: [".pkey/product.json"] },
      commits: [],
    };
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await handleGithubWebhook(
      new Request("https://key.plrs.im/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${hex}`,
          "x-github-delivery": crypto.randomUUID(),
        },
        body,
      }),
      ctx.env,
      ctx.db,
      NOW + 10,
      counting,
    );
    expect(res.status).toBe(200);
    // The refusal is expected, not a failed sync: the delivery's answer stays ok.
    expect(await res.json()).toMatchObject({
      ok: true,
      products: [
        {
          product: SLUG,
          ok: false,
          error: "the system product is applied by the deploy hook",
          reason: "system_product",
        },
      ],
    });
    // Nothing read, nothing written, and no failed-sync state to alarm anyone.
    expect(contents).toBe(0);
    expect((await productRow(ctx)).name).toBe("Acme");
    const webhookRows = await ctx.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM product_sync_state WHERE product = ? AND source = 'webhook'",
      SLUG,
    );
    expect(webhookRows?.n).toBe(0);
  });

  it("refuses a console resync and its dry run, and resyncRepo itself", async () => {
    const ctx = await system();
    for (const query of ["", "?dryRun=1"]) {
      const full = `/api/products/${SLUG}/release/resync`;
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage${full}${query}`, {
          method: "POST",
          headers: { cookie: ctx.cookie, [CSRF_HEADER]: ctx.csrf },
        }),
        ctx.env,
        ctx.db,
        full,
        { now: NOW + 1 },
      );
      expect(res.status, query).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { reason: "system_product" },
      });
    }
    expect(await resync(ctx, { name: "Pushed Name" })).toEqual({
      ok: false,
      error: SYSTEM_RESYNC_REFUSAL,
    });
    expect((await productRow(ctx)).name).toBe("Acme");
  });
});
