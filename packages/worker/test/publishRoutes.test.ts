/**
 * P2-02 — trusted publishing through the real dispatcher: the three routes, and the publisher
 * policy's ingest in link and resync.
 *
 *   POST /<p>/release/publish/token    a fake GitHub OIDC token (local RSA key, test JWKS) in
 *   POST /<p>/release/publish/uploads  ticket + R2 temporary credentials, `present`, `nextSeq`
 *   POST /<p>/release/publish/submit   verify staged objects (R2 fake), promote, ingest
 *
 * Real GitHub OIDC and a real R2 parent token do not exist here; the hand-off lists the checks
 * that need them.
 */

import { createHash } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { parseManifest } from "@polaris-key/manifest";
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
  claimPublisherPolicy,
  getPublisherPolicy,
  GITHUB_OIDC_ISSUER,
  issueStaticCiToken,
  publishAudience,
  stmtUpsertManifestPublisher,
} from "../src/core/publisher.js";
import { setPublishJwksFetcherForTests } from "../src/services/release/publish.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { recordRef } from "../src/core/blobs.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

installDigestStream();

const OWNER = "acme";
const REPO = "djdl";
const REPO_ID = 555;
const OWNER_ID = 77;
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

let key: { privateKey: KeyLike; publicKey: KeyLike };
let jwk: JWK;
beforeAll(async () => {
  key = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(key.publicKey)), kid: "gh-1", alg: "RS256" };
});

let jti = 0;
async function oidc(
  over: Record<string, unknown> = {},
  aud?: string,
): Promise<string> {
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
    ...over,
  })
    .setProtectedHeader({ alg: "RS256", kid: "gh-1" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(aud ?? publishAudience(CONSOLE, SLUG))
    .setIssuedAt(NOW - 5)
    .setExpirationTime(NOW + 300)
    .setJti(`route-jti-${++jti}`)
    .sign(key.privateKey);
}

// ── The product: Release on, an app deliverable with a web build, a publisher policy ──────

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: OWNER, repo: REPO },
    binaryName: "djdl",
    publishing: {
      trustedPublisher: { workflow: ".github/workflows/release.yml" },
    },
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
          {
            id: "linux",
            platform: "linux",
            arch: "x86_64",
            format: "tar.gz",
            match: "djdl-*-linux.tar.gz",
          },
        ],
      },
    },
  },
};
const PRODUCT_DOC = {
  slug: SLUG,
  name: "djdl",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
  },
};
const SCHEMA_DOC = { schemaVersion: 1, entries: [] };

function appDeclaration() {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify(SCHEMA_DOC),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

let db: Db;
let env: Env;
let r2: R2Mock;
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

async function seedPolicy(): Promise<void> {
  const s = stmtUpsertManifestPublisher({
    product: SLUG,
    repositoryId: REPO_ID,
    repositoryOwnerId: OWNER_ID,
    repository: `${OWNER}/${REPO}`,
    workflow: ".github/workflows/release.yml",
    environment: "release",
    now: NOW,
  });
  await db.run(s.sql, ...s.params);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db);
  await seedReleaseProduct(db, {}, "other");
  await db.batch(manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
  await seedPolicy();
  setPublishJwksFetcherForTests(async () => ({ keys: [jwk] }));
});

afterEach(() => {
  vi.useRealTimers();
  setPublishJwksFetcherForTests(null);
});

function post(path: string, body: unknown, token?: string, product = SLUG) {
  return call(
    env,
    db,
    noFetch,
    `${CONSOLE}/${product}/release/publish/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function exchange(over: Record<string, unknown> = {}) {
  const res = await post("token", { token: await oidc(over) });
  return { res, body: (await res.json()) as Record<string, any> };
}

async function ciToken(): Promise<string> {
  const { res, body } = await exchange();
  expect(res.status).toBe(200);
  return body.token as string;
}

// ── The bytes and the descriptor ───────────────────────────────────────────────────────────

const WEB = new TextEncoder().encode("web build bytes, version 1.3.0");
const WEB_SHA = sha(WEB);
const LINUX = new TextEncoder().encode("linux tarball bytes, version 1.3.0");
const LINUX_SHA = sha(LINUX);

function descriptor(version = "1.3.0"): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    channel: "stable",
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        artifacts: [
          {
            name: `djdl-${version}-web.zip`,
            role: "payload",
            sha256: WEB_SHA,
            size: WEB.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${WEB_SHA}` }],
          },
        ],
      },
      {
        id: "linux",
        platform: "linux",
        arch: "x86_64",
        format: "tar.gz",
        artifacts: [
          {
            name: `djdl-${version}-linux.tar.gz`,
            role: "payload",
            sha256: LINUX_SHA,
            size: LINUX.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${LINUX_SHA}` }],
          },
        ],
      },
    ],
  };
}

const OBJECTS = [
  { sha256: WEB_SHA, size: WEB.length },
  { sha256: LINUX_SHA, size: LINUX.length },
];

async function ticketFor(token: string, objects = OBJECTS) {
  const res = await post("uploads", { objects }, token);
  return { res, body: (await res.json()) as Record<string, any> };
}

/** CI's PUT: what R2 would hold after an upload with `x-amz-checksum-sha256`. */
function upload(
  prefix: string,
  bytes: Uint8Array,
  opts = { withSha256: true },
) {
  r2.seed(`${prefix}${sha(bytes)}`, bytes, opts);
}

async function tableCounts() {
  const n = async (t: string) =>
    (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  return {
    objects: await n("blob_objects"),
    refs: await n("blob_refs"),
    releases: await n("release_metadata"),
  };
}

// ── /token ─────────────────────────────────────────────────────────────────────────────────

describe("POST /release/publish/token", () => {
  it("exchanges a policy-satisfying OIDC token for a scoped pkeyci_ token", async () => {
    const { res, body } = await exchange();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      expiresAt: NOW + 1800,
      scopes: ["distribution:report", "release:promote", "release:publish"],
    });
    expect(body.token).toMatch(/^pkeyci_/);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a claim mismatch 403 policy_mismatch, naming the claim", async () => {
    const { res, body } = await exchange({ runner_environment: "self-hosted" });
    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      error: "forbidden",
      reason: "policy_mismatch",
      claim: "runner_environment",
    });
  });

  it("refuses a token minted for another product's audience 401", async () => {
    const res = await post("token", {
      token: await oidc({}, publishAudience(CONSOLE, "other")),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "invalid_oidc_token" });
  });

  it("refuses a replay 401 oidc_token_replayed", async () => {
    const token = await oidc();
    expect((await post("token", { token })).status).toBe(200);
    const again = await post("token", { token });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: "oidc_token_replayed" });
  });

  it("refuses a malformed body 400, and does not exist for GET", async () => {
    expect((await post("token", { nope: 1 })).status).toBe(400);
    const get = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/publish/token`,
    );
    expect(get.status).toBe(404);
  });

  it("does not exist for a product with Release off", async () => {
    const res = await post(
      "token",
      { token: await oidc() },
      undefined,
      "nonexistent",
    );
    expect(res.status).toBe(404);
  });
});

// ── /uploads ───────────────────────────────────────────────────────────────────────────────

describe("POST /release/publish/uploads", () => {
  it("issues a ticket, prefix-scoped credentials, present flags and nextSeq", async () => {
    const token = await ciToken();
    const { res, body } = await ticketFor(token);
    expect(res.status).toBe(200);
    expect(body.ticket).toMatch(/^pkeyup_/);
    expect(body.prefix).toMatch(
      new RegExp(`^staging/${SLUG}/[A-Za-z0-9_-]{22}/$`),
    );
    expect(body.credentials).toMatchObject({
      endpoint: `https://${R2_ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: R2_ENV.BLOBS_BUCKET_NAME,
      accessKeyId: R2_ENV.R2_PARENT_ACCESS_KEY_ID,
    });
    expect(JSON.stringify(body)).not.toContain(
      R2_ENV.R2_PARENT_SECRET_ACCESS_KEY,
    );
    expect(body.objects).toEqual([
      expect.objectContaining({
        sha256: WEB_SHA,
        key: `${body.prefix}${WEB_SHA}`,
        present: false,
      }),
      expect.objectContaining({
        sha256: LINUX_SHA,
        key: `${body.prefix}${LINUX_SHA}`,
        present: false,
      }),
    ]);
    expect(body.nextSeq).toEqual({ app: 1 });
    expect(body.expiresAt).toBe(NOW + 1800);
  });

  it("marks present only what THIS product references — never another product's copy", async () => {
    // `other` already published WEB; djdl has never held it.
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, ?, 'blob', 0, ?, ?)`,
      `blobs/sha256/${WEB_SHA}`,
      WEB_SHA,
      WEB.length,
      NOW,
      NOW,
    );
    await recordRef(
      db,
      {
        product: "other",
        storageKey: `blobs/sha256/${WEB_SHA}`,
        refKind: "artifact",
        refId: "x",
      },
      NOW,
    );
    const token = await ciToken();
    let { body } = await ticketFor(token);
    expect(body.objects.map((o: any) => o.present)).toEqual([false, false]);
    // Once djdl itself references it, it is present for djdl.
    await recordRef(
      db,
      {
        product: SLUG,
        storageKey: `blobs/sha256/${WEB_SHA}`,
        refKind: "artifact",
        refId: "y",
      },
      NOW,
    );
    ({ body } = await ticketFor(token));
    expect(body.objects.map((o: any) => o.present)).toEqual([true, false]);
  });

  it("a token without release:publish cannot obtain a ticket (403 missing_scope)", async () => {
    const t = await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:promote"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    });
    const { res, body } = await ticketFor(t.token);
    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      reason: "missing_scope",
      scope: "release:publish",
    });
  });

  it("refuses a revoked, an expired, an unknown and another product's token (401)", async () => {
    const mk = (product: string, expiresAt: number) =>
      issueStaticCiToken(env, db, {
        product,
        scopes: ["release:publish"],
        expiresAt,
        label: null,
        createdBy: "u1",
        now: NOW,
      });
    const expired = await mk(SLUG, NOW - 1);
    const foreign = await mk("other", NOW + 3600);
    const revoked = await mk(SLUG, NOW + 3600);
    await db.run(
      "UPDATE ci_tokens SET revoked_at = ? WHERE token_id = ?",
      NOW,
      revoked.tokenId,
    );
    for (const token of [
      expired.token,
      foreign.token,
      revoked.token,
      `pkeyci_${"z".repeat(43)}`,
    ]) {
      const { res, body } = await ticketFor(token);
      expect(res.status, token).toBe(401);
      expect(body.reason).toBe("invalid_ci_token");
    }
    expect((await ticketFor("")).res.status).toBe(401);
  });

  it("answers not-found until the parent R2 token is configured", async () => {
    const token = await ciToken();
    delete env.R2_PARENT_SECRET_ACCESS_KEY;
    expect((await ticketFor(token)).res.status).toBe(404);
    // And with no token at all — the route simply does not exist.
    expect((await ticketFor("")).res.status).toBe(404);
  });

  it("refuses malformed objects 400", async () => {
    const token = await ciToken();
    const { res, body } = await ticketFor(token, [
      { sha256: "nope", size: 1 },
    ] as never);
    expect(res.status).toBe(400);
    expect(body.reason).toBe("bad_objects");
  });
});

// ── /submit ────────────────────────────────────────────────────────────────────────────────

describe("POST /release/publish/submit", () => {
  async function staged() {
    const token = await ciToken();
    const { body } = await ticketFor(token);
    return {
      token,
      ticket: body.ticket as string,
      prefix: body.prefix as string,
    };
  }

  it("verifies, promotes and ingests: the release, its files and this product's refs", async () => {
    const { token, ticket, prefix } = await staged();
    upload(prefix, WEB);
    upload(prefix, LINUX, { withSha256: false }); // re-hashed by streaming
    const res = await post(
      "submit",
      { ticket, descriptor: descriptor() },
      token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      dryRun: false,
      releaseId: "app@1.3.0",
      outcome: "created",
    });
    expect(r2.has(`blobs/sha256/${WEB_SHA}`)).toBe(true);
    expect(r2.has(`blobs/sha256/${LINUX_SHA}`)).toBe(true);
    // Staged copies are cleaned up.
    expect(r2.keys().filter((k) => k.startsWith("staging/"))).toEqual([]);
    const refs = await db.all<{ product: string; storage_key: string }>(
      "SELECT product, storage_key FROM blob_refs ORDER BY storage_key",
    );
    expect(refs.map((r) => r.product)).toEqual([SLUG, SLUG]);
    const audit = await db.all<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM audit WHERE product = ? AND action = 'release.publish'",
      SLUG,
    );
    expect(audit).toEqual([
      {
        action: "release.publish",
        actor_sub: expect.stringMatching(/^ci:github:repo:acme\/djdl/),
      },
    ]);
  });

  it("dryRun validates everything and writes nothing — no promote, no ticket redemption", async () => {
    const { token, ticket, prefix } = await staged();
    upload(prefix, WEB);
    upload(prefix, LINUX);
    const res = await post(
      "submit",
      { ticket, descriptor: descriptor(), dryRun: true },
      token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      dryRun: true,
      outcome: "created",
    });
    expect(await tableCounts()).toEqual({ objects: 0, refs: 0, releases: 0 });
    expect(r2.has(`blobs/sha256/${WEB_SHA}`)).toBe(false);
    // The real submit still works with the same ticket.
    expect(
      (await post("submit", { ticket, descriptor: descriptor() }, token))
        .status,
    ).toBe(200);
  });

  const refusals: Array<[string, (prefix: string) => void, string]> = [
    [
      "a staged object is missing",
      (p) => upload(p, WEB),
      "staged_object_missing",
    ],
    [
      "a staged object's SHA-256 differs",
      (p) => {
        upload(p, WEB);
        r2.seed(
          `${p}${LINUX_SHA}`,
          new TextEncoder().encode("tampered bytes, same length!!!!!!!"),
        );
      },
      "staged_object_mismatch",
    ],
    [
      "a staged object's size differs",
      (p) => {
        upload(p, WEB);
        r2.seed(`${p}${LINUX_SHA}`, new TextEncoder().encode("short"));
      },
      "staged_object_mismatch",
    ],
  ];
  for (const [name, stage, reason] of refusals) {
    it(`refuses when ${name}, and promotes nothing`, async () => {
      const { token, ticket, prefix } = await staged();
      stage(prefix);
      const res = await post(
        "submit",
        { ticket, descriptor: descriptor() },
        token,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason });
      expect(r2.putAttempts).toEqual([]);
      expect(r2.has(`blobs/sha256/${WEB_SHA}`)).toBe(false);
      expect(await tableCounts()).toEqual({ objects: 0, refs: 0, releases: 0 });
    });
  }

  it("refuses a descriptor refusal before promoting anything", async () => {
    const { token, ticket, prefix } = await staged();
    upload(prefix, WEB);
    upload(prefix, LINUX);
    const bad = descriptor();
    bad.builds[0].id = "not-declared";
    const res = await post("submit", { ticket, descriptor: bad }, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid_descriptor" });
    expect(r2.putAttempts).toEqual([]);
    expect(await tableCounts()).toEqual({ objects: 0, refs: 0, releases: 0 });
  });

  it("refuses an r2 object the ticket was not issued for", async () => {
    const token = await ciToken();
    const { body } = await ticketFor(token, [OBJECTS[0]!]);
    upload(body.prefix, WEB);
    upload(body.prefix, LINUX);
    const res = await post(
      "submit",
      { ticket: body.ticket, descriptor: descriptor() },
      token,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "object_not_in_ticket" });
  });

  it("a ticket cannot be redeemed twice", async () => {
    const { token, ticket, prefix } = await staged();
    upload(prefix, WEB);
    upload(prefix, LINUX);
    expect(
      (await post("submit", { ticket, descriptor: descriptor() }, token))
        .status,
    ).toBe(200);
    const again = await post(
      "submit",
      { ticket, descriptor: descriptor("1.4.0") },
      token,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ reason: "ticket_redeemed" });
  });

  it("a ticket cannot be redeemed by another product's token, nor another token", async () => {
    const { ticket, prefix } = await staged();
    upload(prefix, WEB);
    upload(prefix, LINUX);
    const foreign = await issueStaticCiToken(env, db, {
      product: "other",
      scopes: ["release:publish"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    });
    // At its own product's route the ticket is unknown…
    const atOther = await post(
      "submit",
      { ticket, descriptor: { ...descriptor(), product: "other" } },
      foreign.token,
      "other",
    );
    expect(atOther.status).toBe(403);
    expect(await atOther.json()).toMatchObject({ reason: "invalid_ticket" });
    // …and at this product's route its token is refused outright.
    expect(
      (
        await post(
          "submit",
          { ticket, descriptor: descriptor() },
          foreign.token,
        )
      ).status,
    ).toBe(401);
    const sibling = await ciToken();
    const bySibling = await post(
      "submit",
      { ticket, descriptor: descriptor() },
      sibling,
    );
    expect(bySibling.status).toBe(403);
    expect(await bySibling.json()).toMatchObject({ reason: "invalid_ticket" });
  });

  it("a failed submit gives the ticket back: fix the upload and send it again", async () => {
    const { token, ticket, prefix } = await staged();
    upload(prefix, WEB);
    expect(
      (await post("submit", { ticket, descriptor: descriptor() }, token))
        .status,
    ).toBe(400);
    upload(prefix, LINUX);
    expect(
      (await post("submit", { ticket, descriptor: descriptor() }, token))
        .status,
    ).toBe(200);
  });

  it("answers identically whether or not another product already stored the bytes", async () => {
    // Product `other` publishes the same two objects first (its own upload, its own refs).
    await db.run(
      `INSERT INTO ci_publishers (product, provider, repository_id, repository_owner_id, repository,
         workflow, environment, scopes_json, source, created_at, modified_at)
       VALUES ('other', 'github', 1, 1, 'x/y', '.github/workflows/r.yml', 'release', '[]', 'admin', 0, 0)`,
    );
    const first = await staged();
    upload(first.prefix, WEB);
    upload(first.prefix, LINUX);
    const a = await post(
      "submit",
      { ticket: first.ticket, descriptor: descriptor("1.3.0") },
      first.token,
    );
    const second = await staged();
    upload(second.prefix, WEB);
    upload(second.prefix, LINUX);
    // Same bytes again (already stored now), new version: CI must see the same shape.
    const b = await post(
      "submit",
      { ticket: second.ticket, descriptor: descriptor("1.4.0") },
      second.token,
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ja, jb] = [
      (await a.json()) as Record<string, unknown>,
      (await b.json()) as Record<string, unknown>,
    ];
    expect(Object.keys(ja).sort()).toEqual(Object.keys(jb).sort());
    expect(JSON.stringify(jb)).not.toMatch(/alreadyStored|already/i);
    expect({ ...ja, releaseId: 0, descriptorSha256: 0 }).toEqual({
      ...jb,
      releaseId: 0,
      descriptorSha256: 0,
    });
  });

  it("a resubmit of the same descriptor is unchanged, not an error", async () => {
    const first = await staged();
    upload(first.prefix, WEB);
    upload(first.prefix, LINUX);
    expect(
      (
        await post(
          "submit",
          { ticket: first.ticket, descriptor: descriptor() },
          first.token,
        )
      ).status,
    ).toBe(200);
    // Everything is referenced now: a new ticket needs no uploads at all.
    const token = await ciToken();
    const { body } = await ticketFor(token);
    expect(body.objects.map((o: any) => o.present)).toEqual([true, true]);
    const res = await post(
      "submit",
      { ticket: body.ticket, descriptor: descriptor() },
      token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "unchanged" });
    expect(body.nextSeq).toEqual({ app: 2 });
  });

  it("needs release:publish", async () => {
    const t = await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:yank"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    });
    const res = await post(
      "submit",
      { ticket: "pkeyup_x", descriptor: descriptor() },
      t.token,
    );
    expect(res.status).toBe(403);
  });
});

// ── Link and resync write the policy; an operator's claim survives resync ──────────────────

function githubStub(
  opts: { releaseDoc?: unknown; repoId?: number } = {},
): FetchImpl {
  const files: Record<string, string> = {
    ".pkey/schema.json": JSON.stringify(SCHEMA_DOC),
    ".pkey/product.json": JSON.stringify(PRODUCT_DOC),
    ".pkey/release.json": JSON.stringify(opts.releaseDoc ?? RELEASE_DOC),
  };
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/installation"))
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_x" }), { status: 200 });
    if (url === `https://api.github.com/repos/${OWNER}/${REPO}`)
      return new Response(
        JSON.stringify({
          id: opts.repoId ?? REPO_ID,
          full_name: `${OWNER}/${REPO}`,
          owner: { id: OWNER_ID },
        }),
        { status: 200 },
      );
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`))
          return new Response(
            JSON.stringify({
              content: Buffer.from(body).toString("base64"),
              encoding: "base64",
            }),
            { status: 200 },
          );
      return new Response("nf", { status: 404 });
    }
    return new Response("nf", { status: 404 });
  };
}

describe("publisher policy ingest", () => {
  it("link writes a manifest-owned policy with GitHub's numeric ids", async () => {
    const fresh = makeTestDb();
    const res = await linkRepo(
      env,
      fresh,
      `${OWNER}/${REPO}`,
      NOW,
      githubStub(),
    );
    expect(res).toMatchObject({ ok: true });
    expect(await getPublisherPolicy(fresh, SLUG)).toMatchObject({
      source: "manifest",
      repositoryId: REPO_ID,
      repositoryOwnerId: OWNER_ID,
      repository: `${OWNER}/${REPO}`,
      workflow: ".github/workflows/release.yml",
      environment: "release",
    });
  });

  async function linked() {
    await db.run(
      "UPDATE products SET release_source = 'github' WHERE slug = ?",
      SLUG,
    );
  }

  it("resync follows the manifest (and audits the change) while the policy is manifest-owned", async () => {
    await linked();
    const moved = structuredClone(RELEASE_DOC) as any;
    moved.release.publishing.trustedPublisher = {
      workflow: ".github/workflows/publish.yml",
      environment: "prod",
    };
    expect(
      await resyncRepo(
        env,
        db,
        SLUG,
        NOW + 10,
        githubStub({ releaseDoc: moved, repoId: 556 }),
      ),
    ).toMatchObject({ ok: true });
    expect(await getPublisherPolicy(db, SLUG)).toMatchObject({
      source: "manifest",
      repositoryId: 556,
      workflow: ".github/workflows/publish.yml",
      environment: "prod",
    });
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND action = 'ci.publisher.manifest'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    // Dropping the declaration drops the manifest-owned policy.
    const none = structuredClone(RELEASE_DOC) as any;
    delete none.release.publishing;
    await resyncRepo(env, db, SLUG, NOW + 20, githubStub({ releaseDoc: none }));
    expect(await getPublisherPolicy(db, SLUG)).toBeNull();
  });

  it("a resync cannot change an operator-claimed policy", async () => {
    await linked();
    await claimPublisherPolicy(
      db,
      SLUG,
      { environment: "locked-down", scopes: ["release:publish"] },
      "u1",
      NOW + 1,
    );
    const before = await getPublisherPolicy(db, SLUG);
    const hostile = structuredClone(RELEASE_DOC) as any;
    hostile.release.publishing.trustedPublisher = {
      workflow: ".github/workflows/anything.yml",
      environment: "dev",
    };
    expect(
      await resyncRepo(
        env,
        db,
        SLUG,
        NOW + 10,
        githubStub({ releaseDoc: hostile, repoId: 999 }),
      ),
    ).toMatchObject({ ok: true });
    expect(await getPublisherPolicy(db, SLUG)).toEqual(before);
    const removed = structuredClone(RELEASE_DOC) as any;
    delete removed.release.publishing;
    await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 20,
      githubStub({ releaseDoc: removed }),
    );
    expect(await getPublisherPolicy(db, SLUG)).toEqual(before);
  });

  it("a GitHub failure resolving the ids refuses the resync before any write", async () => {
    await linked();
    const failing: FetchImpl = async (input) =>
      String(input) === `https://api.github.com/repos/${OWNER}/${REPO}`
        ? new Response("boom", { status: 500 })
        : githubStub()(input);
    const res = await resyncRepo(env, db, SLUG, NOW + 10, failing);
    expect(res).toMatchObject({ ok: false });
  });
});

// ── The operator path (admin API, narrative-only) ──────────────────────────────────────────

async function adminCall(
  method: string,
  resource: string,
  body?: unknown,
  opts: { csrf?: boolean } = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/${resource}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        ...(opts.csrf === false ? {} : { [CSRF_HEADER]: session.csrf }),
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

describe("operator path: policy claim and static tokens", () => {
  it("reads and claims the policy; the claim is audited and wins over resync", async () => {
    const got = await adminCall("GET", "ci-publisher");
    expect(await got.json()).toMatchObject({ policy: { source: "manifest" } });
    const res = await adminCall("PUT", "ci-publisher", {
      environment: "prod",
      scopes: ["release:publish", "release:yank"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      policy: {
        source: "admin",
        environment: "prod",
        scopes: ["release:publish", "release:yank"],
      },
    });
    const audit = await db.all<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM audit WHERE action = 'ci.publisher.claim'",
    );
    expect(audit).toEqual([{ action: "ci.publisher.claim", actor_sub: "u1" }]);
    // The repo's OIDC token for the old environment no longer satisfies it.
    const { res: tok, body } = await exchange();
    expect(tok.status).toBe(403);
    expect(body.claim).toBe("environment");
  });

  it("refuses bad claim fields and unknown scopes", async () => {
    for (const body of [
      { workflow: "release.yml" },
      { environment: "a/b" },
      { scopes: ["release:everything"] },
      { scopes: [] },
      { repositoryId: -1 },
      { repository: "no-slash" },
    ]) {
      const res = await adminCall("PUT", "ci-publisher", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("issues a static token once, lists it without a value, and revokes it", async () => {
    const res = await adminCall("POST", "ci-tokens", {
      scopes: ["release:publish"],
      expiresInDays: 30,
      label: "buildkite",
    });
    expect(res.status).toBe(201);
    const issued = (await res.json()) as Record<string, any>;
    expect(issued.token).toMatch(/^pkeyci_/);
    expect(issued.expiresAt).toBe(NOW + 30 * 86400);
    // The token works against the uploads route.
    expect((await ticketFor(issued.token)).res.status).toBe(200);

    const list = await adminCall("GET", "ci-tokens");
    const text = await list.text();
    expect(text).toContain(issued.tokenId);
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain("token_hash");

    const revoke = await adminCall("DELETE", `ci-tokens/${issued.tokenId}`);
    expect(revoke.status).toBe(200);
    expect((await ticketFor(issued.token)).res.status).toBe(401);
    expect(
      (await adminCall("DELETE", `ci-tokens/${issued.tokenId}`)).status,
    ).toBe(404);
    const actions = (
      await db.all<{ action: string }>(
        "SELECT action FROM audit WHERE action LIKE 'ci.token.%'",
      )
    ).map((a) => a.action);
    expect(actions).toEqual(["ci.token.issue", "ci.token.revoke"]);
  });

  it("caps a static token at 90 days and needs known scopes", async () => {
    for (const body of [
      { scopes: ["release:publish"], expiresInDays: 91 },
      { scopes: ["release:publish"], expiresInDays: 0 },
      { scopes: ["release:publish"] },
      { scopes: ["nope"], expiresInDays: 1 },
      { scopes: ["release:publish"], expiresInDays: 1, label: "x".repeat(101) },
    ]) {
      expect(
        (await adminCall("POST", "ci-tokens", body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      await db.all("SELECT * FROM ci_tokens WHERE kind = 'static'"),
    ).toHaveLength(0);
  });

  it("mutations need the CSRF header", async () => {
    const res = await adminCall(
      "POST",
      "ci-tokens",
      { scopes: ["release:publish"], expiresInDays: 1 },
      { csrf: false },
    );
    expect(res.status).toBe(403);
  });
});
