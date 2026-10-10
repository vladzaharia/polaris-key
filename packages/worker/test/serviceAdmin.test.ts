/**
 * The per-SERVICE admin surface (§R1, spec §4.2).
 *
 * `/manage/api/products/<slug>/<service>/…` is dispatched through the same descriptor the public
 * router uses (`ServiceDescriptor.adminHandle`), so a service owns its own console API instead of
 * having a branch in `console/handlers/products.ts`. Five of the six services have one
 * (distribution has no `adminHandle` yet — its console view is read-only, P2b-01):
 *
 *   license/{licenses…,tiers…,policy}  MOVED in P7 off the dispatcher's own destructure; the
 *                                      pre-suite spellings are GONE, not aliased
 *   config/{catalog,profiles…}         MOVED in P7 (`schema` → `catalog`, see that module)
 *   release/{health,resync,releases}   moved verbatim, plus the truth store's new read
 *   update/settings                    NEW — access modes (incl. `entitled`, D-13) and the
 *                                      compatibility window, relocated off the product PATCH
 *   identity/portal                    moved verbatim from `console/handlers/products.ts`; the
 *                                      console's old `portal` spelling is GONE, not rewritten —
 *                                      it 404s (asserted below)
 *
 * The session, CSRF, rate-limit and platform-admin gates all run in `console/api.ts` BEFORE a
 * descriptor is reached; this suite asserts the dispatch and the handlers, not those gates
 * (which `admin.test.ts` owns).
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getProduct, listAudit } from "../src/core/repo.js";
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
    // `artifactsAccess` moved to Distribution's delivery access in P2b-04
    // (`…/distribution/access`), so it is no longer reported here.
    expect(await res.json()).toEqual({
      metadataAccess: "public",
      // Never touched by an operator, so both claimable blocks are still the manifest's (P0-01).
      accessSource: "manifest",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      compatSource: "manifest",
      // The operator-only artifact policy, on its fail-safe defaults.
      minimumSystemVersion: null,
      requireSparkleSignature: true,
      configured: true,
    });
  });

  it("accepts `entitled` and persists it to release_config", async () => {
    const { db, env, auth } = await fixture();
    const res = await dispatch(
      mkReq("PATCH", PATH, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { metadataAccess: "entitled" },
      }),
      env,
      db,
      PATH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ metadataAccess: "entitled" });
    // Validation is in CODE, not DDL: `release_config`'s columns carry no CHECK, so the new
    // value needed no migration (plan §R2).
    expect((await getReleaseConfig(db, SLUG))?.metadata_access).toBe(
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
      metadataAccess: "public",
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
        body: { metadataAccess: "entitled" },
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
        body: { metadataAccess: "licensed" },
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

  it("gives a file with no platform its build's, or its name's (display only)", async () => {
    const { db, env, auth } = await fixture();
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, published_at,
          created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      SLUG,
      "v2.0.0",
      "2.0.0",
      "public",
      "public",
      NOW,
      NOW,
      NOW,
    );
    for (const [buildId, platform, arch] of [
      ["mac", "macos", "arm64"],
      ["content", null, "any"],
    ] as const) {
      await db.run(
        `INSERT INTO release_builds
           (product, release_id, build_id, platform, arch, format, created_at, modified_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        SLUG,
        "v2.0.0",
        buildId,
        platform,
        arch,
        "zip",
        NOW,
        NOW,
      );
    }
    const files: [string, string | null, string | null, string | null][] = [
      // [name, platform, arch, build_id]
      ["djdl-mac.zip", null, "arm64", "mac"],
      ["djdl-arm64.app.zip", null, "arm64", null],
      ["djdl-win.zip", "windows", "x86_64", null],
      ["content-macos.pck", null, "any", "content"],
      ["NOTES.txt", null, null, null],
    ];
    for (const [i, [name, platform, arch, buildId]] of files.entries()) {
      await db.run(
        `INSERT INTO release_artifacts
           (product, release_id, artifact_id, name, kind, platform, arch, access,
            created_at, build_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        SLUG,
        "v2.0.0",
        String(i + 1),
        name,
        "archive",
        platform,
        arch,
        "public",
        NOW,
        buildId,
      );
    }
    const path = `/api/products/${SLUG}/release/releases`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: { artifacts: { name: string; platform: string | null }[] }[];
    };
    expect(
      Object.fromEntries(
        body.releases[0]!.artifacts.map((a) => [a.name, a.platform]),
      ),
    ).toEqual({
      // The build's platform.
      "djdl-mac.zip": "macos",
      // No build: the name's (`.app.zip` is a macOS bundle), never a bare arch.
      "djdl-arm64.app.zip": "macos",
      // A stored platform wins.
      "djdl-win.zip": "windows",
      // A platform-independent build stays platform-independent, whatever the name says.
      "content-macos.pck": null,
      "NOTES.txt": null,
    });
    // The stored row is untouched: the inference is read-time only.
    expect(
      await db.first<{ platform: string | null }>(
        `SELECT platform FROM release_artifacts WHERE product = ? AND name = ?`,
        SLUG,
        "djdl-arm64.app.zip",
      ),
    ).toEqual({ platform: null });
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

describe("identity/portal", () => {
  const CANONICAL = `/api/products/${SLUG}/identity/portal`;
  const LEGACY = `/api/products/${SLUG}/portal`;

  it("reads and writes the customer-portal settings at the namespaced path", async () => {
    const { db, env, auth } = await fixture(false);

    const patched = await dispatch(
      mkReq("PATCH", CANONICAL, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { portalEnabled: true, magicEnabled: false },
      }),
      env,
      db,
      CANONICAL,
    );
    expect(patched.status).toBe(200);
    expect(
      ((await patched.json()) as { settings: Record<string, unknown> })
        .settings,
    ).toMatchObject({ portalEnabled: true, magicEnabled: false });

    const read = await dispatch(
      mkReq("GET", CANONICAL, { cookie: auth.cookie }),
      env,
      db,
      CANONICAL,
    );
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as { settings: Record<string, unknown> }).settings,
    ).toMatchObject({ portalEnabled: true, magicEnabled: false });
  });

  it("404s the pre-namespace `portal` path — the rewrite is gone, not merely deprecated", async () => {
    // §R1 regrouped `portal` under `identity/` and the console migrated in P7, so the transitional
    // rewrite was deleted. It has to answer 404 rather than 200: an alias that quietly keeps
    // working is an alias nobody ever stops using, and a WRITE through it would land on the same
    // rows while no test covered that spelling.
    const { db, env, auth } = await fixture(false);
    const readCanonical = async (): Promise<Record<string, unknown>> => {
      const res = await dispatch(
        mkReq("GET", CANONICAL, { cookie: auth.cookie }),
        env,
        db,
        CANONICAL,
      );
      return ((await res.json()) as { settings: Record<string, unknown> })
        .settings;
    };
    const before = await readCanonical();

    for (const req of [
      mkReq("PATCH", LEGACY, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { releasesEnabled: !before.releasesEnabled },
      }),
      mkReq("GET", LEGACY, { cookie: auth.cookie }),
    ]) {
      expect((await dispatch(req, env, db, LEGACY)).status).toBe(404);
    }

    // …and the settings are untouched: the 404 happened before any handler ran, so the
    // rejected PATCH is a rejected WRITE and not merely a rejected response shape.
    expect(await readCanonical()).toEqual(before);
  });

  it("audits the change against the verified actor", async () => {
    const { db, env, auth } = await fixture(false);
    await dispatch(
      mkReq("PATCH", CANONICAL, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { portalEnabled: true },
      }),
      env,
      db,
      CANONICAL,
    );
    const rows = await listAudit(db, SLUG, { limit: 10 });
    expect(rows.map((r) => r.action)).toContain("portal.settings.update");
  });

  it("404s an unknown sub-path inside identity rather than falling through", async () => {
    const { db, env, auth } = await fixture(false);
    const path = `/api/products/${SLUG}/identity/oidc`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P7 — the product-scoped resources regrouped under their owning service (§R1)
// ═════════════════════════════════════════════════════════════════════════════

describe("the admin regroup (§R1)", () => {
  /** old spelling → the service-namespaced path that replaced it. */
  const MOVED: [string, string][] = [
    ["licenses", "license/licenses"],
    ["tiers", "license/tiers"],
    ["policy", "license/policy"],
    ["schema", "config/catalog"],
    ["profiles", "config/profiles"],
  ];

  it.each(MOVED)("serves %s at its new home: %s", async (_old, moved) => {
    const { db, env, auth } = await fixture(false);
    const path = `/api/products/${SLUG}/${moved}`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    // 200 for the collections; `config/catalog` 404s only because this fixture publishes no
    // catalog. Either way it REACHED a handler — what must not happen is the dispatcher
    // refusing to route the path at all, which is indistinguishable from the 404 below without
    // asserting on the collection bodies, so those are pinned separately.
    expect([200, 404]).toContain(res.status);
  });

  it.each(MOVED)(
    "the pre-suite spelling %s is gone outright",
    async (old, _moved) => {
      // Pre-launch, the console was the only consumer, so a permanent alias would buy nothing
      // and cost two paths that can answer differently after the next refactor. `portal` is the
      // one exception and it is a deliberate, dated rewrite (`console/api.ts`), not an alias.
      const { db, env, auth } = await fixture(false);
      const path = `/api/products/${SLUG}/${old}`;
      const res = await dispatch(
        mkReq("GET", path, { cookie: auth.cookie }),
        env,
        db,
        path,
      );
      expect(res.status).toBe(404);
    },
  );

  it("lists licences and tiers through License's descriptor", async () => {
    const { db, env, auth } = await fixture(false);
    for (const [resource, key] of [
      ["license/licenses", "licenses"],
      ["license/tiers", "tiers"],
    ] as const) {
      const path = `/api/products/${SLUG}/${resource}`;
      const res = await dispatch(
        mkReq("GET", path, { cookie: auth.cookie }),
        env,
        db,
        path,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ [key]: [] });
    }
  });

  it("round-trips a licence through create → detail → keys, six segments deep", async () => {
    // The dispatcher used to destructure exactly five path positions, which capped how deep a
    // resource could nest. A service routes itself now, so this path — six segments past the
    // slug — has to work, and it is the one the console's key list actually calls.
    const { db, env, auth } = await fixture(false);
    const collection = `/api/products/${SLUG}/license/licenses`;
    const created = await dispatch(
      mkReq("POST", collection, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { name: "Ada", email: "ada@x.io" },
      }),
      env,
      db,
      collection,
    );
    expect(created.status).toBe(201);
    const { licenseId } = (await created.json()) as { licenseId: string };

    const keysPath = `${collection}/${licenseId}/keys`;
    const keys = await dispatch(
      mkReq("GET", keysPath, { cookie: auth.cookie }),
      env,
      db,
      keysPath,
    );
    expect(keys.status).toBe(200);
    // Creating a licence mints its first key, so this proves the nested route reached the
    // handler rather than merely failing to 404.
    expect((await keys.json()) as { keys: unknown[] }).toMatchObject({
      keys: [{ label: "Initial key" }],
    });
  });

  it("publishes and reads a catalog through Config's descriptor", async () => {
    const { db, env, auth } = await fixture(false);
    const path = `/api/products/${SLUG}/config/catalog`;
    const published = await dispatch(
      mkReq("PUT", path, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: {
          catalog: {
            schemaVersion: 1,
            entries: [
              {
                key: "ui.theme",
                kind: "config",
                category: "ui",
                label: "Theme",
                description: "",
                schema: { type: "string" },
              },
            ],
          },
        },
      }),
      env,
      db,
      path,
    );
    expect(published.status).toBe(200);
    const read = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(read.status).toBe(200);
    expect((await read.json()) as { entries: unknown[] }).toMatchObject({
      entries: [{ key: "ui.theme" }],
    });
  });

  it("edits the fingerprint policy under License and reverts it to the manifest", async () => {
    const { db, env, auth } = await fixture(false);
    const path = `/api/products/${SLUG}/license/policy`;
    const patched = await dispatch(
      mkReq("PATCH", path, {
        cookie: auth.cookie,
        csrf: auth.csrf,
        body: { enabled: true, defaultMode: "strict" },
      }),
      env,
      db,
      path,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      policy: { enabled: true, defaultMode: "strict" },
      source: "admin",
    });

    const revertPath = `${path}/revert`;
    const reverted = await dispatch(
      mkReq("POST", revertPath, { cookie: auth.cookie, csrf: auth.csrf }),
      env,
      db,
      revertPath,
    );
    expect(reverted.status).toBe(200);
    expect(await reverted.json()).toMatchObject({ source: "manifest" });
  });

  it("reaches a DISABLED service's settings — configure-then-enable has to be possible", async () => {
    // Unlike the public dispatcher, the admin surface does not check enablement (see the note in
    // `console/api.ts`). Hiding a disabled service from an authenticated platform admin would
    // protect nothing — the console is already behind the platform-admin gate — and would make
    // it impossible to set a service up before turning it on.
    const { db, env, auth } = await fixture(false);
    await db.run(
      "UPDATE products SET services_json = ?, services_source = 'admin' WHERE slug = ?",
      JSON.stringify({
        license: { enabled: false },
        config: { enabled: true },
      }),
      SLUG,
    );
    const path = `/api/products/${SLUG}/license/tiers`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
  });

  it("404s an unknown sub-path inside license/config rather than falling through", async () => {
    const { db, env, auth } = await fixture(false);
    for (const path of [
      `/api/products/${SLUG}/license/nope`,
      `/api/products/${SLUG}/config/nope`,
      `/api/products/${SLUG}/config/catalog/extra`,
    ]) {
      const res = await dispatch(
        mkReq("GET", path, { cookie: auth.cookie }),
        env,
        db,
        path,
      );
      expect(res.status, path).toBe(404);
    }
  });
});

describe("productView carries the enablement set (D-15)", () => {
  it("reports services, registration and the ownership source on the product row", async () => {
    // The console's shell filters its nav on this, so it has to arrive with the product rather
    // than on a second request the sidebar would have to wait for.
    const { db, env, auth } = await fixture(false);
    await db.run(
      "UPDATE products SET services_json = ?, services_source = 'admin' WHERE slug = ?",
      JSON.stringify({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        update: { enabled: true },
        identity: { enabled: false },
        registration: "open",
      }),
      SLUG,
    );
    const path = `/api/products/${SLUG}`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    expect(res.status).toBe(200);
    const { product } = (await res.json()) as {
      product: Record<string, unknown>;
    };
    expect(product).toMatchObject({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        update: { enabled: true },
        identity: { enabled: false },
      },
      registration: "open",
      effectiveRegistration: "open",
      servicesSource: "admin",
    });
  });

  it("reports the DERIVED registration as null-declared when the manifest said nothing", async () => {
    const { db, env, auth } = await fixture(false);
    const path = `/api/products/${SLUG}`;
    const res = await dispatch(
      mkReq("GET", path, { cookie: auth.cookie }),
      env,
      db,
      path,
    );
    const { product } = (await res.json()) as {
      product: Record<string, unknown>;
    };
    // Undeclared is not the same as "someone chose requires-license": the console has to be able
    // to show "derived", or an operator would think a value was set that nobody wrote.
    expect(product.registration).toBeNull();
    expect(product.effectiveRegistration).toBe("requires-license");
    expect(product.servicesSource).toBe("manifest");
  });
});
