/**
 * P2-06 — `pkey release publish` end to end against the real Worker.
 *
 * The CLI's `publishRelease` runs unmodified with a `fetchImpl` shim that routes:
 *
 *   the Actions OIDC endpoint      → a JWT signed by a local RSA key, for the audience the CLI
 *                                    asked for (P2-02's JWKS fetcher is pointed at that key)
 *   the R2 S3 endpoint             → the R2 fake, after checking the PUT is SigV4-signed with the
 *                                    ticket's temporary credentials, inside the ticket's prefix,
 *                                    and carries the file's `x-amz-checksum-sha256`
 *   everything else                → the Worker's dispatcher
 *
 * It publishes a six-build release from a fixture directory and asserts the rows and blobs the
 * descriptor names; publishing it again is a no-op. Real GitHub OIDC and a real R2 parent token
 * do not exist here (the P2-02 hand-off lists the checks that need them).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { parseManifest } from "@polaris-key/manifest";
import { publishRelease, signV4 } from "@polaris-key/cli";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  GITHUB_OIDC_ISSUER,
  stmtUpsertManifestPublisher,
} from "../src/core/publisher.js";
import { setPublishJwksFetcherForTests } from "../src/services/release/publish.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";

installDigestStream();

const OWNER = "acme";
const REPO = "djdl";
const REPO_ID = 555;
const OWNER_ID = 77;
const OIDC_URL = "https://oidc.actions.example/token?api-version=2.0";
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};
const R2_HOST = `${R2_ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── The product's .pkey/, as its repository holds it ─────────────────────────────────────────

const PRODUCT_DOC = {
  apiVersion: "pkey.dev/v1",
  product: { slug: SLUG, name: "djdl" },
  modules: {
    license: { enabled: false },
    config: { enabled: false },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: false },
  },
};
const SCHEMA_DOC = { apiVersion: "pkey.dev/v1", schemaVersion: 1, catalog: [] };
const BUILDS = [
  ["macos", "macos", "universal", "zip", "djdl-*-macos.zip"],
  ["windows", "windows", "x86_64", "zip", "djdl-*-windows.zip"],
  ["linux", "linux", "x86_64", "tar.gz", "djdl-*-linux.tar.gz"],
  ["android", "android", "arm64", "apk", "djdl-*.apk"],
  ["ios", "ios", "arm64", "ipa", "djdl-*.ipa"],
  ["web", "web", "wasm32", "zip", "djdl-*-web.zip"],
] as const;
const RELEASE_DOC = {
  apiVersion: "pkey.dev/v1",
  release: {
    provider: { type: "github", owner: OWNER, repo: REPO },
    binaryName: "djdl",
    publishing: {
      trustedPublisher: { workflow: ".github/workflows/release.yml" },
    },
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver", buildNumber: "descriptor" },
        artifacts: BUILDS.map(([id, platform, arch, format, match]) => ({
          id,
          platform,
          arch,
          format,
          match,
        })),
      },
    },
  },
};

function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 13 + seed * 101 + (i >> 9)) & 0xff;
  return out;
}

/** v1.3.0's exports, nested by artifact as `actions/download-artifact` leaves them. */
const FILES: Record<string, Uint8Array> = {
  "macos/djdl-1.3.0-macos.zip": bytesOf(150_000, 1),
  "macos/djdl-1.3.0-macos.zip.sig": bytesOf(256, 2),
  "windows/djdl-1.3.0-windows.zip": bytesOf(4_000, 3),
  "linux/djdl-1.3.0-linux.tar.gz": bytesOf(5_000, 4),
  "android/djdl-1.3.0.apk": bytesOf(6_000, 5),
  "ios/djdl-1.3.0.ipa": bytesOf(7_000, 6),
  "web/djdl-1.3.0-web.zip": bytesOf(8_000, 7),
};

let cwd: string;
async function writeRepo(): Promise<void> {
  cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-e2e-"));
  await mkdir(path.join(cwd, ".pkey"));
  await writeFile(
    path.join(cwd, ".pkey/product.json"),
    JSON.stringify(PRODUCT_DOC),
  );
  await writeFile(
    path.join(cwd, ".pkey/schema.json"),
    JSON.stringify(SCHEMA_DOC),
  );
  await writeFile(
    path.join(cwd, ".pkey/release.json"),
    JSON.stringify(RELEASE_DOC),
  );
  for (const [rel, bytes] of Object.entries(FILES)) {
    const file = path.join(cwd, "dist", rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await writeFile(
    path.join(cwd, "builds.json"),
    JSON.stringify({ android: { buildNumber: 130 }, ios: { minOS: "16.0" } }),
  );
}

// ── The world: the Worker's D1, KV and R2, a publisher policy, a test OIDC issuer ───────────

let key: { privateKey: KeyLike; publicKey: KeyLike };
beforeAll(async () => {
  key = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "gh-1",
    alg: "RS256",
  };
  setPublishJwksFetcherForTests(async () => ({ keys: [jwk] }));
});

let db: Db;
let env: Env;
let r2: R2Mock;
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db);
  const parsed = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify(SCHEMA_DOC),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  await db.batch(
    manifestDeliverableStatements(SLUG, parsed.manifest.release!.app!, NOW),
  );
  const policy = stmtUpsertManifestPublisher({
    product: SLUG,
    repositoryId: REPO_ID,
    repositoryOwnerId: OWNER_ID,
    repository: `${OWNER}/${REPO}`,
    workflow: ".github/workflows/release.yml",
    environment: "release",
    now: NOW,
  });
  await db.run(policy.sql, ...policy.params);
  await writeRepo();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(cwd, { recursive: true, force: true });
});

// ── The shim ─────────────────────────────────────────────────────────────────────────────────

let jti = 0;
async function oidcToken(audience: string): Promise<string> {
  return new SignJWT({
    sub: `repo:${OWNER}/${REPO}:environment:release`,
    repository: `${OWNER}/${REPO}`,
    repository_id: String(REPO_ID),
    repository_owner_id: String(OWNER_ID),
    job_workflow_ref: `${OWNER}/${REPO}/.github/workflows/release.yml@refs/tags/v1.3.0`,
    ref: "refs/tags/v1.3.0",
    ref_protected: "true",
    environment: "release",
    runner_environment: "github-hosted",
    event_name: "push",
    run_id: "42",
  })
    .setProtectedHeader({ alg: "RS256", kid: "gh-1" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(audience)
    .setIssuedAt(NOW - 5)
    .setExpirationTime(NOW + 300)
    .setJti(`e2e-jti-${++jti}`)
    .sign(key.privateKey);
}

interface Shim {
  fetchImpl: typeof fetch;
  puts: string[];
  workerCalls: string[];
}

async function readBytes(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
  return new Uint8Array(Buffer.concat(chunks));
}

function shim(): Shim {
  const puts: string[] = [];
  const workerCalls: string[] = [];
  let creds: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  } | null = null;
  let prefix = "";
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.href.startsWith(OIDC_URL.split("?")[0]!)) {
      expect(headers.authorization).toBe("bearer request-bearer");
      return Response.json({
        value: await oidcToken(url.searchParams.get("audience")!),
      });
    }
    if (url.host === R2_HOST) {
      // What R2 checks: the signature (temporary credentials), the prefix, the checksum.
      expect(creds).not.toBeNull();
      const objectKey = decodeURIComponent(
        url.pathname.slice(`/${creds!.bucket}/`.length),
      );
      expect(objectKey.startsWith(prefix)).toBe(true);
      const { authorization, ...signed } = headers;
      expect(authorization).toBe(
        signV4({
          method: "PUT",
          url,
          headers: signed,
          payloadHash: signed["x-amz-content-sha256"]!,
          accessKeyId: creds!.accessKeyId,
          secretAccessKey: creds!.secretAccessKey,
          region: "auto",
          service: "s3",
          amzDate: signed["x-amz-date"]!,
        }),
      );
      const bytes = await readBytes(init!.body);
      expect(bytes.length).toBe(Number(signed["content-length"]));
      // R2 refuses a body whose SHA-256 is not the declared checksum (the fake throws).
      await r2.put(objectKey, bytes, {
        sha256: Buffer.from(
          signed["x-amz-checksum-sha256"]!,
          "base64",
        ).toString("hex"),
      });
      puts.push(objectKey);
      return new Response(null, { status: 200 });
    }
    workerCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const res = await call(env, db, noFetch, url.href, init);
    if (url.pathname.endsWith("/release/publish/uploads") && res.ok) {
      const body = (await res.clone().json()) as {
        credentials: typeof creds;
        prefix: string;
      };
      creds = body.credentials;
      prefix = body.prefix;
    }
    return res;
  }) as typeof fetch;
  return { fetchImpl, puts, workerCalls };
}

function out() {
  let text = "";
  return {
    write: (c: string) => ((text += c), true),
    text: () => text,
  };
}

async function publish(s: Shim, over: { dryRun?: boolean } = {}) {
  const stdout = out();
  const stderr = out();
  const result = await publishRelease({
    cwd,
    product: SLUG,
    tag: "v1.3.0",
    channel: "stable",
    dir: "dist",
    meta: "builds.json",
    baseUrl: CONSOLE,
    env: {
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_RUN_ID: "42",
    },
    stdout,
    stderr,
    fetchImpl: s.fetchImpl,
    sleep: async () => undefined,
    ...over,
  });
  return { result, stdout: stdout.text(), stderr: stderr.text() };
}

async function counts() {
  const n = async (t: string) =>
    (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  return {
    releases: await n("release_metadata"),
    builds: await n("release_builds"),
    artifacts: await n("release_artifacts"),
    objects: await n("blob_objects"),
    refs: await n("blob_refs"),
  };
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────

describe("pkey release publish → the Worker", () => {
  it("publishes a six-build release: the Worker holds the builds, roles, SHA-256s and blobs the descriptor names", async () => {
    const s = shim();
    const { result, stdout, stderr } = await publish(s);
    expect(stderr).toBe("");
    expect(result.server).toMatchObject({
      ok: true,
      dryRun: false,
      releaseId: "v1.3.0",
      outcome: "created",
    });
    expect(stdout).toContain("Published v1.3.0 (created)");

    // Every file went up exactly once, into the ticket's staging prefix, and was promoted.
    expect(s.puts).toHaveLength(Object.keys(FILES).length);
    expect(r2.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);

    const builds = await db.all<{
      build_id: string;
      platform: string;
      arch: string;
      format: string;
      build_number: string | null;
      min_os: string | null;
    }>(
      "SELECT build_id, platform, arch, format, build_number, min_os FROM release_builds WHERE product = ? AND release_id = ? ORDER BY build_id",
      SLUG,
      "v1.3.0",
    );
    expect(builds).toEqual(
      [...BUILDS]
        .map(([id, platform, arch, format]) => ({
          build_id: id,
          platform,
          arch,
          format,
          build_number: id === "android" ? "130" : null,
          min_os: id === "ios" ? "16.0" : null,
        }))
        .sort((a, b) => a.build_id.localeCompare(b.build_id)),
    );

    const artifacts = await db.all<{
      build_id: string;
      name: string;
      role: string;
      sha256: string;
    }>(
      "SELECT build_id, name, role, sha256 FROM release_artifacts WHERE product = ? AND release_id = ? ORDER BY name",
      SLUG,
      "v1.3.0",
    );
    const expected = Object.entries(FILES)
      .map(([rel, bytes]) => {
        const name = path.basename(rel);
        return {
          build_id: rel.split("/")[0]!,
          name,
          role: name.endsWith(".sig") ? "signature" : "payload",
          sha256: sha(bytes),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(artifacts).toEqual(expected);

    // The blobs are in the store under their content address, and this product holds a ref.
    for (const [, bytes] of Object.entries(FILES)) {
      const k = `blobs/sha256/${sha(bytes)}`;
      expect(r2.has(k)).toBe(true);
      const obj = await asR2(r2).get(k);
      expect(sha(new Uint8Array(await obj!.arrayBuffer()))).toBe(sha(bytes));
    }
    const refs = await db.all<{ product: string }>(
      "SELECT product FROM blob_refs",
    );
    expect(refs).toHaveLength(Object.keys(FILES).length);
    expect(new Set(refs.map((r) => r.product))).toEqual(new Set([SLUG]));

    const release = await db.first<{
      seq: number;
      channel: string;
      deliverable_id: string;
    }>(
      "SELECT seq, channel, deliverable_id FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      "v1.3.0",
    );
    expect(release).toEqual({
      seq: 1,
      channel: "stable",
      deliverable_id: "app",
    });
  });

  it("publishing the same release again is a no-op: nothing uploaded, nothing written", async () => {
    await publish(shim());
    const before = await counts();
    const again = shim();
    const { result, stdout } = await publish(again);
    expect(result.server).toMatchObject({
      releaseId: "v1.3.0",
      outcome: "unchanged",
    });
    expect(again.puts).toEqual([]);
    expect(result.skipped).toHaveLength(Object.keys(FILES).length);
    expect(stdout).toContain("Uploaded 0 objects; 7 already stored");
    expect(await counts()).toEqual(before);
  });

  it("--dry-run before any upload: the server's verdict, no PUT, no row, no blob", async () => {
    const s = shim();
    const { result, stdout } = await publish(s, { dryRun: true });
    expect(result.server).toMatchObject({
      ok: true,
      dryRun: true,
      outcome: "created",
    });
    expect((result.server!.unverified as string[]).length).toBe(
      Object.keys(FILES).length,
    );
    expect(s.puts).toEqual([]);
    expect(r2.keys()).toEqual([]);
    expect(await counts()).toEqual({
      releases: 0,
      builds: 0,
      artifacts: 0,
      objects: 0,
      refs: 0,
    });
    expect(stdout).toContain(
      "Server validation: ok — would be created as v1.3.0",
    );
    // Then the real publish still lands.
    expect((await publish(shim())).result.server).toMatchObject({
      outcome: "created",
    });
  });

  it("a policy refusal comes back with its reason and claim, and nothing is uploaded", async () => {
    // The product's policy now requires another environment than the job runs in.
    await db.run(
      "UPDATE ci_publishers SET environment = 'production' WHERE product = ?",
      SLUG,
    );
    const s = shim();
    await expect(publish(s)).rejects.toThrow(
      /Exchanging the GitHub OIDC token failed \(403 policy_mismatch\)[\s\S]*failing claim: environment/,
    );
    expect(s.puts).toEqual([]);
    expect(s.workerCalls).toEqual([`POST /${SLUG}/release/publish/token`]);
  });
});
