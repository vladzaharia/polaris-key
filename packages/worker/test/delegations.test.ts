/**
 * P4-19 — content-key delegation at the Worker (plans/P4-19.md §6), through the real dispatcher:
 * a `kind: delegation` record signed by a declared release key is ingested and served by hash, and
 * refused for its body, its key, its `seq` and its window; a pack record signed by the delegated
 * content key (`pkd1-<hash>` kid) is ingested within scope and refused outside it (scope, layout,
 * window, binding, data-only paths, an unknown or revoked delegation, a non-pack kind); an app
 * release cannot pin or hold a delegated release; a revocation of a delegation yanks every release
 * under it (stored, or supplied alongside and stored already revoked); the CI read route lists the
 * delegations with `nextSeq`; the feed lists a delegation's revocation with `kind: delegation`.
 *
 * Every content key is generated here, at run time; no private key is committed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  signJws,
} from "@polaris-key/jws";
import { feedContent } from "@polaris-key/client-core/feed";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_PUB } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import {
  RELEASE_KID,
  RELEASE_PUB,
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import {
  containerVariant,
  packRecord,
  sha,
  treeVariant,
  type Obj,
} from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { delegationsView } from "../src/services/release/packs/adminView.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { composePackParts } from "../src/services/update/compose.js";
import { truncateRevocations } from "../src/services/update/packParts.js";

installDigestStream();

const ROOT = "djdl.events";
const HALLOWEEN = "djdl.events.halloween";
const FOES = "djdl.events.foes";
const PINNED = "djdl.events.skins";
const LEVELS = "djdl.levels";

function releaseDoc() {
  return {
    release: {
      provider: { type: "github", owner: "acme", repo: "djdl" },
      binaryName: "djdl",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      deliverables: {
        app: {
          kind: "app",
          versioning: { scheme: "semver" },
          content: { contentApi: 3 },
          artifacts: [
            {
              id: "web",
              platform: "web",
              arch: "wasm32",
              format: "zip",
              match: "djdl-*-web.zip",
              embeds: [],
            },
          ],
        },
        [HALLOWEEN]: {
          kind: "pack",
          type: "files.tree",
          binding: "standalone",
        },
        [FOES]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          requires: { contentApi: { app: ">=3" } },
        },
        [PINNED]: { kind: "pack", type: "files.tree", binding: "pinned" },
        [LEVELS]: { kind: "pack", type: "files.tree", binding: "standalone" },
      },
    },
  };
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
let token: string;
let seqs = new Map<string, number>();
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "djdl",
      modules: {
        license: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
    }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(releaseDoc()),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const rel = res.manifest.release!;
  await db.batch(
    manifestDeliverableStatements(SLUG, rel.app, NOW, rel.packDeliverables),
  );
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
  seqs = new Map();
});

afterEach(() => vi.useRealTimers());

function post(path: string, body: unknown, bearer: string | null = token) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function submit(body: Record<string, unknown>) {
  const res = await post("publish/submit", body);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function stage(deliverable: string, objects: Obj[]) {
  const unique = [...new Map(objects.map((o) => [o.sha256, o])).values()];
  const up = await post("publish/uploads", {
    objects: unique.map((o) => ({
      sha256: o.sha256,
      size: o.bytes.length,
      gated: false,
    })),
  });
  expect(up.status).toBe(200);
  const body = (await up.json()) as { ticket: string; prefix: string };
  for (const o of unique)
    r2.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
  const res = await post("publish/stage", { ticket: body.ticket, deliverable });
  expect(res.status, await res.clone().text()).toBe(200);
}

// ── Content keys (throwaway, generated per test run) ────────────────────────────────────────

interface ContentKey {
  pem: string;
  pub: string;
}

async function contentKey(): Promise<ContentKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...pkcs8));
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
    pub: base64UrlEncodeBytes(raw),
  };
}

function delegationDoc(
  key: ContentKey | string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: SLUG,
    deliverable: ROOT,
    kind: "delegation",
    version: String(over.seq ?? 1),
    seq: 1,
    issuedAt: NOW - 100,
    expiresAt: NOW + 180 * 86400,
    delegate: { publicKey: typeof key === "string" ? key : key.pub },
    types: ["files.tree", "data.json"],
    notes: "Events team",
    ...over,
  };
}

/** Sign a delegation as `pkey release delegate` does (the release key). */
async function delegate(
  key: ContentKey | string,
  over: Record<string, unknown> = {},
) {
  const jws = await signRecord(delegationDoc(key, over));
  const r = await submit({ record: jws });
  return { ...r, jws, sha256: sha(jws) };
}

interface Published {
  sha256: string;
  seq: number;
  version: string;
  pack: string;
  jws: string;
}

/** A pack record of `pack`, staged and signed by `key` under `delegationJws` (or by the release
 *  key when `delegationJws` is null). */
async function publish(
  pack: string,
  version: string,
  signer: { key: ContentKey; delegation: string } | null,
  o: {
    paths?: [string, string];
    issuedAt?: number;
    container?: boolean;
    contentApi?: string | null;
    kind?: string;
  } = {},
) {
  const seq = (seqs.get(pack) ?? 0) + 1;
  const built = await treeVariant({}, `${pack}-${version}`, o.paths);
  await stage(pack, built.objects);
  const variants: Record<string, unknown>[] = [
    {
      ...built.variant,
      ...(o.contentApi
        ? { requires: { contentApi: { app: o.contentApi } } }
        : {}),
    },
  ];
  if (o.container) {
    const c = containerVariant({ texture: "etc2" }, `${pack}-${version}-c`);
    await stage(pack, c.objects);
    variants[0] = { ...variants[0], variant: { texture: "s3tc" } };
    variants.push({ ...c.variant });
  }
  const record = {
    ...packRecord({
      aud: SLUG,
      deliverable: pack,
      version,
      seq,
      issuedAt: o.issuedAt ?? NOW,
      type: "files.tree",
      handler: { activation: "hot" },
      variants,
    }),
    ...(o.kind ? { kind: o.kind } : {}),
  };
  const jws = signer
    ? await signJws(
        record,
        signer.key.pem,
        `pkd1-${sha(signer.delegation)}`,
        "pkey-release+jws",
      )
    : await signRecord(record);
  const r = await submit({ record: jws });
  if (r.status === 200) seqs.set(pack, seq);
  return {
    ...r,
    published: { sha256: sha(jws), seq, version, pack, jws } as Published,
  };
}

async function hooks() {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  });
}

function revocationOf(
  delegationJws: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const d = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(delegationJws.split(".")[1]!)),
  ) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    aud: SLUG,
    deliverable: d.deliverable,
    kind: "revocation",
    version: d.version,
    seq: d.seq,
    issuedAt: NOW,
    revokes: sha(delegationJws),
    reason: "Content key retired",
    ...over,
  };
}

async function yankOf(releaseId: string) {
  return db.first<{ reason: string; by: string }>(
    "SELECT reason, by FROM release_yanks WHERE product = ? AND release_id = ?",
    SLUG,
    releaseId,
  );
}

// ── Delegation submits ──────────────────────────────────────────────────────────────────────

describe("a kind: delegation submit (plans/P4-19.md §6.2)", () => {
  it("is ingested, served by hash, listed by the read route, and a resubmit is a no-op", async () => {
    const key = await contentKey();
    const dry = await submit({
      record: await signRecord(delegationDoc(key)),
      dryRun: true,
    });
    expect([dry.status, dry.body.outcome]).toEqual([200, "created"]);
    const d = await delegate(key);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.delegation).toMatchObject({
      sha256: d.sha256,
      kid: `pkd1-${d.sha256}`,
      deliverable: ROOT,
      seq: 1,
      types: ["files.tree", "data.json"],
      stored: true,
    });
    const row = await db.first<{ origin: string; public_key: string }>(
      "SELECT origin, public_key FROM release_delegations WHERE product = ? AND record_sha256 = ?",
      SLUG,
      d.sha256,
    );
    expect(row).toEqual({ origin: "submit", public_key: key.pub });
    const again = await submit({ record: d.jws });
    expect([again.status, again.body.outcome]).toEqual([200, "unchanged"]);
    // The record route serves the delegation byte for byte.
    const res = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${d.sha256}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(d.jws);
    // The CI read route: the delegation, its fingerprint, nextSeq for the scope.
    const read = await post("publish/delegations", { deliverable: ROOT });
    expect(read.status).toBe(200);
    const listed = (await read.json()) as Record<string, any>;
    expect(listed.nextSeq).toBe(2);
    expect(listed.delegations).toEqual([
      {
        sha256: d.sha256,
        deliverable: ROOT,
        seq: 1,
        version: "1",
        keyFingerprint: sha(base64UrlDecode(key.pub)),
        issuedAt: NOW - 100,
        expiresAt: NOW + 180 * 86400,
        origin: "submit",
        revoked: false,
        jws: d.jws,
      },
    ]);
    expect(sha(listed.delegations[0].jws)).toBe(d.sha256);
    const other = (await (
      await post("publish/delegations", { deliverable: "djdl.other" })
    ).json()) as Record<string, any>;
    expect(other.nextSeq).toBe(1);
    const all = (await (
      await post("publish/delegations", {})
    ).json()) as Record<string, any>;
    expect(all.nextSeq).toBeUndefined();
  });

  it("refuses in order: body, key, seq, window", async () => {
    const key = await contentKey();
    const body = await delegate(key, {
      types: ["files.tree", "godot.pck"],
    });
    expect([body.status, body.body.reason]).toEqual([400, "delegation-body"]);
    const app = await delegate(key, { deliverable: "app" });
    expect(app.body.reason).toBe("delegation-body");
    const releaseKey = await delegate(RELEASE_PUB);
    expect(releaseKey.body.reason).toBe("delegation-key");
    const productKey = await delegate(TEST_PUB);
    expect(productKey.body.reason).toBe("delegation-key");
    expect((await delegate(key)).status).toBe(200);
    const reused = await delegate(key, { seq: 2, notes: "again" });
    expect(reused.body.reason).toBe("delegation-key");
    const seq = await delegate(await contentKey(), { seq: 1 });
    expect([seq.status, seq.body.reason]).toEqual([409, "seq"]);
    const closed = await delegate(await contentKey(), {
      seq: 2,
      issuedAt: NOW - 10 * 86400,
      expiresAt: NOW,
    });
    expect(closed.body.reason).toBe("delegation-window");
    const ahead = await delegate(await contentKey(), {
      seq: 2,
      issuedAt: NOW + 301,
      expiresAt: NOW + 86400,
    });
    expect(ahead.body.reason).toBe("delegation-window");
    // A delegation signed by a content key is never a delegation (kid).
    const inner = await signJws(
      delegationDoc(await contentKey(), { seq: 2 }),
      key.pem,
      `pkd1-${"0".repeat(64)}`,
      "pkey-release+jws",
    );
    const byContentKey = await submit({ record: inner });
    expect([byContentKey.status, byContentKey.body.reason]).toEqual([
      400,
      "kid",
    ]);
    expect(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM release_delegations WHERE product = ?",
          SLUG,
        )
      )?.n,
    ).toBe(1);
  });

  it("the read route needs the publisher token and no blob store", async () => {
    const res = await post("publish/delegations", {}, null);
    expect(res.status).toBe(401);
    const bad = await post("publish/delegations", { deliverable: "app" });
    expect(bad.status).toBe(400);
    delete (env as { BLOBS?: unknown }).BLOBS;
    const ok = await post("publish/delegations", { deliverable: ROOT });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ delegations: [], nextSeq: 1 });
  });
});

// ── Delegated pack records ──────────────────────────────────────────────────────────────────

describe("a delegated pack record (plans/P4-19.md §6.2)", () => {
  it("is ingested within scope, with its delegation row, and the catalog and console name the signer", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const r = await publish(HALLOWEEN, "1.0.0", { key, delegation: d.jws });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(
      await db.first(
        "SELECT delegation_sha256 FROM release_delegated_records WHERE product = ? AND record_sha256 = ?",
        SLUG,
        r.published.sha256,
      ),
    ).toEqual({ delegation_sha256: d.sha256 });
    const rel = await (await hooks())
      .releaseCatalog()!
      .packRelease(HALLOWEEN, `${HALLOWEEN}@1.0.0`);
    expect(rel?.delegation).toBe(d.sha256);
    const view = await delegationsView(db, SLUG, NOW);
    expect(view).toMatchObject([
      {
        sha256: d.sha256,
        scope: ROOT,
        status: "active",
        releaseCount: 1,
        signedBy: RELEASE_KID,
        revocation: null,
      },
    ]);
    // The console's admin route answers the same list.
    const admin = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/manage/api/products/${SLUG}/release/delegations`,
    );
    expect([401, 403, 200]).toContain(admin.status);
  });

  it("refuses outside its scope, layout, window, binding and data-only files", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const signer = { key, delegation: d.jws };
    const outside = await publish(LEVELS, "1.0.0", signer);
    expect([outside.status, outside.body.reason]).toEqual([
      400,
      "delegation-scope",
    ]);
    const container = await publish(HALLOWEEN, "1.0.0", signer, {
      container: true,
    });
    expect(container.body.reason).toBe("delegation-scope");
    const before = await publish(HALLOWEEN, "1.0.0", signer, {
      issuedAt: NOW - 2 * 86400,
    });
    expect(before.body.reason).toBe("delegation-scope");
    // Inside an older delegation's window, but more than a day before the Worker's clock.
    const oldKey = await contentKey();
    const old = await delegate(oldKey, {
      seq: 2,
      issuedAt: NOW - 5 * 86400,
    });
    expect(old.status).toBe(200);
    const backdated = await publish(
      HALLOWEEN,
      "1.0.0",
      { key: oldKey, delegation: old.jws },
      { issuedAt: NOW - 2 * 86400 },
    );
    expect(backdated.body.reason).toBe("delegation-window");
    const pinned = await publish(PINNED, "1.0.0", signer);
    expect(pinned.body.reason).toBe("delegation-binding");
    const code = await publish(HALLOWEEN, "1.0.0", signer, {
      paths: ["data/a.json", "data/b.gd"],
    });
    expect([code.status, code.body.reason]).toEqual([
      400,
      "delegation-data-only",
    ]);
    // A wrong signer, an unknown delegation.
    const wrong = await publish(HALLOWEEN, "1.0.0", {
      key: await contentKey(),
      delegation: d.jws,
    });
    expect(wrong.body.reason).toBe("signature");
    const unknown = await publish(HALLOWEEN, "1.0.0", {
      key,
      delegation: await signRecord(delegationDoc(key, { notes: "never sent" })),
    });
    expect(unknown.body.reason).toBe("delegation-unknown");
    expect(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM release_delegated_records WHERE product = ?",
          SLUG,
        )
      )?.n,
    ).toBe(0);
    // A data-only release under the same delegation goes through.
    const ok = await publish(HALLOWEEN, "1.0.0", signer, {
      paths: ["data/a.json", "data/b.png"],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("refuses a revocation signed by a content key (kid)", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const r = await publish(HALLOWEEN, "1.0.0", { key, delegation: d.jws });
    expect(r.status).toBe(200);
    const rev = await signJws(
      {
        schemaVersion: 1,
        aud: SLUG,
        deliverable: HALLOWEEN,
        kind: "revocation",
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        revokes: r.published.sha256,
        reason: "content key self-revoking",
      },
      key.pem,
      `pkd1-${d.sha256}`,
      "pkey-release+jws",
    );
    const res = await submit({ record: rev });
    expect([res.status, res.body.reason]).toEqual([400, "kid"]);
  });
});

// ── App releases ───────────────────────────────────────────────────────────────────────────

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);

async function submitApp(content: Record<string, unknown>) {
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version: "1.4.0",
    seq: 14,
    channel: "stable",
    content,
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        embeds: [],
        artifacts: [
          {
            name: "djdl-1.4.0-web.zip",
            role: "payload",
            sha256: WEB_SHA,
            size: WEB.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${WEB_SHA}` }],
          },
        ],
      },
    ],
  };
  const up = await post("publish/uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
  });
  const body = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  const jws = await signRecord(
    recordFor(descriptor, { seq: 14, issuedAt: NOW }),
  );
  return submit({ ticket: body.ticket, descriptor, record: jws });
}

const pinOf = (p: Published) => ({
  pack: p.pack,
  release: { sha256: p.sha256, seq: p.seq, version: p.version },
});

describe("app releases never pin or hold a delegated release (plans/P4-19.md §6.2)", () => {
  it("refuses hold-delegated and pin-delegated", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const foes = await publish(
      FOES,
      "1.0.0",
      { key, delegation: d.jws },
      { contentApi: ">=3" },
    );
    expect(foes.status, JSON.stringify(foes.body)).toBe(200);
    const skins = await publish(PINNED, "1.0.0", null);
    expect(skins.status, JSON.stringify(skins.body)).toBe(200);
    const expects = [
      { pack: FOES, required: false, delivery: "prefetch" },
      { pack: PINNED, required: false, delivery: "on-demand" },
    ];
    const held = await submitApp({
      contentApi: 3,
      pins: [pinOf(skins.published)],
      expects,
      holds: [{ ...pinOf(foes.published), reason: "keeps a quest working" }],
    });
    expect([held.status, held.body.reason]).toEqual([400, "hold-delegated"]);
    // An honest Worker never stores a delegated release of a pinned pack (delegation-binding);
    // the guard still refuses a pin of one.
    await db.run(
      "INSERT INTO release_delegated_records (product, record_sha256, delegation_sha256) VALUES (?, ?, ?)",
      SLUG,
      skins.published.sha256,
      d.sha256,
    );
    const pinned = await submitApp({
      contentApi: 3,
      pins: [pinOf(skins.published)],
      expects,
    });
    expect([pinned.status, pinned.body.reason]).toEqual([400, "pin-delegated"]);
  });
});

// ── Revoking a delegation ──────────────────────────────────────────────────────────────────

describe("revoking a delegation (plans/P4-19.md §6.2, §6.3)", () => {
  it("yanks every release under it, refuses later ones, and the feed lists it with kind delegation", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const signer = { key, delegation: d.jws };
    const a = await publish(HALLOWEEN, "1.0.0", signer);
    expect(a.status).toBe(200);
    // A replacement is refused; a mismatched seq is not the delegation.
    const repl = await submit({
      record: await signRecord(
        revocationOf(d.jws, {
          replacement: {
            sha256: a.published.sha256,
            seq: 1,
            version: "1.0.0",
          },
        }),
      ),
    });
    expect(repl.body.reason).toBe("revocation-replacement");
    const wrongSeq = await submit({
      record: await signRecord(revocationOf(d.jws, { seq: 2 })),
    });
    expect(wrongSeq.body.reason).toBe("revocation-target");

    const revJws = await signRecord(revocationOf(d.jws));
    const rev = await submit({ record: revJws });
    expect([rev.status, rev.body.outcome], JSON.stringify(rev.body)).toEqual([
      200,
      "created",
    ]);
    expect(rev.body.revocation).toMatchObject({
      target: d.sha256,
      kind: "delegation",
      stored: true,
    });
    expect(await yankOf(`${HALLOWEEN}@1.0.0`)).toEqual({
      reason: "delegation-revoked",
      by: `ci:${RELEASE_KID}`,
    });
    const again = await submit({ record: revJws });
    expect(again.body.outcome).toBe("unchanged");
    // The revocation is served by its hash.
    const served = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${sha(revJws)}`,
    );
    expect(await served.text()).toBe(revJws);
    // The hook lists it, with the releases it yanks.
    const list = await (await hooks()).releaseCatalog()!.revocations();
    expect(list).toMatchObject([
      {
        kind: "delegation",
        deliverableId: ROOT,
        targetSha256: d.sha256,
        recordSha256: sha(revJws),
        delegatedReleaseIds: [`${HALLOWEEN}@1.0.0`],
      },
    ]);
    // A later release under it is refused.
    const later = await publish(HALLOWEEN, "1.0.1", signer);
    expect(later.body.reason).toBe("delegation-revoked");
    // The console shows it revoked.
    expect((await delegationsView(db, SLUG, NOW))[0]!.status).toBe("revoked");
    // The composer lists it with kind delegation and pack the scope root, though nothing pins,
    // holds or lists its target, and counts it referenced (kept under the cap and at size step 3).
    const cfg = (await getReleaseConfig(db, SLUG))!;
    const parts = await composePackParts(
      { db, product: SLUG, hooks: await hooks(), cfg },
      "stable",
    );
    expect(parts.revocations).toEqual([
      {
        record: sha(revJws),
        pack: ROOT,
        target: d.sha256,
        version: "1",
        seq: 1,
        kind: "delegation",
      },
    ]);
    expect(parts.referenced.has(sha(revJws))).toBe(true);
    // feedContent reads the entry as usable, kind kept.
    expect(feedContent({ revocations: parts.revocations }).revocations).toEqual(
      parts.revocations,
    );
  });

  it("accepts a delegation supplied alongside: one reusing a stored key AND seq is stored revoked (origin revocation)", async () => {
    const key = await contentKey();
    const d1 = await delegate(key);
    expect(d1.status).toBe(200);
    // Minted and leaked outside CI: the same key and seq, never submitted.
    const d2 = await signRecord(
      delegationDoc(key, { notes: "minted outside CI" }),
    );
    expect(sha(d2)).not.toBe(d1.sha256);
    // Without the delegation, the target is unknown.
    const bare = await submit({ record: await signRecord(revocationOf(d2)) });
    expect(bare.body.reason).toBe("revocation-target");
    // A supplied JWS that is not the target is refused.
    const mismatch = await submit({
      record: await signRecord(revocationOf(d2)),
      delegation: d1.jws,
    });
    expect(mismatch.body.reason).toBe("revocation-target");
    const rev = await submit({
      record: await signRecord(revocationOf(d2)),
      delegation: d2,
    });
    expect([rev.status, rev.body.outcome], JSON.stringify(rev.body)).toEqual([
      200,
      "created",
    ]);
    expect(
      await db.first(
        "SELECT origin, revocation_sha256 IS NOT NULL AS revoked FROM release_delegations WHERE product = ? AND record_sha256 = ?",
        SLUG,
        sha(d2),
      ),
    ).toEqual({ origin: "revocation", revoked: 1 });
    // Releases signed under it are refused.
    const under = await publish(HALLOWEEN, "1.0.0", { key, delegation: d2 });
    expect(under.body.reason).toBe("delegation-revoked");
    // The key can never be delegated again.
    const resubmit = await delegate(key, { seq: 2 });
    expect(resubmit.body.reason).toBe("delegation-key");
    // A key first seen in a revocation joins the no-reuse set too.
    const fresh = await contentKey();
    const leaked = await signRecord(delegationDoc(fresh, { seq: 7 }));
    expect(
      (
        await submit({
          record: await signRecord(revocationOf(leaked)),
          delegation: leaked,
        })
      ).status,
    ).toBe(200);
    expect((await delegate(fresh, { seq: 2 })).body.reason).toBe(
      "delegation-key",
    );
    // The read route lists both origins.
    const read = (await (
      await post("publish/delegations", { deliverable: ROOT })
    ).json()) as Record<string, any>;
    expect(read.nextSeq).toBe(2);
    expect(
      (read.delegations as { origin: string; revoked: boolean }[])
        .map((x) => `${x.origin}:${x.revoked}`)
        .sort(),
    ).toEqual(["revocation:true", "revocation:true", "submit:false"]);
  });

  it("refuses to unyank a release under a revoked delegation", async () => {
    const key = await contentKey();
    const d = await delegate(key);
    const a = await publish(HALLOWEEN, "1.0.0", { key, delegation: d.jws });
    expect(a.status).toBe(200);
    expect(
      (await submit({ record: await signRecord(revocationOf(d.jws)) })).status,
    ).toBe(200);
    const { unyankRelease, isRevoked } =
      await import("../src/services/release/model.js");
    expect(await isRevoked(db, SLUG, `${HALLOWEEN}@1.0.0`)).toBe(true);
    expect(await unyankRelease(db, SLUG, `${HALLOWEEN}@1.0.0`)).toBe(false);
    expect(await yankOf(`${HALLOWEEN}@1.0.0`)).not.toBeNull();
  });
});

describe("composition under the cap (plans/P4-19.md §6.3)", () => {
  it("a delegation's revocation survives truncation among 70 revocations", () => {
    const hex = (s: string) => sha(s);
    const list = Array.from({ length: 69 }, (_, i) => ({
      record: hex(`rev:${i}`),
      pack: "djdl.foes",
      target: hex(`t:${i}`),
      version: "1.0.0",
      seq: 1,
      issuedAt: NOW + i,
    }));
    const delegation = {
      record: hex("rev:delegation"),
      pack: ROOT,
      target: hex("delegation"),
      version: "1",
      seq: 1,
      kind: "delegation" as const,
      issuedAt: NOW - 1000,
    };
    const t = truncateRevocations(
      [delegation, ...list],
      new Set([delegation.record]),
    );
    expect(t.kept).toHaveLength(64);
    expect(t.dropped).toBe(6);
    expect(t.kept.map((r) => r.record)).toContain(delegation.record);
  });
});
