/**
 * The console's product logo (owner request 2026-10-06; docs/design/console-product-card/):
 * `presentation.icon` on the registry rows, read in one statement for the whole list, and the
 * console shell's CSP admitting exactly the image host's origin.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db, DbParam } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/core/console/session.js";
import { cspImageOrigin } from "../src/core/securityHeaders.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const IMG = "https://img.test";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

let db: ReturnType<typeof makeTestDb>;

beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, "djdl");
  await seedProduct(db, "acme");
});

/** An admin env; `imgOrigin: null` is an environment with no image host. */
function adminEnv(imgOrigin: string | null = IMG): Env {
  const e = makeEnv(new KvMock(), []);
  e.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  if (imgOrigin !== null) e.IMG_ORIGIN = imgOrigin;
  return e;
}

async function get(
  path: string,
  env: Env = adminEnv(),
  database: Db = db,
): Promise<Response> {
  const { token } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    env,
    database,
    path,
    { now: NOW },
  );
}

async function icons(env?: Env): Promise<Record<string, unknown>> {
  const res = await get("/api/products", env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    products: { slug: string; presentation: { icon: unknown } }[];
  };
  return Object.fromEntries(
    body.products.map((p) => [p.slug, p.presentation.icon]),
  );
}

async function hosted(
  product: string,
  slot: string,
  row: {
    sha256: string | null;
    status: string;
    contentType?: string | null;
    variants?: { w: number; sha256: string }[];
    /** The product's hosted-asset ref to the copy (what the image host's tenancy needs). */
    ref?: boolean;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, sha256, size,
            content_type, variants_json, status, modified_at)
          VALUES (?, ?, '', 'manifest', 'url', ?, 10, ?, ?, ?, ?)`,
    product,
    slot,
    row.sha256,
    row.contentType === undefined ? "image/png" : row.contentType,
    JSON.stringify(
      (row.variants ?? []).map((v) => ({
        w: v.w,
        format: "image/webp",
        sha256: v.sha256,
        size: 5,
      })),
    ),
    row.status,
    NOW,
  );
  if (!row.sha256 || row.ref === false) return;
  const key = `blobs/sha256/${row.sha256}`;
  await db.run(
    `INSERT OR IGNORE INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
          VALUES (?, ?, 10, 'blob', 0, ?, ?)`,
    key,
    row.sha256,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
          VALUES (?, ?, 'hosted-asset', ?, ?)`,
    product,
    key,
    `${slot}@`,
    NOW,
  );
}

describe("presentation.icon on the registry", () => {
  it("names the original and its 64 and 128 px variants on the image host", async () => {
    await hosted("djdl", "presentation.icon", {
      sha256: A,
      status: "ready",
      variants: [
        { w: 64, sha256: B },
        { w: 128, sha256: C },
        { w: 256, sha256: C },
      ],
    });
    expect((await icons()).djdl).toEqual({
      url: `${IMG}/djdl/a/${A}`,
      w64: `${IMG}/djdl/a/${A}/64.webp`,
      w128: `${IMG}/djdl/a/${A}/128.webp`,
    });
  });

  it("is null for a product with no icon, and a missing variant is null", async () => {
    await hosted("djdl", "presentation.icon", {
      sha256: A,
      status: "ready",
    });
    const all = await icons();
    expect(all.acme).toBeNull();
    expect(all.djdl).toEqual({
      url: `${IMG}/djdl/a/${A}`,
      w64: null,
      w128: null,
    });
  });

  it("prefers presentation.icon, then listing.icon, as the image host's /icon alias does", async () => {
    await hosted("djdl", "listing.icon", { sha256: B, status: "ready" });
    await hosted("djdl", "presentation.icon", { sha256: A, status: "ready" });
    await hosted("acme", "listing.icon", { sha256: C, status: "ready" });
    const all = await icons();
    expect((all.djdl as { url: string }).url).toBe(`${IMG}/djdl/a/${A}`);
    expect((all.acme as { url: string }).url).toBe(`${IMG}/acme/a/${C}`);
  });

  it("shows only a copy the host serves: no first pull in flight, no non-image type", async () => {
    // A first pull still pending has no copy; a refused re-pull keeps (and serves) its last copy.
    await hosted("djdl", "presentation.icon", {
      sha256: null,
      status: "pending",
    });
    await hosted("acme", "presentation.icon", { sha256: A, status: "failed" });
    expect(await icons()).toEqual({
      djdl: null,
      acme: { url: `${IMG}/acme/a/${A}`, w64: null, w128: null },
    });
    await db.run("DELETE FROM hosted_assets");
    await hosted("djdl", "presentation.icon", {
      sha256: A,
      status: "ready",
      contentType: "image/svg+xml",
    });
    // A hash with no ref is not something the host serves.
    await hosted("acme", "presentation.icon", {
      sha256: B,
      status: "ready",
      ref: false,
    });
    expect(await icons()).toEqual({ djdl: null, acme: null });
  });

  it("falls back to listing.icon when the presentation.icon copy has no ref, as the /icon alias does", async () => {
    await hosted("djdl", "presentation.icon", {
      sha256: A,
      status: "ready",
      ref: false,
    });
    await hosted("djdl", "listing.icon", { sha256: B, status: "ready" });
    // Another product's ref to the same bytes is never enough.
    await hosted("acme", "presentation.icon", {
      sha256: C,
      status: "ready",
      ref: false,
    });
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
            VALUES (?, ?, 10, 'blob', 0, ?, ?)`,
      `blobs/sha256/${C}`,
      C,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
            VALUES ('djdl', ?, 'hosted-asset', 'presentation.icon@', ?)`,
      `blobs/sha256/${C}`,
      NOW,
    );
    const all = await icons();
    expect((all.djdl as { url: string }).url).toBe(`${IMG}/djdl/a/${B}`);
    expect(all.acme).toBeNull();
  });

  it("is null in an environment with no image host", async () => {
    await hosted("djdl", "presentation.icon", { sha256: A, status: "ready" });
    expect((await icons(adminEnv(null))).djdl).toBeNull();
  });

  it("rides the one-product read too", async () => {
    await hosted("djdl", "presentation.icon", { sha256: A, status: "ready" });
    const res = await get("/api/products/djdl");
    const body = (await res.json()) as {
      product: { presentation: { icon: { url: string } } };
    };
    expect(body.product.presentation.icon.url).toBe(`${IMG}/djdl/a/${A}`);
  });

  it("reads every product's icon in one statement, however many products there are", async () => {
    const count = async (): Promise<number> => {
      let n = 0;
      const counting = new Proxy(db, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (prop === "all" || prop === "first")
            return (sql: string, ...params: DbParam[]) => {
              if (/FROM hosted_assets/.test(sql)) n++;
              return (v as (s: string, ...p: DbParam[]) => unknown).call(
                target,
                sql,
                ...params,
              );
            };
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Db;
      const res = await get("/api/products", adminEnv(), counting);
      expect(res.status).toBe(200);
      return n;
    };
    const two = await count();
    for (let i = 0; i < 6; i++) await seedProduct(db, `p${i}`);
    expect(await count()).toBe(two);
    expect(two).toBe(1);
  });
});

describe("the console shell's CSP admits exactly the image host", () => {
  const csp = (res: Response) =>
    res.headers.get("content-security-policy") ?? "";
  const imgSrc = (res: Response) =>
    csp(res)
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("img-src "));

  it("adds IMG_ORIGIN to img-src on the shell, and nothing else changes", async () => {
    const res = await get("");
    expect(imgSrc(res)).toBe(`img-src 'self' data: ${IMG}`);
    const plain = await get("", adminEnv(null));
    expect(imgSrc(plain)).toBe("img-src 'self' data:");
    expect(csp(res).replace(` ${IMG}`, "")).toBe(csp(plain));
  });

  it("uses the origin only: a configured path is dropped", async () => {
    const res = await get("", adminEnv("https://img.test/some/path"));
    expect(imgSrc(res)).toBe(`img-src 'self' data: ${IMG}`);
  });

  it("leaves the JSON API's policy alone", async () => {
    const res = await get("/api/products");
    expect(imgSrc(res)).toBe("img-src 'self' data:");
  });

  it("writes only a bare HTTPS origin (or a loopback HTTP one) into the policy", () => {
    expect(cspImageOrigin("https://img.plrs.im")).toBe("https://img.plrs.im");
    expect(cspImageOrigin("https://img-dev.plrs.im:8443")).toBe(
      "https://img-dev.plrs.im:8443",
    );
    expect(cspImageOrigin("http://localhost:8788")).toBe(
      "http://localhost:8788",
    );
    for (const bad of [
      "*",
      "https://*.plrs.im",
      "http://img.plrs.im",
      "https://img.plrs.im/",
      "https://img.plrs.im/x",
      "https://img.plrs.im; script-src *",
      "https://img.plrs.im 'unsafe-inline'",
      "data:",
      "https://.plrs.im",
      "https://img..plrs.im",
      "HTTPS://IMG.PLRS.IM",
      "",
      null,
      undefined,
    ])
      expect(cspImageOrigin(bad), String(bad)).toBeNull();
  });
});
