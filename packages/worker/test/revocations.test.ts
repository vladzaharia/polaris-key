/**
 * P4-13 — revocation records, pack floors and pack sets in the signed feed (plans/P4-13.md §6),
 * through the real dispatcher: a revocation signed by a declared release key is ingested (row,
 * yank, re-resolution) and served by hash; one signed otherwise is refused; superseding updates the
 * one current row, an older one is refused and a byte-identical resubmit changes nothing; the body,
 * target and replacement checks refuse in order; resolution skips the revoked release; an app
 * release cannot pin or hold a revoked one; the composed feed carries `packSets`, `packFloors` and
 * `revocations`; a `play-pad` pack is narrowed to pinned on the Play outlet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { base64UrlDecode } from "@polaris-key/jws";
import { feedContent } from "@polaris-key/client-core/feed";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KID, TEST_PEM, TEST_PUB } from "./seed.js";
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
  RELEASE_KID_2027,
  RELEASE_PEM_2027,
  RELEASE_PUB,
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import { packRecord, sha, treeVariant, type Obj } from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { composePackParts } from "../src/services/update/compose.js";

installDigestStream();

const FOES = "djdl.foes";
const L10N = "djdl.l10n";
const SKINS = "djdl.skins";

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
        [FOES]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          required: true,
          delivery: "essential",
          requires: { contentApi: { app: ">=3" } },
        },
        [L10N]: { kind: "pack", type: "files.tree", binding: "standalone" },
        [SKINS]: { kind: "pack", type: "files.tree", binding: "pinned" },
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
      scopes: ["release:publish", "release:promote", "release:yank"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
  seqs = new Map();
});

afterEach(() => vi.useRealTimers());

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
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

let seqs = new Map<string, number>();

interface Published {
  sha256: string;
  seq: number;
  version: string;
  pack: string;
}

async function publishPack(
  pack: string,
  version: string,
  o: { contentApi?: string | null; engine?: string } = {},
): Promise<Published> {
  const seq = (seqs.get(pack) ?? 0) + 1;
  const built = await treeVariant({}, `${pack}-${version}`);
  await stage(pack, built.objects);
  const contentApi = o.contentApi === undefined ? ">=3" : o.contentApi;
  const requires = {
    ...(contentApi !== null ? { contentApi: { app: contentApi } } : {}),
    ...(o.engine ? { engine: o.engine } : {}),
  };
  const record = packRecord({
    aud: SLUG,
    deliverable: pack,
    version,
    seq,
    issuedAt: NOW,
    type: "files.tree",
    handler: { activation: "hot" },
    variants: [
      {
        ...built.variant,
        ...(Object.keys(requires).length > 0 ? { requires } : {}),
      },
    ],
  });
  const jws = await signRecord(record);
  const res = await post("publish/submit", { record: jws });
  expect(res.status, await res.clone().text()).toBe(200);
  seqs.set(pack, seq);
  return { sha256: sha(jws), seq, version, pack };
}

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);

async function submitApp(
  version: string,
  seq: number,
  content: Record<string, unknown>,
) {
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
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
            name: `djdl-${version}-web.zip`,
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
  const jws = await signRecord(recordFor(descriptor, { seq, issuedAt: NOW }));
  const res = await post("publish/submit", {
    ticket: body.ticket,
    descriptor,
    record: jws,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

function appContent(
  skins: Published,
  holds: Published[] = [],
): Record<string, unknown> {
  return {
    contentApi: 3,
    pins: [pinOf(skins)],
    expects: [
      { pack: FOES, required: true, delivery: "essential" },
      { pack: L10N, required: false, delivery: "prefetch" },
      { pack: SKINS, required: false, delivery: "on-demand" },
    ],
    ...(holds.length > 0
      ? {
          holds: holds.map((h) => ({
            ...pinOf(h),
            reason: "keeps a quest working",
          })),
        }
      : {}),
  };
}

function pinOf(p: Published) {
  return {
    pack: p.pack,
    release: { sha256: p.sha256, seq: p.seq, version: p.version },
  };
}

/** A revocation of `target`, signed as `pkey release revoke` does. */
function revocation(
  target: Published,
  o: {
    replacement?: Published | null;
    reason?: string;
    issuedAt?: number;
    over?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: SLUG,
    deliverable: target.pack,
    kind: "revocation",
    version: target.version,
    seq: target.seq,
    issuedAt: o.issuedAt ?? NOW,
    revokes: target.sha256,
    ...(o.replacement
      ? {
          replacement: {
            sha256: o.replacement.sha256,
            seq: o.replacement.seq,
            version: o.replacement.version,
          },
        }
      : {}),
    reason: o.reason ?? "Exploit in foes spawn tables",
    ...(o.over ?? {}),
  };
}

async function revoke(
  doc: Record<string, unknown>,
  sign: { pem?: string; kid?: string } = {},
  dryRun = false,
) {
  const jws = await signRecord(doc, sign);
  const res = await post("publish/submit", {
    record: jws,
    ...(dryRun ? { dryRun: true } : {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
    jws,
    sha256: sha(jws),
  };
}

async function revocationRows() {
  return db.all<{
    target_sha256: string;
    record_sha256: string;
    replacement_sha256: string | null;
    issued_at: number;
  }>(
    "SELECT target_sha256, record_sha256, replacement_sha256, issued_at FROM release_revocations WHERE product = ?",
    SLUG,
  );
}

async function foesAtLevel3(): Promise<string | null> {
  const rows = await db.all<{ set_json: string }>(
    "SELECT set_json FROM release_sets WHERE product = ? AND channel = 'stable' AND content_api = 3",
    SLUG,
  );
  for (const r of rows) {
    const packs = (
      JSON.parse(r.set_json) as { packs: { pack: string; version: string }[] }
    ).packs;
    const f = packs.find((p) => p.pack === FOES);
    if (f) return f.version;
  }
  return null;
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

/** foes 1.0.0 and 1.0.1, l10n 1.0.0, skins 1.0.0 (pinned), app 1.4.0 at contentApi 3. */
async function world(o: { holdOld?: boolean } = {}) {
  const foesOld = await publishPack(FOES, "1.0.0");
  const foesNew = await publishPack(FOES, "1.0.1");
  const l10n = await publishPack(L10N, "1.0.0", { contentApi: null });
  const skins = await publishPack(SKINS, "1.0.0", { contentApi: null });
  const app = await submitApp(
    "1.4.0",
    14,
    appContent(skins, o.holdOld ? [foesOld] : []),
  );
  expect(app.status, JSON.stringify(app.body)).toBe(200);
  return { foesOld, foesNew, l10n, skins };
}

describe("revocation ingest (plans/P4-13.md §6.2)", () => {
  it("ingests a revocation signed by a release key: the row, the yank, the record route", async () => {
    const { foesOld, foesNew } = await world();
    const dry = await revoke(
      revocation(foesNew, { replacement: null }),
      {},
      true,
    );
    expect([dry.status, dry.body.outcome]).toEqual([200, "created"]);
    expect(await revocationRows()).toEqual([]);

    const r = await revoke(revocation(foesOld, { replacement: foesNew }));
    expect([r.status, r.body.outcome, r.body.revocation.stored]).toEqual([
      200,
      "created",
      true,
    ]);
    expect(await revocationRows()).toEqual([
      {
        target_sha256: foesOld.sha256,
        record_sha256: r.sha256,
        replacement_sha256: foesNew.sha256,
        issued_at: NOW,
      },
    ]);
    const yank = await db.first<{ reason: string; by: string }>(
      `SELECT y.reason, y.by FROM release_yanks y
         JOIN release_records r ON r.product = y.product AND r.release_id = y.release_id
        WHERE y.product = ? AND r.record_sha256 = ?`,
      SLUG,
      foesOld.sha256,
    );
    expect(yank).toEqual({ reason: "revoked", by: `ci:${RELEASE_KID}` });
    // The record route serves the revocation by its hash, byte for byte.
    const res = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${r.sha256}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(r.jws);
    // The hook lists it with the target's pin.
    const list = await (await hooks()).releaseCatalog()!.revocations();
    expect(list).toMatchObject([
      {
        deliverableId: FOES,
        targetSha256: foesOld.sha256,
        recordSha256: r.sha256,
        version: "1.0.0",
        seq: 1,
        replacement: { sha256: foesNew.sha256 },
      },
    ]);
  });

  it("refuses a revocation signed by an undeclared key or by a product key", async () => {
    const { foesOld } = await world();
    const undeclared = await revoke(revocation(foesOld), {
      pem: RELEASE_PEM_2027,
      kid: RELEASE_KID_2027,
    });
    expect([
      undeclared.status,
      undeclared.body.error,
      undeclared.body.reason,
    ]).toEqual([400, "release_record_rejected", "kid"]);
    // A declared "release key" that is the product's signing key proves nothing.
    await db.run(
      "UPDATE release_config SET release_keys_json = ? WHERE product = ?",
      JSON.stringify([
        { kid: RELEASE_KID, publicKey: RELEASE_PUB },
        { kid: TEST_KID, publicKey: TEST_PUB },
      ]),
      SLUG,
    );
    const productKey = await revoke(revocation(foesOld), {
      pem: TEST_PEM,
      kid: TEST_KID,
    });
    expect([productKey.status, productKey.body.reason]).toEqual([
      400,
      "product-key",
    ]);
    expect(await revocationRows()).toEqual([]);
  });

  it("supersedes by a newer issuedAt (update in place), refuses an older one, and a resubmit is a no-op", async () => {
    const { foesOld, foesNew } = await world();
    const first = await revoke(revocation(foesOld, { issuedAt: NOW }));
    expect(first.status).toBe(200);
    const again = await post("publish/submit", { record: first.jws });
    expect(((await again.json()) as Record<string, unknown>).outcome).toBe(
      "unchanged",
    );
    const newer = await revoke(
      revocation(foesOld, { issuedAt: NOW + 10, replacement: foesNew }),
    );
    expect([newer.status, newer.body.outcome]).toEqual([200, "superseded"]);
    expect(await revocationRows()).toEqual([
      {
        target_sha256: foesOld.sha256,
        record_sha256: newer.sha256,
        replacement_sha256: foesNew.sha256,
        issued_at: NOW + 10,
      },
    ]);
    // The superseded record is no longer served; the current one is.
    expect(
      (
        await call(
          env,
          db,
          noFetch,
          `${CONSOLE}/${SLUG}/release/records/${first.sha256}`,
        )
      ).status,
    ).toBe(404);
    const older = await revoke(
      revocation(foesOld, { issuedAt: NOW + 5, reason: "an older thought" }),
    );
    expect([older.status, older.body.reason]).toEqual([
      409,
      "revocation-stale",
    ]);
    expect((await revocationRows())[0]!.record_sha256).toBe(newer.sha256);
  });

  it("refuses in order: body, target, replacement, an incompatible replacement", async () => {
    const { foesOld, foesNew, l10n } = await world();
    const app = await revoke(
      revocation(foesOld, { over: { deliverable: "app" } }),
    );
    expect(app.body.reason).toBe("revocation-body");
    const long = await revoke(revocation(foesOld, { reason: "x".repeat(513) }));
    expect(long.body.reason).toBe("revocation-body");
    const unknown = await revoke(
      revocation({ ...foesOld, sha256: "0".repeat(64) }),
    );
    expect(unknown.body.reason).toBe("revocation-target");
    const wrongSeq = await revoke(revocation(foesOld, { over: { seq: 2 } }));
    expect(wrongSeq.body.reason).toBe("revocation-target");
    const otherPack = await revoke(
      revocation(foesOld, { replacement: { ...l10n, pack: FOES } }),
    );
    expect(otherPack.body.reason).toBe("revocation-replacement");
    // A replacement whose range no longer admits the live level 3.
    const narrow = await publishPack(FOES, "1.1.0", { contentApi: ">=4" });
    const incompatible = await revoke(
      revocation(foesOld, { replacement: narrow }),
    );
    expect(incompatible.body.reason).toBe(
      "revocation-replacement-incompatible",
    );
    // An engine the target does not run on.
    const engined = await publishPack(FOES, "1.2.0", { engine: "godot-4.4" });
    expect(
      (await revoke(revocation(foesOld, { replacement: engined }))).body.reason,
    ).toBe("revocation-replacement-incompatible");
    // A revoked replacement is refused too.
    expect((await revoke(revocation(foesNew))).status).toBe(200);
    expect(
      (await revoke(revocation(foesOld, { replacement: foesNew }))).body.reason,
    ).toBe("revocation-replacement");
    expect((await revocationRows()).length).toBe(1);
  });
});

describe("resolution and app publishes (plans/P4-13.md §6.2, §6.3)", () => {
  it("resolution skips the revoked release", async () => {
    const { foesNew } = await world();
    expect(await foesAtLevel3()).toBe("1.0.1");
    expect((await revoke(revocation(foesNew))).status).toBe(200);
    expect(await foesAtLevel3()).toBe("1.0.0");
  });

  it("refuses an app release that pins or holds a revoked release", async () => {
    const { foesOld, skins } = await world();
    expect((await revoke(revocation(foesOld))).status).toBe(200);
    const held = await submitApp("1.4.1", 15, appContent(skins, [foesOld]));
    expect([held.status, held.body.reason]).toEqual([400, "hold-revoked"]);
    expect((await revoke(revocation(skins))).status).toBe(200);
    const pinned = await submitApp("1.4.1", 15, appContent(skins));
    expect([pinned.status, pinned.body.reason]).toEqual([400, "pin-revoked"]);
  });
});

function feedPayload(jws: string): Record<string, any> {
  return JSON.parse(
    new TextDecoder().decode(base64UrlDecode(jws.split(".")[1]!)),
  ) as Record<string, any>;
}

describe("the composed feed (plans/P4-13.md §2.2, §6.3)", () => {
  it("carries packSets, packFloors and revocations, each usable by feedContent", async () => {
    const { foesOld, foesNew, l10n } = await world({ holdOld: true });
    await db.run(
      `INSERT INTO release_pack_floors
         (product, deliverable_id, channel, content_api, min_version, source, created_at, modified_at)
       VALUES (?, ?, 'stable', 3, '1.0.1', 'admin', ?, ?)`,
      SLUG,
      FOES,
      NOW,
      NOW,
    );
    const r = await revoke(revocation(foesOld, { replacement: foesNew }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/update/stable/feed.jws?platform=web`,
    );
    expect(res.status).toBe(200);
    const doc = feedPayload(await res.text());
    const content = feedContent(doc);
    expect(content.packSets).not.toBeNull();
    expect(content.packSets!.rows.every((row) => row.contentApi === 3)).toBe(
      true,
    );
    const named = Object.values(content.packSets!.releases).map(
      (x) => `${x.pack}@${x.version}`,
    );
    expect(named.sort()).toEqual([`${FOES}@1.0.1`, `${L10N}@1.0.0`]);
    expect(content.packSets!.releases[l10n.sha256]).toEqual({
      pack: L10N,
      version: "1.0.0",
      seq: 1,
    });
    expect(content.packFloors).toEqual([
      {
        pack: FOES,
        contentApi: 3,
        minVersion: "1.0.1",
        versionScheme: "semver",
      },
    ]);
    // The app release holds the target, so the revocation is listed.
    expect(content.revocations).toEqual([
      {
        record: r.sha256,
        pack: FOES,
        target: foesOld.sha256,
        version: "1.0.0",
        seq: 1,
      },
    ]);
  });

  it("narrows a play-pad pack to pinned on the Play outlet, and lists nothing for floating transports", async () => {
    await world();
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, 'play', 'play', '{}', ?, ?), (?, 'steam', 'steam', '{}', ?, ?)`,
      SLUG,
      NOW,
      NOW,
      SLUG,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport)
       VALUES (?, ?, 'play', 'play-pad'), (?, ?, 'steam', 'steam-depot'),
              (?, ?, 'play', 'play-pad')`,
      SLUG,
      FOES,
      SLUG,
      FOES,
      SLUG,
      SKINS,
    );
    const cfg = (await getReleaseConfig(db, SLUG))!;
    const parts = await composePackParts(
      { db, product: SLUG, hooks: await hooks(), cfg },
      "stable",
    );
    // `skins` is pinned already: only compatible and standalone packs are narrowed.
    expect(parts.packSets?.outlets).toEqual({ play: { pinned: [FOES] } });
  });
});
