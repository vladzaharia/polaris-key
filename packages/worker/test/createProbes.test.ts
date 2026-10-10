/**
 * The New Product wizard's create probes (UX-72, FLOWS.md §3.11):
 *
 *   W22 `GET  /manage/api/github/repositories`        what the App can read, marked
 *   W23 `POST /manage/api/products/link-repo?dryRun=1` the create dry run, digest-pinned create
 *   W24 `GET  /manage/api/products/slug-check`        is a slug free
 *
 * and link-repo's create answering the product (C-2: "<Name> is ready", never the slug).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "./githubHead.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  checkSlug,
  manifestProblems,
  prepareCreate,
  slugFromName,
} from "../src/services/release/linkRepo.js";
import { stmtInsertReleaseConfig } from "../src/repo.js";
import { getProduct } from "../src/repo.js";
import { handleAdmin } from "../src/admin/index.js";
import { resetGithubRepositoryCache } from "../src/admin/handlers/github.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.OIDC_ISSUER_ALLOWLIST = "id.example";
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
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

const SCHEMA = JSON.stringify({
  schemaVersion: 1,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "run",
      label: "Concurrency",
      description: "",
      schema: { type: "integer", minimum: 1 },
    },
    {
      key: "run.verbose",
      kind: "flag",
      category: "run",
      label: "Verbose",
      description: "",
      schema: { type: "boolean" },
    },
  ],
});

function productJson(slug = "tonebox", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    slug,
    name: "Tonebox",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    tiers: [],
    provisioning: [],
    ...extra,
  });
}

const RELEASE = JSON.stringify({
  release: {
    ghOwner: "acme",
    ghRepo: "tonebox",
    binaryName: "tonebox",
    deliverables: {
      app: {
        kind: "app",
        artifacts: [
          {
            id: "macos",
            platform: "macos",
            arch: "universal",
            format: "dmg",
            match: "Tonebox-*.dmg",
          },
          {
            id: "win",
            platform: "windows",
            arch: "x86_64",
            format: "zip",
            match: "Tonebox-*-win.zip",
          },
        ],
      },
    },
  },
});

function repoFiles(
  product = productJson(),
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ".pkey/schema.json": SCHEMA,
    ".pkey/product.json": product,
    ".pkey/release.json": RELEASE,
    ...extra,
  };
}

/** Installation discovery, the token exchange and repository files; `installed: false` 404s. */
function stubFetch(
  files: Record<string, string>,
  opts: { installed?: boolean } = {},
): FetchImpl {
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation") && !url.includes("/installations/"))
      return opts.installed === false
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ id: 4242 }), { status: 200 });
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

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
  groups: string[] = ["admins"],
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "a@x.io", groups },
    NOW,
  );
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method,
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Request;
  return handleAdmin(req, env, db, path.split("?")[0]!, { now: NOW + 60 });
}

/** Mark `slug` as linked to `owner/repo`, as a create from that repository leaves it. */
async function linkTo(db: Db, slug: string, owner: string, repo: string) {
  await db.batch([
    stmtInsertReleaseConfig({
      product: slug,
      ghOwner: owner,
      ghRepo: repo,
      ghInstallationId: 4242,
      channelWorkflow: null,
      betaBranch: "main",
      binaryName: repo,
      sparkleEd25519Pub: null,
      summaryMarker: "pkey:summary",
      metadataAccess: "public",
      artifactsAccess: "public",
      accessSource: "manifest",
    }),
    {
      sql: "UPDATE products SET release_source = 'github' WHERE slug = ?",
      params: [slug],
    },
  ]);
}

afterEach(() => vi.unstubAllGlobals());

// ── W24 ───────────────────────────────────────────────────────────────────────

describe("slug check (W24)", () => {
  it("answers available, taken, reserved and invalid, each with a free suggestion", async () => {
    const db = makeTestDb();
    await seedProduct(db, "tonebox");
    await seedProduct(db, "tonebox-app");
    expect(await checkSlug(db, "beatgrid")).toEqual({
      slug: "beatgrid",
      status: "available",
    });
    expect(await checkSlug(db, "tonebox")).toMatchObject({
      status: "taken",
      suggestion: "tonebox-2",
    });
    // Router paths, the system product and the admin API's own actions.
    for (const slug of ["docs", "manage", "polaris-key", "link-repo", "kek"])
      expect(await checkSlug(db, slug), slug).toMatchObject({
        status: "reserved",
        suggestion: `${slug}-app`,
      });
    expect(await checkSlug(db, "Tone Box!")).toMatchObject({
      status: "invalid",
      suggestion: "tone-box",
    });
    expect(await checkSlug(db, "-tonebox")).toMatchObject({
      status: "invalid",
      suggestion: "tonebox-2",
    });
    const long = "a".repeat(70);
    const verdict = await checkSlug(db, long);
    expect(verdict).toMatchObject({ status: "invalid" });
    if (verdict.status !== "available")
      expect(verdict.suggestion).toHaveLength(64);
  });

  it("derives slugs as the console does", () => {
    expect(slugFromName("Ünïcode  Tone—Box 2")).toBe("unicode-tone-box-2");
    expect(slugFromName("!!!")).toBe("");
  });

  it("is a GET for the platform group's operators, and refuses a missing slug", async () => {
    const db = makeTestDb();
    const env = envFor();
    await seedProduct(db, "tonebox");
    // Slug-check reads the CURRENT platform group; a session without it is refused.
    const outsider = await call(
      env,
      db,
      "GET",
      "/api/products/slug-check?slug=tonebox",
      undefined,
      [],
    );
    expect(outsider.status).toBe(403);
    const res = await call(
      env,
      db,
      "GET",
      "/api/products/slug-check?slug=tonebox",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      slug: "tonebox",
      status: "taken",
      suggestion: "tonebox-app",
    });
    const missing = await call(env, db, "GET", "/api/products/slug-check");
    expect(missing.status).toBe(422);
    const post = await call(env, db, "POST", "/api/products/slug-check", {});
    expect(post.status).toBe(405);
  });

  it("manual create refuses the admin API's action names", async () => {
    const db = makeTestDb();
    const env = envFor();
    const res = await call(env, db, "POST", "/api/products", {
      slug: "slug-check",
      name: "Slug check",
    });
    expect(res.status).toBe(422);
    expect(await getProduct(db, "slug-check")).toBeNull();
  });
});

// ── W23 ───────────────────────────────────────────────────────────────────────

describe("create dry run (W23)", () => {
  it("shows the product as it will be and writes nothing", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal(
      "fetch",
      stubFetch(
        repoFiles(
          productJson("tonebox", {
            presentation: { accent: "#2bb8a4" },
            oidc: {
              provider: "custom",
              issuer: "https://id.example",
              clientId: "tonebox",
              clientSecretSecret: "OIDC_SECRET",
              redirectUris: [],
            },
          }),
          { ".github/workflows/release.yml": "on: push" },
        ),
      ),
    );
    const res = await call(
      env,
      db,
      "POST",
      "/api/products/link-repo?dryRun=1",
      { repoUrl: "https://github.com/acme/tonebox" },
    );
    expect(res.status).toBe(200);
    const dry = (await res.json()) as Record<string, unknown>;
    expect(dry).toMatchObject({
      ok: true,
      dryRun: true,
      ready: true,
      repository: "acme/tonebox",
      installationId: 4242,
      commit: HEAD_SHA,
      product: {
        slug: "tonebox",
        name: "Tonebox",
        presentation: { accent: "#2bb8a4" },
      },
      slug: { slug: "tonebox", status: "available" },
      registeredAs: null,
      catalog: { entries: 2 },
      platforms: { values: ["macos", "windows"], source: "artifact-map" },
      secrets: ["OIDC_SECRET"],
      releaseWorkflow: true,
      problems: [],
    });
    expect(dry.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(dry.services)).toBe(true);
    // Nothing exists until Create (F3).
    expect(await getProduct(db, "tonebox")).toBeNull();
  });

  it("lists manifest problems with their file and path", async () => {
    const db = makeTestDb();
    const env = envFor();
    const dry = await prepareCreate(
      env,
      db,
      "acme/tonebox",
      NOW,
      stubFetch(repoFiles(productJson("Bad Slug"))),
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.ready).toBe(false);
    expect(dry.product).toBeNull();
    expect(dry.releaseWorkflow).toBe(false);
    expect(dry.problems).toContainEqual(
      expect.objectContaining({
        check: "manifest",
        file: "product",
        path: "/product/slug",
      }),
    );
  });

  it("makes a taken slug a problem in .pkey/product with a free suggestion", async () => {
    const db = makeTestDb();
    const env = envFor();
    await seedProduct(db, "tonebox");
    const dry = await prepareCreate(
      env,
      db,
      "acme/tonebox",
      NOW,
      stubFetch(repoFiles()),
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.ready).toBe(false);
    expect(dry.slug).toMatchObject({ status: "taken" });
    expect(dry.problems).toEqual([
      {
        check: "slug",
        file: "product",
        path: "/product/slug",
        message: "product already exists: tonebox",
        suggestion: "tonebox-app",
      },
    ]);
  });

  it("names the product a repository already is (F15)", async () => {
    const db = makeTestDb();
    const env = envFor();
    await seedProduct(db, "beatgrid");
    await linkTo(db, "beatgrid", "Acme", "Tonebox");
    const dry = await prepareCreate(
      env,
      db,
      "acme/tonebox",
      NOW,
      stubFetch(repoFiles()),
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.registeredAs).toBe("beatgrid");
    expect(dry.problems[0]).toMatchObject({ check: "repository" });
  });

  it("lists the policy refusals the create would hit", async () => {
    const db = makeTestDb();
    const env = envFor();
    const dry = await prepareCreate(
      env,
      db,
      "acme/tonebox",
      NOW,
      stubFetch(
        repoFiles(
          productJson("tonebox", {
            oidc: {
              provider: "custom",
              issuer: "https://id.elsewhere.example",
              clientId: "c",
              clientSecretSecret: "OIDC_SECRET",
              redirectUris: [],
            },
          }),
        ),
      ),
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.problems).toContainEqual(
      expect.objectContaining({
        check: "policy",
        file: "product",
        path: "/oidc/issuer",
      }),
    );
  });

  it("refuses with the check that failed before the manifest is read", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", stubFetch(repoFiles(), { installed: false }));
    const app = await call(
      env,
      db,
      "POST",
      "/api/products/link-repo?dryRun=1",
      {
        repoUrl: "acme/other",
      },
    );
    expect(app.status).toBe(422);
    expect(await app.json()).toMatchObject({ reason: "app" });
    const bad = await call(
      env,
      db,
      "POST",
      "/api/products/link-repo?dryRun=1",
      {
        repoUrl: "not a repository",
      },
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ reason: "repository" });
  });

  it("parses validator lines into file, path and message", () => {
    expect(
      manifestProblems([
        "product/product/slug: product.slug must match ^[a-z0-9-]{1,64}$.",
        "schema: larger than the limit",
        "something else",
      ]),
    ).toEqual([
      {
        check: "manifest",
        file: "product",
        path: "/product/slug",
        message: "product.slug must match ^[a-z0-9-]{1,64}$.",
      },
      {
        check: "manifest",
        file: "schema",
        path: "/",
        message: "larger than the limit",
      },
      { check: "manifest", file: null, path: null, message: "something else" },
    ]);
  });
});

describe("link-repo create (digest pin, C-2)", () => {
  it("creates with the dry run's digest and answers the product's name", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", stubFetch(repoFiles()));
    const dry = (await (
      await call(env, db, "POST", "/api/products/link-repo?dryRun=1", {
        repoUrl: "acme/tonebox",
      })
    ).json()) as { manifestDigest: string };
    const res = await call(env, db, "POST", "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
      manifestDigest: dry.manifestDigest,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: "tonebox",
      product: { slug: "tonebox", name: "Tonebox" },
    });
  });

  it("refuses with 409 when .pkey/ changed since the check, and creates nothing", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", stubFetch(repoFiles()));
    const res = await call(env, db, "POST", "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
      manifestDigest: "0".repeat(64),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "manifest" });
    expect(await getProduct(db, "tonebox")).toBeNull();
  });

  it("still creates without a digest (the API and pkey)", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", stubFetch(repoFiles()));
    const res = await call(env, db, "POST", "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
    });
    expect(res.status).toBe(201);
    const second = await call(env, db, "POST", "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
    });
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      message: "product already exists: tonebox",
    });
  });
});

// ── W22 ───────────────────────────────────────────────────────────────────────

const REPOS = [
  { name: "old", pushed_at: "2026-01-01T00:00:00Z", language: "C" },
  { name: "tonebox", pushed_at: "2026-10-01T00:00:00Z", language: "GDScript" },
  { name: "beatgrid", pushed_at: "2026-09-01T00:00:00Z", language: null },
  { name: "empty", pushed_at: null, language: null },
];

/** The App, one installation on `acme`, its repositories and their `.pkey/` directories. */
function githubStub(
  calls: { url: string; body?: unknown }[],
  opts: { manifests?: string[]; installations?: boolean } = {},
): FetchImpl {
  const manifests = new Set(opts.manifests ?? ["tonebox", "beatgrid"]);
  return async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url === "https://api.github.com/app")
      return Response.json({
        slug: "polaris-key-test",
        html_url: "https://github.com/apps/polaris-key-test",
      });
    if (url.startsWith("https://api.github.com/app/installations?"))
      return Response.json(
        opts.installations === false
          ? []
          : [
              {
                id: 11,
                account: { login: "acme", type: "Organization" },
                repository_selection: "selected",
                permissions: { contents: "read", metadata: "read" },
              },
            ],
      );
    if (url.endsWith("/access_tokens"))
      return Response.json({ token: "ghs_list" });
    if (url.startsWith("https://api.github.com/installation/repositories"))
      return Response.json({
        total_count: REPOS.length,
        repositories: REPOS.map((r) => ({
          name: r.name,
          full_name: `acme/${r.name}`,
          owner: { login: "acme" },
          language: r.language,
          pushed_at: r.pushed_at,
          private: r.name !== "old",
          default_branch: "main",
        })),
      });
    const m = url.match(/\/repos\/acme\/([^/]+)\/contents\/\.pkey$/);
    if (m)
      return manifests.has(m[1]!)
        ? Response.json([
            { name: "product.json", type: "file" },
            { name: "schema.json", type: "file" },
          ])
        : new Response("not found", { status: 404 });
    return new Response("not found", { status: 404 });
  };
}

describe("repositories the App can read (W22)", () => {
  beforeEach(() => resetGithubRepositoryCache());

  it("lists the installation and its repositories, newest push first, marked", async () => {
    const db = makeTestDb();
    const env = envFor();
    await seedProduct(db, "beatgrid");
    await linkTo(db, "beatgrid", "acme", "beatgrid");
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", githubStub(calls));
    const res = await call(env, db, "GET", "/api/github/repositories");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      app: unknown;
      installations: unknown[];
      repositories: Array<Record<string, unknown>>;
      total: number;
      nextCursor: string | null;
    };
    expect(body.configured).toBe(true);
    expect(body.app).toEqual({
      slug: "polaris-key-test",
      installUrl: "https://github.com/apps/polaris-key-test/installations/new",
    });
    expect(body.installations).toEqual([
      {
        id: 11,
        account: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "read", metadata: "read" },
        repositoryCount: 4,
        listingError: null,
      },
    ]);
    expect(body.repositories.map((r) => r.fullName)).toEqual([
      "acme/tonebox",
      "acme/beatgrid",
      "acme/old",
      "acme/empty",
    ]);
    expect(body.repositories[0]).toEqual({
      installationId: 11,
      owner: "acme",
      name: "tonebox",
      fullName: "acme/tonebox",
      language: "GDScript",
      pushedAt: Date.parse("2026-10-01T00:00:00Z") / 1000,
      private: true,
      defaultBranch: "main",
      product: null,
      hasManifest: true,
    });
    expect(body.repositories[1]).toMatchObject({
      product: "beatgrid",
      hasManifest: true,
    });
    expect(body.repositories[2]).toMatchObject({
      product: null,
      hasManifest: false,
    });
    expect(body.total).toBe(4);
    expect(body.nextCursor).toBeNull();

    // The listing token reads metadata only; the probe's reads contents of the page's repos only.
    const tokens = calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(tokens[0]!.body).toEqual({ permissions: { metadata: "read" } });
    expect(tokens[1]!.body).toEqual({
      repositories: ["tonebox", "beatgrid", "old", "empty"],
      permissions: { contents: "read", metadata: "read" },
    });

    // Cached for 60 s: a second read lists nothing from GitHub.
    const before = calls.length;
    expect(
      (await call(env, db, "GET", "/api/github/repositories")).status,
    ).toBe(200);
    expect(calls.length).toBe(before);
  });

  it("filters by q (a pasted URL matches exactly) and pages with nextCursor", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", githubStub([]));
    const pasted = (await (
      await call(
        env,
        db,
        "GET",
        `/api/github/repositories?q=${encodeURIComponent("https://github.com/ACME/tonebox.git")}`,
      )
    ).json()) as { repositories: { fullName: string }[]; total: number };
    expect(pasted.repositories.map((r) => r.fullName)).toEqual([
      "acme/tonebox",
    ]);
    const search = (await (
      await call(env, db, "GET", "/api/github/repositories?q=o")
    ).json()) as { total: number };
    expect(search.total).toBe(2); // tonebox and old
    const first = (await (
      await call(env, db, "GET", "/api/github/repositories?limit=3")
    ).json()) as { repositories: unknown[]; nextCursor: string | null };
    expect(first.repositories).toHaveLength(3);
    expect(first.nextCursor).toBe("3");
    const rest = (await (
      await call(env, db, "GET", "/api/github/repositories?limit=3&cursor=3")
    ).json()) as {
      repositories: { fullName: string }[];
      nextCursor: string | null;
    };
    expect(rest.repositories.map((r) => r.fullName)).toEqual(["acme/empty"]);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await call(env, db, "GET", "/api/github/repositories?cursor=x")).status,
    ).toBe(422);
    expect(
      (await call(env, db, "GET", "/api/github/repositories?limit=0")).status,
    ).toBe(422);
  });

  it("answers no installations, and configured: false without the App", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", githubStub([], { installations: false }));
    const none = (await (
      await call(env, db, "GET", "/api/github/repositories")
    ).json()) as { installations: unknown[]; repositories: unknown[] };
    expect(none.installations).toEqual([]);
    expect(none.repositories).toEqual([]);

    resetGithubRepositoryCache();
    const bare = envFor();
    delete (bare as { GITHUB_APP_ID?: string }).GITHUB_APP_ID;
    const res = await call(bare, db, "GET", "/api/github/repositories");
    expect(await res.json()).toMatchObject({
      configured: false,
      app: null,
      repositories: [],
    });
  });

  it("lists the other installations when one is suspended or refuses a token", async () => {
    const db = makeTestDb();
    const env = envFor();
    const base = githubStub([]);
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.github.com/app/installations?"))
        return Response.json([
          {
            id: 11,
            account: { login: "acme", type: "Organization" },
            repository_selection: "selected",
            permissions: { contents: "read", metadata: "read" },
          },
          {
            id: 12,
            account: { login: "broken", type: "Organization" },
            repository_selection: "all",
            permissions: { contents: "read", metadata: "read" },
          },
          {
            id: 13,
            account: { login: "paused", type: "User" },
            repository_selection: "all",
            permissions: { contents: "read", metadata: "read" },
            suspended_at: "2026-09-01T00:00:00Z",
          },
        ]);
      if (url.endsWith("/installations/12/access_tokens"))
        return new Response("forbidden", { status: 403 });
      return base(input, init);
    }) as FetchImpl);
    const res = await call(env, db, "GET", "/api/github/repositories");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.installations).toEqual([
      expect.objectContaining({
        id: 11,
        repositoryCount: 4,
        listingError: null,
      }),
      expect.objectContaining({
        id: 12,
        account: "broken",
        repositoryCount: null,
        listingError: "installation token failed: 403",
      }),
    ]);
    expect(body.total).toBe(4);
    // The suspended installation is never asked for a token.
    expect(calls.some((u) => u.includes("/installations/13/"))).toBe(false);
  });

  it("is platform-admin only, GET only, and 502s when GitHub refuses", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    expect(
      (await call(env, db, "GET", "/api/github/repositories", undefined, []))
        .status,
    ).toBe(403);
    expect(
      (await call(env, db, "POST", "/api/github/repositories", {})).status,
    ).toBe(405);
    expect((await call(env, db, "GET", "/api/github/other")).status).toBe(404);
    const down = await call(env, db, "GET", "/api/github/repositories");
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ reason: "github" });
  });
});
