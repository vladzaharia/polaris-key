/**
 * Native-client publish (F-22): `npm publish`, `twine upload`, `swift package-registry publish`
 * and Maven/Gradle `PUT`s, end to end through the real registry host dispatcher over `mount.ts`'s
 * routes, into F-03's ingest, and back out through each feed's real read routes.
 *
 *   - PUBLISH TOKENS: the mint rules (owner-bound, named publish ecosystems, 1 to 30 days) and
 *     `authorizeRegistryPublish`'s ladder (401 / 403 / CI tokens);
 *   - each ADAPTER: the request its client sends (built here the way the client builds it), the
 *     release it becomes (pinned against golden files under `test/fixtures/registry/native/`,
 *     `UPDATE_NATIVE_GOLDENS=1` rewrites them), the feed serving it, and its refusals;
 *   - twine's and Maven's multi-request SESSIONS: the settle, the touch that holds it back, the
 *     metadata trigger, the cron sweep;
 *   - the bounded parsers (`multipart.ts`, `npmBody.ts`, `swiftArchive.ts`).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest, SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, seedLicenseWithKey } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import { envFor, seedReleaseProduct, SLUG } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { dispatchRegistryHost } from "../src/core/registryHost.js";
import { REGISTRY_ROUTES, SERVICES } from "../src/mount.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import {
  forgetRegistryTokens,
  mintRegistryToken,
  revokeRegistryToken,
} from "../src/core/registryTokens.js";
import { authorizeRegistryPublish } from "../src/core/registryPublish.js";
import {
  multipartBoundary,
  parseMultipart,
} from "../src/services/release/packages/native/multipart.js";
import { parseNpmPublishBody } from "../src/services/release/packages/native/npmBody.js";
import { swiftArchiveManifests } from "../src/services/release/packages/native/swiftArchive.js";
import {
  IDLE_FINALIZE_SECONDS,
  readSession,
  settleSession,
  sweepNativeSessions,
} from "../src/services/release/packages/native/sessions.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";

installDigestStream();

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(here, "fixtures", "registry", "native");
const PKG = "https://pkg.example.test";

function golden(name: string, value: unknown): void {
  const file = join(GOLDEN_DIR, name);
  // Token ids are random per run; the golden pins that one is recorded, not which.
  const text = `${JSON.stringify(value, null, 2)}\n`.replace(
    /"rtok_[A-Za-z0-9_-]+"/g,
    '"rtok_<id>"',
  );
  if (process.env.UPDATE_NATIVE_GOLDENS) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text).toBe(readFileSync(file, "utf8"));
}

const sha = (
  b: Uint8Array | string,
  alg = "sha256",
  enc: "hex" | "base64" = "hex",
) => createHash(alg).update(b).digest(enc);

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
      "npm.sdk": {
        kind: "package",
        ecosystem: "npm",
        name: "@acme/sdk",
        artifacts: { tarball: { match: "sdk-*.tgz" } },
      },
      "pypi.tools": {
        kind: "package",
        ecosystem: "pypi",
        name: "acme-tools",
        artifacts: { dist: { match: "*" } },
      },
      "swift.kit": {
        kind: "package",
        ecosystem: "swift",
        name: "acme.AcmeKit",
        artifacts: { archive: { match: "*.zip" } },
      },
      "maven.core": {
        kind: "package",
        ecosystem: "maven",
        name: "im.acme:core",
        artifacts: { files: { match: "*" } },
      },
    },
  },
};

let db: Db;
let env: Env;
let r2: R2Mock;
let publishToken: string;
let waits: Promise<unknown>[];

async function feed(eco: string, namespace: unknown, ext: unknown = {}) {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
       max_package_bytes, ext_json, updated_at) VALUES (?, ?, 1, ?, 52428800, ?, ?)`,
    SLUG,
    eco,
    JSON.stringify(namespace),
    JSON.stringify(ext),
    NOW,
  );
}

async function mint(
  over: Partial<Parameters<typeof mintRegistryToken>[2]> = {},
): Promise<string> {
  const res = await mintRegistryToken(
    env,
    db,
    {
      product: SLUG,
      label: "laptop",
      binding: "owner",
      scopes: ["publish"],
      ecosystems: ["npm", "pypi", "swift", "maven"],
      createdBy: "admin:test",
      ...over,
    },
    NOW,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.token;
}

function call(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, {
      method,
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
    { waitUntil: (p) => void waits.push(p) },
  );
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const basic = (t: string, user = "__token__") => ({
  authorization: `Basic ${btoa(`${user}:${t}`)}`,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  forgetRegistrySettings();
  forgetRegistryTokens();
  waits = [];
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  env.PKG_ORIGIN = PKG;
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  await seedReleaseProduct(db);
  const res = parseManifest({
    product: JSON.stringify({ slug: SLUG, name: "djdl" }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const rel = res.manifest.release!;
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
  await feed("npm", { scope: "@acme" });
  await feed("pypi", { names: ["acme-tools"] });
  await feed("swift", { scope: "acme" });
  await feed("maven", { groupPrefixes: ["im.acme"] });
  publishToken = await mint();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { caches?: unknown }).caches;
});

async function packageRow(eco: string, version: string) {
  const row = await db.first<Record<string, unknown>>(
    `SELECT ecosystem, name, version, deliverable_id, release_id, state, files_json,
            metadata_json, source_json FROM release_packages
      WHERE product = ? AND ecosystem = ? AND version = ?`,
    SLUG,
    eco,
    version,
  );
  if (!row) return null;
  return {
    ...row,
    files_json: JSON.parse(row.files_json as string),
    metadata_json: JSON.parse(row.metadata_json as string),
    source_json: JSON.parse(row.source_json as string),
  };
}

// ── Publish tokens ───────────────────────────────────────────────────────────────────────────

describe("publish tokens (F-22)", () => {
  async function m(over: Partial<Parameters<typeof mintRegistryToken>[2]>) {
    return mintRegistryToken(
      env,
      db,
      {
        product: SLUG,
        label: "x",
        binding: "owner",
        createdBy: "admin:t",
        scopes: ["publish"],
        ecosystems: ["npm"],
        ...over,
      },
      NOW,
    );
  }

  it("stores publish as publish + read, defaults to 7 days, at most 30", async () => {
    const ok = await m({});
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.view.scopes).toEqual(["publish", "read"]);
    expect(ok.view.expiresAt).toBe(NOW + 7 * 86_400);
    expect((await m({ expiresInDays: 30 })).ok).toBe(true);
    const long = await m({ expiresInDays: 31 });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fields).toContain("expiresInDays");
  });

  it("is owner-bound, header-presented and narrowed to named publish ecosystems", async () => {
    const all = await m({ ecosystems: null });
    expect(!all.ok && all.fields).toContain("ecosystems");
    const oci = await m({ ecosystems: ["oci"] });
    expect(!oci.ok && oci.fields).toContain("ecosystems");
    const godot = await m({ ecosystems: ["godot"] });
    expect(!godot.ok && godot.fields).toContain("ecosystems");
    const url = await m({ presentation: "url" });
    expect(url.ok).toBe(false);
    const licence = await seedLicenseWithKey(db, SLUG);
    const bound = await m({
      binding: "license",
      licenseId: licence.licenseId,
    });
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.reason).toBe("license_tokens_read_only");
  });

  it("authorizes owner publish tokens and CI tokens with release:publish; refuses the rest", async () => {
    const req = (h: Record<string, string>) =>
      new Request(`${PKG}/npm/${SLUG}/@acme%2fsdk`, {
        method: "PUT",
        headers: h,
      });
    const judge = (h: Record<string, string>, eco = "npm", owner = SLUG) =>
      authorizeRegistryPublish(env, db, req(h), {
        owner,
        ecosystem: eco,
        ip: "203.0.113.9",
      });
    expect((await judge({})).ok).toBe(false);
    expect(await judge({})).toEqual({ ok: false, refusal: "challenge" });
    const ok = await judge(bearer(publishToken));
    expect(ok.ok && ok.principal.kind).toBe("registry");
    expect((await judge(basic(publishToken), "pypi")).ok).toBe(true);
    // Another owner's view of the token: no credential at all.
    expect(await judge(bearer(publishToken), "npm", "globex")).toEqual({
      ok: false,
      refusal: "challenge",
    });
    const read = await mint({ scopes: ["read"], ecosystems: null });
    expect((await judge(bearer(read))).ok).toBe(false);
    expect(await judge(bearer(read))).toMatchObject({ refusal: "forbidden" });
    const npmOnly = await mint({ ecosystems: ["npm"] });
    expect(await judge(bearer(npmOnly), "maven")).toMatchObject({
      refusal: "forbidden",
    });
    const ci = (
      await issueStaticCiToken(env, db, {
        product: SLUG,
        scopes: ["release:publish"],
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
    const ciOk = await judge(bearer(ci));
    expect(ciOk.ok && ciOk.principal.kind).toBe("ci");
    const feedsOnly = (
      await issueStaticCiToken(env, db, {
        product: SLUG,
        scopes: ["distribution:feeds"],
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
    expect(await judge(bearer(feedsOnly))).toMatchObject({
      refusal: "forbidden",
    });
    const views = await db.all<{ token_id: string }>(
      "SELECT token_id FROM registry_tokens WHERE product = ? AND label = 'laptop' LIMIT 1",
      SLUG,
    );
    await revokeRegistryToken(
      db,
      SLUG,
      views[0]!.token_id,
      "admin:t",
      "manual",
      NOW,
    );
    forgetRegistryTokens();
    expect(await judge(bearer(publishToken))).toEqual({
      ok: false,
      refusal: "challenge",
    });
  });
});

describe("the platform's own SDK feeds (F-10: pipeline only)", () => {
  it("mints no publish token for the system product", async () => {
    const input = {
      product: SYSTEM_PRODUCT_SLUG,
      label: "x",
      binding: "owner" as const,
      createdBy: "admin:t",
    };
    const res = await mintRegistryToken(
      env,
      db,
      { ...input, scopes: ["publish"], ecosystems: ["npm"] },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("system_feeds_pipeline_only");
      expect(res.fields).toEqual(["scopes"]);
    }
  });

  it("refuses every native publish to the system product, whatever the credential", async () => {
    for (const eco of ["npm", "pypi", "swift", "maven"]) {
      const res = await authorizeRegistryPublish(
        env,
        db,
        new Request(`${PKG}/npm/${SYSTEM_PRODUCT_SLUG}/x`, {
          method: "PUT",
          headers: bearer(publishToken),
        }),
        { owner: SYSTEM_PRODUCT_SLUG, ecosystem: eco, ip: "203.0.113.9" },
      );
      expect(res).toMatchObject({ ok: false, refusal: "forbidden" });
      if (!res.ok) expect(res.reason).toMatch(/deploy pipeline only/);
    }
  });
});

// ── npm ──────────────────────────────────────────────────────────────────────────────────────

/** libnpmpublish's document for one version (what npm, pnpm, Yarn and Bun send). */
function npmPublishBody(
  version: string,
  tarball: Uint8Array,
  opts: { tag?: string; tamper?: boolean; name?: string } = {},
): string {
  const name = opts.name ?? "@acme/sdk";
  const integrity = `sha512-${sha(opts.tamper ? new Uint8Array([1]) : tarball, "sha512", "base64")}`;
  return JSON.stringify({
    _id: name,
    name,
    description: "The Acme SDK",
    "dist-tags": { [opts.tag ?? "latest"]: version },
    versions: {
      [version]: {
        name,
        version,
        description: "The Acme SDK",
        main: "index.js",
        license: "MIT",
        dependencies: { lodash: "^4.17.21" },
        scripts: { test: "never stored" },
        _id: `${name}@${version}`,
        dist: {
          integrity,
          shasum: sha(tarball, "sha1"),
          tarball: `http://localhost/${name}/-/sdk-${version}.tgz`,
        },
      },
    },
    access: null,
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: "application/octet-stream",
        data: Buffer.from(tarball).toString("base64"),
        length: tarball.length,
      },
    },
  });
}

const tgz = (v: string, size = 256) => {
  const out = new Uint8Array(size);
  const seed = new TextEncoder().encode(`npm pack output of @acme/sdk ${v}`);
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length]! ^ (i & 0xff);
  return out;
};

describe("npm publish (PUT /npm/<owner>/<name>)", () => {
  const put = (
    body: string,
    headers: Record<string, string> = bearer(publishToken),
    path = `/npm/${SLUG}/@acme%2fsdk`,
  ) =>
    call("PUT", path, {
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("publishes a version the packument and tarball routes then serve", async () => {
    const tarball = tgz("1.0.0");
    const res = await put(npmPublishBody("1.0.0", tarball));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, id: "@acme/sdk" });
    const row = await packageRow("npm", "1.0.0");
    golden("npm.release.json", row);
    expect(row!.metadata_json).not.toHaveProperty("scripts");
    const doc = (await (
      await call("GET", `/npm/${SLUG}/@acme%2fsdk`, {
        headers: { accept: "application/json" },
      })
    ).json()) as Record<string, any>;
    expect(doc["dist-tags"].latest).toBe("1.0.0");
    const v = doc.versions["1.0.0"];
    expect(v.dist.integrity).toBe(`sha512-${sha(tarball, "sha512", "base64")}`);
    expect(v.dist.shasum).toBe(sha(tarball, "sha1"));
    const bytes = new Uint8Array(
      await (await call("GET", new URL(v.dist.tarball).pathname)).arrayBuffer(),
    );
    expect(sha(bytes)).toBe(sha(tarball));
    // Audited, and the staged copy is gone.
    const audit = await db.first<{ summary: string; actor_sub: string }>(
      "SELECT summary, actor_sub FROM audit WHERE product = ? AND action = 'release.publish'",
      SLUG,
    );
    expect(audit?.summary).toMatch(
      /through npm publish with registry token rtok_/,
    );
    expect(audit?.actor_sub).toMatch(/^registry-token:rtok_/);
    expect([...r2.keys()].some((k) => k.startsWith("staging/"))).toBe(false);
  });

  it("takes the unescaped path, a dist-tag as the channel, and a large tarball without materialising it", async () => {
    const big = tgz("2.0.0-beta.1", 200_000);
    const res = await put(
      npmPublishBody("2.0.0-beta.1", big, { tag: "beta" }),
      bearer(publishToken),
      `/npm/${SLUG}/@acme/sdk`,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const doc = (await (
      await call("GET", `/npm/${SLUG}/@acme%2fsdk`, {
        headers: { accept: "application/json" },
      })
    ).json()) as Record<string, any>;
    expect(doc["dist-tags"]).toEqual({ beta: "2.0.0-beta.1" });
  });

  it("refuses a tarball that does not match dist.integrity, and a republish with other bytes", async () => {
    const bad = await put(
      npmPublishBody("1.0.0", tgz("1.0.0"), { tamper: true }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ reason: "integrity-mismatch" });
    expect(await packageRow("npm", "1.0.0")).toBeNull();
    expect((await put(npmPublishBody("1.0.0", tgz("1.0.0")))).status).toBe(201);
    // The same publish again is the same release (npm retries); other bytes never are.
    expect((await put(npmPublishBody("1.0.0", tgz("1.0.0")))).status).toBe(200);
    const again = await put(npmPublishBody("1.0.0", tgz("x")));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: "release_exists",
      reason: "package-version-taken",
    });
  });

  it("answers the challenge, 403 for a read token, the not-found for an off feed, and refuses undeclared names and other operations", async () => {
    const body = npmPublishBody("1.0.0", tgz("1.0.0"));
    const anon = await put(body, {});
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(
      'Basic realm="pkg.example.test"',
    );
    const read = await mint({ scopes: ["read"], ecosystems: null });
    expect((await put(body, bearer(read))).status).toBe(403);
    const undeclared = await put(
      npmPublishBody("1.0.0", tgz("1.0.0"), { name: "@acme/other" }),
      bearer(publishToken),
      `/npm/${SLUG}/@acme%2fother`,
    );
    expect(undeclared.status).toBe(403);
    expect(await undeclared.json()).toMatchObject({
      reason: "package-undeclared",
    });
    const deprecate = await put(
      JSON.stringify({ _id: "@acme/sdk", name: "@acme/sdk", versions: {} }),
    );
    expect(deprecate.status).toBe(400);
    expect(await deprecate.json()).toMatchObject({
      reason: "npm-unsupported-operation",
    });
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE ecosystem = 'npm'",
    );
    forgetRegistrySettings();
    const off = await put(body);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "not_found" });
  });

  it("publishes with the owner's CI token (release:publish), recording the CI source", async () => {
    const ci = (
      await issueStaticCiToken(env, db, {
        product: SLUG,
        scopes: ["release:publish"],
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
    expect(
      (await put(npmPublishBody("1.0.0", tgz("1.0.0")), bearer(ci))).status,
    ).toBe(201);
    expect((await packageRow("npm", "1.0.0"))!.source_json).toMatchObject({
      kind: "static",
      client: "npm",
    });
  });
});

// ── twine ────────────────────────────────────────────────────────────────────────────────────

/** twine's legacy upload form for one file. */
function twineForm(
  filename: string,
  bytes: Uint8Array,
  fields: Record<string, string> = {},
): { body: Uint8Array; contentType: string } {
  const boundary = "----twineBoundary7MA4YWxkTrZu0gW";
  const all: Record<string, string> = {
    ":action": "file_upload",
    protocol_version: "1",
    metadata_version: "2.1",
    name: "acme-tools",
    version: "1.0.0",
    filetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
    pyversion: filename.endsWith(".whl") ? "py3" : "source",
    summary: "Acme tools",
    requires_python: ">=3.9",
    license: "MIT",
    sha256_digest: sha(bytes),
    md5_digest: sha(bytes, "md5"),
    ...fields,
  };
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(all))
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const body = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("twine upload (POST /pypi/<owner>/legacy/)", () => {
  const upload = (
    filename: string,
    bytes: Uint8Array,
    fields: Record<string, string> = {},
    headers: Record<string, string> = basic(publishToken),
  ) => {
    const f = twineForm(filename, bytes, fields);
    return call("POST", `/pypi/${SLUG}/legacy/`, {
      headers: { "content-type": f.contentType, ...headers },
      body: f.body,
    });
  };
  const sdist = new TextEncoder().encode("sdist bytes of acme-tools 1.0.0");
  const wheel = new TextEncoder().encode("wheel bytes of acme_tools 1.0.0");
  const key = {
    product: SLUG,
    ecosystem: "pypi" as const,
    nameNorm: "acme-tools",
    version: "1.0.0",
  };

  async function settleNow(): Promise<void> {
    const product = (await loadProductPublic(db, SLUG))!;
    const s = (await readSession(db, key))!;
    await settleSession(
      {
        env,
        db,
        product,
        now: NOW,
        hooks: buildHooks(SERVICES, product.services, {
          env,
          db,
          product,
          now: NOW,
        }),
      },
      key,
      s.touchSeq,
      0,
    );
  }

  it("gathers a version's files and publishes them as one release once the uploads settle", async () => {
    const a = await upload("acme_tools-1.0.0.tar.gz", sdist);
    expect(a.status, await a.clone().text()).toBe(200);
    const b = await upload("acme_tools-1.0.0-py3-none-any.whl", wheel);
    expect(b.status, await b.clone().text()).toBe(200);
    // A settle per upload is pending (each in the request's waitUntil, beside the token's
    // last-used write).
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(await packageRow("pypi", "1.0.0")).toBeNull();
    await settleNow();
    const row = await packageRow("pypi", "1.0.0");
    golden("pypi.release.json", row);
    expect(row!.files_json.map((f: { type: string }) => f.type).sort()).toEqual(
      ["sdist", "wheel"],
    );
    expect((await readSession(db, key))!.state).toBe("published");
    const page = (await (
      await call("GET", `/pypi/${SLUG}/simple/acme-tools/`, {
        headers: { accept: "application/vnd.pypi.simple.v1+json" },
      })
    ).json()) as { files: { filename: string }[] };
    expect(page.files.map((f) => f.filename).sort()).toEqual([
      "acme_tools-1.0.0-py3-none-any.whl",
      "acme_tools-1.0.0.tar.gz",
    ]);
  });

  it("a settle stands down when another upload of the same token began after it", async () => {
    await upload("acme_tools-1.0.0.tar.gz", sdist);
    const product = (await loadProductPublic(db, SLUG))!;
    const stale = (await readSession(db, key))!.touchSeq;
    await upload("acme_tools-1.0.0-py3-none-any.whl", wheel);
    await settleSession(
      {
        env,
        db,
        product,
        now: NOW,
        hooks: buildHooks(SERVICES, product.services, {
          env,
          db,
          product,
          now: NOW,
        }),
      },
      key,
      stale,
      0,
    );
    expect((await readSession(db, key))!.state).toBe("open");
    await settleNow();
    expect((await readSession(db, key))!.state).toBe("published");
  });

  it("the cron publishes an idle session, and refuses nothing it has not checked", async () => {
    await upload("acme_tools-1.0.0.tar.gz", sdist);
    const product = (await loadProductPublic(db, SLUG))!;
    const later = NOW + IDLE_FINALIZE_SECONDS + 1;
    const out = await sweepNativeSessions({
      env,
      db,
      product,
      now: later,
      hooks: buildHooks(SERVICES, product.services, {
        env,
        db,
        product,
        now: later,
      }),
    });
    expect(out.published).toBe(1);
    expect(await packageRow("pypi", "1.0.0")).not.toBeNull();
  });

  it("refuses a digest mismatch, a file of another project, an undeclared project and a second token mid-upload", async () => {
    const mismatch = await upload("acme_tools-1.0.0.tar.gz", sdist, {
      sha256_digest: "0".repeat(64),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      reason: "integrity-mismatch",
    });
    const other = await upload("other-1.0.0.tar.gz", sdist);
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ reason: "pypi-file-name" });
    const undeclared = await upload("ghost-1.0.0.tar.gz", sdist, {
      name: "ghost",
    });
    expect(undeclared.status).toBe(403);
    expect((await upload("acme_tools-1.0.0.tar.gz", sdist)).status).toBe(200);
    const second = await mint({ ecosystems: ["pypi"] });
    const clash = await upload(
      "acme_tools-1.0.0-py3-none-any.whl",
      wheel,
      {},
      basic(second),
    );
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ reason: "upload-in-progress" });
  });
});

// ── SwiftPM ──────────────────────────────────────────────────────────────────────────────────

/** A zip with each entry deflated (or stored), under `dir/` (what `archive-source` builds). */
function zip(
  entries: Record<string, string>,
  opts: { dir?: string; store?: boolean; badCrc?: boolean } = {},
): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [n, text] of Object.entries(entries)) {
    const name = enc.encode(`${opts.dir ?? "AcmeKit"}/${n}`);
    const raw = enc.encode(text);
    const data = opts.store ? raw : deflateRawSync(raw);
    const crc = opts.badCrc ? 0 : crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(opts.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(opts.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const MANIFEST =
  '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "AcmeKit")\n';
const MANIFEST_510 =
  '// swift-tools-version:5.10\nimport PackageDescription\nlet package = Package(name: "AcmeKit")\n';

/** SwiftPM's publish form. */
function swiftForm(archive: Uint8Array, signature?: Uint8Array) {
  const boundary = "swiftpm-publish-boundary";
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="source-archive"\r\nContent-Type: application/zip\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
    ),
    archive,
    enc.encode("\r\n"),
  ];
  if (signature)
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="source-archive-signature"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      signature,
      enc.encode("\r\n"),
    );
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"description":"Acme"}\r\n--${boundary}--\r\n`,
    ),
  );
  return {
    body: new Uint8Array(Buffer.concat(parts)),
    contentType: `multipart/form-data;boundary="${boundary}"`,
  };
}

describe("swift package-registry publish (PUT /swift/<owner>/<scope>/<name>/<version>)", () => {
  const archive = zip({
    "Package.swift": MANIFEST,
    "Package@swift-5.10.swift": MANIFEST_510,
    "Sources/AcmeKit/Kit.swift": "public struct Kit {}\n",
  });
  const signature = new TextEncoder().encode("CMS signature bytes");
  const publish = (
    a: Uint8Array,
    sig: Uint8Array | undefined,
    version = "1.0.0",
    headers: Record<string, string> = bearer(publishToken),
  ) => {
    const f = swiftForm(a, sig);
    return call("PUT", `/swift/${SLUG}/acme/AcmeKit/${version}`, {
      headers: {
        accept: "application/vnd.swift.registry.v1+json",
        "content-type": f.contentType,
        ...(sig ? { "x-swift-package-signature-format": "cms-1.0.0" } : {}),
        ...headers,
      },
      body: f.body,
    });
  };

  it("publishes a signed release whose manifests come out of the archive", async () => {
    const res = await publish(archive, signature);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("location")).toBe(
      `${PKG}/swift/${SLUG}/acme/AcmeKit/1.0.0`,
    );
    golden("swift.release.json", await packageRow("swift", "1.0.0"));
    const manifest = await call(
      "GET",
      `/swift/${SLUG}/acme/AcmeKit/1.0.0/Package.swift`,
      { headers: { accept: "application/vnd.swift.registry.v1+swift" } },
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(MANIFEST);
    const info = (await (
      await call("GET", `/swift/${SLUG}/acme/AcmeKit/1.0.0`, {
        headers: { accept: "application/vnd.swift.registry.v1+json" },
      })
    ).json()) as { resources: { checksum: string; signing?: unknown }[] };
    expect(info.resources[0]!.checksum).toBe(sha(archive));
    expect(info.resources[0]!.signing).toBeTruthy();
    const dup = await publish(archive, signature);
    expect(dup.status).toBe(409);
    expect(dup.headers.get("content-type")).toBe("application/problem+json");
  });

  it("refuses an unsigned release where the feed requires signing, and takes it where it does not", async () => {
    const unsigned = await publish(archive, undefined);
    expect(unsigned.status).toBe(422);
    expect(await unsigned.json()).toMatchObject({ reason: "swift-unsigned" });
    await db.run(
      "UPDATE dist_registry_feeds SET ext_json = ? WHERE ecosystem = 'swift'",
      JSON.stringify({ requireSigned: false }),
    );
    forgetRegistrySettings();
    expect((await publish(archive, undefined)).status).toBe(201);
  });

  it("refuses an archive without Package.swift and a malformed one, as problem+json", async () => {
    const empty = await publish(zip({ "README.md": "x" }), signature);
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ reason: "swift-bad-archive" });
    const crc = await publish(
      zip({ "Package.swift": MANIFEST }, { badCrc: true }),
      signature,
    );
    expect(crc.status).toBe(422);
    const anon = await publish(archive, signature, "1.0.0", {});
    expect(anon.status).toBe(401);
    expect(anon.headers.get("content-version")).toBe("1");
  });
});

// ── Maven / Gradle ───────────────────────────────────────────────────────────────────────────

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>im.acme</groupId>
  <artifactId>core</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>9</version></dependency></dependencies>
</project>
`;

describe("Maven and Gradle deploys (PUT /maven/<owner>/…)", () => {
  const base = `/maven/${SLUG}/im/acme/core`;
  const put = (
    path: string,
    body: string | Uint8Array,
    headers: Record<string, string> = basic(publishToken),
  ) => call("PUT", `${base}/${path}`, { headers, body });
  const jar = new TextEncoder().encode("jar bytes of im.acme:core 1.0.0");

  it("gathers the files, checks their sidecars, and publishes on maven-metadata.xml", async () => {
    expect((await put("1.0.0/core-1.0.0.jar", jar)).status).toBe(201);
    expect(
      (await put("1.0.0/core-1.0.0.jar.sha1", sha(jar, "sha1"))).status,
    ).toBe(201);
    expect(
      (await put("1.0.0/core-1.0.0.jar.md5", sha(jar, "md5"))).status,
    ).toBe(201);
    expect((await put("1.0.0/core-1.0.0.pom", POM)).status).toBe(201);
    expect(
      (await put("1.0.0/core-1.0.0.pom.sha256", `${sha(POM)}  core-1.0.0.pom`))
        .status,
    ).toBe(201);
    expect(
      (await put("1.0.0/core-1.0.0.jar.asc", "-----BEGIN PGP SIGNATURE-----"))
        .status,
    ).toBe(201);
    expect(await packageRow("maven", "1.0.0")).toBeNull();
    const meta = await put("maven-metadata.xml", "<metadata/>");
    expect(meta.status, await meta.clone().text()).toBe(201);
    expect((await put("maven-metadata.xml.sha1", "abc")).status).toBe(201);
    const row = await packageRow("maven", "1.0.0");
    golden("maven.release.json", row);
    expect(row!.metadata_json).toMatchObject({
      groupId: "im.acme",
      artifactId: "core",
      packaging: "jar",
    });
    const served = await call("GET", `${base}/maven-metadata.xml`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("<version>1.0.0</version>");
    const file = await call("GET", `${base}/1.0.0/core-1.0.0.jar.sha1`);
    expect(await file.text()).toBe(sha(jar, "sha1"));
  });

  it("refuses a checksum that disagrees, a snapshot, a POM of other coordinates and undeclared coordinates", async () => {
    expect((await put("1.0.0/core-1.0.0.jar", jar)).status).toBe(201);
    const bad = await put("1.0.0/core-1.0.0.jar.sha1", "0".repeat(40));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ reason: "integrity-mismatch" });
    const snap = await put("1.1.0-SNAPSHOT/core-1.1.0-SNAPSHOT.jar", jar);
    expect(snap.status).toBe(400);
    expect(await snap.json()).toMatchObject({ reason: "maven-snapshot" });
    const pom = await put(
      "1.0.0/core-1.0.0.pom",
      POM.replace(
        "<artifactId>core</artifactId>",
        "<artifactId>other</artifactId>",
      ),
    );
    expect(pom.status).toBe(400);
    expect(await pom.json()).toMatchObject({ reason: "maven-pom-mismatch" });
    const ghost = await call(
      "PUT",
      `/maven/${SLUG}/im/acme/ghost/1.0.0/ghost-1.0.0.jar`,
      {
        headers: basic(publishToken),
        body: jar,
      },
    );
    expect(ghost.status).toBe(403);
    const anon = await put("1.0.0/core-1.0.0.jar", jar, {});
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
  });
});

// ── The parsers ──────────────────────────────────────────────────────────────────────────────

describe("the bounded parsers", () => {
  it("multipart: boundaries, names, filenames, and malformed bodies", () => {
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe(
      "a b",
    );
    expect(multipartBoundary("application/json")).toBeNull();
    const f = twineForm("x-1.0.0.tar.gz", new Uint8Array([0, 13, 10, 45, 45]));
    const parts = parseMultipart(f.body, multipartBoundary(f.contentType)!)!;
    const content = parts.find((p) => p.name === "content")!;
    expect(content.filename).toBe("x-1.0.0.tar.gz");
    expect([...content.data]).toEqual([0, 13, 10, 45, 45]);
    expect(
      parseMultipart(
        f.body.subarray(0, f.body.length - 10),
        "----twineBoundary7MA4YWxkTrZu0gW",
      ),
    ).toBeNull();
    expect(parseMultipart(new TextEncoder().encode("nothing"), "b")).toBeNull();
  });

  it("npm body: cuts out the large attachment, decodes it, and refuses large values elsewhere", () => {
    const tarball = tgz("1.0.0", 100_000);
    const parsed = parseNpmPublishBody(
      new TextEncoder().encode(npmPublishBody("1.0.0", tarball)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sha([...parsed.body.attachments.values()][0]!)).toBe(sha(tarball));
    const sneaky = JSON.stringify({
      name: "a",
      readme: "x".repeat(70_000),
      _attachments: {},
    });
    expect(parseNpmPublishBody(new TextEncoder().encode(sneaky)).ok).toBe(
      false,
    );
    expect(parseNpmPublishBody(new TextEncoder().encode("{")).ok).toBe(false);
  });

  it("swift archive: manifests only, at the root or in the one top-level directory, bounded", async () => {
    const ok = await swiftArchiveManifests(
      zip({
        "Package.swift": MANIFEST,
        "Sources/x.swift": "x",
        "Package@swift-5.10.swift": MANIFEST_510,
      }),
    );
    expect(ok.ok && ok.manifests.map((m) => m.name)).toEqual([
      "Package.swift",
      "Package@swift-5.10.swift",
    ]);
    const stored = await swiftArchiveManifests(
      zip({ "Package.swift": MANIFEST }, { store: true }),
    );
    expect(stored.ok).toBe(true);
    const huge = await swiftArchiveManifests(
      zip({ "Package.swift": "x".repeat(1024 * 1024 + 1) }),
    );
    expect(huge.ok).toBe(false);
    expect((await swiftArchiveManifests(new Uint8Array(10))).ok).toBe(false);
  });
});
