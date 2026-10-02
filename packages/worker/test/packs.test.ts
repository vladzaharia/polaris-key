/**
 * P4-02 — pack deliverables through the real dispatcher (plans/P4-01.md §6): manifest sync's pack
 * rows; the delivery gate (`delivery.entitlement`) through the uploads preflight, the stage round
 * and ingest; stage rounds earning `pack-upload` refs; the record-only pack submit with every
 * refusal reason; app releases' `content` and `embeds` (pins, yanks, embeds); and the hook's pack
 * reads over `release_pins`. Records are signed with the corpus's release test keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  github,
  release,
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
  bytesFrom,
  containerVariant,
  packRecord,
  sha,
  treeVariant,
  type BuiltVariant,
  type Obj,
} from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import {
  syncReleaseStore,
  syncReleaseStoreReport,
} from "../src/services/release/sync.js";
import {
  listReleaseMetadata,
  listStoredReleaseIds,
  releaseStoreStatements,
} from "../src/services/release/store.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { knownChannels } from "../src/services/release/resolve.js";
import { listPortalReleases } from "../src/services/identity/portal/repo.js";
import { checkPackAgainstDeclaration } from "../src/services/release/packs/ingest.js";

installDigestStream();

const CORE = "djdl.core3d";
const SKINS = "djdl.skins";
const L10N = "djdl.l10n";

const RELEASE_DOC = {
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
          {
            id: "ios",
            platform: "ios",
            arch: "arm64",
            format: "ipa",
            match: "djdl-*-ios.ipa",
          },
        ],
      },
      [CORE]: {
        kind: "pack",
        type: "godot.pck",
        baseline: "embedded",
        required: true,
        delivery: "essential",
        handler: { mountOrder: 1, prefixes: ["res://assets/core/"] },
        variants: { texture: ["s3tc", "etc2"] },
        requires: { engine: "godot-4.7" },
      },
      [SKINS]: {
        kind: "pack",
        type: "files.tree",
        delivery: "on-demand",
        entitlement: "skins",
      },
      [L10N]: {
        kind: "pack",
        type: "files.tree",
        delivery: "prefetch",
        variants: { locale: ["en", "fr"] },
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
const SCHEMA_DOC = {
  schemaVersion: 1,
  entries: [
    {
      key: "skins",
      kind: "flag",
      category: "Extras",
      label: "Skins",
      description: "The supporter skins.",
      schema: { type: "boolean" },
      userGrant: true,
    },
  ],
};

function parsed(releaseDoc: unknown = RELEASE_DOC) {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify(SCHEMA_DOC),
    release: JSON.stringify(releaseDoc),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest;
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

async function syncDeliverables(releaseDoc: unknown = RELEASE_DOC) {
  const rel = parsed(releaseDoc).release!;
  await db.batch(
    manifestDeliverableStatements(SLUG, rel.app, NOW, rel.packDeliverables),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  await syncDeliverables();
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

afterEach(() => vi.useRealTimers());

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

async function setGate(deliverable: string, entitlement: string | null) {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, 'entitled', ?, 'admin', ?)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET entitlement = excluded.entitlement`,
    SLUG,
    deliverable,
    entitlement,
    NOW,
  );
}

async function distributionOff() {
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

/** Upload `objects` through a ticket and a stage round for `deliverable`. */
async function stage(
  deliverable: string,
  objects: Obj[],
  gated = false,
): Promise<Response> {
  const unique = [...new Map(objects.map((o) => [o.sha256, o])).values()];
  const up = await post("uploads", {
    objects: unique.map((o) => ({
      sha256: o.sha256,
      size: o.bytes.length,
      gated,
    })),
  });
  expect(up.status).toBe(200);
  const body = (await up.json()) as { ticket: string; prefix: string };
  for (const o of unique)
    r2.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
  return post("stage", { ticket: body.ticket, deliverable });
}

async function stageOk(deliverable: string, objects: Obj[], gated = false) {
  const res = await stage(deliverable, objects, gated);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { staged: string[]; present: string[] };
}

const CORE_HANDLER = {
  mountOrder: 1,
  prefixes: ["res://assets/core/"],
  activation: "restart",
};

function coreVariants(seed: string): BuiltVariant[] {
  return [
    containerVariant({ texture: "s3tc" }, `${seed}/s3tc`, {
      engine: "godot-4.7",
    }),
    containerVariant({ texture: "etc2" }, `${seed}/etc2`, {
      engine: "godot-4.7",
    }),
  ];
}

function coreRecord(
  version: string,
  seq: number,
  variants: BuiltVariant[],
  over: Record<string, unknown> = {},
) {
  return {
    ...packRecord({
      aud: SLUG,
      deliverable: CORE,
      version,
      seq,
      issuedAt: NOW,
      type: "godot.pck",
      handler: CORE_HANDLER,
      variants: variants.map((v) => v.variant),
    }),
    ...over,
  };
}

/** Stage and submit a core3d release; returns its record hash. */
async function publishCore(version: string, seq: number): Promise<string> {
  const variants = coreVariants(`core-${version}`);
  await stageOk(
    CORE,
    variants.flatMap((v) => v.objects),
  );
  const jws = await signRecord(coreRecord(version, seq, variants));
  const res = await post("submit", { record: jws });
  expect(res.status, await res.clone().text()).toBe(200);
  return sha(jws);
}

async function submitRefused(record: unknown) {
  const res = await post("submit", { record: await signRecord(record) });
  const body = (await res.json()) as {
    error: string;
    reason: string;
    message: string;
  };
  return { status: res.status, ...body };
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await db.first<{ n: number }>(sql, ...(params as never[])))!.n;
}

async function catalog() {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  }).releaseCatalog()!;
}

// ── Manifest sync ───────────────────────────────────────────────────────────

describe("manifest sync writes pack rows (P4-02)", () => {
  it("one kind = 'pack' row per declared pack, with its type and declaration", async () => {
    const rows = await db.all<{
      deliverable_id: string;
      kind: string;
      pack_type: string | null;
      def_source: string;
    }>(
      "SELECT deliverable_id, kind, pack_type, def_source FROM release_deliverables WHERE product = ? ORDER BY deliverable_id",
      SLUG,
    );
    expect(rows).toEqual([
      {
        deliverable_id: "app",
        kind: "app",
        pack_type: null,
        def_source: "manifest",
      },
      {
        deliverable_id: CORE,
        kind: "pack",
        pack_type: "godot.pck",
        def_source: "manifest",
      },
      {
        deliverable_id: L10N,
        kind: "pack",
        pack_type: "files.tree",
        def_source: "manifest",
      },
      {
        deliverable_id: SKINS,
        kind: "pack",
        pack_type: "files.tree",
        def_source: "manifest",
      },
    ]);
    expect(
      (await (await catalog()).packDeliverables()).map((p) => p.id),
    ).toEqual([CORE, L10N, SKINS]);
  });

  it("a pack no longer declared loses its manifest row; an operator-owned row is never rewritten", async () => {
    await db.run(
      "UPDATE release_deliverables SET def_source = 'admin', def_json = '{}' WHERE product = ? AND deliverable_id = ?",
      SLUG,
      SKINS,
    );
    const doc = structuredClone(RELEASE_DOC) as any;
    delete doc.release.deliverables[L10N];
    doc.release.deliverables[SKINS].delivery = "prefetch";
    await syncDeliverables(doc);
    const ids = (
      await db.all<{ deliverable_id: string; def_json: string }>(
        "SELECT deliverable_id, def_json FROM release_deliverables WHERE product = ? AND kind = 'pack' ORDER BY deliverable_id",
        SLUG,
      )
    ).map((r) => [r.deliverable_id, r.def_json === "{}"]);
    expect(ids).toEqual([
      [CORE, false],
      [SKINS, true],
    ]);
  });
});

// ── The delivery gate, the preflight and the stage round ────────────────────

describe("uploads preflight and the delivery gate (decision 35)", () => {
  it("a preflight issues no ticket and answers seqs with a pack's gate and an existing release's record hash", async () => {
    await setGate(SKINS, "skins");
    const res = await post("uploads", {
      releases: [
        { deliverable: SKINS, version: "1.0.0" },
        { deliverable: CORE, version: "1.0.0" },
        { deliverable: "app", version: "1.0.0" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ticket).toBeUndefined();
    expect(body.seqs).toEqual([
      { deliverable: SKINS, version: "1.0.0", seq: 1, entitlement: "skins" },
      { deliverable: CORE, version: "1.0.0", seq: 1, entitlement: null },
      { deliverable: "app", version: "1.0.0", seq: 1 },
    ]);
    const recordSha = await publishCore("1.0.0", 1);
    const again = (await (
      await post("uploads", {
        releases: [{ deliverable: CORE, version: "1.0.0" }],
      })
    ).json()) as { seqs: unknown[] };
    expect(again.seqs).toEqual([
      {
        deliverable: CORE,
        version: "1.0.0",
        seq: 1,
        recordSha256: recordSha,
        entitlement: null,
      },
    ]);
  });

  it("an objects array that is present stays non-empty", async () => {
    const res = await post("uploads", {
      objects: [],
      releases: [{ deliverable: CORE, version: "1.0.0" }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("bad_objects");
  });

  it("Distribution off refuses every pack: preflight, stage and submit (distribution_disabled)", async () => {
    const variants = coreVariants("off");
    const up = await post("uploads", {
      objects: variants
        .flatMap((v) => v.objects)
        .map((o) => ({ sha256: o.sha256, size: o.bytes.length })),
    });
    const ticket = ((await up.json()) as any).ticket as string;
    await distributionOff();
    const pre = await post("uploads", {
      releases: [{ deliverable: CORE, version: "1.0.0" }],
    });
    expect(pre.status).toBe(409);
    expect(((await pre.json()) as any).reason).toBe("distribution_disabled");
    const st = await post("stage", { ticket, deliverable: CORE });
    expect(((await st.json()) as any).reason).toBe("distribution_disabled");
    const sub = await submitRefused(coreRecord("1.0.0", 1, variants));
    expect(sub.reason).toBe("distribution_disabled");
  });
});

describe("POST /release/publish/stage (decision 28)", () => {
  it("promotes the round and earns one pack-upload ref per object; a second round finds them present", async () => {
    const variants = coreVariants("stage");
    const objects = variants.flatMap((v) => v.objects);
    const first = await stageOk(CORE, objects);
    expect(first.staged).toHaveLength(objects.length);
    expect(first.present).toEqual([]);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ? AND ref_kind = 'pack-upload' AND ref_id = ?",
        SLUG,
        CORE,
      ),
    ).toBe(objects.length);
    const second = await stageOk(CORE, objects);
    expect(second.staged).toEqual([]);
    expect(second.present).toHaveLength(objects.length);
  });

  it("refuses an undeclared pack, a gated flag that differs from the gate, and a redeemed ticket", async () => {
    const objects = coreVariants("refuse")[0]!.objects;
    const unknown = await stage("djdl.nope", objects);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).reason).toBe(
      "unknown_pack_deliverable",
    );
    // The skins pack is gated: an ungated object is refused, a gated one accepted.
    await setGate(SKINS, "skins");
    const mismatch = await stage(SKINS, objects, false);
    expect(((await mismatch.json()) as any).reason).toBe("gated_mismatch");
    // core3d is ungated: a gated object is refused.
    const gatedOnUngated = await stage(CORE, objects, true);
    expect(((await gatedOnUngated.json()) as any).reason).toBe(
      "gated_mismatch",
    );
    // A staged copy that was never uploaded.
    const up = await post("uploads", {
      objects: [{ sha256: objects[0]!.sha256, size: objects[0]!.bytes.length }],
    });
    const missing = await post("stage", {
      ticket: ((await up.json()) as any).ticket,
      deliverable: CORE,
    });
    expect(((await missing.json()) as any).reason).toBe(
      "staged_object_missing",
    );
  });
});

// ── Pack record ingest ──────────────────────────────────────────────────────

describe("pack record ingest", () => {
  it("ingests a valid two-variant pack record with every artifact row", async () => {
    const variants = coreVariants("ok");
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects),
    );
    const jws = await signRecord(coreRecord("1.4.0", 12, variants));
    const res = await post("submit", { record: jws });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dryRun: false,
      releaseId: `${CORE}@1.4.0`,
      outcome: "created",
      record: { sha256: sha(jws), stored: true },
      staged: [],
    });
    const release = await db.first<{ deliverable_id: string; seq: number }>(
      "SELECT deliverable_id, seq FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      `${CORE}@1.4.0`,
    );
    expect(release).toEqual({ deliverable_id: CORE, seq: 12 });
    expect(
      await db.all(
        "SELECT build_id, platform, arch, format, variant_json FROM release_builds WHERE product = ? AND release_id = ? ORDER BY build_id",
        SLUG,
        `${CORE}@1.4.0`,
      ),
    ).toEqual([
      {
        build_id: "texture=etc2",
        platform: null,
        arch: "any",
        format: "godot.pck",
        variant_json: '{"texture":"etc2"}',
      },
      {
        build_id: "texture=s3tc",
        platform: null,
        arch: "any",
        format: "godot.pck",
        variant_json: '{"texture":"s3tc"}',
      },
    ]);
    const artifacts = await db.all<{ build_id: string; role: string }>(
      "SELECT build_id, role FROM release_artifacts WHERE product = ? AND release_id = ? ORDER BY build_id, role",
      SLUG,
      `${CORE}@1.4.0`,
    );
    // Six objects per variant: full, index, gaps, a payload delta, a files delta's patch and data.
    expect(artifacts.map((a) => `${a.build_id}:${a.role}`)).toEqual(
      ["texture=etc2", "texture=s3tc"].flatMap((b) =>
        [
          "delta",
          "files-gaps",
          "files-index",
          "patch",
          "patch-data",
          "payload",
        ].map((r) => `${b}:${r}`),
      ),
    );
    // A pack-object ref per named object; the record is stored, kind pack.
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ? AND ref_kind = 'pack-object' AND ref_id = ?",
        SLUG,
        `${CORE}@1.4.0`,
      ),
    ).toBe(12);
    expect(
      await db.first(
        "SELECT kind, seq, deliverable_id FROM release_records WHERE product = ? AND record_sha256 = ?",
        SLUG,
        sha(jws),
      ),
    ).toEqual({ kind: "pack", seq: 12, deliverable_id: CORE });
    // A re-run with the same record is unchanged.
    const again = await post("submit", { record: jws });
    expect(((await again.json()) as any).outcome).toBe("unchanged");
    // The hook reads the release back from the record, and a variant's files from its index.
    const cat = await catalog();
    const pr = await cat.packRelease(CORE, `${CORE}@1.4.0`);
    expect(pr?.recordSha256).toBe(sha(jws));
    expect(pr?.variants.map((v) => [v.variantKey, v.objects.length])).toEqual([
      ["texture=s3tc", 6],
      ["texture=etc2", 6],
    ]);
    const files = await cat.packFiles(`${CORE}@1.4.0`, "texture=s3tc");
    expect(files?.map((f) => f.path)).toEqual([
      "assets/core/a.bin",
      "assets/core/b.bin",
    ]);
  });

  it("a small pack publishes in one request: the submit's own ticket is promoted as a round", async () => {
    const variants = await Promise.all([
      treeVariant({ locale: "en" }, "l10n-en"),
      treeVariant({ locale: "fr" }, "l10n-fr"),
    ]);
    const objects = [
      ...new Map(
        variants.flatMap((v) => v.objects).map((o) => [o.sha256, o]),
      ).values(),
    ];
    const up = await post("uploads", {
      objects: objects.map((o) => ({ sha256: o.sha256, size: o.bytes.length })),
    });
    const body = (await up.json()) as { ticket: string; prefix: string };
    for (const o of objects)
      r2.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
    const record = packRecord({
      aud: SLUG,
      deliverable: L10N,
      version: "2.0.1",
      seq: 5,
      issuedAt: NOW,
      type: "files.tree",
      handler: { activation: "hot" },
      variants: variants.map((v) => v.variant),
    });
    // A dry run checks everything and promotes nothing.
    const dry = await post("submit", {
      ticket: body.ticket,
      record: await signRecord(record),
      dryRun: true,
    });
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(((await dry.json()) as any).unverified).toEqual([]);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM release_records WHERE product = ?",
        SLUG,
      ),
    ).toBe(0);
    const res = await post("submit", {
      ticket: body.ticket,
      record: await signRecord(record),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).staged).toHaveLength(objects.length);
  });

  it("refuses an unknown deliverable (pack-unknown)", async () => {
    const r = await submitRefused(
      coreRecord("1.0.0", 1, coreVariants("x"), { deliverable: "djdl.nope" }),
    );
    expect([r.status, r.error, r.reason]).toEqual([
      400,
      "release_record_rejected",
      "pack-unknown",
    ]);
  });

  it("refuses a type that differs from the declaration (pack-type)", async () => {
    const r = await submitRefused(
      coreRecord("1.0.0", 1, coreVariants("x"), { type: "files.tree" }),
    );
    expect(r.reason).toBe("pack-type");
  });

  it("refuses a seq not above the deliverable's last (seq)", async () => {
    await publishCore("1.0.0", 3);
    const r = await submitRefused(coreRecord("1.1.0", 3, coreVariants("y")));
    expect([r.status, r.reason]).toEqual([409, "seq"]);
  });

  it("refuses an undeclared variant (pack-variant)", async () => {
    const r = await submitRefused(
      coreRecord("1.0.0", 1, [
        containerVariant({ texture: "astc" }, "astc", { engine: "godot-4.7" }),
      ]),
    );
    expect(r.reason).toBe("pack-variant");
  });

  it("refuses a missing object (pack-object)", async () => {
    const variants = coreVariants("missing");
    // Everything but the s3tc variant's gaps object.
    const gaps = variants[0]!.objects[2]!;
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects).filter((o) => o !== gaps),
    );
    const r = await submitRefused(coreRecord("1.0.0", 1, variants));
    expect(r.reason).toBe("pack-object");
    expect(r.message).toContain("files-gaps");
  });

  it("refuses a file blob the index names but the product never uploaded (pack-object)", async () => {
    const variants = coreVariants("blob");
    const blobB = variants[0]!.objects[7]!;
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects).filter((o) => o !== blobB),
    );
    const r = await submitRefused(coreRecord("1.0.0", 1, variants));
    expect([r.reason, r.message.includes("a file blob")]).toEqual([
      "pack-object",
      true,
    ]);
  });

  it("refuses a wrong size (pack-object), for a named object and for full against payload", async () => {
    const variants = coreVariants("size");
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects),
    );
    const wrong = structuredClone(variants);
    (wrong[0]!.variant as any).deltas[0].artifact.bytes += 1;
    expect((await submitRefused(coreRecord("1.0.0", 1, wrong))).reason).toBe(
      "pack-object",
    );
    // full.size against payload.size is a publish rule, refused before any read.
    const full = structuredClone(variants);
    // (codec zstd, so the claims' `none` rule, bytes === size, does not refuse it first)
    (full[1]!.variant as any).full.codec = "zstd";
    (full[1]!.variant as any).full.size += 1;
    const r = await submitRefused(coreRecord("1.0.0", 1, full));
    expect([r.reason, r.message.includes("full")]).toEqual([
      "pack-object",
      true,
    ]);
  });

  it("refuses a wrong SHA-256 (pack-object): an object the product never uploaded", async () => {
    const variants = coreVariants("hash");
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects),
    );
    const wrong = structuredClone(variants);
    (wrong[0]!.variant as any).full.sha256 = sha("not uploaded");
    expect((await submitRefused(coreRecord("1.0.0", 1, wrong))).reason).toBe(
      "pack-object",
    );
  });

  it("refuses an index over MAX_PUBLISHED_INDEX_BYTES before reading, and a malformed index (pack-index)", async () => {
    const big = structuredClone(coreVariants("big"));
    (big[0]!.variant as any).files.size = 8388609;
    const r = await submitRefused(coreRecord("1.0.0", 1, big));
    expect(r.reason).toBe("pack-index");
    // An index whose payload does not match its variant's: parseFilesIndex refuses it.
    const variants = coreVariants("bad-index");
    await stageOk(
      CORE,
      variants.flatMap((v) => v.objects),
    );
    const mismatched = structuredClone(variants);
    // Swap the two variants' indexes: each index now describes the other payload.
    const a = (mismatched[0]!.variant as any).files;
    (mismatched[0]!.variant as any).files = (
      mismatched[1]!.variant as any
    ).files;
    (mismatched[1]!.variant as any).files = a;
    const bad = await submitRefused(coreRecord("1.0.0", 1, mismatched));
    expect(bad.reason).toBe("pack-index");
  });

  it("holds a pack record to the gate: a gate the record lacks, an assertion the gate contradicts, and the gated prefix", async () => {
    const variants = [await treeVariant({}, "skins")];
    const record = (entitlement?: string) =>
      packRecord({
        aud: SLUG,
        deliverable: SKINS,
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        type: "files.tree",
        variants: variants.map((v) => v.variant),
        ...(entitlement !== undefined ? { entitlement } : {}),
      });
    // No gate yet, but .pkey/release asserts `skins`: refused both ways until the operator gates.
    expect((await submitRefused(record("skins"))).reason).toBe(
      "pack-entitlement",
    );
    expect((await submitRefused(record())).reason).toBe("pack-entitlement");
    // The operator gates it: a record without the flag is refused; with it, accepted from gated/.
    await setGate(SKINS, "skins");
    expect((await submitRefused(record())).reason).toBe("pack-entitlement");
    await stageOk(SKINS, variants[0]!.objects, true);
    const res = await post("submit", {
      record: await signRecord(record("skins")),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      (
        await db.all<{ storage_key: string }>(
          "SELECT storage_key FROM release_artifacts WHERE product = ? AND release_id = ?",
          SLUG,
          `${SKINS}@1.0.0`,
        )
      ).every((r) => r.storage_key.startsWith("gated/blobs/sha256/")),
    ).toBe(true);
  });

  it("an app record is still submitted with its descriptor", async () => {
    const res = await post("submit", {
      record: await signRecord({
        schemaVersion: 1,
        aud: SLUG,
        deliverable: "app",
        kind: "app",
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        builds: [
          {
            id: "ios",
            platform: "ios",
            arch: "arm64",
            format: "ipa",
            artifacts: [],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("bad_body");
  });
});

// ── App releases with content ───────────────────────────────────────────────

const WEB = new TextEncoder().encode("web build bytes, version 1.5.0");
const WEB_SHA = sha(WEB);

function appDescriptor(
  version: string,
  seq: number,
  content: Record<string, unknown> | undefined,
  embeds: { web?: string[]; ios?: string[] } = {},
): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel: "stable",
    ...(content ? { content } : {}),
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        ...(embeds.web ? { embeds: embeds.web } : {}),
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
        id: "ios",
        platform: "ios",
        arch: "arm64",
        format: "ipa",
        buildNumber: "4022",
        ...(embeds.ios ? { embeds: embeds.ios } : {}),
        artifacts: [],
      },
    ],
  };
}

function content(
  pins: {
    pack: string;
    sha256: string;
    seq: number;
    version: string;
    required?: boolean;
  }[],
) {
  return {
    contentApi: 3,
    pins: pins.map((p) => ({
      pack: p.pack,
      release: { sha256: p.sha256, seq: p.seq, version: p.version },
    })),
    expects: pins.map((p) => ({
      pack: p.pack,
      required: p.required ?? p.pack === CORE,
      delivery: p.pack === CORE ? "essential" : "on-demand",
    })),
  };
}

/** Submit an app release with its record; returns the parsed answer. */
async function submitApp(
  descriptor: Record<string, any>,
  record?: Record<string, unknown>,
) {
  const up = await post("uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
  });
  const body = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  const jws = await signRecord(
    record ?? recordFor(descriptor, { seq: descriptor.seq, issuedAt: NOW }),
  );
  const res = await post("submit", {
    ticket: body.ticket,
    descriptor,
    record: jws,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe("app releases with content (pins and embeds)", () => {
  it("accepts pins and embeds, mirrors them into release_pins, content_api and embeds_json, read through the hook", async () => {
    const core = await publishCore("1.4.0", 12);
    const d = appDescriptor(
      "1.5.0",
      15,
      content([{ pack: CORE, sha256: core, seq: 12, version: "1.4.0" }]),
      { web: [], ios: [CORE] },
    );
    const res = await submitApp(d);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      await db.first(
        "SELECT content_api FROM release_metadata WHERE product = ? AND release_id = ?",
        SLUG,
        "app@1.5.0",
      ),
    ).toEqual({ content_api: 3 });
    const cat = await catalog();
    const pin = {
      appReleaseId: "app@1.5.0",
      pack: CORE,
      packReleaseId: `${CORE}@1.4.0`,
      recordSha256: core,
      required: true,
      delivery: "essential",
    };
    // "What does app release Y pin" and "which app releases pin pack release X".
    expect(await cat.pins("app@1.5.0")).toEqual([pin]);
    expect(await cat.pinnedBy(`${CORE}@1.4.0`)).toEqual([pin]);
    expect(await cat.embeds("app@1.5.0", "ios")).toEqual([CORE]);
    expect(await cat.embeds("app@1.5.0", "web")).toEqual([]);
  });

  it("refuses an app release without content while packs are declared (content-api)", async () => {
    const res = await submitApp(appDescriptor("1.5.0", 1, undefined));
    expect([res.status, res.body.error, res.body.reason]).toEqual([
      400,
      "release_record_rejected",
      "content-api",
    ]);
  });

  it("refuses a pin to an unknown release (pin-unknown) and to another pack's release (pin-mismatch)", async () => {
    const unknown = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([
          { pack: CORE, sha256: sha("nothing"), seq: 1, version: "1.0.0" },
        ]),
      ),
    );
    expect(unknown.body.reason).toBe("pin-unknown");
    const core = await publishCore("1.0.0", 1);
    const mismatch = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([{ pack: CORE, sha256: core, seq: 1, version: "1.0.1" }]),
      ),
    );
    expect(mismatch.body.reason).toBe("pin-mismatch");
  });

  it("yanking a pinned pack release keeps the existing pins and refuses a new pin (pin-yanked)", async () => {
    const core = await publishCore("1.0.0", 1);
    const pins = content([
      { pack: CORE, sha256: core, seq: 1, version: "1.0.0" },
    ]);
    expect((await submitApp(appDescriptor("1.5.0", 1, pins))).status).toBe(200);
    await db.run(
      "INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES (?, ?, 'broken', ?, 'ops')",
      SLUG,
      `${CORE}@1.0.0`,
      NOW,
    );
    expect(await (await catalog()).pinnedBy(`${CORE}@1.0.0`)).toHaveLength(1);
    const refused = await submitApp(appDescriptor("1.6.0", 2, pins));
    expect(refused.body.reason).toBe("pin-yanked");
    expect(await (await catalog()).pinnedBy(`${CORE}@1.0.0`)).toHaveLength(1);
  });

  it("refuses an unpinned required pack (pin-missing)", async () => {
    // The l10n pack is optional; core3d is required (and an embedded baseline).
    const variants = await Promise.all([
      treeVariant({ locale: "en" }, "l10n-en2"),
    ]);
    await stageOk(L10N, variants[0]!.objects);
    const l10nJws = await signRecord(
      packRecord({
        aud: SLUG,
        deliverable: L10N,
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        type: "files.tree",
        variants: variants.map((v) => v.variant),
      }),
    );
    expect((await post("submit", { record: l10nJws })).status).toBe(200);
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([
          { pack: L10N, sha256: sha(l10nJws), seq: 1, version: "1.0.0" },
        ]),
      ),
    );
    expect(res.body.reason).toBe("pin-missing");
  });

  it("refuses a required expect that pins a gated record (pin-gated)", async () => {
    const core = await publishCore("1.0.0", 1);
    await setGate(SKINS, "skins");
    const variants = [await treeVariant({}, "skins-gated")];
    await stageOk(SKINS, variants[0]!.objects, true);
    const skinsJws = await signRecord(
      packRecord({
        aud: SLUG,
        deliverable: SKINS,
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        type: "files.tree",
        entitlement: "skins",
        variants: variants.map((v) => v.variant),
      }),
    );
    expect((await post("submit", { record: skinsJws })).status).toBe(200);
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([
          { pack: CORE, sha256: core, seq: 1, version: "1.0.0" },
          {
            pack: SKINS,
            sha256: sha(skinsJws),
            seq: 1,
            version: "1.0.0",
            required: true,
          },
        ]),
      ),
    );
    expect(res.body.reason).toBe("pin-gated");
  });

  it("refuses an embeds entry that is not pinned (embeds)", async () => {
    const core = await publishCore("1.0.0", 1);
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([{ pack: CORE, sha256: core, seq: 1, version: "1.0.0" }]),
        { ios: [CORE, L10N] },
      ),
    );
    expect(res.body.reason).toBe("embeds");
  });

  it("refuses a record whose content differs from its descriptor's (descriptor-mismatch)", async () => {
    const core = await publishCore("1.0.0", 1);
    const d = appDescriptor(
      "1.5.0",
      1,
      content([{ pack: CORE, sha256: core, seq: 1, version: "1.0.0" }]),
    );
    const record = structuredClone(recordFor(d, { seq: 1, issuedAt: NOW }));
    (record.content as any).contentApi = 4;
    const res = await submitApp(d, record);
    expect([res.body.error, res.body.reason]).toEqual([
      "release_record_rejected",
      "descriptor-mismatch",
    ]);
  });

  it("the descriptor validator refuses content naming an undeclared pack before any store check", async () => {
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        1,
        content([
          { pack: "djdl.other", sha256: sha("x"), seq: 1, version: "1.0.0" },
        ]),
      ),
    );
    expect(res.body.reason).toBe("invalid_descriptor");
    expect(JSON.stringify(res.body.errors)).toContain(
      "invalid_descriptor_content",
    );
  });
});

describe("the object check batches", () => {
  it("checks objects in json_each batches", async () => {
    const { firstMissingObject } =
      await import("../src/services/release/packs/ingest.js");
    const blob = bytesFrom("batch", 10);
    await stageOk(CORE, [{ bytes: blob, sha256: sha(blob) }]);
    const key = `blobs/sha256/${sha(blob)}`;
    expect(await firstMissingObject(db, SLUG, [[key, 10]], 1)).toBeNull();
    expect(await firstMissingObject(db, SLUG, [[key, 11]], 1)).toBe(key);
    expect(await firstMissingObject(db, "other", [[key, 10]], 1)).toBe(key);
    const many = Array.from({ length: 25 }, () => [key, 10] as const);
    expect(await firstMissingObject(db, SLUG, many, 10)).toBeNull();
  });
});

// ── Round-1 review: the GitHub sync, app-only readers, fail-closed declarations ──

/** A GitHub release whose tag is `tag`, with one asset. */
function ghRelease(tag: string, assetId: number, name: string) {
  return release(tag, [
    {
      id: assetId,
      name,
      size: 10,
      content_type: "application/octet-stream",
      browser_download_url: `https://github.com/acme/djdl/releases/download/${tag}/${name}`,
    } as never,
  ]);
}

/** The pack release's rows that a GitHub sync must never touch. */
async function packRows(releaseId: string) {
  return {
    metadata: await db.first(
      "SELECT * FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      releaseId,
    ),
    builds: await db.all(
      "SELECT * FROM release_builds WHERE product = ? AND release_id = ? ORDER BY build_id",
      SLUG,
      releaseId,
    ),
    artifacts: await db.all(
      "SELECT * FROM release_artifacts WHERE product = ? AND release_id = ? ORDER BY artifact_id",
      SLUG,
      releaseId,
    ),
    health: await db.first(
      "SELECT * FROM release_health WHERE product = ? AND subject_kind = 'release' AND subject_id = ?",
      SLUG,
      releaseId,
    ),
  };
}

describe("a GitHub release tagged with a pack release id (B1)", () => {
  it("is skipped and reported; the pack row, its record marker and builds are unchanged, and a later pin still verifies", async () => {
    const core = await publishCore("1.4.0", 12);
    const packId = `${CORE}@1.4.0`;
    const before = await packRows(packId);
    expect(
      (before.metadata as { metadata_json: string }).metadata_json,
    ).toContain(core);
    expect(before.builds.length).toBeGreaterThan(0);

    const gh = github({
      releases: [
        ghRelease(packId, 9001, "djdl-1.4.0-web.zip"),
        ghRelease("v1.3.0", 9002, "djdl-1.3.0-web.zip"),
      ],
    });
    const report = await syncReleaseStoreReport(
      env,
      db,
      SLUG,
      NOW + 100,
      gh.fetchImpl,
    );
    expect(report.statements).toBeGreaterThan(0);
    expect(report.packTagConflicts).toEqual([packId]);
    expect(await packRows(packId)).toEqual(before);
    expect(
      await db.first<{ m: string }>(
        "SELECT json_extract(metadata_json, '$.record.sha256') AS m FROM release_metadata WHERE product = ? AND release_id = ?",
        SLUG,
        packId,
      ),
    ).toEqual({ m: core });
    // The app release beside it synced as usual.
    expect(
      await db.first(
        "SELECT deliverable_id FROM release_metadata WHERE product = ? AND release_id = 'v1.3.0'",
        SLUG,
      ),
    ).toEqual({ deliverable_id: "app" });

    // A pin to the pack release still verifies against its record, version and seq.
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        15,
        content([{ pack: CORE, sha256: core, seq: 12, version: "1.4.0" }]),
      ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("the write-time guards hold even when the plan did not skip it (a pack ingested after the sync read the store)", async () => {
    const core = await publishCore("1.4.0", 12);
    const packId = `${CORE}@1.4.0`;
    const before = await packRows(packId);
    const cfg = (await getReleaseConfig(db, SLUG))!;
    // The statement builder handed the colliding release directly, as a stale plan would.
    await db.batch(
      releaseStoreStatements(
        SLUG,
        cfg,
        [ghRelease(packId, 9001, "djdl-1.4.0-web.zip")],
        NOW + 100,
      ),
    );
    expect(await packRows(packId)).toEqual(before);
    expect(
      await db.first<{ m: string }>(
        "SELECT json_extract(metadata_json, '$.record.sha256') AS m FROM release_metadata WHERE product = ? AND release_id = ?",
        SLUG,
        packId,
      ),
    ).toEqual({ m: core });
  });
});

describe("app-only readers ignore pack releases (B2, N6)", () => {
  it("sync health's stored ids are the app's only (no absentUpstream on a pack release)", async () => {
    await publishCore("1.4.0", 12);
    expect(await listStoredReleaseIds(db, SLUG)).not.toContain(`${CORE}@1.4.0`);
    const gh = github({ releases: [] });
    await syncReleaseStore(env, db, SLUG, NOW + 100, gh.fetchImpl);
    expect(
      await db.first(
        "SELECT 1 AS n FROM release_health WHERE product = ? AND subject_kind = 'release' AND subject_id = ?",
        SLUG,
        `${CORE}@1.4.0`,
      ),
    ).toBeNull();
  });

  it("the customer portal never lists a pack release", async () => {
    await publishCore("1.4.0", 12);
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, created_at,
          modified_at, deliverable_id, seq)
       VALUES (?, 'v9.0.0', '9.0.0', 'public', 'public', ?, ?, 'app', 99)`,
      SLUG,
      NOW,
      NOW,
    );
    const rows = await listPortalReleases(db, [SLUG]);
    expect(rows.map((r) => r.release_id)).toEqual(["v9.0.0"]);
  });

  it("the console Releases list is the app's only (pack views are P4-09's)", async () => {
    await publishCore("1.4.0", 12);
    expect(
      (await listReleaseMetadata(db, SLUG)).map((r) => r.release_id),
    ).not.toContain(`${CORE}@1.4.0`);
  });

  it("knownChannels learns no channel from a pack release", async () => {
    await publishCore("1.4.0", 12);
    await db.run(
      "UPDATE release_metadata SET channel = 'dlc-nightly' WHERE product = ? AND release_id = ?",
      SLUG,
      `${CORE}@1.4.0`,
    );
    const cfg = await getReleaseConfig(db, SLUG);
    expect(await knownChannels(db, SLUG, cfg)).not.toContain("dlc-nightly");
    // An app release on the same channel does declare it.
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, created_at,
          modified_at, deliverable_id, seq, channel)
       VALUES (?, 'v9.0.0', '9.0.0', 'public', 'public', ?, ?, 'app', 99, 'dlc-nightly')`,
      SLUG,
      NOW,
      NOW,
    );
    expect(await knownChannels(db, SLUG, cfg)).toContain("dlc-nightly");
  });
});

describe("pack declarations are checked closed (N1, N4)", () => {
  it("a variant axis named constructor is a pack-variant refusal, not a 500", async () => {
    const pack = parsed().release!.packDeliverables.find((p) => p.id === CORE)!;
    const record = coreRecord("1.0.0", 1, [
      containerVariant({ constructor: "x" } as never, "ctor", {
        engine: "godot-4.7",
      }),
    ]);
    expect(
      checkPackAgainstDeclaration(record as never, pack, null)?.reason,
    ).toBe("pack-variant");
    const r = await submitRefused(record);
    expect(r.status).toBe(400);
    expect(r.reason).toBe("pack-variant");
  });

  it("an unreadable pack declaration refuses an app release's ingest (pack-unreadable)", async () => {
    const core = await publishCore("1.4.0", 12);
    await db.run(
      "UPDATE release_deliverables SET def_json = '{not json' WHERE product = ? AND deliverable_id = ?",
      SLUG,
      SKINS,
    );
    const res = await submitApp(
      appDescriptor(
        "1.5.0",
        15,
        content([{ pack: CORE, sha256: core, seq: 12, version: "1.4.0" }]),
      ),
    );
    expect([res.status, res.body.error, res.body.reason]).toEqual([
      400,
      "release_record_rejected",
      "pack-unreadable",
    ]);
    expect(res.body.message).toContain(SKINS);
  });
});
