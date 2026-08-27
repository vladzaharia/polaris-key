/**
 * The per-SERVICE admin surface (§R1, spec §4.2).
 *
 * `/manage/api/products/<slug>/<service>/…` is dispatched through the same descriptor the public
 * router uses (`ServiceDescriptor.adminHandle`), so a service owns its own console API instead of
 * having a branch in `admin/handlers/products.ts`. Two services have one so far:
 *
 *   release/{health,resync,releases}   moved verbatim, plus the truth store's new read
 *   update/settings                    NEW — access modes (incl. `entitled`, D-13) and the
 *                                      compatibility window, relocated off the product PATCH
 *
 * The session, CSRF, rate-limit and platform-admin gates all run in `admin/api.ts` BEFORE a
 * descriptor is reached; this suite asserts the dispatch and the handlers, not those gates
 * (which `admin.test.ts` owns).
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { getProduct, listAudit } from "../src/repo.js";
import { getReleaseConfig } from "../src/services/release/index.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function session(env: Env): Promise<{ cookie: string; csrf: string }> {
  const { token, session: s } = await issueSession(
    env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    },
    NOW,
  );
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: s.csrf };
}

function mkReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

async function seedReleaseConfig(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "acme",
    "djdl",
    42,
    null,
    "main",
    null,
    "djdl",
    null,
    null,
    "pkey:summary",
    null,
    "public",
    "public",
  );
}

async function fixture(withReleaseConfig = true) {
  const db = makeTestDb();
  const env = adminEnv();
  await seedProduct(db, SLUG);
  if (withReleaseConfig) await seedReleaseConfig(db);
  const auth = await session(env);
  return { db, env, auth };
}

describe("update/settings", () => {
  const PATH = `/api/products/${SLUG}/update/settings`;

  it("reports the access modes and the compatibility window", async () => {
    const { db, env, auth } = await fixture();
    const res = await dispatch(
      mkReq("GET", PATH, { cookie: auth.cookie }),
      env,
      db,
      PATH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      metadataAccess: "public",
      artifactsAccess: "public",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      configured: true,
    });
  });

  it("accepts `entitled` and persists it to release_config", async () => {
    const { db, env, auth } = await fixture();
    const res = await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { metadataAccess: "public", artifactsAccess: "entitled" },
      }),
      env,
      db,
      PATH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      metadataAccess: "public",
      artifactsAccess: "entitled",
    });
    // Validation is in CODE, not DDL: `release_config`'s two columns carry no CHECK, so the new
    // value needed no migration (plan §R2).
    expect((await getReleaseConfig(db, SLUG))?.artifacts_access).toBe(
      "entitled",
    );
  });

  it("relocates the compatibility window off the product PATCH", async () => {
    const { db, env, auth } = await fixture();

    // The product PATCH no longer accepts it — dropped, not ignored, so a console cannot appear
    // to save a value that never changes (spec §8).
    const productPath = `/api/products/${SLUG}`;
    const ignored = await dispatch(
      mkReq("PATCH", productPath, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { name: "DJDL", compatMin: "5.0.0", compatMax: "6.0.0" },
      }),
      env,
      db,
      productPath,
    );
    expect(ignored.status).toBe(200);
    let row = await getProduct(db, SLUG);
    expect(row?.compat_min).toBe("0.0.0");
    expect(row?.compat_max).toBe("99.0.0");
    // …and the rest of that PATCH still applied, so this is a removal, not a rejection.
    expect(row?.name).toBe("DJDL");

    // Its new home does accept it.
    const moved = await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { compatMin: "5.0.0", compatMax: "6.0.0" },
      }),
      env,
      db,
      PATH,
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      compatMin: "5.0.0",
      compatMax: "6.0.0",
    });
    row = await getProduct(db, SLUG);
    expect(row?.compat_min).toBe("5.0.0");
    expect(row?.compat_max).toBe("6.0.0");
  });

  it("patches partially: an omitted field keeps its value", async () => {
    const { db, env, auth } = await fixture();
    await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { compatMin: "2.0.0" },
      }),
      env,
      db,
      PATH,
    );
    const res = await dispatch(
      mkReq("GET", PATH, { cookie: auth.cookie }),
      env,
      db,
      PATH,
    );
    expect(await res.json()).toMatchObject({
      compatMin: "2.0.0",
      compatMax: "99.0.0",
      artifactsAccess: "public",
    });
  });

  it("refuses an unknown access mode or a malformed version", async () => {
    const { db, env, auth } = await fixture();
    for (const [body, fields] of [
      [{ metadataAccess: "everyone" }, ["metadataAccess"]],
      [{ artifactsAccess: 7 }, ["artifactsAccess"]],
      [{ compatMin: "one.two.three" }, ["compatMin"]],
      [{ compatMax: "1.2" }, ["compatMax"]],
    ] as Array<[Record<string, unknown>, string[]]>) {
      const res = await dispatch(
        mkReq("PATCH", PATH, {
          cookie: auth.cookie,
          csrf: auth.csrf,
          body,
        }),
        env,
        db,
        PATH,
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ fields });
    }
    // Nothing was written on the way to any of those refusals.
    expect((await getReleaseConfig(db, SLUG))?.metadata_access).toBe("public");
    expect((await getProduct(db, SLUG))?.compat_min).toBe("0.0.0");
  });

  it("refuses an access-mode change on a product with no release config", async () => {
    // `setReleaseAccess` would match no rows, and the console would show a saved value the next
    // GET does not return.
    const { db, env, auth } = await fixture(false);
    const res = await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { artifactsAccess: "entitled" },
      }),
      env,
      db,
      PATH,
    );
    expect(res.status).toBe(422);
    const get = await dispatch(
      mkReq("GET", PATH, { cookie: auth.cookie }),
      env,
      db,
      PATH,
    );
    expect(await get.json()).toMatchObject({ configured: false });
  });

  it("audits the change", async () => {
    const { db, env, auth } = await fixture();
    await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { artifactsAccess: "licensed" },
      }),
      env,
      db,
      PATH,
    );
    const rows = await listAudit(db, SLUG, { limit: 10 });
    expect(rows.map((r) => r.action)).toContain("update.settings.update");
  });

  it("404s an unknown sub-path inside the service", async () => {
    const { db, env, auth } = await fixture();
    const path = `/api/products/${SLUG}/update/nope`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(404);
  });
});

describe("release admin, dispatched through the descriptor", () => {
  it("still answers release/health at its unchanged path", async () => {
    const { db, env, auth } = await fixture();
    const path = `/api/products/${SLUG}/release/health`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
    // No GitHub App configured in this env, so the health check reports the failure rather than
    // throwing — the shape is what matters here, not the verdict.
    expect(await res.json()).toHaveProperty("health.status");
  });

  it("serves the truth store at release/releases", async () => {
    const { db, env, auth } = await fixture();
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "v1.2.3",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://github.com/acme/djdl/releases/tag/v1.2.3",
      "public",
      "public",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_channels
         (product, channel, release_id, policy_json, created_at, modified_at)
       VALUES (?,?,?,?,?,?)`,
      SLUG,
      "stable",
      "v1.2.3",
      null,
      NOW,
      NOW,
    );
    const path = `/api/products/${SLUG}/release/releases`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      releases: [{ releaseId: "v1.2.3", version: "1.2.3", artifacts: [] }],
      channels: [{ channel: "stable", releaseId: "v1.2.3" }],
    });
  });

  it("refuses the wrong method rather than falling through to a 404", async () => {
    const { db, env, auth } = await fixture();
    const path = `/api/products/${SLUG}/release/health`;
    const res = await dispatch(
      mkReq("POST", path, { cookie: auth.cookie, csrf: auth.csrf }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(405);
  });
});

describe("service admin dispatch", () => {
  it("404s a service with no admin surface, without leaking that it exists", async () => {
    const { db, env, auth } = await fixture();
    for (const path of [
      `/api/products/${SLUG}/config/anything`,
      `/api/products/${SLUG}/license/anything`,
    ]) {
      const res = await dispatch(
        mkReq("GET", path, { cookie: auth.cookie }),
        env,
        db,
        path,
      );
      expect(res.status).toBe(404);
    }
  });

  it("reaches a disabled service's settings — an operator configures before enabling", async () => {
    // Deliberately unlike the PUBLIC dispatcher, which hides a disabled service entirely. The
    // console is already behind the platform-admin gate, and "enable, then configure" would be
    // impossible if the settings vanished with the service.
    const { db, env, auth } = await fixture();
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      JSON.stringify({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      }),
      SLUG,
    );
    const path = `/api/products/${SLUG}/update/settings`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
  });
});
