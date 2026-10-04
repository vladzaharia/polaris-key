/**
 * F-05 — the PyPI feed (plans/F-01.md §6.2, §6.7, §6.8): the PEP 691/503 documents against golden
 * files, PEP 691 negotiation, and the routes through the real registry-host dispatcher over
 * package releases published through the real submit route (yank and deprecate through Release's
 * admin routes): normalisation and trailing-slash redirects, PEP 658 metadata, PEP 592 yank, the
 * inert HTML fallback and its `htmlFallback` switch, the §6.7 headers, and the one not-found.
 *
 * `UPDATE_PYPI_GOLDENS=1` rewrites the golden files under `test/fixtures/registry/pypi/`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { inertDocumentPolicy } from "../../src/core/bytesHost.js";
import {
  dispatchRegistryHost,
  REGISTRY_HOST_TYPES,
} from "../../src/core/registryHost.js";
import { issueStaticCiToken } from "../../src/core/publisher.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import { REGISTRY_ROUTES, SERVICES } from "../../src/mount.js";
import { RENDERERS } from "../../src/services/distribution/registry/index.js";
import {
  registryObjectKey,
  type RegistryPackage,
} from "../../src/services/distribution/registry/materialise.js";
import {
  indexHtml,
  indexJson,
  normalizeProjectName,
  projectHtml,
  projectJson,
  renderPypi,
  uploadTime,
} from "../../src/services/distribution/registry/pypi/render.js";
import {
  PYPI_DOCUMENT_CSP,
  fileIn,
  negotiateSimple,
} from "../../src/services/distribution/registry/pypi/routes.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";
import { manifestDeliverableStatements } from "../../src/services/release/deliverables.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { asR2, installDigestStream, R2Mock } from "../r2Mock.js";
import {
  admin,
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "../releaseRoutesFixture.js";
import { NOW } from "../seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(here, "..", "fixtures", "registry", "pypi");

function golden(name: string, body: string): void {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_PYPI_GOLDENS === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, body);
  }
  expect(body).toBe(readFileSync(file, "utf8"));
}

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

/** Markup a browser could act on: none of it may appear in an HTML form. */
const ACTIVE_MARKUP =
  /<\s*(script|form|style|iframe|object|embed|base|img|svg|link|meta\s+http-equiv)|\son[a-z]+\s*=|javascript:/i;

// ── The documents ────────────────────────────────────────────────────────────────────────────

/** The golden fixture: a deprecated, a yanked (with a hostile reason), a stable and a beta. */
function fixture(): RegistryPackage {
  const file = (name: string, type: string, seed: string, size: number) => ({
    name,
    type,
    sha256: sha(seed),
    size,
  });
  return {
    product: "acme",
    ecosystem: "pypi",
    deliverableId: "pypi.sdk",
    name: "Acme_SDK",
    nameNorm: "acme-sdk",
    versions: [
      {
        version: "0.8.0",
        state: "deprecated",
        stateMessage: "use 1.x",
        files: [file("acme_sdk-0.8.0.tar.gz", "sdist", "s080", 800)],
        metadata: { name: "Acme_SDK", version: "0.8.0" },
        publishedAt: NOW,
      },
      {
        version: "0.9.0",
        state: "yanked",
        stateMessage: `broken <build> & "quotes"`,
        files: [
          file("acme_sdk-0.9.0-py3-none-any.whl", "wheel", "w090", 900),
          file(
            "acme_sdk-0.9.0-py3-none-any.whl.metadata",
            "core-metadata",
            "m090",
            90,
          ),
        ],
        metadata: {
          name: "Acme_SDK",
          version: "0.9.0",
          requiresPython: ">=3.8",
        },
        publishedAt: NOW + 60,
      },
      {
        version: "1.0.0",
        state: "live",
        stateMessage: null,
        files: [
          file("acme_sdk-1.0.0.tar.gz", "sdist", "s100", 1000),
          file("acme_sdk-1.0.0-py3-none-any.whl", "wheel", "w100", 1100),
          file(
            "acme_sdk-1.0.0-py3-none-any.whl.metadata",
            "core-metadata",
            "m100",
            110,
          ),
        ],
        metadata: {
          name: "Acme_SDK",
          version: "1.0.0",
          requiresPython: ">=3.9,<4",
          summary: "The Acme SDK",
        },
        publishedAt: NOW + 120,
      },
      {
        version: "1.1.0b1",
        state: "live",
        stateMessage: null,
        files: [
          file("acme_sdk-1.1.0b1-py3-none-any.whl", "wheel", "w110b1", 1200),
        ],
        metadata: { name: "Acme_SDK", version: "1.1.0b1" },
        publishedAt: NOW + 180,
      },
    ],
    tags: {},
  };
}

describe("the PyPI documents (golden files)", () => {
  it("the PEP 691 JSON project page (API 1.1)", () => {
    const body = projectJson(fixture());
    golden("project.json", `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
    const doc = JSON.parse(body);
    expect(doc.meta).toEqual({ "api-version": "1.1" });
    expect(doc.name).toBe("acme-sdk");
    expect(doc.versions).toEqual(["0.8.0", "0.9.0", "1.0.0", "1.1.0b1"]);
    // No core-metadata file is ever listed as a file of its own.
    expect(
      doc.files.map((f: { filename: string }) => f.filename),
    ).not.toContainEqual(expect.stringMatching(/\.metadata$/));
    const yanked = doc.files.find((f: { filename: string }) =>
      f.filename.startsWith("acme_sdk-0.9.0"),
    );
    expect(yanked.yanked).toBe(`broken <build> & "quotes"`);
    expect(yanked["core-metadata"]).toEqual({ sha256: sha("m090") });
    expect(yanked).not.toHaveProperty("dist-info-metadata");
    // Deprecated has no PyPI equivalent: listed as live.
    expect(
      doc.files.find((f: { filename: string }) =>
        f.filename.startsWith("acme_sdk-0.8.0"),
      ).yanked,
    ).toBe(false);
  });

  it("the PEP 503 HTML project page escapes every value and carries no active markup", () => {
    const body = projectHtml(fixture());
    golden("project.html", body);
    expect(body).not.toMatch(ACTIVE_MARKUP);
    expect(body).toContain(
      'data-yanked="broken &lt;build&gt; &amp; &quot;quotes&quot;"',
    );
    expect(body).toContain('data-requires-python="&gt;=3.9,&lt;4"');
    expect(body).not.toContain("data-dist-info-metadata");
  });

  it("the project list in both forms", () => {
    const projects = [
      { name: "Acme_SDK", nameNorm: "acme-sdk" },
      { name: "acme-sdk-tools", nameNorm: "acme-sdk-tools" },
      { name: "a<b", nameNorm: "a<b" },
    ];
    golden(
      "index.json",
      `${JSON.stringify(JSON.parse(indexJson(projects)), null, 2)}\n`,
    );
    const html = indexHtml(projects);
    golden("index.html", html);
    expect(html).not.toMatch(ACTIVE_MARKUP);
    expect(html).toContain('<a href="a&lt;b/">a&lt;b</a>');
  });

  it("renders each project page in both forms under its normalised name", () => {
    const objects = renderPypi(fixture());
    expect(objects.map((o) => [o.key, o.contentType])).toEqual([
      ["simple/acme-sdk/index.json", "application/vnd.pypi.simple.v1+json"],
      ["simple/acme-sdk/index.html", "application/vnd.pypi.simple.v1+html"],
    ]);
    expect(RENDERERS.get("pypi")?.ecosystem).toBe("pypi");
  });

  it("normalises names per PEP 503 and writes PEP 700 upload times", () => {
    for (const [name, norm] of [
      ["Acme_SDK", "acme-sdk"],
      ["acme.sdk", "acme-sdk"],
      ["ACME--_.sdk", "acme-sdk"],
      ["polaris-key", "polaris-key"],
    ])
      expect(normalizeProjectName(name!)).toBe(norm);
    expect(uploadTime(NOW)).toBe("2023-11-14T22:13:20.000000Z");
  });

  it("finds a file, and a wheel's metadata, only by name and hash together", () => {
    const pkg = fixture();
    const w = pkg.versions[2]!.files[1]!;
    expect(fileIn(pkg, w.sha256, w.name)?.file.name).toBe(w.name);
    expect(fileIn(pkg, w.sha256, `${w.name}.metadata`)?.file.sha256).toBe(
      sha("m100"),
    );
    expect(fileIn(pkg, sha("m100"), `${w.name}.metadata`)).toBeNull();
    expect(fileIn(pkg, w.sha256, "acme_sdk-1.0.0.tar.gz")).toBeNull();
    // An sdist has no PEP 658 metadata here.
    const s = pkg.versions[2]!.files[0]!;
    expect(fileIn(pkg, s.sha256, `${s.name}.metadata`)).toBeNull();
  });
});

describe("PEP 691 negotiation", () => {
  const PIP =
    "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01";
  const UV =
    "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html;q=0.2, text/html;q=0.01";
  it.each([
    [PIP, true, "json"],
    [UV, true, "json"],
    ["application/vnd.pypi.simple.latest+json", true, "json"],
    ["text/html", true, "html"],
    ["application/vnd.pypi.simple.v1+html", true, "html"],
    ["application/json", true, "html"],
    ["*/*", true, "html"],
    [null, true, "html"],
    ["application/vnd.pypi.simple.v1+json;q=0, text/html", true, "html"],
    // htmlFallback off: a wildcard (or no Accept) still admits JSON; HTML-only clients get 406.
    ["text/html", false, "not-acceptable"],
    ["application/json", false, "not-acceptable"],
    ["*/*", false, "json"],
    [null, false, "json"],
    [PIP, false, "json"],
  ] as const)("%s (htmlFallback %s) → %s", (accept, fallback, want) => {
    expect(negotiateSimple(accept, fallback)).toBe(want);
  });

  it("the HTML policy is one the host admits as inert", () => {
    expect(inertDocumentPolicy(PYPI_DOCUMENT_CSP)).toBe(true);
    // The HTML type stays OFF the host's allowlist: only the inert-document rule admits it.
    expect(REGISTRY_HOST_TYPES.has("application/vnd.pypi.simple.v1+html")).toBe(
      false,
    );
  });
});

// ── The routes, through the real dispatcher ──────────────────────────────────────────────────

installDigestStream();

const PKG = "https://pkg.example.test";
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });
const JSON_ACCEPT =
  "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01";

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        artifacts: [
          {
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            match: "djdl-*-web.zip",
          },
        ],
      },
      "pypi.sdk": {
        kind: "package",
        ecosystem: "pypi",
        name: "Acme_SDK",
        artifacts: {
          wheel: { match: "*.whl" },
          sdist: { match: "*.tar.gz" },
        },
      },
      "pypi.tools": {
        kind: "package",
        ecosystem: "pypi",
        name: "acme-sdk-tools",
        artifacts: { wheel: { match: "*.whl" } },
      },
    },
  },
};

function declaration() {
  const res = parseManifest({
    product: JSON.stringify({ slug: SLUG, name: "djdl" }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!;
}

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;

async function setFeed(
  over: { enabled?: number; mode?: string; ext?: Record<string, unknown> } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, 'pypi', ?, ?, ?, 52428800, ?, ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET enabled = excluded.enabled,
       access_mode = excluded.access_mode, ext_json = excluded.ext_json`,
    SLUG,
    over.enabled ?? 1,
    over.mode ?? "public",
    JSON.stringify({ prefixes: ["acme-sdk"] }),
    JSON.stringify(over.ext ?? {}),
    NOW,
  );
  forgetRegistrySettings();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  forgetRegistrySettings();
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  env.PKG_ORIGIN = PKG;
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db);
  const rel = declaration();
  await db.batch(
    manifestDeliverableStatements(
      SLUG,
      rel.app,
      NOW,
      rel.packDeliverables,
      rel.packageDeliverables,
    ),
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    SLUG,
    NOW,
  );
  await setFeed();
  token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { caches?: unknown }).caches;
});

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/publish/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

interface Fixture {
  name: string;
  type: "wheel" | "sdist" | "core-metadata";
  bytes: Uint8Array;
}

const enc = (s: string) => new TextEncoder().encode(s);

function wheelFiles(project: string, version: string): Fixture[] {
  const base = `${project.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
  return [
    { name: base, type: "wheel", bytes: enc(`wheel ${project} ${version}`) },
    {
      name: `${base}.metadata`,
      type: "core-metadata",
      bytes: enc(
        `Metadata-Version: 2.1\nName: ${project}\nVersion: ${version}\nRequires-Python: >=3.9\n`,
      ),
    },
  ];
}

/** Stage the files through an upload ticket, then submit the descriptor. */
async function publish(
  deliverable: string,
  name: string,
  version: string,
  files: Fixture[],
  channel = "stable",
) {
  const up = await post("uploads", {
    objects: files.map((f) => ({ sha256: sha(f.bytes), size: f.bytes.length })),
  });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { ticket: string; prefix: string };
  for (const f of files)
    r2.seed(`${u.prefix}${sha(f.bytes)}`, f.bytes, { withSha256: true });
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable,
    kind: "package",
    version,
    channel,
    package: {
      ecosystem: "pypi",
      name,
      files: files.map((f) => ({
        name: f.name,
        role: "payload",
        type: f.type,
        sha256: sha(f.bytes),
        size: f.bytes.length,
        locations: [{ provider: "r2", key: `blobs/sha256/${sha(f.bytes)}` }],
      })),
      metadata: { name, version, requiresPython: ">=3.9" },
    },
  };
  const res = await post("submit", { ticket: u.ticket, descriptor });
  const body = await res.text();
  expect(res.status, body).toBe(200);
}

const SDIST_100: Fixture = {
  name: "acme_sdk-1.0.0.tar.gz",
  type: "sdist",
  bytes: enc("sdist acme-sdk 1.0.0"),
};

/** The fixture of the brief: a deprecated, a yanked, a stable and a beta version. */
async function publishAll(): Promise<void> {
  await publish(
    "pypi.sdk",
    "Acme_SDK",
    "0.8.0",
    wheelFiles("acme-sdk", "0.8.0"),
  );
  await publish(
    "pypi.sdk",
    "Acme_SDK",
    "0.9.0",
    wheelFiles("acme-sdk", "0.9.0"),
  );
  await publish("pypi.sdk", "Acme_SDK", "1.0.0", [
    ...wheelFiles("acme-sdk", "1.0.0"),
    SDIST_100,
  ]);
  await publish(
    "pypi.sdk",
    "Acme_SDK",
    "1.1.0b1",
    wheelFiles("acme-sdk", "1.1.0b1"),
    "beta",
  );
  await publish(
    "pypi.tools",
    "acme-sdk-tools",
    "0.1.0",
    wheelFiles("acme-sdk-tools", "0.1.0"),
  );
  const rel = (id: string) => `/releases/${encodeURIComponent(id)}`;
  expect(
    (
      await admin(env, db, "POST", `${rel("pypi.sdk@0.9.0")}/yank`, {
        reason: "broken build",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await admin(env, db, "POST", `${rel("pypi.sdk@0.8.0")}/deprecate`, {
        message: "use 1.x",
      })
    ).status,
  ).toBe(200);
}

function get(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, { method, headers }),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
  );
}

/** The hardening every registry-host answer carries (§6.1). */
function expectHardened(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.has("set-cookie")).toBe(false);
}

const PAGE = `/pypi/${SLUG}/simple/acme-sdk/`;

describe("the PyPI routes (F-05)", () => {
  it("serves the PEP 691 JSON page with the exact type, the index headers and Vary: Accept", async () => {
    await publishAll();
    const res = await get(PAGE, { accept: JSON_ACCEPT });
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.pypi.simple.v1+json",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=60",
    );
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    const body = await res.text();
    expect(res.headers.get("etag")).toBe(`"${sha(body)}"`);
    const doc = JSON.parse(body);
    expect(doc.meta).toEqual({ "api-version": "1.1" });
    expect(doc.name).toBe("acme-sdk");
    expect(doc.versions).toEqual(["0.8.0", "0.9.0", "1.0.0", "1.1.0b1"]);
    const byName = Object.fromEntries(
      doc.files.map((f: { filename: string }) => [f.filename, f]),
    );
    const w100 = byName["acme_sdk-1.0.0-py3-none-any.whl"];
    const [wheel, meta] = wheelFiles("acme-sdk", "1.0.0");
    expect(w100).toEqual({
      filename: "acme_sdk-1.0.0-py3-none-any.whl",
      url: `../../files/${sha(wheel!.bytes)}/acme_sdk-1.0.0-py3-none-any.whl`,
      hashes: { sha256: sha(wheel!.bytes) },
      "requires-python": ">=3.9",
      "core-metadata": { sha256: sha(meta!.bytes) },
      yanked: false,
      size: wheel!.bytes.length,
      "upload-time": uploadTime(NOW),
    });
    expect(byName["acme_sdk-1.0.0.tar.gz"]).not.toHaveProperty("core-metadata");
    // PEP 592: the yanked version stays listed with its reason; deprecate is live on PyPI.
    expect(byName["acme_sdk-0.9.0-py3-none-any.whl"].yanked).toBe(
      "broken build",
    );
    expect(byName["acme_sdk-0.8.0-py3-none-any.whl"].yanked).toBe(false);
    // Nothing of the other project leaks in.
    expect(Object.keys(byName).some((n) => n.includes("tools"))).toBe(false);
  });

  it("serves the inert HTML page only when Accept lacks the JSON type", async () => {
    await publishAll();
    const res = await get(PAGE, { accept: "text/html" });
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.pypi.simple.v1+html",
    );
    expect(res.headers.get("content-security-policy")).toBe(PYPI_DOCUMENT_CSP);
    expect(res.headers.has("content-disposition")).toBe(false);
    expect(res.headers.get("vary")).toBe("Accept");
    const body = await res.text();
    expect(body).not.toMatch(ACTIVE_MARKUP);
    expect(body).toContain('data-yanked="broken build"');
    expect(body).toMatch(
      /<a href="\.\.\/\.\.\/files\/[0-9a-f]{64}\/acme_sdk-1\.0\.0-py3-none-any\.whl#sha256=[0-9a-f]{64}" data-requires-python="&gt;=3\.9" data-core-metadata="sha256=[0-9a-f]{64}">/,
    );
  });

  it("htmlFallback off: an HTML-only client gets 406, a wildcard gets JSON", async () => {
    await publishAll();
    await setFeed({ ext: { htmlFallback: false } });
    const refused = await get(PAGE, { accept: "text/html" });
    expect(refused.status).toBe(406);
    expectHardened(refused);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toMatchObject({ error: "bad_request" });
    const any = await get(PAGE, { accept: "*/*" });
    expect(any.status).toBe(200);
    expect(any.headers.get("content-type")).toBe(
      "application/vnd.pypi.simple.v1+json",
    );
    expect((await get(PAGE, { accept: JSON_ACCEPT })).status).toBe(200);
  });

  it("redirects to the PEP 503 normalised name with its trailing slash (301)", async () => {
    await publishAll();
    for (const path of [
      `/pypi/${SLUG}/simple/Acme_SDK/`,
      `/pypi/${SLUG}/simple/Acme_SDK`,
      `/pypi/${SLUG}/simple/acme.sdk/`,
      `/pypi/${SLUG}/simple/acme-sdk`,
    ]) {
      const res = await get(path, { accept: JSON_ACCEPT });
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(PAGE);
      expectHardened(res);
    }
    const list = await get(`/pypi/${SLUG}/simple`);
    expect(list.status).toBe(301);
    expect(list.headers.get("location")).toBe(`/pypi/${SLUG}/simple/`);
  });

  it("lists every published project in both forms", async () => {
    await publishAll();
    const json = await get(`/pypi/${SLUG}/simple/`, { accept: JSON_ACCEPT });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toBe(
      "application/vnd.pypi.simple.v1+json",
    );
    expect(await json.json()).toEqual({
      meta: { "api-version": "1.1" },
      projects: [{ name: "Acme_SDK" }, { name: "acme-sdk-tools" }],
    });
    const html = await get(`/pypi/${SLUG}/simple/`, { accept: "text/html" });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBe(PYPI_DOCUMENT_CSP);
    const body = await html.text();
    expect(body).toContain('<a href="acme-sdk/">Acme_SDK</a>');
    expect(body).not.toMatch(ACTIVE_MARKUP);
  });

  it("omits a project whose delivery access is stricter than the list's", async () => {
    await publishAll();
    await db.run(
      `INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, 'pypi.tools', 'licensed', 'admin', ?)`,
      SLUG,
      NOW,
    );
    forgetRegistrySettings();
    const json = await get(`/pypi/${SLUG}/simple/`, { accept: JSON_ACCEPT });
    expect(((await json.json()) as any).projects).toEqual([
      { name: "Acme_SDK" },
    ]);
    const page = await get(`/pypi/${SLUG}/simple/acme-sdk-tools/`, {
      accept: JSON_ACCEPT,
    });
    expect(page.status).toBe(401);
    expect(page.headers.get("www-authenticate")).toBe(
      'Basic realm="pkg.example.test"',
    );
  });

  it("serves files and PEP 658 metadata under files/<sha256>/, immutable, verified", async () => {
    await publishAll();
    const [wheel, meta] = wheelFiles("acme-sdk", "1.0.0");
    const url = `/pypi/${SLUG}/files/${sha(wheel!.bytes)}/${wheel!.name}`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(res.headers.get("cache-control")).toMatch(
      /^public, max-age=31536000, immutable/,
    );
    expect(res.headers.get("etag")).toBe(`"${sha(wheel!.bytes)}"`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(wheel!.bytes);

    const m = await get(`${url}.metadata`);
    expect(m.status).toBe(200);
    expect(m.headers.get("etag")).toBe(`"${sha(meta!.bytes)}"`);
    expect(await m.text()).toBe(new TextDecoder().decode(meta!.bytes));

    // The other project's file resolves to its own deliverable (longest name first).
    const [tw] = wheelFiles("acme-sdk-tools", "0.1.0");
    expect(
      (await get(`/pypi/${SLUG}/files/${sha(tw!.bytes)}/${tw!.name}`)).status,
    ).toBe(200);
    // A yanked version's files stay fetchable (an exact pin still installs, PEP 592).
    const [y] = wheelFiles("acme-sdk", "0.9.0");
    expect(
      (await get(`/pypi/${SLUG}/files/${sha(y!.bytes)}/${y!.name}`)).status,
    ).toBe(200);
    // HEAD has no body.
    const head = await get(url, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers the one not-found for a wrong hash, a name it does not list, an sdist's metadata", async () => {
    await publishAll();
    const [wheel] = wheelFiles("acme-sdk", "1.0.0");
    for (const path of [
      `/pypi/${SLUG}/files/${"0".repeat(64)}/${wheel!.name}`,
      `/pypi/${SLUG}/files/${sha(wheel!.bytes)}/acme_sdk-1.0.0.tar.gz`,
      `/pypi/${SLUG}/files/${sha(SDIST_100.bytes)}/${SDIST_100.name}.metadata`,
      `/pypi/${SLUG}/files/${sha(wheel!.bytes)}/other-1.0.tar.gz`,
      `/pypi/${SLUG}/simple/nothing-here/`,
      `/pypi/${SLUG}/simple/%E0%A4%A/`,
      `/pypi/${SLUG}/simple/-bad-/`,
      `/pypi/nobody/simple/acme-sdk/`,
    ]) {
      const res = await get(path, { accept: JSON_ACCEPT });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.json(), path).toEqual({ error: "not_found" });
      expectHardened(res);
    }
  });

  it("a feed that is off answers the same not-found everywhere, redirects included", async () => {
    await publishAll();
    await setFeed({ enabled: 0 });
    const [wheel] = wheelFiles("acme-sdk", "1.0.0");
    for (const path of [
      PAGE,
      `/pypi/${SLUG}/simple/`,
      `/pypi/${SLUG}/simple/Acme_SDK`,
      `/pypi/${SLUG}/files/${sha(wheel!.bytes)}/${wheel!.name}`,
    ]) {
      const res = await get(path, { accept: "text/html" });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("a non-public feed answers the Basic challenge for known and unknown names alike, never cached", async () => {
    await publishAll();
    await setFeed({ mode: "authenticated" });
    for (const path of [PAGE, `/pypi/${SLUG}/simple/nothing-here/`]) {
      const res = await get(path, { accept: JSON_ACCEPT });
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Basic realm="pkg.example.test"',
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("If-None-Match answers 304; the page follows a yank at once, rendered and written back", async () => {
    await publishAll();
    const first = await get(PAGE, { accept: JSON_ACCEPT });
    const etag = first.headers.get("etag")!;
    // The page was written back under registry/pypi/<owner>/ with its render record.
    expect(
      r2.has(registryObjectKey("pypi", SLUG, "simple/acme-sdk/index.json")),
    ).toBe(true);
    const again = await get(PAGE, {
      accept: JSON_ACCEPT,
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    // A yank changes Release's state; the stored render is stale and is not served.
    const y = await admin(
      env,
      db,
      "POST",
      `/releases/${encodeURIComponent("pypi.sdk@1.0.0")}/yank`,
      { reason: "regression" },
    );
    expect(y.status).toBe(200);
    const after = await get(PAGE, { accept: JSON_ACCEPT });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const doc = (await after.json()) as any;
    expect(
      doc.files.find(
        (f: { filename: string }) =>
          f.filename === "acme_sdk-1.0.0-py3-none-any.whl",
      ).yanked,
    ).toBe("regression");
  });

  it("serves the stored render when it is current, and heals a lost one", async () => {
    await publishAll();
    await get(PAGE, { accept: JSON_ACCEPT });
    const key = registryObjectKey("pypi", SLUG, "simple/acme-sdk/index.json");
    // A marker in the stored object proves the answer comes from R2, not a fresh render.
    r2.tamper(key, enc('{"stored":true}'));
    const res = await get(PAGE, { accept: JSON_ACCEPT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true });
    // A lost object under a current render record is rendered again and written back.
    await asR2(r2).delete(key);
    const healed = await get(PAGE, { accept: JSON_ACCEPT });
    expect(healed.status).toBe(200);
    expect(((await healed.json()) as any).name).toBe("acme-sdk");
    expect(r2.has(key)).toBe(true);
  });

  it("only GET and HEAD; a cookie never reaches the route", async () => {
    await publishAll();
    const res = await dispatchRegistryHost(
      new Request(`${PKG}${PAGE}`, { method: "POST" }),
      env,
      db,
      REGISTRY_ROUTES,
      SERVICES,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const head = await get(PAGE, { accept: JSON_ACCEPT }, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("Release off for the owner reads as absent", async () => {
    await publishAll();
    await db.run(
      `UPDATE products SET services_json = json_set(services_json, '$.release.enabled', json('false')) WHERE slug = ?`,
      SLUG,
    );
    const res = await get(PAGE, { accept: JSON_ACCEPT });
    expect(res.status).toBe(404);
  });
});
