/**
 * LX-07: offline grace clamped to licence expiry (S-19 G9, §7.6, decision 7).
 *
 * Pinned here, through the real paths and the reference verifiers:
 *
 *   - the arithmetic (`clampGraceUntil`): the window ends at the licence's expiry, never below the
 *     document's own `expiresAt` (every verifier refuses `graceUntil < expiresAt`), and never moves
 *     a window that already ends first;
 *   - a licence expiring inside its window gets a clamped licence document, config document,
 *     offline bundle and browser-session document, each of which the reference client accepts;
 *   - the per-product opt-out (`licensing.clampGraceToExpiry: false`, through `writeSetting()`)
 *     restores today's window on every one of them;
 *   - a perpetual licence, a licence expiring past its window, the config document of a product
 *     that no longer runs License, and a config-only bundle are untouched, and the first two cost
 *     no settings read;
 *   - the affected-licence report lists exactly the licences the clamp shortens, with each
 *     product's clamp state, and the offline tool builds it from a copy without writing.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  inspectBundle,
  verifyConfigDoc,
  verifyLicenseDoc,
} from "@polaris-key/client-core";
import { DOC_EXPIRY_SECONDS } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  DJDL_CATALOG,
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
import type { SqliteDb } from "../src/db/sqlite.js";
import { matchRoute } from "../src/router.js";
import { dispatchService } from "../src/core/registry.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { writeSetting } from "../src/core/settings/write.js";
import { clampGraceUntil, offlineWindowEnd } from "../src/core/documents.js";
import {
  CLAMP_GRACE_SETTING,
  graceClampFor,
  graceClampReport,
  graceClampReportCsv,
  graceClampState,
} from "../src/core/licensing/graceClamp.js";
import { buildDoc } from "../src/services/identity/doc.js";
import {
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "../src/services/identity/browserSession.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { listAudit, setServices } from "../src/core/repo.js";
import { serializeServices } from "../src/core/services.js";
import { reportOnCopy } from "../scripts/grace-clamp-report.js";

const SLUG = "djdl";
const DAY = 86_400;
const TRUST = { [TEST_KID]: TEST_PUB };
/** The seeded product default (`seedProduct`): 30 offline days. */
const WINDOW = NOW + 30 * DAY;

const ACTOR = { sub: "u1", name: null, email: null };

/** The per-product opt-out (or back on), through the one write path. */
async function setClamp(db: Db, on: boolean, product = SLUG): Promise<void> {
  const out = await writeSetting(
    { env: {}, db, registry: SETTINGS },
    { key: CLAMP_GRACE_SETTING, value: on },
    { actor: ACTOR, origin: "console", now: NOW, product, strict: false },
  );
  expect(out).toMatchObject({ ok: true });
}

interface World {
  db: SqliteDb;
  env: Env;
  product: Product;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG, { catalog: DJDL_CATALOG });
  return { db, env, product: (await loadProduct(env, db, SLUG))! };
}

/** Drive a product path exactly as `index.ts` does: match, then Core's dispatch (which hands
 *  the service the real settings registry). */
async function call(
  w: World,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const route = matchRoute(path);
  if (route.kind !== "service") throw new Error(`not a service route: ${path}`);
  return dispatchService(SERVICES, route.slug, w.product.services, {
    req: mkReq(init.method ?? "GET", init.headers ?? {}),
    env: w.env,
    db: w.db,
    product: w.product,
    rest: route.rest,
    now: NOW,
  });
}

/** A licence expiring `expiresIn` seconds from NOW (null: perpetual), activated on `device`. */
async function activated(
  w: World,
  expiresIn: number | null,
  device = "dev-1",
): Promise<{ licenseId: string; token: string }> {
  const { licenseId, key } = await seedLicenseWithKey(w.db, SLUG, {
    id: `lic_${device}`,
    expiresAt: expiresIn === null ? null : NOW + expiresIn,
  });
  const res = await call(w, `/${SLUG}/license/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "x-pkey-device": device },
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return { licenseId, token };
}

async function licenseDoc(w: World, token: string, device = "dev-1") {
  const res = await call(w, `/${SLUG}/license/document`, {
    headers: { authorization: `Bearer ${token}`, "x-pkey-version": "1.0.0" },
  });
  expect(res.status).toBe(200);
  const doc = await verifyLicenseDoc(await res.text(), {
    lastAcceptedIssuedAt: null,
    trust: TRUST,
    expectedAud: SLUG,
    deviceId: device,
    now: NOW,
  });
  expect(doc).not.toBeNull();
  return doc!;
}

async function configDoc(w: World, token: string, device = "dev-1") {
  const res = await call(w, `/${SLUG}/config/document`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const doc = await verifyConfigDoc(await res.text(), {
    lastAcceptedIssuedAt: null,
    trust: TRUST,
    expectedAud: SLUG,
    deviceId: device,
    now: NOW,
  });
  expect(doc).not.toBeNull();
  return doc!;
}

/** A Db that fails the test if anything reads it. */
const UNREAD: Db = new Proxy({} as Db, {
  get() {
    throw new Error("the database was read");
  },
});

describe("LX-07: the clamp arithmetic", () => {
  it("ends the window at the licence's expiry, never below the document's expiresAt, never later than the window", () => {
    // No clamp: today's window.
    expect(clampGraceUntil(WINDOW, NOW, null)).toBe(WINDOW);
    expect(clampGraceUntil(WINDOW, NOW, undefined)).toBe(WINDOW);
    // Expiry inside the window: the window ends at the expiry.
    expect(clampGraceUntil(WINDOW, NOW, NOW + 5 * DAY)).toBe(NOW + 5 * DAY);
    // Expiry past the window: unchanged (the clamp only ever lowers it).
    expect(clampGraceUntil(WINDOW, NOW, NOW + 31 * DAY)).toBe(WINDOW);
    // Expiry within the hour: the document's own expiresAt, which every verifier requires
    // `graceUntil` to reach (WIRE-CONTRACT-V4 §3).
    expect(clampGraceUntil(WINDOW, NOW, NOW + 60)).toBe(
      NOW + DOC_EXPIRY_SECONDS,
    );
    // A zero-day window was already below that floor: left exactly as it was.
    expect(clampGraceUntil(offlineWindowEnd(NOW, 0), NOW, NOW + 60)).toBe(NOW);
  });

  it("does not read the setting when the clamp could not change the window", async () => {
    const ctx = { env: {}, db: UNREAD, registry: SETTINGS };
    expect(await graceClampFor(ctx, SLUG, null, NOW, 30)).toBeNull();
    expect(
      await graceClampFor(ctx, SLUG, { expires_at: null }, NOW, 30),
    ).toBeNull();
    expect(
      await graceClampFor(ctx, SLUG, { expires_at: NOW + 30 * DAY }, NOW, 30),
    ).toBeNull();
    expect(
      await graceClampFor(ctx, SLUG, { expires_at: NOW + 400 * DAY }, NOW, 30),
    ).toBeNull();
  });
});

describe("LX-07: the licence and config documents", () => {
  it("a licence expiring before its grace window ends gets a clamped window on both documents", async () => {
    const w = await world();
    const { token } = await activated(w, 5 * DAY);
    const lic = await licenseDoc(w, token);
    expect(lic.expiresAt).toBe(NOW + DOC_EXPIRY_SECONDS);
    expect(lic.graceUntil).toBe(NOW + 5 * DAY);
    // The config document of a device bound to that licence ends with it too (R1: its secrets
    // stop with the licence, offline as well as online).
    const cfg = await configDoc(w, token);
    expect(cfg.graceUntil).toBe(NOW + 5 * DAY);
  });

  it("opt-out restores today's window", async () => {
    const w = await world();
    const { token } = await activated(w, 5 * DAY);
    await setClamp(w.db, false);
    expect((await licenseDoc(w, token)).graceUntil).toBe(WINDOW);
    expect((await configDoc(w, token)).graceUntil).toBe(WINDOW);
    // And back on.
    await setClamp(w.db, true);
    expect((await licenseDoc(w, token)).graceUntil).toBe(NOW + 5 * DAY);
  });

  it("a licence expiring within the hour gets the document's own hour, which the verifier accepts", async () => {
    const w = await world();
    const { token } = await activated(w, 600);
    const lic = await licenseDoc(w, token);
    expect(lic.graceUntil).toBe(lic.expiresAt);
  });

  it("leaves a perpetual licence and one expiring past its window alone", async () => {
    const w = await world();
    const perpetual = await activated(w, null, "dev-1");
    expect((await licenseDoc(w, perpetual.token, "dev-1")).graceUntil).toBe(
      WINDOW,
    );
    const yearly = await activated(w, 365 * DAY, "dev-2");
    expect((await licenseDoc(w, yearly.token, "dev-2")).graceUntil).toBe(
      WINDOW,
    );
  });

  it("leaves the config document alone once the product stops running License (no licence governs it)", async () => {
    const w = await world();
    const { token } = await activated(w, 5 * DAY);
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: { ...w.product.services, license: { enabled: false } },
      }),
      "manifest",
      NOW,
    );
    w.product = (await loadProduct(w.env, w.db, SLUG))!;
    expect((await configDoc(w, token)).graceUntil).toBe(WINDOW);
  });

  it("follows the licence's own offline days", async () => {
    const w = await world();
    const { licenseId, token } = await activated(w, 5 * DAY);
    await w.db.run(
      "UPDATE licenses SET max_offline_days = 3 WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    // Three days end before the expiry: nothing to clamp.
    expect((await licenseDoc(w, token)).graceUntil).toBe(NOW + 3 * DAY);
  });
});

describe("LX-07: the setting's read path", () => {
  it("resolves the default (on), a console opt-out, and the stored row without a registry", async () => {
    const w = await world();
    const withRegistry = { env: {}, db: w.db, registry: SETTINGS };
    const byHand = { env: {}, db: w.db };
    expect(await graceClampState(withRegistry, SLUG, NOW)).toEqual({
      on: true,
      source: "default",
    });
    expect(await graceClampState(byHand, SLUG, NOW)).toEqual({
      on: true,
      source: "default",
    });
    await setClamp(w.db, false);
    expect(await graceClampState(withRegistry, SLUG, NOW)).toEqual({
      on: false,
      source: "console",
    });
    expect(await graceClampState(byHand, SLUG, NOW)).toEqual({
      on: false,
      source: "console",
    });
    // An expired break-glass claim is no claim: back to the default.
    await w.db.run(
      "UPDATE product_settings SET expires_at = ? WHERE product = ? AND key = ?",
      NOW - 1,
      SLUG,
      CLAMP_GRACE_SETTING,
    );
    expect((await graceClampState(byHand, SLUG, NOW)).on).toBe(true);
    expect((await graceClampState(withRegistry, SLUG, NOW)).on).toBe(true);
  });
});

// ── The offline bundle ──────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const BUNDLE_DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

async function mintBundle(
  w: World,
  licenseId: string | undefined,
  graceDays: number,
) {
  const env = w.env;
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const path = `/api/products/${SLUG}/bundles`;
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method: "POST",
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      deviceId: BUNDLE_DEVICE,
      graceDays,
      ...(licenseId ? { licenseId } : {}),
    }),
  }) as unknown as Request;
  const res = await handleAdmin(req, env, w.db, path, { now: NOW });
  expect(res.status).toBe(200);
  const { bundle } = (await res.json()) as { bundle: string };
  const inspection = await inspectBundle(bundle, {
    pinned: TRUST,
    product: SLUG,
    floors: { license: null, config: null },
    profile: "import",
    deviceId: BUNDLE_DEVICE,
    now: NOW,
  });
  expect(inspection.ok).toBe(true);
  if (!inspection.ok) throw new Error("bundle refused");
  return inspection.bundle.docs;
}

describe("LX-07: the offline bundle", () => {
  it("clamps both inner documents to the licence's expiry, says so in the audit row, and the opt-out restores graceDays", async () => {
    const w = await world();
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG, {
      expiresAt: NOW + 10 * DAY,
    });
    const docs = await mintBundle(w, licenseId, 90);
    expect(docs.license!.doc.graceUntil).toBe(NOW + 10 * DAY);
    expect(docs.config!.doc.graceUntil).toBe(NOW + 10 * DAY);
    const [row] = await listAudit(w.db, SLUG, { action: "bundle.minted" });
    expect(row?.summary).toContain(
      "90-day grace, clamped to the licence's expiry (",
    );

    await setClamp(w.db, false);
    const optedOut = await mintBundle(w, licenseId, 90);
    expect(optedOut.license!.doc.graceUntil).toBe(NOW + 90 * DAY);
    expect(optedOut.config!.doc.graceUntil).toBe(NOW + 90 * DAY);
  });

  it("never clamps a config-only bundle (no licence)", async () => {
    const w = await world();
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const docs = await mintBundle(w, undefined, 45);
    expect(docs.license).toBeUndefined();
    expect(docs.config!.doc.graceUntil).toBe(NOW + 45 * DAY);
  });
});

// ── Identity's fused browser-session document ───────────────────────────────────────────────

describe("LX-07: the browser-session document", () => {
  it("is clamped the same way, and the opt-out restores today's window", async () => {
    const w = await world();
    const { key } = await seedLicenseWithKey(w.db, SLUG, {
      expiresAt: NOW + 5 * DAY,
    });
    const login = await handleBrowserSessionLicense(
      new Request(`https://key.plrs.im/${SLUG}/identity/session/license`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }) as unknown as Request,
      w.env,
      w.db,
      w.product,
      NOW,
      SETTINGS,
    );
    expect(login.status).toBe(201);
    const cookie = login.headers.get("set-cookie")!;
    const session = async () => {
      const res = await handleBrowserSession(
        new Request(`https://key.plrs.im/${SLUG}/identity/session`, {
          headers: { cookie },
        }) as unknown as Request,
        w.env,
        w.db,
        w.product,
        NOW,
        SETTINGS,
      );
      return ((await res.json()) as { doc: { graceUntil: number } }).doc;
    };
    expect((await session()).graceUntil).toBe(NOW + 5 * DAY);
    await setClamp(w.db, false);
    expect((await session()).graceUntil).toBe(WINDOW);
  });

  it("buildDoc takes the clamp", () => {
    const input = {
      schemaVersion: 1,
      aud: SLUG,
      licenseId: "lic",
      deviceId: "dev",
      now: NOW,
      maxOfflineDays: 30,
      profile: null,
      payload: { config: {}, secrets: {}, entitlements: {} },
    } as unknown as Parameters<typeof buildDoc>[0];
    expect(buildDoc(input).graceUntil).toBe(WINDOW);
    expect(buildDoc({ ...input, clampGraceTo: NOW + DAY }).graceUntil).toBe(
      NOW + DAY,
    );
  });
});

// ── The affected-licence report ─────────────────────────────────────────────────────────────

async function reportWorld(): Promise<World> {
  const w = await world();
  await seedProduct(w.db, "acme");
  // djdl: one affected licence with two authorised devices, and four that are not affected.
  await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_soon",
    expiresAt: NOW + 5 * DAY,
    tierId: null,
  });
  for (const d of ["dev-a", "dev-b"])
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen)
       VALUES (?, ?, 'lic_soon', 'authorized', ?, ?)`,
      SLUG,
      d,
      NOW,
      NOW,
    );
  await seedLicenseWithKey(w.db, SLUG, { id: "lic_perpetual" });
  await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_later",
    expiresAt: NOW + 60 * DAY,
  });
  await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_expired",
    expiresAt: NOW - DAY,
  });
  await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_disabled",
    expiresAt: NOW + 2 * DAY,
  });
  await w.db.run(
    "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = 'lic_disabled'",
    SLUG,
  );
  // acme: opted out, one affected licence.
  await seedLicenseWithKey(w.db, "acme", {
    id: "lic_acme",
    expiresAt: NOW + 12 * DAY,
  });
  await setClamp(w.db, false, "acme");
  return w;
}

describe("LX-07: the affected-licence report", () => {
  it("lists exactly the usable licences the clamp shortens, with each product's clamp state", async () => {
    const w = await reportWorld();
    const report = await graceClampReport(
      { env: {}, db: w.db, registry: SETTINGS },
      { now: NOW },
    );
    expect(report.now).toBe(NOW);
    expect(report.products.map((p) => p.product)).toEqual(["acme", SLUG]);
    const [acme, djdl] = report.products;
    expect(acme).toMatchObject({
      licenseService: true,
      clamp: { on: false, source: "console" },
      licences: [{ licenseId: "lic_acme", expiresAt: NOW + 12 * DAY }],
    });
    expect(djdl).toMatchObject({
      licenseService: true,
      clamp: { on: true, source: "default" },
    });
    expect(djdl!.licences).toEqual([
      {
        licenseId: "lic_soon",
        tierId: null,
        expiresAt: NOW + 5 * DAY,
        maxOfflineDays: 30,
        windowEnd: WINDOW,
        clampedTo: NOW + 5 * DAY,
        daysRemoved: 25,
        authorizedDevices: 2,
      },
    ]);
    expect(report.totals).toEqual({
      products: 2,
      licences: 2,
      authorizedDevices: 2,
      clampedLicences: 1,
    });
    // One product only.
    const one = await graceClampReport(
      { env: {}, db: w.db, registry: SETTINGS },
      { now: NOW, product: "acme" },
    );
    expect(one.products.map((p) => p.product)).toEqual(["acme"]);

    const csv = graceClampReportCsv(report);
    expect(csv.split("\n")[0]).toBe(
      "product,licenseService,clamp,clampSource,licenseId,tierId,expiresAt,maxOfflineDays,windowEnd,clampedTo,daysRemoved,authorizedDevices",
    );
    expect(csv).toContain(
      `djdl,on,on,default,lic_soon,,${new Date((NOW + 5 * DAY) * 1000).toISOString()},30,`,
    );
    // Licence ids and counts only: no name, email or key.
    expect(csv + JSON.stringify(report)).not.toMatch(
      /ada@example\.com|Ada|pkey_/,
    );
  });

  it("the offline tool builds the same report from a copy and writes nothing", async () => {
    const w = await reportWorld();
    const raw = (w.db as unknown as { db: Database.Database }).db;
    const offline = await reportOnCopy({
      sqliteBytes: raw.serialize(),
      now: NOW,
    });
    expect(offline.changes).toBe(0);
    expect(offline.report).toEqual(
      await graceClampReport(
        { env: {}, db: w.db, registry: SETTINGS },
        { now: NOW },
      ),
    );
    expect(offline.csv).toBe(graceClampReportCsv(offline.report));

    const bare = new Database(":memory:");
    const refused = reportOnCopy({ sqliteBytes: bare.serialize(), now: NOW });
    bare.close();
    await expect(refused).rejects.toThrow(/no product_settings table/);
  });
});
