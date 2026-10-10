/**
 * P4-05 — pack transports, availability and gated delivery, through the real dispatcher
 * (plans/P4-01.md §6 and decision 35):
 *
 *   - transports: every pack is routed per outlet (`dist_transports`); a transport other than
 *     `pkey-cdn`, `web` and `embedded` is stored and reported unsupported;
 *   - availability: `pkey-cdn`/`web` live per variant once every object the record names is
 *     stored and held; `embedded` per (app release, outlet) from the builds' `embeds`;
 *   - bytes: every pack object on the blob route with Range, If-Range, ETag = SHA-256,
 *     Repr-Digest and no Content-Encoding; `files`/`builds` never serve a pack object (P4-02's
 *     hand-off); a `gated/` object needs the pack's CURRENT gate's flag and is `private, no-store`;
 *     `entitled` without a gate is fail-closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  setDeliverableAccess,
  stagePackObjects,
} from "./seed.js";
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
  containerVariant,
  packRecord,
  sha,
  treeVariant,
  type BuiltVariant,
  type Obj,
} from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { manifestIngestStatements } from "../src/services/distribution/outlets.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { handleActivate } from "../src/services/license/activation.js";
import { blobKey, recordRef } from "../src/core/assets/blobs.js";
import { buildMatrix } from "../src/services/distribution/matrix.js";
import { hashKey } from "../src/platform/crypto.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";

installDigestStream();

const CORE = "djdl.core3d";
const SKINS = "djdl.skins";
const ORIGIN = "https://game.example";

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
      // No `.pkey/release` assertion: the operator's gate alone decides (decision 35).
      [SKINS]: { kind: "pack", type: "files.tree", delivery: "on-demand" },
    },
  },
};

/**
 * Four outlets: `direct` (every deliverable by `pkey-cdn`), `bundled` (a second direct outlet
 * that carries the core pack EMBEDDED), `web` (the web build, `web` transport) and an App
 * Installer outlet whose packs travel by `msix-optional`, a transport v1 does not act on.
 */
const DISTRIBUTION_DOC = {
  outlets: {
    direct: {},
    bundled: { kind: "direct" },
    web: {},
    "app-installer": {
      packageFamilyName: "Acme.Djdl_8wekyb3d8bbwe",
      publisher: "CN=Acme",
    },
  },
  transports: {
    packs: { "app-installer": "msix-optional" },
    deliverables: { [CORE]: { bundled: "embedded" } },
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
  entries: ["skins", "skins2", "core-paid"].map((key) => ({
    key,
    kind: "flag",
    category: "Extras",
    label: key,
    description: `The ${key} flag.`,
    schema: { type: "boolean" },
    userGrant: true,
  })),
};

function parsed() {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify(SCHEMA_DOC),
    release: JSON.stringify(RELEASE_DOC),
    distribution: JSON.stringify(DISTRIBUTION_DOC),
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
  Object.assign(env, R2_ENV);
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
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([ORIGIN]),
    SLUG,
  );
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

/** One deliverable's `dist_access` row, as an operator sets it. */
function access(
  deliverable: string,
  mode: string,
  entitlement: string | null = null,
) {
  return setDeliverableAccess(db, SLUG, deliverable, mode, entitlement, NOW);
}

/** Upload `objects` through a ticket and a stage round for `deliverable`. */
function stage(deliverable: string, objects: Obj[], gated = false) {
  return stagePackObjects(post, r2, deliverable, objects, gated);
}

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

function coreRecordOf(version: string, seq: number, variants: BuiltVariant[]) {
  return packRecord({
    aud: SLUG,
    deliverable: CORE,
    version,
    seq,
    issuedAt: NOW,
    type: "godot.pck",
    handler: {
      mountOrder: 1,
      prefixes: ["res://assets/core/"],
      activation: "restart",
    },
    variants: variants.map((v) => v.variant),
  });
}

/** Stage and submit a core3d release; returns its variants and record hash. */
async function publishCore(version: string, seq: number) {
  const variants = coreVariants(`core-${version}`);
  await stage(
    CORE,
    variants.flatMap((v) => v.objects),
  );
  const jws = await signRecord(coreRecordOf(version, seq, variants));
  const res = await post("submit", { record: jws });
  expect(res.status, await res.clone().text()).toBe(200);
  return { variants, recordSha256: sha(jws) };
}

/** Stage (under `gate`, when set) and submit a skins release. */
async function publishSkins(version: string, seq: number, gate: string | null) {
  const variant = await treeVariant({}, `skins-${version}`);
  await stage(SKINS, variant.objects, gate !== null);
  const jws = await signRecord(
    packRecord({
      aud: SLUG,
      deliverable: SKINS,
      version,
      seq,
      issuedAt: NOW,
      type: "files.tree",
      variants: [variant.variant],
      ...(gate !== null ? { entitlement: gate } : {}),
    }),
  );
  const res = await post("submit", { record: jws });
  expect(res.status, await res.clone().text()).toBe(200);
  return variant;
}

/** A device token whose licence holds `flags` (true) and, optionally, an app version cap. */
async function deviceToken(
  flags: string[] = [],
  opts: { maxVersion?: string } = {},
): Promise<string> {
  devices += 1;
  const { key } = await seedLicenseWithKey(db, SLUG, {
    id: `lic_${devices}`,
    entitlements: Object.fromEntries(
      flags.map((f) => [f, { state: "enforced", value: true, updatedAt: NOW }]),
    ),
    ...(opts.maxVersion ? { maxVersion: opts.maxVersion } : {}),
  });
  // The seed hashes the key unpeppered; this env peppers (the CI token needs a pepper).
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

function bytes(path: string, init: RequestInit = {}, origin = BYTES) {
  return call(env, db, noFetch, `${origin}/${SLUG}${path}`, init);
}

function blob(hex: string, init: RequestInit = {}, origin = BYTES) {
  return bytes(`/distribution/blobs/sha256/${hex}`, init, origin);
}

const auth = (token: string): RequestInit => ({
  headers: { authorization: `Bearer ${token}` },
});

async function hooks() {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  });
}

async function availability(releaseId: string) {
  return (await hooks()).delivery()!.availability(releaseId);
}

// ── Transports ──────────────────────────────────────────────────────────────

describe("pack transports (P4-05)", () => {
  it("routes every pack per outlet; a transport v1 does not act on is stored and reported unsupported", async () => {
    const rows = await db.all<{
      deliverable_id: string;
      outlet_id: string;
      transport: string;
    }>(
      `SELECT deliverable_id, outlet_id, transport FROM dist_transports
        WHERE product = ? ORDER BY deliverable_id, outlet_id`,
      SLUG,
    );
    expect(rows.map((r) => Object.values(r).join(" "))).toEqual([
      "app app-installer pkey-cdn",
      "app bundled pkey-cdn",
      "app direct pkey-cdn",
      "app web pkey-cdn",
      `${CORE} app-installer msix-optional`,
      `${CORE} bundled embedded`,
      `${CORE} direct pkey-cdn`,
      `${CORE} web pkey-cdn`,
      `${SKINS} app-installer msix-optional`,
      `${SKINS} bundled pkey-cdn`,
      `${SKINS} direct pkey-cdn`,
      `${SKINS} web pkey-cdn`,
    ]);

    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const path = `/api/products/${SLUG}/distribution/outlets`;
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${path}`, {
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
        },
      }),
      env,
      db,
      path,
      { now: NOW },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outlets: Array<{
        outletId: string;
        transports: Array<{
          deliverableId: string;
          transport: string;
          supported: boolean;
        }>;
      }>;
    };
    const installer = body.outlets.find((o) => o.outletId === "app-installer")!;
    expect(installer.transports).toEqual([
      { deliverableId: "app", transport: "pkey-cdn", supported: true },
      { deliverableId: CORE, transport: "msix-optional", supported: false },
      { deliverableId: SKINS, transport: "msix-optional", supported: false },
    ]);

    // Nothing is derived on an unsupported transport, even on a self-hosted outlet kind.
    await access(CORE, "public");
    await publishCore("1.4.0", 12);
    const records = await availability(`${CORE}@1.4.0`);
    expect(records.some((r) => r.outletId === "app-installer")).toBe(false);
    const matrix = await buildMatrix(
      { db, product: SLUG, hooks: await hooks() },
      CORE,
    );
    expect(
      matrix!.outlets.map((o) => [o.outletId, o.transport, o.supported]),
    ).toEqual([
      ["app-installer", "msix-optional", false],
      ["bundled", "embedded", true],
      ["direct", "pkey-cdn", true],
      ["web", "pkey-cdn", true],
    ]);
  });
});

// ── Availability ────────────────────────────────────────────────────────────

describe("pack availability (P4-05)", () => {
  it("pkey-cdn is live per variant only once every object is stored and held", async () => {
    const variants = coreVariants("core-1.4.0");
    const all = variants.flatMap((v) => v.objects);
    // Every object but the last: the record cannot be ingested, so nothing is live.
    const last = variants[1]!.objects[0]!; // etc2's `full`
    await stage(
      CORE,
      all.filter((o) => o.sha256 !== last.sha256),
    );
    const jws = await signRecord(coreRecordOf("1.4.0", 12, variants));
    const refused = await post("submit", { record: jws });
    expect(((await refused.json()) as { reason: string }).reason).toBe(
      "pack-object",
    );
    expect(await availability(`${CORE}@1.4.0`)).toEqual([]);

    // The last object uploaded: live on every pkey-cdn outlet, per variant.
    await stage(CORE, [last]);
    expect((await post("submit", { record: jws })).status).toBe(200);
    const live = (await availability(`${CORE}@1.4.0`)).filter(
      (r) => r.transport === "pkey-cdn",
    );
    expect(live.map((r) => `${r.outletId} ${r.buildId} ${r.state}`)).toEqual([
      "direct texture=etc2 live",
      "direct texture=s3tc live",
      "web texture=etc2 live",
      "web texture=s3tc live",
    ]);
    expect(live.every((r) => r.derived && r.source === "derived")).toBe(true);

    // One object's ref removed: that variant is not live, the other still is.
    const key = blobKey(last.sha256);
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
      SLUG,
      key,
    );
    const after = (await availability(`${CORE}@1.4.0`)).filter(
      (r) => r.transport === "pkey-cdn",
    );
    expect(after.map((r) => `${r.outletId} ${r.buildId}`)).toEqual([
      "direct texture=s3tc",
      "web texture=s3tc",
    ]);
    // The ref back: live again. The matrix derives the same records.
    await recordRef(
      db,
      {
        product: SLUG,
        storageKey: key,
        refKind: "pack-upload",
        refId: CORE,
      },
      NOW,
    );
    expect(
      (await availability(`${CORE}@1.4.0`)).filter(
        (r) => r.transport === "pkey-cdn",
      ),
    ).toHaveLength(4);
    const matrix = await buildMatrix(
      { db, product: SLUG, hooks: await hooks() },
      CORE,
    );
    const fromMatrix = matrix!.cells.flatMap((c) => c.records);
    expect(fromMatrix).toEqual(await availability(`${CORE}@1.4.0`));
  });

  it("embedded is ready for each (app release, outlet) whose build embeds the pack", async () => {
    const core = await publishCore("1.4.0", 12);
    // No app release pins it yet: nothing embedded.
    expect(
      (await availability(`${CORE}@1.4.0`)).filter(
        (r) => r.transport === "embedded",
      ),
    ).toEqual([]);

    await publishApp("1.5.0", 15, core.recordSha256, { web: [] });
    await publishApp("1.6.0", 16, core.recordSha256, { web: [], ios: [] });
    const embedded = (await availability(`${CORE}@1.4.0`)).filter(
      (r) => r.transport === "embedded",
    );
    // 1.5.0's iOS build said nothing about embeds: every `baseline: embedded` pack. 1.6.0
    // embeds nothing in either build, so it is not listed. The web build's `[]` never counts.
    expect(embedded).toEqual([
      {
        deliverableId: CORE,
        releaseId: `${CORE}@1.4.0`,
        buildId: "",
        outletId: "bundled",
        transport: "embedded",
        state: "live",
        since: expect.any(Number),
        platformRef: null,
        detail: { appReleaseId: "app@1.5.0", buildIds: ["ios"] },
        source: "derived",
        derived: true,
        updatedAt: null,
      },
    ]);
    // `bundled` carries the pack embedded, so no CDN record there.
    expect(
      (await availability(`${CORE}@1.4.0`)).filter(
        (r) => r.outletId === "bundled" && r.transport !== "embedded",
      ),
    ).toEqual([]);
    const matrix = await buildMatrix(
      { db, product: SLUG, hooks: await hooks() },
      CORE,
    );
    expect(
      matrix!.cells.find((c) => c.outletId === "bundled")!.records,
    ).toEqual(embedded);
  });
});

// ── App releases with content ───────────────────────────────────────────────

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);

async function publishApp(
  version: string,
  seq: number,
  coreSha256: string,
  embeds: { web?: string[]; ios?: string[] },
  core: { seq: number; version: string } = { seq: 12, version: "1.4.0" },
) {
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
      pins: [
        {
          pack: CORE,
          release: { sha256: coreSha256, seq: core.seq, version: core.version },
        },
      ],
      expects: [{ pack: CORE, required: true, delivery: "essential" }],
    },
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
  const up = await post("uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
  });
  const body = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  const res = await post("submit", {
    ticket: body.ticket,
    descriptor,
    record: await signRecord(recordFor(descriptor, { seq, issuedAt: NOW })),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

// ── Bytes ───────────────────────────────────────────────────────────────────

describe("pack bytes on the blob route (P4-05)", () => {
  it("serves every pack object by SHA-256 with Range, If-Range, ETag, Repr-Digest and no Content-Encoding", async () => {
    await access(CORE, "public");
    const { variants } = await publishCore("1.4.0", 12);
    const full = variants[0]!.objects[0]!; // s3tc's `full`, 170 bytes
    const hex = full.sha256;

    const ranged = await blob(hex, { headers: { range: "bytes=100-199" } });
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      full.bytes.slice(100, 170),
    );
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 100-169/${full.bytes.length}`,
    );

    const ifRange = await blob(hex, {
      headers: { range: "bytes=100-199", "if-range": `"${"0".repeat(64)}"` },
    });
    expect(ifRange.status).toBe(200);
    expect(new Uint8Array(await ifRange.arrayBuffer())).toEqual(full.bytes);

    const multi = await blob(hex, { headers: { range: "bytes=0-9,20-29" } });
    expect(multi.status).toBe(200);
    expect(new Uint8Array(await multi.arrayBuffer())).toEqual(full.bytes);

    const head = await blob(hex, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(full.bytes.length));
    expect(head.headers.get("etag")).toBe(`"${hex}"`);
    expect(head.headers.get("repr-digest")).toBe(
      `sha-256=:${Buffer.from(hex, "hex").toString("base64")}:`,
    );
    expect(head.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    for (const res of [ranged, ifRange, multi, head])
      expect(res.headers.get("content-encoding")).toBeNull();

    // Every role: the index, its gaps, both deltas' objects and a file blob (pack-upload only).
    for (const o of variants[0]!.objects) {
      const res = await blob(o.sha256);
      expect(res.status, o.sha256).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(o.bytes);
    }
  });

  it("answers a cross-origin preflight for range and if-range", async () => {
    await access(CORE, "public");
    const { variants } = await publishCore("1.4.0", 12);
    const res = await blob(variants[0]!.objects[0]!.sha256, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "range, if-range",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase()
      .split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(["range", "if-range"]));
  });

  it("files/ and builds/ never serve a pack object (P4-02's hand-off): the blob route is the only way", async () => {
    await access(CORE, "public");
    const { variants } = await publishCore("1.4.0", 12);
    const release = encodeURIComponent(`${CORE}@1.4.0`);
    for (const origin of [BYTES, CONSOLE]) {
      for (const path of [
        `/distribution/files/${release}/texture=s3tc%2Fpayload`,
        `/release/files/${release}/texture=s3tc%2Fpayload`,
        `/distribution/files/${release}/texture=s3tc%2Ffiles-index`,
        `/distribution/builds/1.4.0/texture=s3tc?deliverable=${CORE}`,
        `/distribution/builds/stable/texture=s3tc?deliverable=${CORE}`,
      ]) {
        const res = await bytes(path, {}, origin);
        expect(res.status, `${origin}${path}`).toBe(404);
      }
    }
    // Under the app's `entitled` mode with a window, the pack version is never window-checked:
    // the pack's own (public) mode governs its bytes on the blob route.
    await access("app", "entitled");
    const capped = await deviceToken([], { maxVersion: "0.1.0" });
    expect(
      (await blob(variants[0]!.objects[0]!.sha256, auth(capped))).status,
    ).toBe(200);
    // And no immutable delivery URL is minted for a pack release.
    const delivery = (await hooks()).delivery()!;
    expect(
      await delivery.deliveryUrl({
        releaseId: `${CORE}@1.4.0`,
        name: "texture=s3tc/payload",
      }),
    ).toBeNull();
    expect(
      await delivery.deliveryUrl({
        releaseId: `${CORE}@1.4.0`,
        buildId: "texture=s3tc",
      }),
    ).toBeNull();
  });

  it("an ungated pack's objects follow its mode; entitled without a gate is fail-closed", async () => {
    await access(CORE, "licensed");
    const { variants } = await publishCore("1.4.0", 12);
    const hex = variants[0]!.objects[0]!.sha256;
    const token = await deviceToken();

    const anon = await blob(hex);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({
      error: "download_auth_required",
    });
    const licensed = await blob(hex, auth(token));
    expect(licensed.status).toBe(200);
    expect(licensed.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );

    // `entitled` with no gate: no grant to check, so nobody — not even a licence holding every
    // flag, nor one inside any app window.
    await access(CORE, "entitled");
    const rich = await deviceToken(["skins", "skins2", "core-paid"]);
    for (const t of [token, rich]) {
      const res = await blob(hex, auth(t));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "delivery_gate_missing" },
      });
    }
    // A pack with no row of its own inherits the app's `entitled`: still fail-closed.
    await db.run(
      "DELETE FROM dist_access WHERE product = ? AND deliverable_id = ?",
      SLUG,
      CORE,
    );
    await access("app", "entitled");
    expect((await blob(hex, auth(rich))).status).toBe(403);
  });

  it("a gated object: 401 without a token, 403 without the flag, 200 private with it; never on the public path", async () => {
    await access(SKINS, "entitled", "skins");
    const variant = await publishSkins("1.0.0", 1, "skins");
    const [full, index, fileA] = variant.objects as [Obj, Obj, Obj];
    // Stored under gated/ only.
    expect(await r2.get(blobKey(full.sha256, { gated: true }))).not.toBeNull();
    expect(await r2.get(blobKey(full.sha256))).toBeNull();

    const anon = await blob(full.sha256);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const without = await blob(full.sha256, auth(await deviceToken(["other"])));
    expect(without.status).toBe(403);
    expect(await without.json()).toMatchObject({
      error: { code: "not_entitled" },
    });

    const holder = await deviceToken(["skins"]);
    for (const o of [full, index, fileA]) {
      const res = await blob(o.sha256, {
        headers: { authorization: `Bearer ${holder}`, range: "bytes=0-9" },
      });
      expect(res.status, o.sha256).toBe(206);
      expect(res.headers.get("cache-control")).toBe(
        "private, no-store, no-transform",
      );
      expect(res.headers.get("etag")).toBe(`"${o.sha256}"`);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        o.bytes.slice(0, 10),
      );
    }

    // The public path never reads gated/: the same release on files/ and builds/ is not-found,
    // with or without the flag, on both hosts.
    const release = encodeURIComponent(`${SKINS}@1.0.0`);
    for (const origin of [BYTES, CONSOLE])
      for (const path of [
        `/distribution/files/${release}/default%2Fpayload`,
        `/distribution/builds/1.0.0/default?deliverable=${SKINS}`,
      ]) {
        expect((await bytes(path, {}, origin)).status).toBe(404);
        expect((await bytes(path, auth(holder), origin)).status).toBe(404);
      }
  });

  it("authorises against the CURRENT gate: a renamed flag moves who may download, an un-gated pack stays private", async () => {
    await access(SKINS, "entitled", "skins");
    const variant = await publishSkins("1.0.0", 1, "skins");
    const hex = variant.objects[0]!.sha256;
    const old = await deviceToken(["skins"]);
    const renamed = await deviceToken(["skins2"]);
    expect((await blob(hex, auth(old))).status).toBe(200);
    expect((await blob(hex, auth(renamed))).status).toBe(403);

    // The operator renames the flag: the record still says `skins` (a publish-time snapshot),
    // but only the new flag downloads.
    await access(SKINS, "entitled", "skins2");
    expect((await blob(hex, auth(old))).status).toBe(403);
    expect((await blob(hex, auth(renamed))).status).toBe(200);

    // Un-gated later: the gated/ object is served under the pack's mode, still private.
    await access(SKINS, "public", null);
    const res = await blob(hex);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("a gate set after a release leaves its blobs/ objects on the public path under the pack's mode", async () => {
    await access(CORE, "public");
    const { variants } = await publishCore("1.4.0", 12);
    const hex = variants[0]!.objects[0]!.sha256;
    // Gated, mode still public: the earlier public objects stay public (they were cacheable).
    await access(CORE, "public", "core-paid");
    const open = await blob(hex);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    // Gated and `entitled`: the gate is the grant, for its blobs/ objects too.
    await access(CORE, "entitled", "core-paid");
    expect((await blob(hex, auth(await deviceToken()))).status).toBe(403);
    const paid = await blob(hex, auth(await deviceToken(["core-paid"])));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("an anonymous request for a closed pack's object is 403 delivery_gate_missing, not 401", async () => {
    // `entitled` with no gate: no credential could pass, so asking for one (401) would send a
    // client to sign in for nothing. The refusal names the operator's missing setting instead;
    // it reveals only that the product holds that hash, which its signed record already says.
    await access(CORE, "entitled");
    const { variants } = await publishCore("1.4.0", 12);
    const res = await blob(variants[0]!.objects[0]!.sha256);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "delivery_gate_missing" },
    });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("a disabled (revoked), an expired or another product's licence never passes the flag check", async () => {
    await access(SKINS, "entitled", "skins");
    const variant = await publishSkins("1.0.0", 1, "skins");
    const hex = variant.objects[0]!.sha256;

    const revoked = await deviceToken(["skins"]);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      `lic_${devices}`,
    );
    const expired = await deviceToken(["skins"]);
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE product = ? AND id = ?",
      NOW - 1,
      SLUG,
      `lic_${devices}`,
    );
    // A device token minted by another product, whose licence holds a flag of the same name.
    await seedProduct(db, "other");
    const { key } = await seedLicenseWithKey(db, "other", {
      id: "lic_other",
      entitlements: {
        skins: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    await db.run(
      "UPDATE keys_index SET key_hash = ? WHERE key_hash = ?",
      await hashKey(key, env.KEY_HASH_PEPPER),
      await hashKey(key),
    );
    const act = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-other",
      }),
      env,
      db,
      (await loadProduct(env, db, "other"))!,
      NOW,
    );
    expect(act.status, await act.clone().text()).toBe(200);
    const foreign = ((await act.json()) as { token: string }).token;

    for (const [label, token] of [
      ["disabled", revoked],
      ["expired", expired],
      ["another product's", foreign],
    ] as const) {
      const res = await blob(hex, auth(token));
      expect(res.status, label).toBe(401);
      expect(await res.json(), label).toMatchObject({
        error: { code: "unauthorized" },
      });
    }
    // Control: a live licence of this product holding the flag passes.
    expect((await blob(hex, auth(await deviceToken(["skins"])))).status).toBe(
      200,
    );
  });

  it("another product's ref never counts", async () => {
    await access(SKINS, "entitled", "skins");
    const variant = await publishSkins("1.0.0", 1, "skins");
    const hex = variant.objects[0]!.sha256;
    const key = blobKey(hex, { gated: true });
    await seedProduct(db, "other");
    await recordRef(
      db,
      {
        product: "other",
        storageKey: key,
        refKind: "pack-upload",
        refId: SKINS,
      },
      NOW,
    );
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
      SLUG,
      key,
    );
    const holder = await deviceToken(["skins"]);
    expect((await blob(hex, auth(holder))).status).toBe(404);
  });
});

// ── Query cost (B1): bounded D1 reads at the page bound ────────────────────────

/** `db` with every statement counted (a batch counts each of its statements, as D1 does). */
function counting(inner: Db): {
  db: Db;
  count: () => number;
  reset: () => void;
} {
  let n = 0;
  const db: Db = {
    all: (sql, ...p) => (n++, inner.all(sql, ...p)),
    first: (sql, ...p) => (n++, inner.first(sql, ...p)),
    run: (sql, ...p) => (n++, inner.run(sql, ...p)),
    runChanges: (sql, ...p) => (n++, inner.runChanges(sql, ...p)),
    batch: (stmts) => ((n += stmts.length), inner.batch(stmts)),
  } as Db;
  return { db, count: () => n, reset: () => (n = 0) };
}

async function countedHooks(c: { db: Db }) {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db: c.db,
    product,
    now: NOW,
  });
}

describe("pack availability reads are bounded (P4-05, B1)", () => {
  /** 50 core releases (the matrix's page bound), each pinned by an app release with 2 builds. */
  async function fifty() {
    const RELEASES = 50;
    for (let i = 0; i < RELEASES; i++) {
      const version = `1.${i}.0`;
      const { recordSha256 } = await publishCore(version, i + 1);
      // The web build embeds nothing; the iOS build says nothing, so it embeds the baseline.
      await publishApp(
        `2.${i}.0`,
        i + 1,
        recordSha256,
        { web: [] },
        {
          seq: i + 1,
          version,
        },
      );
    }
    return RELEASES;
  }

  it("the matrix of 50 pack releases with pinning app releases stays under a fixed ceiling", async () => {
    const n = await fifty();
    const c = counting(db);
    const h = await countedHooks(c);
    c.reset();
    const matrix = await buildMatrix(
      { db: c.db, product: SLUG, hooks: h },
      CORE,
      50,
    );
    const reads = c.count();
    expect(matrix!.releases).toHaveLength(n);
    // Every release is live by CDN (two variants) and embedded once on `bundled`.
    const embedded = matrix!.cells
      .filter((cell) => cell.outletId === "bundled")
      .flatMap((cell) => cell.records);
    expect(embedded).toHaveLength(n);
    expect(embedded[0]!.detail).toMatchObject({ buildIds: ["ios"] });
    // One record read per pack release, plus a constant of bulk reads (catalog, outlets,
    // transports, stored rows, submissions, rollouts, objects, refs, pins, app releases,
    // declarations, builds with embeds). Before B1 this page cost 607 reads; now 75.
    expect(reads, `matrix reads: ${reads}`).toBeLessThanOrEqual(n + 30);
    console.info(`[B1] matrix of ${n} pack releases: ${reads} D1 queries`);
  }, 120_000);

  it("delivery.availability() of one pack release is a fixed handful of reads", async () => {
    await fifty();
    const c = counting(db);
    const h = await countedHooks(c);
    c.reset();
    const records = await h.delivery()!.availability(`${CORE}@1.49.0`);
    const reads = c.count();
    expect(records.filter((r) => r.transport === "embedded")).toHaveLength(1);
    expect(records.filter((r) => r.transport === "pkey-cdn")).toHaveLength(4);
    // Before B1: 19 here, and one more per declared pack ahead of it in `findRelease`; now 12.
    expect(reads, `availability reads: ${reads}`).toBeLessThanOrEqual(15);
    console.info(`[B1] delivery.availability(): ${reads} D1 queries`);
  }, 120_000);
});
