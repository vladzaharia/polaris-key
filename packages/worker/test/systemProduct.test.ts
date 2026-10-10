/**
 * F-03 — the system product (plans/F-01.md §6.3): `ensureSystemProduct` through
 * `POST /manage/api/platform/feeds/bootstrap`, and the create, link, delete and rename refusals.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getProduct } from "../src/core/repo.js";
import { parseServices, serializeServices } from "../src/core/services.js";
import { SYSTEM_FEEDS } from "../src/console/systemProduct.js";
import { open } from "../src/platform/keyvault.js";

let db: Db;
let env: Env;

beforeEach(() => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
  groups = ["platform-admins"],
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

describe("the package-feeds bootstrap (F-03)", () => {
  it("creates the system product once: a sealed key, Release and Distribution on, packageFeeds on, the platform feeds", async () => {
    const res = await admin("POST", "/platform/feeds/bootstrap");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slug: SYSTEM_PRODUCT_SLUG,
      created: true,
    });
    const row = (await getProduct(db, SYSTEM_PRODUCT_SLUG))!;
    expect(row).toMatchObject({ system: 1, name: "Polaris Key" });
    const services = parseServices(row.services_json).services;
    expect(services.release.enabled).toBe(true);
    expect(services.distribution.enabled).toBe(true);
    // The signing key is sealed under PLATFORM_KEK, like a manual create's.
    const key = await db.first<{ enc_private_json: string; kid: string }>(
      "SELECT enc_private_json, kid FROM product_keys WHERE product = ? AND status = 'active'",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(
      await open(env, key!.enc_private_json, {
        product: SYSTEM_PRODUCT_SLUG,
        kind: "signing-key",
        id: key!.kid,
      }),
    ).toContain("PRIVATE KEY");
    expect(
      await db.first(
        "SELECT enabled, version FROM dist_registry_owners WHERE product = ?",
        SYSTEM_PRODUCT_SLUG,
      ),
    ).toEqual({ enabled: 1, version: 1 });
    const feeds = await db.all<{
      ecosystem: string;
      namespace_json: string;
      ext_json: string;
      upstream: string;
      max_package_bytes: number;
    }>(
      "SELECT ecosystem, namespace_json, ext_json, upstream, max_package_bytes FROM dist_registry_feeds WHERE product = ? ORDER BY ecosystem",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(feeds.map((f) => f.ecosystem)).toEqual([
      "cargo",
      "godot",
      "maven",
      "npm",
      "oci",
      "pypi",
      "swift",
    ]);
    expect(feeds.every((f) => f.upstream === "none")).toBe(true);
    const byEco = new Map(feeds.map((f) => [f.ecosystem, f]));
    for (const f of SYSTEM_FEEDS)
      expect(JSON.parse(byEco.get(f.ecosystem)!.namespace_json)).toEqual(
        f.namespace,
      );
    expect(JSON.parse(byEco.get("swift")!.ext_json)).toEqual({
      requireSigned: true,
    });
    expect(byEco.get("oci")!.max_package_bytes).toBe(5368709120);
    expect(
      await db.all(
        "SELECT deliverable_id, reason FROM registry_render_queue WHERE product = ?",
        SYSTEM_PRODUCT_SLUG,
      ),
    ).toEqual([{ deliverable_id: "*", reason: "package-feeds" }]);
    const audit = await db.all<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM platform_audit",
    );
    expect(audit).toEqual([
      { action: "feed.bootstrap", target_id: SYSTEM_PRODUCT_SLUG },
    ]);
  });

  it("is idempotent: a second run creates nothing and keeps an operator's settings", async () => {
    await admin("POST", "/platform/feeds/bootstrap");
    await db.run(
      "UPDATE dist_registry_feeds SET namespace_json = ? WHERE product = ? AND ecosystem = 'npm'",
      JSON.stringify({ scope: "@polaris-key-next" }),
      SYSTEM_PRODUCT_SLUG,
    );
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 0 WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    const again = await admin("POST", "/platform/feeds/bootstrap");
    expect(await again.json()).toMatchObject({ ok: true, created: false });
    expect(
      (
        await db.all("SELECT kid FROM product_keys WHERE product = ?", [
          SYSTEM_PRODUCT_SLUG,
        ] as never)
      ).length,
    ).toBe(1);
    const npm = await db.first<{ namespace_json: string }>(
      "SELECT namespace_json FROM dist_registry_feeds WHERE product = ? AND ecosystem = 'npm'",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(JSON.parse(npm!.namespace_json)).toEqual({
      scope: "@polaris-key-next",
    });
    // An operator's packageFeeds off stays off.
    expect(
      await db.first(
        "SELECT enabled FROM dist_registry_owners WHERE product = ?",
        SYSTEM_PRODUCT_SLUG,
      ),
    ).toEqual({ enabled: 0 });
  });

  it("a second run does not turn back on a service an operator turned off", async () => {
    await admin("POST", "/platform/feeds/bootstrap");
    const row = await getProduct(db, SYSTEM_PRODUCT_SLUG);
    const services = parseServices(row!.services_json ?? null);
    services.services.release = { enabled: false };
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      serializeServices(services),
      SYSTEM_PRODUCT_SLUG,
    );
    await admin("POST", "/platform/feeds/bootstrap");
    const after = parseServices(
      (await getProduct(db, SYSTEM_PRODUCT_SLUG))!.services_json ?? null,
    );
    expect(after.services.release?.enabled).toBe(false);
    expect(after.services.distribution?.enabled).toBe(true);
  });

  it("is platform-admin only, and POST only", async () => {
    expect(
      (await admin("POST", "/platform/feeds/bootstrap", undefined, ["x"]))
        .status,
    ).toBe(403);
    expect((await admin("GET", "/platform/feeds/bootstrap")).status).toBe(405);
  });

  it("refuses a manual create of the slug, and delete and rename of the system product", async () => {
    const create = await admin("POST", "/products", {
      slug: SYSTEM_PRODUCT_SLUG,
      name: "Mine",
    });
    expect(create.status).toBe(422);
    expect(await create.json()).toMatchObject({
      error: { message: "reserved slug" },
    });
    await admin("POST", "/platform/feeds/bootstrap");
    const del = await admin("DELETE", `/products/${SYSTEM_PRODUCT_SLUG}`, {
      confirmSlug: SYSTEM_PRODUCT_SLUG,
    });
    expect(del.status).toBe(409);
    expect((await getProduct(db, SYSTEM_PRODUCT_SLUG))?.status).not.toBe(
      "deleted",
    );
    const rename = await admin("PATCH", `/products/${SYSTEM_PRODUCT_SLUG}`, {
      name: "Something else",
    });
    expect(rename.status).toBe(409);
    expect((await getProduct(db, SYSTEM_PRODUCT_SLUG))?.name).toBe(
      "Polaris Key",
    );
    // S-18 §4.5 item 8: every other claimable field is manifest-authoritative on the system
    // product too; ST-20 takes a console edit only as a break-glass claim with a reason.
    const limit = await admin("PATCH", `/products/${SYSTEM_PRODUCT_SLUG}`, {
      defaultDeviceLimit: 7,
    });
    expect(limit.status).toBe(409);
    expect(await limit.json()).toMatchObject({
      reason: "manifest_authoritative",
    });
    // The products list marks it, so the console can keep it out of the switcher.
    const list = (await (await admin("GET", "/products")).json()) as {
      products: { slug: string; system: boolean }[];
    };
    expect(
      list.products.find((p) => p.slug === SYSTEM_PRODUCT_SLUG)?.system,
    ).toBe(true);
  });

  it("refuses to adopt a product of the same name that is not the system product", async () => {
    await seedProduct(db, SYSTEM_PRODUCT_SLUG);
    const res = await admin("POST", "/platform/feeds/bootstrap");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { reason: "slug_taken" },
    });
    expect((await getProduct(db, SYSTEM_PRODUCT_SLUG))?.system).toBe(0);
  });
});
