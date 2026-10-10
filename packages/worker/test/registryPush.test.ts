/**
 * F-23 — native `docker push` to the OCI feed: the token service's push grant, the blob upload
 * state machine over R2 multipart (`services/release/packages/ociUpload.ts`, vendored from
 * cloudflare/serverless-registry), the manifest `PUT`, and the rule that a tag push writes the
 * SAME release rows a ticket publish of the same image writes. Everything goes through the real
 * registry host dispatcher over `mount.ts`'s routes, into the real Release ingest.
 *
 * The R2 fake enforces R2's multipart rule (equal parts of at least 5 MiB, a smaller last one),
 * so the chunk-fitting tests use real part sizes. The workerd lane
 * (`test-workerd/registryOci.test.ts`) runs a chunked push against miniflare's R2.
 *
 * Golden file: `test/fixtures/registry/oci/push-2.0.0.json` (`UPDATE_REGISTRY_GOLDENS=1`).
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRegistryHost } from "../src/core/registry/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/repo.js";
import {
  BYTE_ROUTES,
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import { dispatchBytesHost } from "../src/core/assets/bytesHost.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { forgetLicenceHolds } from "../src/services/distribution/registry/authorize.js";
import {
  REGISTRY_TOKEN_TTL_SECONDS,
  forgetRegistryTokens,
  mintRegistryToken,
  revokeRegistryToken,
  signPullToken,
  verifyPullToken,
} from "../src/core/registry/registryTokens.js";
import { OCI_PUSH_REF, blobKey } from "../src/core/assets/blobs.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import {
  OCI_PUSH_ROUTES,
  SPOOL_BYTES,
  parseOciManifest,
} from "../src/services/release/packages/ociPush.js";
import { RELEASE_REGISTRY_OPENAPI } from "../src/services/release/index.js";
import { stmtUpsertDeliverable } from "../src/services/release/model.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import {
  OCI_ID,
  OCI_REPO,
  ociFixture,
  publishOciFixture,
} from "./ociFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "fixtures", "registry", "oci");
const PKG = "https://pkg.example.test";
const HOST = "pkg.example.test";
const OWNER = "acme";
const OTHER = "globex";
const NAME = `${OWNER}/${OCI_REPO}`;
const KEY = "registry-token-key-for-tests";
const MiB = 1024 * 1024;
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
};

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

let db: Db;
let env: Env;
let bucket: R2Mock;
let clock: number;
let pushToken: string;

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const digestOf = (b: Uint8Array) => `sha256:${sha(b)}`;

function basic(token: string, user = "__token__"): string {
  return `Basic ${btoa(`${user}:${token}`)}`;
}

async function call(
  method: string,
  path: string,
  init: { body?: Uint8Array; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body && headers["content-length"] === undefined)
    headers["content-length"] = String(init.body.byteLength);
  if (headers["content-length"] === "omit") delete headers["content-length"];
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, {
      method,
      headers,
      ...(init.body ? { body: init.body } : {}),
    }),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
    undefined,
    REGISTRY_OWNERLESS_ROUTES,
  );
}

async function ociCode(res: Response): Promise<string> {
  const body = (await res.json()) as { errors: { code: string }[] };
  return body.errors[0]!.code;
}

/** A token from `/v2/token` for `scope`, or the refusal's status. */
async function ociToken(
  credential: string | null,
  scope = `repository:${NAME}:pull,push`,
): Promise<{ status: number; token?: string; code?: string }> {
  const res = await call(
    "GET",
    `/v2/token?service=${HOST}&scope=${encodeURIComponent(scope)}`,
    { headers: credential ? { authorization: credential } : {} },
  );
  if (res.status !== 200)
    return { status: res.status, code: await ociCode(res) };
  return {
    status: 200,
    token: ((await res.json()) as { token: string }).token,
  };
}

async function bearerFor(credential: string, repo = NAME): Promise<string> {
  const t = await ociToken(credential, `repository:${repo}:pull,push`);
  expect(t.status, JSON.stringify(t)).toBe(200);
  return `Bearer ${t.token}`;
}

async function seedOwner(slug: string): Promise<void> {
  await seedProduct(db, slug);
  await setServices(
    db,
    slug,
    serializeServices({ services: ON }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    slug,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'oci', 1, '{}', 5368709120, ?)`,
    slug,
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
      product: OWNER,
      label: "push",
      binding: "owner",
      scopes: ["read", "publish"],
      // A publish token names its publish ecosystems (F-22's mint rule).
      ecosystems: ["oci"],
      createdBy: "admin:test",
      ...over,
    },
    Math.floor(clock / 1000),
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.token;
}

/** Push one blob as docker does: POST, one PATCH with the whole blob, PUT ?digest=. */
async function pushBlob(
  auth: string,
  bytes: Uint8Array,
  repo = NAME,
): Promise<Response> {
  const start = await call("POST", `/v2/${repo}/blobs/uploads/`, {
    headers: { authorization: auth },
  });
  expect(start.status, await start.clone().text()).toBe(202);
  const location = start.headers.get("location")!;
  const patch = await call("PATCH", location, {
    body: bytes,
    headers: {
      authorization: auth,
      "content-type": "application/octet-stream",
    },
  });
  expect(patch.status, await patch.clone().text()).toBe(202);
  return call(
    "PUT",
    `${patch.headers.get("location")!}?digest=${digestOf(bytes)}`,
    {
      headers: { authorization: auth },
    },
  );
}

async function putManifest(
  auth: string,
  reference: string,
  bytes: Uint8Array,
  mediaType: string,
  repo = NAME,
): Promise<Response> {
  return call("PUT", `/v2/${repo}/manifests/${reference}`, {
    body: bytes,
    headers: { authorization: auth, "content-type": mediaType },
  });
}

interface Obj {
  bytes: Uint8Array;
  mediaType: string;
}

const desc = (o: Obj, extra: Record<string, unknown> = {}) => ({
  mediaType: o.mediaType,
  digest: digestOf(o.bytes),
  size: o.bytes.length,
  ...extra,
});

/** One platform image of `version`: layer, config and manifest. */
function image(version: string, arch: string, manifestType = OCI_MANIFEST) {
  const layer: Obj = {
    bytes: enc(`pushed layer ${version} ${arch}\n`),
    mediaType: OCI_LAYER,
  };
  const config: Obj = {
    bytes: enc(
      JSON.stringify({
        architecture: arch,
        os: "linux",
        rootfs: { type: "layers", diff_ids: [digestOf(layer.bytes)] },
      }),
    ),
    mediaType: OCI_CONFIG,
  };
  const manifest: Obj = {
    bytes: enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: manifestType,
        config: desc(config),
        layers: [desc(layer)],
      }),
    ),
    mediaType: manifestType,
  };
  return { layer, config, manifest };
}

function multiArch(version: string) {
  const amd = image(version, "amd64");
  const arm = image(version, "arm64");
  const index: Obj = {
    bytes: enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          desc(amd.manifest, {
            platform: { architecture: "amd64", os: "linux" },
          }),
          desc(arm.manifest, {
            platform: { architecture: "arm64", os: "linux" },
          }),
        ],
      }),
    ),
    mediaType: OCI_INDEX,
  };
  return { amd, arm, index };
}

/** Push a whole multi-arch image under `tag`, as `docker buildx --push` does. */
async function pushMultiArch(auth: string, tag: string) {
  const img = multiArch(tag);
  for (const p of [img.amd, img.arm]) {
    for (const b of [p.layer, p.config])
      expect((await pushBlob(auth, b.bytes)).status).toBe(201);
    const m = await putManifest(
      auth,
      digestOf(p.manifest.bytes),
      p.manifest.bytes,
      OCI_MANIFEST,
    );
    expect(m.status, await m.clone().text()).toBe(201);
  }
  const res = await putManifest(auth, tag, img.index.bytes, OCI_INDEX);
  return { img, res };
}

/** Declare another (empty) OCI package deliverable of the owner, as resync would. */
async function declareRepository(id: string, repo: string): Promise<void> {
  const s = stmtUpsertDeliverable(
    {
      product: OWNER,
      deliverableId: id,
      kind: "package",
      defJson: JSON.stringify({
        kind: "package",
        id,
        ecosystem: "oci",
        name: repo,
        artifacts: { layout: { match: "image/**" } },
      }),
      ecosystem: "oci",
      packageName: repo,
    },
    NOW,
  );
  await db.run(s.sql, ...s.params);
  await db.run(
    `INSERT OR IGNORE INTO dist_access (product, deliverable_id, mode, source, modified_at)
     VALUES (?, ?, 'public', 'manifest', ?)`,
    OWNER,
    id,
    NOW,
  );
}

beforeEach(async () => {
  installDigestStream();
  clock = NOW * 1000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.PKG_ORIGIN = PKG;
  env.KEY_HASH_PEPPER = "pepper";
  env.REGISTRY_TOKEN_KEY = KEY;
  bucket = new R2Mock();
  env.BLOBS = asR2(bucket);
  await seedOwner(OWNER);
  await seedOwner(OTHER);
  await publishOciFixture(db, env, bucket, OWNER, NOW);
  pushToken = await mint();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { caches?: unknown }).caches;
});

// ── Declarations ─────────────────────────────────────────────────────────────────────────────

describe("the push routes' declarations (rule 10)", () => {
  it("every push route has an OpenAPI row, and each row's sample path reaches the route it names", () => {
    const names = new Set(OCI_PUSH_ROUTES.map((r) => r.name));
    expect(new Set(RELEASE_REGISTRY_OPENAPI.map(([, , o]) => o))).toEqual(
      names,
    );
    const sample = (path: string) =>
      path
        .replace("{owner}", OWNER)
        .replace("{repository}", OCI_REPO)
        .replace("{uuid}", "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b")
        .replace("{reference}", "1.0.0");
    for (const [path, methods, owner] of RELEASE_REGISTRY_OPENAPI) {
      for (const m of methods) {
        const route = OCI_PUSH_ROUTES.find(
          (r) =>
            (r.methods as readonly string[]).includes(m.toUpperCase()) &&
            r.match(sample(path)) !== null,
        );
        expect(route?.name, `${m} ${path}`).toBe(owner);
        expect(route!.match(sample(path))!.owner).toBe(OWNER);
      }
    }
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────────────────────

describe("who may push: the token service and the mint", () => {
  it("an owner-bound publish token is granted pull and push; the token names the repository in both", async () => {
    const t = await ociToken(basic(pushToken));
    expect(t.status).toBe(200);
    const claims = await verifyPullToken(env, t.token!, NOW);
    expect(claims?.repos).toEqual([NAME]);
    expect(claims?.push).toEqual([NAME]);
  });

  it("a pull-only request gets no push grant, and every pull token stays exactly as before", async () => {
    const t = await ociToken(basic(pushToken), `repository:${NAME}:pull`);
    const claims = await verifyPullToken(env, t.token!, NOW);
    expect(claims?.push).toBeUndefined();
    const payload = JSON.parse(
      Buffer.from(t.token!.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "exp",
      "iat",
      "own",
      "repos",
      "sub",
    ]);
  });

  it("push is refused to a read token, a licence token, another owner's publisher, anonymous, and for an undeclared repository", async () => {
    expect(
      (await ociToken(basic(await mint({ scopes: ["read"] })))).status,
    ).toBe(403);
    const { licenseId } = await seedLicenseWithKey(db, OWNER);
    const licence = await mint({
      binding: "license",
      licenseId,
      scopes: ["read"],
    });
    expect((await ociToken(basic(licence))).status).toBe(403);
    const other = await mint({ product: OTHER });
    expect((await ociToken(basic(other))).status).toBe(403);
    expect((await ociToken(null)).status).toBe(401);
    expect(
      (
        await ociToken(
          basic(pushToken),
          `repository:${OWNER}/tools/nope:pull,push`,
        )
      ).status,
    ).toBe(403);
    // A token narrowed to other ecosystems never pushes OCI.
    expect(
      (await ociToken(basic(await mint({ ecosystems: ["npm"] })))).status,
    ).toBe(403);
    // `delete` and `*` stay refused.
    expect(
      (await ociToken(basic(pushToken), `repository:${NAME}:pull,push,delete`))
        .status,
    ).toBe(403);
  });

  it("a CI token pushes with release:publish, and not without it", async () => {
    const ci = await issueStaticCiToken(env, db, {
      product: OWNER,
      label: "build",
      scopes: ["release:publish"],
      expiresAt: NOW + 86_400,
      createdBy: "admin:a",
      now: NOW,
    });
    expect((await ociToken(basic(ci.token))).status).toBe(200);
    const promoteOnly = await issueStaticCiToken(env, db, {
      product: OWNER,
      label: "promote",
      scopes: ["release:promote"],
      expiresAt: NOW + 86_400,
      createdBy: "admin:a",
      now: NOW,
    });
    // Without the publish scope it is no registry credential at all (401, not 403).
    expect((await ociToken(basic(promoteOnly.token))).status).toBe(401);
  });

  it("the mint: publish implies read; licence and Godot URL tokens can only read", async () => {
    const res = await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "p",
        binding: "owner",
        scopes: ["publish"],
        ecosystems: ["oci"],
        createdBy: "admin:t",
      },
      NOW,
    );
    expect(res.ok && res.view.scopes).toEqual(["publish", "read"]);
    const { licenseId } = await seedLicenseWithKey(db, OWNER);
    const lic = await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "l",
        binding: "license",
        licenseId,
        scopes: ["read", "publish"],
        ecosystems: ["oci"],
        createdBy: "admin:t",
      },
      NOW,
    );
    expect(!lic.ok && lic.reason).toBe("license_tokens_read_only");
    const url = await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "u",
        binding: "owner",
        presentation: "url",
        scopes: ["read", "publish"],
        ecosystems: ["oci"],
        createdBy: "admin:t",
      },
      NOW,
    );
    // A publish token is never a Godot editor URL token (F-22's mint rule refuses the field).
    expect(!url.ok && url.fields).toContain("presentation");
  });
});

// ── Refusals before anything is written ──────────────────────────────────────────────────────

describe("push refusals", () => {
  it("no push token: 401 with the Bearer challenge naming pull,push, on every push method", async () => {
    const pull = await ociToken(basic(pushToken), `repository:${NAME}:pull`);
    for (const auth of [null, `Bearer ${pull.token}`, basic(pushToken)]) {
      for (const [method, path] of [
        ["POST", `/v2/${NAME}/blobs/uploads/`],
        [
          "PATCH",
          `/v2/${NAME}/blobs/uploads/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b`,
        ],
        ["PUT", `/v2/${NAME}/manifests/9.9.9`],
      ] as const) {
        const res = await call(
          method,
          path,
          auth ? { headers: { authorization: auth } } : {},
        );
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe(
          `Bearer realm="${PKG}/v2/token",service="${HOST}",scope="repository:${NAME}:pull,push"`,
        );
        expect(await ociCode(res)).toBe("UNAUTHORIZED");
        expect(res.headers.get("docker-distribution-api-version")).toBe(
          "registry/2.0",
        );
        expect(res.headers.get("content-security-policy")).toContain("sandbox");
      }
    }
    // An unknown repository answers the same 401 to an unauthorised caller: no oracle.
    const res = await call("POST", `/v2/${OWNER}/tools/nope/blobs/uploads/`);
    expect(res.status).toBe(401);
  });

  it("a push token for an undeclared repository, a disabled feed, or Distribution off is NAME_UNKNOWN", async () => {
    const forged = await signPullToken(
      env,
      {
        sub: (await verifyPullToken(
          env,
          (await ociToken(basic(pushToken))).token!,
          NOW,
        ))!.sub,
        own: OWNER,
        repos: [`${OWNER}/tools/nope`],
        push: [`${OWNER}/tools/nope`],
      },
      NOW,
    );
    const nope = await call("POST", `/v2/${OWNER}/tools/nope/blobs/uploads/`, {
      headers: { authorization: `Bearer ${forged!.token}` },
    });
    expect(nope.status).toBe(404);
    expect(await ociCode(nope)).toBe("NAME_UNKNOWN");

    const auth = await bearerFor(basic(pushToken));
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE product = ?",
      OWNER,
    );
    forgetRegistrySettings();
    const off = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    expect(off.status).toBe(404);
    expect(await ociCode(off)).toBe("NAME_UNKNOWN");

    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 1 WHERE product = ?",
      OWNER,
    );
    await setServices(
      db,
      OWNER,
      serializeServices({
        services: { ...ON, distribution: { enabled: false } },
      }),
      "manifest",
      NOW,
    );
    forgetRegistrySettings();
    const dist = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    expect(dist.status).toBe(404);

    await setServices(
      db,
      OWNER,
      serializeServices({ services: { ...ON, release: { enabled: false } } }),
      "manifest",
      NOW,
    );
    const rel = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    expect(rel.status).toBe(404);
    expect(await ociCode(rel)).toBe("NAME_UNKNOWN");
  });

  it("a revoked publisher stops pushing within the 30-second window, even with a live push token", async () => {
    const auth = await bearerFor(basic(pushToken));
    const claims = await verifyPullToken(env, auth.slice(7), NOW);
    await revokeRegistryToken(db, OWNER, claims!.sub, "admin:t", "manual", NOW);
    clock += (REGISTRY_TOKEN_TTL_SECONDS + 1) * 1000;
    vi.setSystemTime(clock);
    forgetRegistryTokens();
    const res = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(401);
  });
});

// ── Blob uploads ─────────────────────────────────────────────────────────────────────────────

describe("blob uploads over R2 multipart", () => {
  it("POST opens an upload with the chunk floor, GET reports progress, DELETE forgets it", async () => {
    const auth = await bearerFor(basic(pushToken));
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    expect(start.status).toBe(202);
    const location = start.headers.get("location")!;
    expect(location).toMatch(
      new RegExp(`^/v2/${NAME}/blobs/uploads/[0-9a-f-]{36}$`),
    );
    expect(start.headers.get("range")).toBe("0-0");
    expect(start.headers.get("oci-chunk-min-length")).toBe(String(5 * MiB));
    expect(start.headers.get("docker-upload-uuid")).toBe(
      location.split("/").pop(),
    );
    expect(start.body).toBeNull();

    const patch = await call("PATCH", location, {
      body: enc("hello"),
      headers: { authorization: auth },
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("range")).toBe("0-4");
    const status = await call("GET", location, {
      headers: { authorization: auth },
    });
    expect(status.status).toBe(204);
    expect(status.headers.get("range")).toBe("0-4");

    expect(
      (await call("DELETE", location, { headers: { authorization: auth } }))
        .status,
    ).toBe(204);
    const gone = await call("GET", location, {
      headers: { authorization: auth },
    });
    expect(gone.status).toBe(404);
    expect(await ociCode(gone)).toBe("BLOB_UPLOAD_UNKNOWN");
    expect(bucket.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
  });

  it("a whole blob in one PATCH (docker's way) lands verified at its locked key, held by its repository alone", async () => {
    const auth = await bearerFor(basic(pushToken));
    const bytes = enc("a docker layer\n");
    const res = await pushBlob(auth, bytes);
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(
      `/v2/${NAME}/blobs/${digestOf(bytes)}`,
    );
    expect(res.headers.get("docker-content-digest")).toBe(digestOf(bytes));
    expect(bucket.has(blobKey(sha(bytes)))).toBe(true);
    const ref = await db.first<{ ref_id: string }>(
      "SELECT ref_id FROM blob_refs WHERE product = ? AND storage_key = ? AND ref_kind = ?",
      OWNER,
      blobKey(sha(bytes)),
      OCI_PUSH_REF,
    );
    expect(ref?.ref_id).toBe(OCI_ID);
    // Staging is cleaned up; the pull route does not serve an untagged pushed blob.
    expect(bucket.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
    // OCI's read-after-write: the repository serves it by digest, privately, before any tag...
    const pull = await call("HEAD", `/v2/${NAME}/blobs/${digestOf(bytes)}`);
    expect(pull.status).toBe(200);
    expect(pull.headers.get("cache-control")).toContain("private");
    // ...but only that repository: another repository of the owner does not.
    await declareRepository("oci.other", "tools/other");
    const elsewhere = await call(
      "HEAD",
      `/v2/${OWNER}/tools/other/blobs/${digestOf(bytes)}`,
    );
    expect(elsewhere.status).toBe(404);
  });

  it("an untagged pushed blob is not downloadable from the bytes host either (the ref serves nothing)", async () => {
    env.BLOB_ORIGIN = "https://dl.example.test";
    const auth = await bearerFor(basic(pushToken));
    const bytes = enc("untagged layer\n");
    expect((await pushBlob(auth, bytes)).status).toBe(201);
    const blob = (hex: string) =>
      dispatchBytesHost(
        new Request(
          `https://dl.example.test/${OWNER}/distribution/blobs/sha256/${hex}`,
        ),
        env,
        db,
        BYTE_ROUTES,
        SERVICES,
      );
    // Even with the app public: neither the pushed, untagged object (a holder that serves
    // nothing never falls back to the app's mode) nor a published image's object (a
    // `package-file` ref, SEC-DST-1: the OCI pull route serves it, never the blob route).
    await db.run(
      "INSERT OR IGNORE INTO release_config (product) VALUES (?)",
      OWNER,
    );
    await db.run(
      `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, 'app', 'public', 'manifest', ?)`,
      OWNER,
      NOW,
    );
    const published = ociFixture()[3]!.objects[2]!;
    const pubRes = await blob(published.sha256);
    expect(pubRes.status, await pubRes.clone().text()).toBe(404);
    expect((await blob(sha(bytes))).status).toBe(404);
  });

  it("a body without Content-Length (chunked transfer) is read and stored", async () => {
    const auth = await bearerFor(basic(pushToken));
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const bytes = randomBytes(1000);
    const patch = await call("PATCH", start.headers.get("location")!, {
      body: bytes,
      headers: { authorization: auth, "content-length": "omit" },
    });
    expect(patch.status).toBe(202);
    const put = await call(
      "PUT",
      `${patch.headers.get("location")}?digest=${digestOf(bytes)}`,
      {
        headers: { authorization: auth },
      },
    );
    expect(put.status).toBe(201);
  });

  it("a body without Content-Length but with Content-Range is streamed as the range's length (and refused when it is not)", async () => {
    const auth = await bearerFor(basic(pushToken));
    const bytes = enc("0123456789");
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const loc = start.headers.get("location")!;
    const short = await call("PATCH", loc, {
      body: bytes.subarray(0, 3),
      headers: {
        authorization: auth,
        "content-length": "omit",
        "content-range": "0-3",
      },
    });
    expect(short.status).toBe(400);
    expect(await ociCode(short)).toBe("SIZE_INVALID");
    const first = await call("PATCH", loc, {
      body: bytes.subarray(0, 4),
      headers: {
        authorization: auth,
        "content-length": "omit",
        "content-range": "0-3",
      },
    });
    expect(first.status, await first.clone().text()).toBe(202);
    expect(first.headers.get("range")).toBe("0-3");
    const put = await call("PUT", `${loc}?digest=${digestOf(bytes)}`, {
      body: bytes.subarray(4),
      headers: {
        authorization: auth,
        "content-length": "omit",
        "content-range": "4-9",
      },
    });
    expect(put.status, await put.clone().text()).toBe(201);
  });

  /** `bytes` as a streamed body without `Content-Length`, in 1 MiB reads (docker's layer PATCH). */
  function chunkedRequest(
    method: string,
    path: string,
    bytes: Uint8Array,
    auth: string,
  ): Request {
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.byteLength) return c.close();
        c.enqueue(bytes.slice(at, at + MiB));
        at += MiB;
      },
    });
    return new Request(`${PKG}${path}`, {
      method,
      headers: { authorization: auth },
      body,
      duplex: "half",
    } as RequestInit);
  }

  /** Record every multipart part's size the bucket is sent. */
  function recordPartSizes(): number[] {
    const sizes: number[] = [];
    const resume = bucket.resumeMultipartUpload.bind(bucket);
    vi.spyOn(bucket, "resumeMultipartUpload").mockImplementation(
      (key, uploadId) => {
        const mp = resume(key, uploadId);
        const uploadPart = mp.uploadPart.bind(mp);
        return {
          ...mp,
          uploadPart: async (n: number, value: unknown) => {
            const part = await uploadPart(n, value as never);
            sizes.push(
              (
                bucket as unknown as {
                  uploads: Map<
                    string,
                    { parts: Map<number, { bytes: Uint8Array }> }
                  >;
                }
              ).uploads
                .get(uploadId)!
                .parts.get(n)!.bytes.byteLength,
            );
            return part;
          },
        };
      },
    );
    return sizes;
  }

  for (const how of ["PATCH", "PUT", "POST"] as const) {
    it(`a body without Content-Length larger than one spooled piece is appended piece by piece, never held whole (${how})`, async () => {
      const auth = await bearerFor(basic(pushToken));
      const total = 2 * SPOOL_BYTES + 3 * MiB + 7;
      const bytes = new Uint8Array(randomBytes(total));
      const sizes = recordPartSizes();
      const dispatch = (req: Request) =>
        dispatchRegistryHost(
          req,
          env,
          db,
          REGISTRY_ROUTES,
          SERVICES,
          undefined,
          REGISTRY_OWNERLESS_ROUTES,
        );
      let res: Response;
      if (how === "POST") {
        res = await dispatch(
          chunkedRequest(
            "POST",
            `/v2/${NAME}/blobs/uploads/?digest=${digestOf(bytes)}`,
            bytes,
            auth,
          ),
        );
      } else {
        const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
          headers: { authorization: auth },
        });
        const loc = start.headers.get("location")!;
        if (how === "PATCH") {
          const patch = await dispatch(
            chunkedRequest("PATCH", loc, bytes, auth),
          );
          expect(patch.status, await patch.clone().text()).toBe(202);
          expect(patch.headers.get("range")).toBe(`0-${total - 1}`);
          res = await call("PUT", `${loc}?digest=${digestOf(bytes)}`, {
            headers: { authorization: auth },
          });
        } else {
          res = await dispatch(
            chunkedRequest(
              "PUT",
              `${loc}?digest=${digestOf(bytes)}`,
              bytes,
              auth,
            ),
          );
        }
      }
      expect(res.status, await res.clone().text()).toBe(201);
      // Each piece became its own part of SPOOL_BYTES (no part, so no read, ever held the whole
      // body); the remainder is the last part.
      expect(sizes).toEqual([SPOOL_BYTES, SPOOL_BYTES, 3 * MiB + 7]);
      const stored = await bucket.get(blobKey(sha(bytes)));
      expect(
        sha(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer())),
      ).toBe(sha(bytes));
      expect(bucket.openUploads()).toBe(0);
      expect(bucket.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
    });
  }

  for (const [label, chunks] of [
    [
      "chunks smaller than a part, then one that fixes the part size",
      [3 * MiB, 4 * MiB, 6 * MiB + 1],
    ],
    ["equal chunks above the floor", [6 * MiB, 6 * MiB, 2 * MiB]],
    ["a first chunk smaller than the next", [5 * MiB + 3, 11 * MiB]],
    [
      "a large first chunk, then small ones",
      [12 * MiB, 1 * MiB, 3 * MiB, 9 * MiB],
    ],
  ] as const) {
    it(`fits any chunk sizes to R2's part rule: ${label}`, async () => {
      const auth = await bearerFor(basic(pushToken));
      const total = chunks.reduce((a, b) => a + b, 0);
      const bytes = new Uint8Array(randomBytes(total));
      const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
        headers: { authorization: auth },
      });
      let location = start.headers.get("location")!;
      let at = 0;
      for (const n of chunks) {
        const patch = await call("PATCH", location, {
          body: bytes.subarray(at, at + n),
          headers: {
            authorization: auth,
            "content-range": `${at}-${at + n - 1}`,
          },
        });
        expect(patch.status, await patch.clone().text()).toBe(202);
        at += n;
        expect(patch.headers.get("range")).toBe(`0-${at - 1}`);
        location = patch.headers.get("location")!;
      }
      const put = await call("PUT", `${location}?digest=${digestOf(bytes)}`, {
        headers: { authorization: auth },
      });
      expect(put.status, await put.clone().text()).toBe(201);
      const stored = await bucket.get(blobKey(sha(bytes)));
      expect(
        sha(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer())),
      ).toBe(sha(bytes));
      expect(bucket.openUploads()).toBe(0);
      expect(bucket.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
    });
  }

  it("a chunk out of order is 416 with the upload's range; a final chunk in the PUT is appended", async () => {
    const auth = await bearerFor(basic(pushToken));
    const bytes = enc("0123456789");
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const loc = start.headers.get("location")!;
    const first = await call("PATCH", loc, {
      body: bytes.subarray(0, 4),
      headers: { authorization: auth, "content-range": "0-3" },
    });
    expect(first.status).toBe(202);
    const skip = await call("PATCH", loc, {
      body: bytes.subarray(6),
      headers: { authorization: auth, "content-range": "6-9" },
    });
    expect(skip.status).toBe(416);
    expect(skip.headers.get("range")).toBe("0-3");
    expect(await ociCode(skip)).toBe("BLOB_UPLOAD_INVALID");
    const lying = await call("PATCH", loc, {
      body: bytes.subarray(4),
      headers: { authorization: auth, "content-range": "4-5" },
    });
    expect(lying.status).toBe(416);
    const put = await call("PUT", `${loc}?digest=${digestOf(bytes)}`, {
      body: bytes.subarray(4),
      headers: { authorization: auth, "content-range": "4-9" },
    });
    expect(put.status, await put.clone().text()).toBe(201);
  });

  it("a monolithic POST ?digest= stores the blob; a wrong digest stores nothing and forgets the upload", async () => {
    const auth = await bearerFor(basic(pushToken));
    const bytes = enc("monolithic\n");
    const ok = await call(
      "POST",
      `/v2/${NAME}/blobs/uploads/?digest=${digestOf(bytes)}`,
      {
        body: bytes,
        headers: { authorization: auth },
      },
    );
    expect(ok.status).toBe(201);
    expect(ok.headers.get("docker-content-digest")).toBe(digestOf(bytes));

    const other = enc("not what the digest says");
    const claimed = sha(enc("something else entirely"));
    const bad = await call(
      "POST",
      `/v2/${NAME}/blobs/uploads/?digest=sha256:${claimed}`,
      {
        body: other,
        headers: { authorization: auth },
      },
    );
    expect(bad.status).toBe(400);
    expect(await ociCode(bad)).toBe("DIGEST_INVALID");
    expect(bucket.has(blobKey(claimed))).toBe(false);
    expect(
      await db.first(
        "SELECT 1 FROM blob_objects WHERE storage_key = ?",
        blobKey(claimed),
      ),
    ).toBeNull();
    expect(bucket.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
  });

  it("uploading another tenant's digest earns a ref only with the very bytes", async () => {
    // globex holds an object acme never uploaded.
    const theirs = enc("globex private layer\n");
    bucket.seed(blobKey(sha(theirs)), theirs, { withSha256: true });
    await db.run(
      "INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at) VALUES (?, ?, ?, 'blob', 0, ?, ?)",
      blobKey(sha(theirs)),
      sha(theirs),
      theirs.length,
      NOW,
      NOW,
    );
    const auth = await bearerFor(basic(pushToken));
    // Garbage claiming their digest: refused, no ref.
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const patch = await call("PATCH", start.headers.get("location")!, {
      body: enc("x".repeat(theirs.length)),
      headers: { authorization: auth },
    });
    const put = await call(
      "PUT",
      `${patch.headers.get("location")}?digest=${digestOf(theirs)}`,
      {
        headers: { authorization: auth },
      },
    );
    expect(put.status).toBe(400);
    expect(await ociCode(put)).toBe("DIGEST_INVALID");
    expect(
      await db.first(
        "SELECT 1 FROM blob_refs WHERE product = ? AND storage_key = ?",
        OWNER,
        blobKey(sha(theirs)),
      ),
    ).toBeNull();
    // A mount of it falls back to a plain upload (acme does not hold it).
    const mount = await call(
      "POST",
      `/v2/${NAME}/blobs/uploads/?mount=${digestOf(theirs)}&from=tools/x`,
      {
        headers: { authorization: auth },
      },
    );
    expect(mount.status).toBe(202);
    // A manifest naming it without uploading it is refused.
    const manifest = enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: {
          mediaType: OCI_CONFIG,
          digest: digestOf(theirs),
          size: theirs.length,
        },
        layers: [],
      }),
    );
    const m = await putManifest(
      auth,
      digestOf(manifest),
      manifest,
      OCI_MANIFEST,
    );
    expect(m.status).toBe(400);
    expect(await ociCode(m)).toBe("MANIFEST_BLOB_UNKNOWN");
    // The very bytes: accepted (the upload proves possession).
    expect((await pushBlob(auth, theirs)).status).toBe(201);
  });

  it("a blob the owner already holds mounts at once (201)", async () => {
    const auth = await bearerFor(basic(pushToken));
    const held = ociFixture()[3]!.objects[1]!; // a published config of 1.1.0-beta.1
    const res = await call(
      "POST",
      `/v2/${NAME}/blobs/uploads/?mount=sha256:${held.sha256}&from=${OCI_REPO}`,
      {
        headers: { authorization: auth },
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("docker-content-digest")).toBe(
      `sha256:${held.sha256}`,
    );
  });

  it("the feed's per-blob ceiling refuses a chunk that would cross it", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET max_package_bytes = 100 WHERE product = ?",
      OWNER,
    );
    forgetRegistrySettings();
    const auth = await bearerFor(basic(pushToken));
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const res = await call("PATCH", start.headers.get("location")!, {
      body: new Uint8Array(101),
      headers: { authorization: auth },
    });
    expect(res.status).toBe(413);
    expect(await ociCode(res)).toBe("SIZE_INVALID");
  });

  it("an upload is the repository's: another repository's path does not find it", async () => {
    const auth = await bearerFor(basic(pushToken));
    const start = await call("POST", `/v2/${NAME}/blobs/uploads/`, {
      headers: { authorization: auth },
    });
    const id = start.headers.get("location")!.split("/").pop()!;
    // Declare a second repository and push to it with the first upload's id.
    await declareRepository("oci.other", "tools/other");
    const other = await bearerFor(basic(pushToken), `${OWNER}/tools/other`);
    const res = await call(
      "GET",
      `/v2/${OWNER}/tools/other/blobs/uploads/${id}`,
      { headers: { authorization: other } },
    );
    expect(res.status).toBe(404);
    expect(await ociCode(res)).toBe("BLOB_UPLOAD_UNKNOWN");
  });
});

// ── Manifests ────────────────────────────────────────────────────────────────────────────────

describe("manifest PUT", () => {
  it("a multi-arch image pushed under a version tag publishes the same rows a ticket publish writes", async () => {
    const auth = await bearerFor(basic(pushToken));
    const { img, res } = await pushMultiArch(auth, "2.0.0");
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get("docker-content-digest")).toBe(
      digestOf(img.index.bytes),
    );
    expect(res.headers.get("location")).toBe(
      `/v2/${NAME}/manifests/${digestOf(img.index.bytes)}`,
    );

    // What `pkey release publish` builds for the same image layout (`cli/src/package/oci.ts`):
    // every object, walked from the root, typed and named by digest; the root and platforms.
    const order: [Obj, string][] = [
      [img.index, "oci-index"],
      [img.amd.manifest, "oci-manifest"],
      [img.amd.config, "oci-blob"],
      [img.amd.layer, "oci-blob"],
      [img.arm.manifest, "oci-manifest"],
      [img.arm.config, "oci-blob"],
      [img.arm.layer, "oci-blob"],
    ];
    const row = await db.first<{
      release_id: string;
      state: string;
      files_json: string;
      metadata_json: string;
      source_json: string;
    }>(
      "SELECT release_id, state, files_json, metadata_json, source_json FROM release_packages WHERE product = ? AND version = '2.0.0'",
      OWNER,
    );
    expect(row?.release_id).toBe(`${OCI_ID}@2.0.0`);
    expect(row?.state).toBe("live");
    expect(JSON.parse(row!.files_json)).toEqual(
      order.map(([o, type]) => ({
        name: digestOf(o.bytes),
        type,
        sha256: sha(o.bytes),
        size: o.bytes.length,
        mediaType: o.mediaType,
      })),
    );
    expect(JSON.parse(row!.metadata_json)).toEqual({
      name: OCI_REPO,
      version: "2.0.0",
      root: digestOf(img.index.bytes),
      mediaType: OCI_INDEX,
      platforms: ["linux/amd64", "linux/arm64"],
    });
    const source = JSON.parse(row!.source_json) as Record<string, unknown>;
    expect(source).toMatchObject({ kind: "registry", via: "oci-push" });
    // The release row, its artifacts and their refs, as the ingest writes them for a ticket.
    const artifacts = await db.all<{ storage_key: string }>(
      "SELECT storage_key FROM release_artifacts WHERE product = ? AND release_id = ? ORDER BY artifact_id",
      OWNER,
      `${OCI_ID}@2.0.0`,
    );
    expect(artifacts.map((a) => a.storage_key).sort()).toEqual(
      order.map(([o]) => blobKey(sha(o.bytes))).sort(),
    );
    const refs = await db.all<{ storage_key: string }>(
      "SELECT storage_key FROM blob_refs WHERE product = ? AND ref_kind = 'package-file' AND ref_id LIKE ?",
      OWNER,
      `${OCI_ID}@2.0.0/%`,
    );
    expect(refs).toHaveLength(order.length);
    const audit = await db.first<{ actor_sub: string; summary: string }>(
      "SELECT actor_sub, summary FROM audit WHERE product = ? AND action = 'release.publish' AND target_id = ?",
      OWNER,
      `${OCI_ID}@2.0.0`,
    );
    expect(audit?.summary).toContain("docker push");
    expect(audit?.actor_sub).toMatch(/^registry:rtok_/);

    golden(
      "push-2.0.0.json",
      `${JSON.stringify(
        {
          files: JSON.parse(row!.files_json),
          metadata: JSON.parse(row!.metadata_json),
          source: { kind: source.kind, via: source.via },
        },
        null,
        2,
      )}\n`,
    );

    // The pull side serves it at once: by tag, by digest, in the tag list.
    const pulled = await call("GET", `/v2/${NAME}/manifests/2.0.0`, {
      headers: { authorization: auth },
    });
    expect(pulled.status).toBe(200);
    expect(new Uint8Array(await pulled.arrayBuffer())).toEqual(img.index.bytes);
    const tags = await call("GET", `/v2/${NAME}/tags/list`, {
      headers: { authorization: auth },
    });
    expect(((await tags.json()) as { tags: string[] }).tags).toContain("2.0.0");
    const layer = await call(
      "GET",
      `/v2/${NAME}/blobs/${digestOf(img.arm.layer.bytes)}`,
      {
        headers: { authorization: auth },
      },
    );
    expect(layer.status).toBe(200);
  });

  it("re-pushing the same version is unchanged (201, no second audit); a different image under it is 409", async () => {
    const auth = await bearerFor(basic(pushToken));
    const first = await pushMultiArch(auth, "2.0.0");
    expect(first.res.status).toBe(201);
    const again = await putManifest(
      auth,
      "2.0.0",
      first.img.index.bytes,
      OCI_INDEX,
    );
    expect(again.status).toBe(201);
    const audits = await db.all(
      "SELECT 1 FROM audit WHERE product = ? AND target_id = ?",
      OWNER,
      `${OCI_ID}@2.0.0`,
    );
    expect(audits).toHaveLength(1);
    const single = image("2.0.0-other", "amd64", DOCKER_MANIFEST);
    for (const b of [single.layer, single.config])
      await pushBlob(auth, b.bytes);
    const taken = await putManifest(
      auth,
      "2.0.0",
      single.manifest.bytes,
      DOCKER_MANIFEST,
    );
    expect(taken.status).toBe(409);
    expect(await ociCode(taken)).toBe("DENIED");
    // A published version's tag also refuses (the fixture's 1.0.0, and the yanked 0.9.0).
    for (const v of ["1.0.0", "0.9.0"]) {
      const res = await putManifest(
        auth,
        v,
        single.manifest.bytes,
        DOCKER_MANIFEST,
      );
      expect(res.status, v).toBe(409);
    }
  });

  it("a Docker schema 2 manifest pushed by tag publishes a single-platform version", async () => {
    const auth = await bearerFor(basic(pushToken));
    const img = image("3.0.0", "amd64", DOCKER_MANIFEST);
    for (const b of [img.layer, img.config])
      expect((await pushBlob(auth, b.bytes)).status).toBe(201);
    const res = await putManifest(
      auth,
      "3.0.0",
      img.manifest.bytes,
      DOCKER_MANIFEST,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const row = await db.first<{ metadata_json: string }>(
      "SELECT metadata_json FROM release_packages WHERE product = ? AND version = '3.0.0'",
      OWNER,
    );
    expect(JSON.parse(row!.metadata_json)).toEqual({
      name: OCI_REPO,
      version: "3.0.0",
      root: digestOf(img.manifest.bytes),
      mediaType: DOCKER_MANIFEST,
    });
  });

  it("channel tags are refused: they are moved by pkey release promote, never pushed", async () => {
    const auth = await bearerFor(basic(pushToken));
    const img = image("4.0.0", "amd64");
    for (const b of [img.layer, img.config]) await pushBlob(auth, b.bytes);
    for (const tag of ["latest", "stable", "beta", "staging", "pr-12"]) {
      const res = await putManifest(
        auth,
        tag,
        img.manifest.bytes,
        OCI_MANIFEST,
      );
      expect(res.status, tag).toBe(400);
      expect(await ociCode(res), tag).toBe("TAG_INVALID");
    }
    expect(
      await db.first(
        "SELECT 1 FROM release_packages WHERE product = ? AND version IN ('latest','beta')",
        OWNER,
      ),
    ).toBeNull();
  });

  it("a manifest by digest is stored and held, and publishes nothing", async () => {
    const auth = await bearerFor(basic(pushToken));
    const img = image("5.0.0", "amd64");
    for (const b of [img.layer, img.config]) await pushBlob(auth, b.bytes);
    const before = await db.all(
      "SELECT 1 FROM release_packages WHERE product = ?",
      OWNER,
    );
    const res = await putManifest(
      auth,
      digestOf(img.manifest.bytes),
      img.manifest.bytes,
      OCI_MANIFEST,
    );
    expect(res.status).toBe(201);
    expect(bucket.has(blobKey(sha(img.manifest.bytes)))).toBe(true);
    expect(
      await db.all("SELECT 1 FROM release_packages WHERE product = ?", OWNER),
    ).toHaveLength(before.length);
  });

  it("refuses a manifest that is malformed, mistyped, mis-digested, oversized or names missing objects", async () => {
    const auth = await bearerFor(basic(pushToken));
    const img = image("6.0.0", "amd64");
    await pushBlob(auth, img.config.bytes);
    // The layer was never pushed.
    const missing = await putManifest(
      auth,
      "6.0.0",
      img.manifest.bytes,
      OCI_MANIFEST,
    );
    expect(missing.status).toBe(400);
    expect(await ociCode(missing)).toBe("MANIFEST_BLOB_UNKNOWN");
    await pushBlob(auth, img.layer.bytes);
    const wrongType = await putManifest(
      auth,
      "6.0.0",
      img.manifest.bytes,
      "application/json",
    );
    expect(await ociCode(wrongType)).toBe("MANIFEST_INVALID");
    const disagree = await putManifest(
      auth,
      "6.0.0",
      img.manifest.bytes,
      DOCKER_MANIFEST,
    );
    expect(await ociCode(disagree)).toBe("MANIFEST_INVALID");
    const misdigest = await putManifest(
      auth,
      `sha256:${"0".repeat(64)}`,
      img.manifest.bytes,
      OCI_MANIFEST,
    );
    expect(await ociCode(misdigest)).toBe("DIGEST_INVALID");
    const notJson = await putManifest(auth, "6.0.0", enc("{"), OCI_MANIFEST);
    expect(await ociCode(notJson)).toBe("MANIFEST_INVALID");
    const big = await putManifest(
      auth,
      "6.0.0",
      new Uint8Array(4 * MiB + 1),
      OCI_MANIFEST,
    );
    expect(big.status).toBe(413);
    const badTag = await putManifest(
      auth,
      "-bad",
      img.manifest.bytes,
      OCI_MANIFEST,
    );
    expect(await ociCode(badTag)).toBe("TAG_INVALID");
    // A declared size that is not the stored one.
    const lying = enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { ...desc(img.config), size: img.config.bytes.length + 1 },
        layers: [desc(img.layer)],
      }),
    );
    const sized = await putManifest(auth, "6.0.0", lying, OCI_MANIFEST);
    expect(await ociCode(sized)).toBe("MANIFEST_INVALID");
    expect(
      await db.first(
        "SELECT 1 FROM release_packages WHERE product = ? AND version = '6.0.0'",
        OWNER,
      ),
    ).toBeNull();
  });

  it("an index naming a platform manifest that was never pushed is refused", async () => {
    const auth = await bearerFor(basic(pushToken));
    const img = multiArch("7.0.0");
    for (const p of [img.amd]) {
      for (const b of [p.layer, p.config]) await pushBlob(auth, b.bytes);
      await putManifest(
        auth,
        digestOf(p.manifest.bytes),
        p.manifest.bytes,
        OCI_MANIFEST,
      );
    }
    const res = await putManifest(auth, "7.0.0", img.index.bytes, OCI_INDEX);
    expect(res.status).toBe(400);
    expect(await ociCode(res)).toBe("MANIFEST_BLOB_UNKNOWN");
  });

  it("a CI token's push is recorded as the CI token, like its ticket publish", async () => {
    const ci = await issueStaticCiToken(env, db, {
      product: OWNER,
      label: "build",
      scopes: ["release:publish"],
      expiresAt: NOW + 86_400,
      createdBy: "admin:a",
      now: NOW,
    });
    const auth = await bearerFor(basic(ci.token));
    const img = image("8.0.0", "amd64");
    for (const b of [img.layer, img.config]) await pushBlob(auth, b.bytes);
    expect(
      (await putManifest(auth, "8.0.0", img.manifest.bytes, OCI_MANIFEST))
        .status,
    ).toBe(201);
    const row = await db.first<{ source_json: string }>(
      "SELECT source_json FROM release_packages WHERE product = ? AND version = '8.0.0'",
      OWNER,
    );
    expect(JSON.parse(row!.source_json)).toEqual({
      kind: "static",
      tokenId: ci.tokenId,
      via: "oci-push",
    });
  });
});

describe("parseOciManifest", () => {
  it("reads an image manifest and an index, and says why it refuses", () => {
    const img = image("9.0.0", "amd64");
    const m = parseOciManifest(img.manifest.bytes, OCI_MANIFEST);
    expect(typeof m === "object" && m.kind).toBe("manifest");
    const idx = parseOciManifest(multiArch("9.0.0").index.bytes, OCI_INDEX);
    expect(
      typeof idx === "object" && idx.kind === "index" && idx.children,
    ).toHaveLength(2);
    expect(parseOciManifest(enc('{"schemaVersion":1}'), OCI_MANIFEST)).toBe(
      "schemaVersion must be 2",
    );
    expect(
      parseOciManifest(
        enc(
          JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                mediaType: "text/plain",
                digest: `sha256:${"a".repeat(64)}`,
                size: 1,
              },
            ],
          }),
        ),
        OCI_INDEX,
      ),
    ).toMatch(/not a manifest type/);
  });
});

function golden(file: string, body: string): void {
  const path = join(GOLDEN, file);
  if (process.env.UPDATE_REGISTRY_GOLDENS === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, body);
    return;
  }
  expect(body).toBe(readFileSync(path, "utf8"));
}
