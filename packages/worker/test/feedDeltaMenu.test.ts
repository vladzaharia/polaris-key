/**
 * P4-29 — the feed's delta menu, the Worker's half (plans/P4-29.md §6), through the real
 * dispatcher:
 *
 *   - the `lazyDeltas` hook lists a ready lazy delta to a pinned container variant, and leaves out
 *     a row a record delta already covers, a descriptor that fails §2.2, a window too large for a
 *     32-bit applier, and everything while either P4-17 switch is off;
 *   - the composed feed lists it under the target payload for devices on `from`, and client-core's
 *     planner picks it after `withFeedDeltas` (P4-17's fourth criterion);
 *   - the blob route serves it by its own hash under the holding pack's rules: a gated pack's
 *     delta only to a caller its current gate admits; a cold delta or a switch turned off is the
 *     plain not-found;
 *   - P4-18's payload URL answers `dcz` from it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { base64UrlDecode } from "@polaris-key/jws";
import { feedContent } from "@polaris-key/client-core/feed";
import {
  plan,
  planTarget,
  withFeedDeltas,
} from "@polaris-key/client-core/packs";
import type { PackVariant } from "@polaris-key/protocol/packs";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { mkReq, NOW, seedLicenseWithKey } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  BYTES,
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
  bytesFrom,
  containerVariant,
  packRecord,
  rawZstdFrame,
  sha,
  type Obj,
} from "./packFixture.js";
import type { Db, DbParam } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { manifestIngestStatements } from "../src/services/distribution/outlets.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { hashKey } from "../src/crypto.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { deltaKey, recordObject, recordRef } from "../src/core/blobs.js";
import { recordReady } from "../src/services/release/packs/deltas/store.js";
import { dczHeader } from "../src/services/distribution/dictionary.js";

installDigestStream();

const CORE = "djdl.core3d";
const VAULT = "djdl.vault";
const SKINS = "djdl.skins";
const VARIANT = "texture=s3tc";

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
          },
        ],
      },
      [CORE]: {
        kind: "pack",
        type: "godot.pck",
        delivery: "essential",
        handler: { mountOrder: 1, prefixes: ["res://assets/core/"] },
        variants: { texture: ["s3tc"] },
        requires: { engine: "godot-4.7" },
      },
      [VAULT]: {
        kind: "pack",
        type: "godot.pck",
        delivery: "on-demand",
        handler: { mountOrder: 2, prefixes: ["res://assets/vault/"] },
        requires: { engine: "godot-4.7" },
      },
      [SKINS]: { kind: "pack", type: "files.tree", delivery: "on-demand" },
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
      key: "vault",
      kind: "flag",
      category: "Extras",
      label: "vault",
      description: "The vault flag.",
      schema: { type: "boolean" },
      userGrant: true,
    },
  ],
};

function parsed() {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify(SCHEMA_DOC),
    release: JSON.stringify(RELEASE_DOC),
    distribution: JSON.stringify({ outlets: { direct: {} } }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest;
}

let db: Db;
let env: Env;
let r2: R2Mock;
let ciToken: string;
let devices = 0;
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock(), blobOrigin: BYTES });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, {
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_PARENT_ACCESS_KEY_ID: "parent-akid",
    R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
    BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
  });
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  const m = parsed();
  await db.batch([
    ...manifestDeliverableStatements(
      SLUG,
      m.release!.app,
      NOW,
      m.release!.packDeliverables,
    ),
    ...manifestIngestStatements(m, SLUG, NOW),
  ]);
  ciToken = (
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/publish/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ciToken}`,
    },
    body: JSON.stringify(body),
  });
}

async function access(
  deliverable: string,
  mode: string,
  entitlement: string | null = null,
) {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, ?, ?, 'admin', ?)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET
       mode = excluded.mode, entitlement = excluded.entitlement`,
    SLUG,
    deliverable,
    mode,
    entitlement,
    NOW,
  );
}

async function stage(deliverable: string, objects: Obj[], gated = false) {
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
  const res = await post("stage", { ticket: body.ticket, deliverable });
  expect(res.status, await res.clone().text()).toBe(200);
}

interface Published {
  payload: Uint8Array;
  payloadSha256: string;
  frame: Uint8Array;
  fullSha256: string;
  artifact: Uint8Array | null;
  artifactSha256: string | null;
}

/**
 * A container release of `pack`: the payload stored as one zstd frame (`codec: zstd`) and, when
 * `from` is given, a `zstd-patch-from` payload delta from it (the artifact's bytes are opaque
 * here: the Worker never decodes one).
 */
async function publish(
  pack: string,
  version: string,
  seq: number,
  o: { from?: string; variant?: Record<string, string>; gate?: string } = {},
): Promise<Published> {
  const built = containerVariant(o.variant ?? {}, `${pack}-${version}`, {
    engine: "godot-4.7",
  });
  const v = built.variant as {
    payload: { size: number; sha256: string };
    full: { sha256: string; bytes: number; size: number; codec: string };
    deltas: { scope: string; from: string; artifact?: { sha256: string } }[];
  };
  const payload = built.objects.find((x) => x.sha256 === v.full.sha256)!.bytes;
  const frame = rawZstdFrame(payload);
  v.full = {
    sha256: sha(frame),
    bytes: frame.length,
    size: payload.length,
    codec: "zstd",
  };
  const objects = [
    ...built.objects.filter((x) => x.sha256 !== sha(payload)),
    { bytes: frame, sha256: sha(frame) },
  ];
  let artifact: Uint8Array | null = null;
  if (o.from) {
    for (const d of v.deltas) d.from = o.from;
    const sha256 = v.deltas.find((d) => d.scope === "payload")!.artifact!
      .sha256;
    artifact = objects.find((x) => x.sha256 === sha256)!.bytes;
  } else v.deltas = [];
  await stage(pack, objects, o.gate !== undefined);
  const jws = await signRecord(
    packRecord({
      aud: SLUG,
      deliverable: pack,
      version,
      seq,
      issuedAt: NOW,
      type: "godot.pck",
      handler: {
        mountOrder: pack === CORE ? 1 : 2,
        prefixes: [
          pack === CORE ? "res://assets/core/" : "res://assets/vault/",
        ],
        activation: "restart",
      },
      variants: [built.variant],
      ...(o.gate !== undefined ? { entitlement: o.gate } : {}),
    }),
  );
  const res = await post("submit", { record: jws });
  expect(res.status, await res.clone().text()).toBe(200);
  return {
    payload,
    payloadSha256: v.payload.sha256,
    frame,
    fullSha256: v.full.sha256,
    artifact,
    artifactSha256: artifact ? sha(artifact) : null,
  };
}

/** v1 and v2 of the core pack (variant `texture=s3tc`), v2 with a payload delta from v1. */
async function coreV1V2() {
  await access(CORE, "public");
  const v1 = await publish(CORE, "1.0.0", 1, { variant: { texture: "s3tc" } });
  const v2 = await publish(CORE, "1.1.0", 2, {
    variant: { texture: "s3tc" },
    from: v1.payloadSha256,
  });
  return { v1, v2 };
}

function payloadUrl(
  pack: string,
  variant: string,
  sha256: string,
  query = "",
  origin = BYTES,
) {
  return `${origin}/${SLUG}/distribution/packs/${pack}/${variant}/payload/${sha256}${query}`;
}

function get(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return call(env, db, noFetch, url, { method, headers });
}

const CHROMIUM_AE = "gzip, deflate, br, zstd";
const CHROMIUM_AE_DCZ = "gzip, deflate, br, zstd, dcz";
const sfBinary = (hex: string) =>
  `:${Buffer.from(hex, "hex").toString("base64")}:`;
const bytesOf = async (res: Response) =>
  new Uint8Array(await res.arrayBuffer());

async function deviceToken(flags: string[]): Promise<string> {
  devices += 1;
  const { key } = await seedLicenseWithKey(db, SLUG, {
    id: `lic_${devices}`,
    entitlements: Object.fromEntries(
      flags.map((f) => [f, { state: "enforced", value: true, updatedAt: NOW }]),
    ),
  });
  await db.run(
    "UPDATE keys_index SET key_hash = ? WHERE key_hash = ?",
    await hashKey(key, env.KEY_HASH_PEPPER),
    await hashKey(key),
  );
  const product = (await loadProduct(env, db, SLUG))!;
  const act = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": `dev-${devices}`,
    }),
    env,
    db,
    product,
    NOW,
  );
  expect(act.status, await act.clone().text()).toBe(200);
  return ((await act.json()) as { token: string }).token;
}

// ── P4-29 helpers ───────────────────────────────────────────────────────────

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);
const METHOD = "zstd-patch-from";

/** App `version` at `seq` on stable (a web build), through the real submit route. */
async function submitApp(
  version: string,
  seq: number,
  pins: { pack: string; version: string }[],
): Promise<string> {
  const pinned = [];
  for (const p of pins) {
    const row = await packRow(p.pack, p.version);
    pinned.push({
      pack: p.pack,
      release: { sha256: row.record_sha256, seq: row.seq, version: p.version },
    });
  }
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel: "stable",
    content: {
      contentApi: 3,
      pins: pinned,
      expects: pins.map((p) => ({
        pack: p.pack,
        required: false,
        delivery: "on-demand",
      })),
    },
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
    ],
  };
  const up = await post("uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
  });
  const body = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  const jws = await signRecord(recordFor(descriptor, { seq, issuedAt: NOW }));
  const res = await post("submit", {
    ticket: body.ticket,
    descriptor,
    record: jws,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = await db.first<{ release_id: string }>(
    `SELECT release_id FROM release_metadata
      WHERE product = ? AND deliverable_id = 'app' AND version = ?`,
    SLUG,
    version,
  );
  return row!.release_id;
}

/** The pack release's id and record hash. */
async function packRow(pack: string, version: string) {
  return (await db.first<{
    release_id: string;
    record_sha256: string;
    seq: number;
  }>(
    `SELECT m.release_id, r.record_sha256, m.seq FROM release_metadata m
       JOIN release_records r ON r.product = m.product AND r.release_id = m.release_id
      WHERE m.product = ? AND m.deliverable_id = ? AND m.version = ?`,
    SLUG,
    pack,
    version,
  ))!;
}

function optIn(enabled = true) {
  env.LAZY_DELTAS = "on";
  return db.run(
    `INSERT INTO lazy_delta_settings (product, enabled, hot_devices, daily_cap, updated_at)
     VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT (product) DO UPDATE SET enabled = excluded.enabled`,
    SLUG,
    enabled ? 1 : 0,
    NOW,
  );
}

interface Lazy {
  frame: Uint8Array;
  sha256: string;
  key: string;
}

/** A ready lazy delta `from` → `to` of `pack`, stored and held as P4-17's consumer stores it. */
async function lazyDelta(
  pack: string,
  from: Published,
  to: Published,
  o: {
    gated?: boolean;
    memBytes?: number;
    windowLog?: number;
    createdAt?: number;
  } = {},
): Promise<Lazy> {
  const frame = bytesFrom(`lazy:${from.payloadSha256}:${to.payloadSha256}`, 48);
  const sha256 = sha(frame);
  const key = deltaKey(from.payloadSha256, to.payloadSha256, METHOD, {
    gated: o.gated === true,
  });
  r2.seed(key, frame, { withSha256: true });
  const at = o.createdAt ?? NOW;
  await recordObject(
    db,
    {
      storageKey: key,
      sha256,
      size: frame.length,
      kind: "delta",
      gated: o.gated === true,
    },
    at,
  );
  await recordRef(
    db,
    { product: SLUG, storageKey: key, refKind: "lazy-delta", refId: pack },
    at,
  );
  const memBytes = o.memBytes ?? from.payload.length + to.payload.length;
  await recordReady(
    db,
    {
      product: SLUG,
      deliverableId: pack,
      buildId: VARIANT,
      from: from.payloadSha256,
      to: to.payloadSha256,
    },
    key,
    {
      method: METHOD,
      scope: "payload",
      from: from.payloadSha256,
      to: to.payloadSha256,
      size: to.payload.length,
      memBytes,
      windowLog: o.windowLog ?? 10,
      artifact: { sha256, bytes: frame.length },
    },
    at,
  );
  return { frame, sha256, key };
}

/** `n` devices last seen on `payload` of `pack` (P4-17's demand table), at `at`. */
async function seen(
  pack: string,
  payload: string,
  n: number,
  prefix = "dev",
  at = NOW,
): Promise<void> {
  for (let i = 0; i < n; i++)
    await db.run(
      `INSERT OR REPLACE INTO delta_demand_devices
         (product, deliverable_id, from_sha256, to_sha256, device_id, strategy, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      pack,
      sha(`from:${prefix}:${i}`),
      payload,
      `${prefix}-${i}`,
      "chunk",
      at,
    );
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

function feedPayload(jws: string): Record<string, any> {
  return JSON.parse(
    new TextDecoder().decode(base64UrlDecode(jws.split(".")[1]!)),
  ) as Record<string, any>;
}

async function feed(): Promise<Record<string, any>> {
  const res = await call(
    env,
    db,
    noFetch,
    `${CONSOLE}/${SLUG}/update/stable/feed.jws?platform=web`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return feedPayload(await res.text());
}

const blobUrl = (hex: string) =>
  `${BYTES}/${SLUG}/distribution/blobs/sha256/${hex}`;

/** CORE v1 and v2 (no record delta), app 1.0.0 pinning v2 (and `pins`), and a ready lazy
 *  delta v1 → v2. */
async function coreWorld(pins: { pack: string; version: string }[] = []) {
  await access(CORE, "public");
  const v1 = await publish(CORE, "1.0.0", 1, { variant: { texture: "s3tc" } });
  const v2 = await publish(CORE, "1.1.0", 2, { variant: { texture: "s3tc" } });
  const app = await submitApp("1.0.0", 1, [
    { pack: CORE, version: "1.1.0" },
    ...pins,
  ]);
  const record = (await packRow(CORE, "1.1.0")).record_sha256;
  await optIn();
  const lazy = await lazyDelta(CORE, v1, v2);
  return { v1, v2, app, record, lazy };
}

// ── The hook (§6.1) ─────────────────────────────────────────────────────────

describe("ReleaseCatalog.lazyDeltas (plans/P4-29.md §6.1)", () => {
  it("lists a ready lazy delta to a named record's container variant", async () => {
    const { v1, v2, record, lazy } = await coreWorld();
    const rows = await (await catalog()).lazyDeltas!([record]);
    expect(rows).toEqual([
      {
        recordSha256: record,
        deliverableId: CORE,
        to: v2.payloadSha256,
        entry: {
          from: v1.payloadSha256,
          method: METHOD,
          scope: "payload",
          memBytes: v1.payload.length + v2.payload.length,
          artifact: { sha256: lazy.sha256, bytes: lazy.frame.length },
        },
        createdAt: NOW,
      },
    ]);
    // A record not named lists nothing.
    expect(await (await catalog()).lazyDeltas!([sha("other")])).toEqual([]);
  });

  it("lists nothing while LAZY_DELTAS is off or the product is not opted in", async () => {
    const { record } = await coreWorld();
    env.LAZY_DELTAS = "off";
    expect(await (await catalog()).lazyDeltas!([record])).toEqual([]);
    await optIn(false);
    expect(await (await catalog()).lazyDeltas!([record])).toEqual([]);
  });

  it("leaves out a pair the record's own delta covers, a bad descriptor and an oversized window", async () => {
    await access(CORE, "public");
    const v1 = await publish(CORE, "1.0.0", 1, {
      variant: { texture: "s3tc" },
    });
    const v0 = await publish(CORE, "0.9.0", 2, {
      variant: { texture: "s3tc" },
    });
    const vx = await publish(CORE, "0.8.0", 3, {
      variant: { texture: "s3tc" },
    });
    // v2 carries a record delta from v1 (CI's), so a lazy v1 → v2 is redundant.
    const vy = await publish(CORE, "0.7.0", 4, {
      variant: { texture: "s3tc" },
    });
    const v2 = await publish(CORE, "1.1.0", 5, {
      variant: { texture: "s3tc" },
      from: v1.payloadSha256,
    });
    await submitApp("1.0.0", 1, [{ pack: CORE, version: "1.1.0" }]);
    const record = (await packRow(CORE, "1.1.0")).record_sha256;
    await optIn();
    await lazyDelta(CORE, v1, v2);
    await lazyDelta(CORE, v0, v2, { memBytes: 0 });
    // memBytes ~ 340 B: the window bound is max(10, ⌈log2⌉) = 10, so 11 is refused.
    await lazyDelta(CORE, vx, v2, { windowLog: 11 });
    // The control: a valid pair from another base is listed, alone.
    const ok = await lazyDelta(CORE, vy, v2);
    expect(
      (await (await catalog()).lazyDeltas!([record])).map(
        (r) => r.entry.artifact.sha256,
      ),
    ).toEqual([ok.sha256]);
  });
});

describe("ReleaseCatalog.lazyDeltaDevices (the menu's rank, P4-29 follow-up)", () => {
  it("counts the devices last seen on each base in the hot window, aligned with the bases", async () => {
    const { v1, v2 } = await coreWorld();
    await seen(CORE, v1.payloadSha256, 3);
    await seen(CORE, v2.payloadSha256, 1, "other");
    // A device seen before the hot window does not count.
    await seen(CORE, v1.payloadSha256, 1, "stale", NOW - 40 * 86_400);
    expect(
      await (
        await catalog()
      ).lazyDeltaDevices!([
        { deliverableId: CORE, from: v1.payloadSha256 },
        { deliverableId: CORE, from: sha("nobody") },
        { deliverableId: VAULT, from: v1.payloadSha256 },
        { deliverableId: CORE, from: v2.payloadSha256 },
      ]),
    ).toEqual([3, 0, 0, 1]);
  });
});

// ── The composed feed (§6.1, §6.2) ──────────────────────────────────────────

describe("the composed feed's delta menu (plans/P4-29.md §6.1, §6.2)", () => {
  it("lists the ready delta under the target payload, and client-core's planner picks it", async () => {
    const { v1, v2, lazy } = await coreWorld();
    const doc = await feed();
    const content = feedContent(doc);
    expect(content.deltas).toEqual({
      [v2.payloadSha256]: [
        {
          from: v1.payloadSha256,
          method: METHOD,
          scope: "payload",
          memBytes: v1.payload.length + v2.payload.length,
          artifact: { sha256: lazy.sha256, bytes: lazy.frame.length },
        },
      ],
    });
    // P4-17's fourth criterion: the merged variant's feed delta is the plan for a device on v1.
    const record = (await (
      await catalog()
    ).packRelease(CORE, (await packRow(CORE, "1.1.0")).release_id))!;
    const variant = record.variants[0]!;
    const full = {
      variant: variant.variant,
      payload: variant.payload,
      full: {
        sha256: v2.fullSha256,
        bytes: v2.frame.length,
        size: v2.payload.length,
        codec: "zstd",
      },
      files: {
        format: "pkey-files/1",
        layout: "container",
        sha256: sha("index"),
        bytes: 10,
        size: 10,
        codec: "zstd",
        gaps: { sha256: sha("gaps"), bytes: 0, size: 0, codec: "none" },
      },
      deltas: [],
    } as unknown as PackVariant;
    const merged = withFeedDeltas(full, content.deltas);
    expect(merged.feedIds).toEqual([lazy.sha256]);
    const p = plan({
      target: planTarget(merged.variant, sha("record"), null),
      installed: [
        { release: sha("v1"), payloadSha256: v1.payloadSha256, files: null },
      ],
      caps: {
        strategies: ["delta", "chunk", "file", "full"],
        patchMethods: [METHOD],
        transports: ["pkey-cdn"],
        memBudget: 1 << 30,
        freeDisk: 1 << 30,
      },
    });
    expect(p).toMatchObject({ strategy: "delta", delta: lazy.sha256 });
  });

  it("lists a gated pack's delta too (serving, not listing, is gated), and bumps seq when it turns cold", async () => {
    await access(VAULT, "entitled", "vault");
    const g1 = await publish(VAULT, "1.0.0", 1, { gate: "vault" });
    const g2 = await publish(VAULT, "1.1.0", 2, { gate: "vault" });
    const { v2, lazy } = await coreWorld([{ pack: VAULT, version: "1.1.0" }]);
    const gl = await lazyDelta(VAULT, g1, g2, { gated: true });
    const doc = await feed();
    expect(Object.keys(doc.deltas).sort()).toEqual(
      [v2.payloadSha256, g2.payloadSha256].sort(),
    );
    expect(doc.deltas[g2.payloadSha256][0].artifact.sha256).toBe(gl.sha256);
    // P4-17's cold marking: the row and the ref go, the menu shrinks, the seq moves.
    await db.run(
      "UPDATE release_lazy_deltas SET state = 'cold' WHERE product = ? AND artifact_sha256 = ?",
      SLUG,
      lazy.sha256,
    );
    const after = await feed();
    expect(Object.keys(after.deltas)).toEqual([g2.payloadSha256]);
    expect(after.seq).toBe(doc.seq + 1);
  });

  it("ranks by the devices on each base, read only when a document is signed (never on the hash path)", async () => {
    await access(CORE, "public");
    const v0 = await publish(CORE, "0.9.0", 1, {
      variant: { texture: "s3tc" },
    });
    const v1 = await publish(CORE, "1.0.0", 2, {
      variant: { texture: "s3tc" },
    });
    const v2 = await publish(CORE, "1.1.0", 3, {
      variant: { texture: "s3tc" },
    });
    await submitApp("1.0.0", 1, [{ pack: CORE, version: "1.1.0" }]);
    await optIn();
    // The newer delta would rank first on generation time; v0's installed base outranks it.
    const newer = await lazyDelta(CORE, v1, v2, { createdAt: NOW });
    const older = await lazyDelta(CORE, v0, v2, { createdAt: NOW - 60 });
    await seen(CORE, v0.payloadSha256, 2);
    const reads: string[] = [];
    const all = db.all.bind(db);
    vi.spyOn(db, "all").mockImplementation(((
      sql: string,
      ...args: DbParam[]
    ) => {
      if (sql.includes("delta_demand_devices")) reads.push(sql);
      return all(sql, ...args);
    }) as typeof db.all);
    const signed = await feed();
    expect(
      signed.deltas[v2.payloadSha256].map(
        (e: { artifact: { sha256: string } }) => e.artifact.sha256,
      ),
    ).toEqual([older.sha256, newer.sha256]);
    expect(reads.length).toBeGreaterThan(0);
    // The stored copy is current: the request hashes the candidate set and reads no device count.
    reads.length = 0;
    const again = await feed();
    expect(again.seq).toBe(signed.seq);
    expect(again.deltas).toEqual(signed.deltas);
    expect(reads).toEqual([]);
    // Device counts moving never re-sign: the rank is outside the hash.
    await seen(CORE, v1.payloadSha256, 5, "more");
    expect((await feed()).seq).toBe(signed.seq);
    expect(reads).toEqual([]);
  });

  it("omits the member, and keeps the seq, with no ready delta or with the switch off", async () => {
    const { lazy } = await coreWorld();
    const listed = await feed();
    env.LAZY_DELTAS = "off";
    const off = await feed();
    expect(off.deltas).toBeUndefined();
    expect(lazy.sha256).toBeTruthy();
    expect(off.seq).toBe(listed.seq + 1);
  });
});

// ── Serving (§6.3) ──────────────────────────────────────────────────────────

describe("serving lazy deltas (plans/P4-29.md §6.3)", () => {
  it("serves a public pack's delta by its own hash on the blob route", async () => {
    const { lazy } = await coreWorld();
    const res = await get(blobUrl(lazy.sha256));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await bytesOf(res)).toEqual(lazy.frame);
  });

  it("answers not-found for a cold delta, or with either switch off", async () => {
    const { lazy } = await coreWorld();
    env.LAZY_DELTAS = "off";
    expect((await get(blobUrl(lazy.sha256))).status).toBe(404);
    env.LAZY_DELTAS = "on";
    await optIn(false);
    expect((await get(blobUrl(lazy.sha256))).status).toBe(404);
    await optIn(true);
    expect((await get(blobUrl(lazy.sha256))).status).toBe(200);
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_kind = 'lazy-delta'",
      SLUG,
    );
    expect((await get(blobUrl(lazy.sha256))).status).toBe(404);
  });

  it("serves a gated pack's delta only to a caller its current gate admits", async () => {
    await access(VAULT, "entitled", "vault");
    const g1 = await publish(VAULT, "1.0.0", 1, { gate: "vault" });
    const g2 = await publish(VAULT, "1.1.0", 2, { gate: "vault" });
    await optIn();
    const gl = await lazyDelta(VAULT, g1, g2, { gated: true });
    expect(gl.key.startsWith("gated/deltas/")).toBe(true);
    const anon = await get(blobUrl(gl.sha256));
    expect([401, 403]).toContain(anon.status);
    const without = await get(blobUrl(gl.sha256), {
      authorization: `Bearer ${await deviceToken([])}`,
    });
    expect(without.status).toBe(403);
    const withFlag = await get(blobUrl(gl.sha256), {
      authorization: `Bearer ${await deviceToken(["vault"])}`,
    });
    expect(withFlag.status, await withFlag.clone().text()).toBe(200);
    expect(withFlag.headers.get("cache-control")).toContain("private");
    expect(await bytesOf(withFlag)).toEqual(gl.frame);
  });

  it("answers dcz from the lazy delta on P4-18's payload URL", async () => {
    const { v1, v2, lazy } = await coreWorld();
    const res = await get(payloadUrl(CORE, VARIANT, v2.payloadSha256), {
      "accept-encoding": CHROMIUM_AE_DCZ,
      "available-dictionary": sfBinary(v1.payloadSha256),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("dcz");
    const body = await bytesOf(res);
    expect(body.subarray(0, 40)).toEqual(dczHeader(v1.payloadSha256));
    expect(body.subarray(40)).toEqual(lazy.frame);
    // With the switch off the payload URL no longer knows it: `?via=dcz` is the 409.
    env.LAZY_DELTAS = "off";
    const off = await get(
      payloadUrl(CORE, VARIANT, v2.payloadSha256, "?via=dcz"),
      {
        "accept-encoding": CHROMIUM_AE_DCZ,
        "available-dictionary": sfBinary(v1.payloadSha256),
      },
    );
    expect(off.status).toBe(409);
  });
});
