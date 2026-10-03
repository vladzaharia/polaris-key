/**
 * P4-18 — the payload URL (`/<p>/distribution/packs/<pack>/<variant>/payload/<sha256>`) and
 * Compression Dictionary Transport, through the real dispatcher on both hosts (RFC 9842;
 * notes/A7 §9.3):
 *
 *   - the stored `full` frame streamed with `Content-Encoding: zstd` (only when `zstd` is
 *     accepted, else `406`), with `Use-As-Dictionary` matching exactly the (pack, variant)'s
 *     payload URLs, and none for a gated pack or a payload over 100 MiB;
 *   - a request offering the `from` of a published `zstd-patch-from` delta as its
 *     `Available-Dictionary` gets `Content-Encoding: dcz`: the 40-byte header and the stored
 *     artifact, unchanged; another dictionary gets the plain payload; `?via=dcz` turns a miss
 *     into `409` with no body;
 *   - every answer varies on `Accept-Encoding, Available-Dictionary`; the blob route is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
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
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import {
  bytesFrom,
  containerVariant,
  packRecord,
  rawZstdFrame,
  sha,
  treeVariant,
  type Obj,
} from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { manifestIngestStatements } from "../src/services/distribution/outlets.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { hashKey } from "../src/crypto.js";
import { blobKey } from "../src/core/blobs.js";
import {
  acceptsEncoding,
  choosePayloadAnswer,
  DCZ_MAGIC,
  dczHeader,
  MAX_DICTIONARY_BYTES,
  parseAvailableDictionary,
  useAsDictionary,
} from "../src/services/distribution/dictionary.js";
import { servePayload } from "../src/services/distribution/payload.js";
import type { ReleaseCatalog } from "../src/core/hooks.js";
import { BYTE_ROUTES } from "../src/mount.js";
import { preEncoded } from "../src/index.js";

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

// ── The pure half ───────────────────────────────────────────────────────────

describe("dictionary transport helpers (P4-18)", () => {
  it("derives the dcz header from `from` alone: the magic, then the 32-byte hash", () => {
    const from = sha("base");
    const h = dczHeader(from);
    expect(h.length).toBe(40);
    expect([...h.subarray(0, 8)]).toEqual([
      0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0,
    ]);
    expect(Buffer.from(h.subarray(8)).toString("hex")).toBe(from);
    expect(() => dczHeader("nothex")).toThrow();
  });

  it("reads Available-Dictionary as an sf-binary SHA-256 only", () => {
    const from = sha("base");
    expect(parseAvailableDictionary(sfBinary(from))).toBe(from);
    expect(parseAvailableDictionary(` ${sfBinary(from)} `)).toBe(from);
    expect(parseAvailableDictionary(null)).toBeNull();
    expect(parseAvailableDictionary(from)).toBeNull();
    expect(parseAvailableDictionary(":AAAA:")).toBeNull();
    expect(parseAvailableDictionary(":!!!:")).toBeNull();
  });

  it("parses Accept-Encoding with q-values", () => {
    expect(acceptsEncoding(CHROMIUM_AE_DCZ, "dcz")).toBe(true);
    expect(acceptsEncoding(CHROMIUM_AE, "dcz")).toBe(false);
    expect(acceptsEncoding("zstd;q=0", "zstd")).toBe(false);
    expect(acceptsEncoding("gzip, zstd;q=0.5", "zstd")).toBe(true);
    expect(acceptsEncoding("*", "zstd")).toBe(true);
    expect(acceptsEncoding("*, zstd;q=0", "zstd")).toBe(false);
    expect(acceptsEncoding(null, "zstd")).toBe(false);
  });

  it("matches exactly one (pack, variant)'s payload URLs", () => {
    expect(useAsDictionary(SLUG, CORE, VARIANT)).toBe(
      `match="/djdl/distribution/packs/djdl.core3d/texture=s3tc/payload/*", match-dest=("")`,
    );
  });

  it("chooses dcz, then the guard's 409, then the full payload or 406", () => {
    const from = sha("base");
    const deltas = [{ from, artifact: { sha256: sha("a"), bytes: 9 } }];
    const base = {
      acceptEncoding: CHROMIUM_AE_DCZ,
      availableDictionary: sfBinary(from),
      guard: false,
      fullCodec: "zstd",
      deltas,
    };
    expect(choosePayloadAnswer(base)).toEqual({
      kind: "dcz",
      from,
      artifact: deltas[0]!.artifact,
    });
    expect(
      choosePayloadAnswer({ ...base, acceptEncoding: CHROMIUM_AE }),
    ).toEqual({ kind: "full", encoding: "zstd" });
    expect(
      choosePayloadAnswer({
        ...base,
        availableDictionary: sfBinary(sha("other")),
        guard: true,
      }),
    ).toEqual({ kind: "refuse", status: 409 });
    expect(
      choosePayloadAnswer({
        ...base,
        availableDictionary: null,
        acceptEncoding: "gzip",
      }),
    ).toEqual({ kind: "refuse", status: 406 });
    expect(
      choosePayloadAnswer({
        ...base,
        availableDictionary: null,
        acceptEncoding: "gzip",
        fullCodec: "none",
      }),
    ).toEqual({ kind: "full", encoding: null });
  });
});

// ── The route ───────────────────────────────────────────────────────────────

describe("the payload URL (P4-18)", () => {
  it("is registered on the bytes host, canonical spelling only", () => {
    const route = BYTE_ROUTES.find((r) => r.name === "distribution.payload")!;
    expect(route.service).toBe("distribution");
    const hex = "b".repeat(64);
    expect(
      route.match(`/djdl/distribution/packs/${CORE}/${VARIANT}/payload/${hex}`),
    ).toEqual({
      product: "djdl",
      params: { kind: "payload", packId: CORE, buildId: VARIANT, sha256: hex },
    });
    expect(
      route.match(
        `/djdl/distribution/packs/${CORE}/texture%3Ds3tc/payload/${hex}`,
      )?.params.buildId,
    ).toBe(VARIANT);
    for (const bad of [
      `/djdl/release/packs/${CORE}/${VARIANT}/payload/${hex}`,
      `/djdl/distribution/packs/${CORE}/${VARIANT}/payload/${hex.slice(1)}`,
      `/djdl/distribution/packs/app/default/payload/${hex}`,
      `/djdl/distribution/packs/${CORE}/Texture=s3tc/payload/${hex}`,
      `/djdl/distribution/packs/${CORE}/${VARIANT}/full/${hex}`,
    ])
      expect(route.match(bad), bad).toBeNull();
  });

  it("streams the stored frame with Content-Encoding: zstd and a per-(pack, variant) Use-As-Dictionary, on both hosts", async () => {
    const { v1 } = await coreV1V2();
    for (const origin of [BYTES, CONSOLE]) {
      const res = await get(
        payloadUrl(CORE, VARIANT, v1.payloadSha256, "", origin),
        { "accept-encoding": CHROMIUM_AE, range: "bytes=0-9" },
      );
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("zstd");
      expect(res.headers.get("use-as-dictionary")).toBe(
        useAsDictionary(SLUG, CORE, VARIANT),
      );
      expect(res.headers.get("vary")).toBe(
        "Accept-Encoding, Available-Dictionary",
      );
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable, no-transform",
      );
      // Full-body only: a Range is ignored.
      expect(res.headers.get("accept-ranges")).toBe("none");
      expect(res.headers.get("content-range")).toBeNull();
      expect(res.headers.get("content-length")).toBe(String(v1.frame.length));
      expect(res.headers.get("etag")).toBe(`"${v1.fullSha256}"`);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      // The body is the stored frame, unchanged: the browser decodes it to the payload.
      expect(await bytesOf(res)).toEqual(v1.frame);
    }
    // HEAD: the same headers, no body.
    const head = await get(
      payloadUrl(CORE, VARIANT, v1.payloadSha256),
      { "accept-encoding": CHROMIUM_AE },
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBe("zstd");
    expect(head.headers.get("content-length")).toBe(String(v1.frame.length));
    expect((await bytesOf(head)).length).toBe(0);
  });

  it("refuses a zstd payload to a client without zstd (406), and any method but GET and HEAD (405)", async () => {
    const { v1 } = await coreV1V2();
    const res = await get(payloadUrl(CORE, VARIANT, v1.payloadSha256), {
      "accept-encoding": "gzip, br",
    });
    expect(res.status).toBe(406);
    expect(res.headers.get("vary")).toBe(
      "Accept-Encoding, Available-Dictionary",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await bytesOf(res)).length).toBe(0);
    const posted = await get(
      payloadUrl(CORE, VARIANT, v1.payloadSha256),
      {},
      "POST",
    );
    expect(posted.status).toBe(405);
  });

  it("answers Content-Encoding: dcz, the 40-byte header and the stored artifact for a matching Available-Dictionary", async () => {
    const { v1, v2 } = await coreV1V2();
    for (const query of ["", "?via=dcz"]) {
      const res = await get(
        payloadUrl(CORE, VARIANT, v2.payloadSha256, query),
        {
          "accept-encoding": CHROMIUM_AE_DCZ,
          "available-dictionary": sfBinary(v1.payloadSha256),
        },
      );
      expect(res.status, query).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("dcz");
      expect(res.headers.get("vary")).toBe(
        "Accept-Encoding, Available-Dictionary",
      );
      expect(res.headers.get("content-length")).toBe(
        String(40 + v2.artifact!.length),
      );
      // v2 becomes the next dictionary.
      expect(res.headers.get("use-as-dictionary")).toBe(
        useAsDictionary(SLUG, CORE, VARIANT),
      );
      const body = await bytesOf(res);
      expect(body.length).toBe(40 + v2.artifact!.length);
      expect(body.subarray(0, 8)).toEqual(DCZ_MAGIC);
      expect(Buffer.from(body.subarray(8, 40)).toString("hex")).toBe(
        v1.payloadSha256,
      );
      expect(body.subarray(40)).toEqual(v2.artifact);
    }
  });

  it("serves the plain payload for another dictionary or without dcz; the guard turns those into 409", async () => {
    const { v1, v2 } = await coreV1V2();
    const cases: Record<string, string>[] = [
      {
        "accept-encoding": CHROMIUM_AE_DCZ,
        "available-dictionary": sfBinary(sha("another base")),
      },
      // The right dictionary, but `dcz` is not accepted.
      {
        "accept-encoding": CHROMIUM_AE,
        "available-dictionary": sfBinary(v1.payloadSha256),
      },
      // No dictionary at all (evicted, never fetched, or another browser).
      { "accept-encoding": CHROMIUM_AE },
    ];
    for (const headers of cases) {
      const plain = await get(
        payloadUrl(CORE, VARIANT, v2.payloadSha256),
        headers,
      );
      expect(plain.status).toBe(200);
      expect(plain.headers.get("content-encoding")).toBe("zstd");
      expect(await bytesOf(plain)).toEqual(v2.frame);

      const guarded = await get(
        payloadUrl(CORE, VARIANT, v2.payloadSha256, "?via=dcz"),
        headers,
      );
      expect(guarded.status).toBe(409);
      expect(guarded.headers.get("cache-control")).toBe("no-store");
      expect(guarded.headers.get("vary")).toBe(
        "Accept-Encoding, Available-Dictionary",
      );
      expect((await bytesOf(guarded)).length).toBe(0);
    }
    // v1 has no delta at all: a dictionary offered for it is never answered with dcz.
    const first = await get(payloadUrl(CORE, VARIANT, v1.payloadSha256), {
      "accept-encoding": CHROMIUM_AE_DCZ,
      "available-dictionary": sfBinary(v1.payloadSha256),
    });
    expect(first.headers.get("content-encoding")).toBe("zstd");
  });

  it("falls back to the plain payload when the delta's artifact is not stored", async () => {
    const { v1, v2 } = await coreV1V2();
    await r2.delete(blobKey(v2.artifactSha256!));
    const res = await get(payloadUrl(CORE, VARIANT, v2.payloadSha256), {
      "accept-encoding": CHROMIUM_AE_DCZ,
      "available-dictionary": sfBinary(v1.payloadSha256),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("zstd");
    expect(await bytesOf(res)).toEqual(v2.frame);
  });

  it("leaves the blob route's responses unchanged", async () => {
    const { v1, v2 } = await coreV1V2();
    for (const hex of [v1.fullSha256, v2.artifactSha256!]) {
      const res = await get(
        `${BYTES}/${SLUG}/distribution/blobs/sha256/${hex}`,
        {
          "accept-encoding": CHROMIUM_AE_DCZ,
          "available-dictionary": sfBinary(v1.payloadSha256),
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("use-as-dictionary")).toBeNull();
      expect(res.headers.get("vary")).toBeNull();
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("etag")).toBe(`"${hex}"`);
      expect(sha(await bytesOf(res))).toBe(hex);
    }
  });

  it("never offers a gated payload as a dictionary; it follows the pack's current gate", async () => {
    await access(VAULT, "entitled", "vault");
    const v1 = await publish(VAULT, "1.0.0", 1, { gate: "vault" });
    const url = payloadUrl(VAULT, "default", v1.payloadSha256);
    expect((await get(url, { "accept-encoding": CHROMIUM_AE })).status).toBe(
      401,
    );
    const holder = await deviceToken(["vault"]);
    const res = await get(url, {
      "accept-encoding": CHROMIUM_AE,
      authorization: `Bearer ${holder}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("zstd");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
    expect(res.headers.get("use-as-dictionary")).toBeNull();
    expect(await bytesOf(res)).toEqual(v1.frame);
  });

  it("lets a licensed (ungated) payload be kept by the browser, never by a shared cache", async () => {
    await access(CORE, "licensed");
    const v1 = await publish(CORE, "1.0.0", 1, {
      variant: { texture: "s3tc" },
    });
    const url = payloadUrl(CORE, VARIANT, v1.payloadSha256);
    expect((await get(url, { "accept-encoding": CHROMIUM_AE })).status).toBe(
      401,
    );
    const res = await get(url, {
      "accept-encoding": CHROMIUM_AE,
      authorization: `Bearer ${await deviceToken([])}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable, no-transform",
    );
    expect(res.headers.get("use-as-dictionary")).toBe(
      useAsDictionary(SLUG, CORE, VARIANT),
    );
  });

  it("is the plain not-found for an unknown hash, another variant, a tree pack or an unknown pack", async () => {
    const { v1 } = await coreV1V2();
    const tree = await treeVariant({}, "skins-1.0.0");
    await access(SKINS, "public");
    await stage(SKINS, tree.objects);
    const jws = await signRecord(
      packRecord({
        aud: SLUG,
        deliverable: SKINS,
        version: "1.0.0",
        seq: 1,
        issuedAt: NOW,
        type: "files.tree",
        variants: [tree.variant],
      }),
    );
    expect((await post("submit", { record: jws })).status).toBe(200);
    const treeSha = (tree.variant as { payload: { sha256: string } }).payload
      .sha256;
    for (const url of [
      payloadUrl(CORE, VARIANT, sha("nothing")),
      payloadUrl(CORE, "texture=etc2", v1.payloadSha256),
      payloadUrl(CORE, "default", v1.payloadSha256),
      payloadUrl(SKINS, "default", treeSha),
      payloadUrl("djdl.unknown", "default", v1.payloadSha256),
    ]) {
      const res = await get(url, { "accept-encoding": CHROMIUM_AE });
      expect(res.status, url).toBe(404);
    }
  });

  it("finds an older release's payload (newest first)", async () => {
    const { v1 } = await coreV1V2();
    await publish(CORE, "1.2.0", 3, { variant: { texture: "s3tc" } });
    const res = await get(payloadUrl(CORE, VARIANT, v1.payloadSha256), {
      "accept-encoding": CHROMIUM_AE,
    });
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(v1.frame);
  });
});

// ── The 100 MiB limit (no 100 MiB fixture: the decision reads the record's `payload.size`) ──

describe("the dictionary size limit (P4-18)", () => {
  async function answer(size: number) {
    const frame = rawZstdFrame(bytesFrom("big", 64));
    const sha256 = sha(frame);
    const key = blobKey(sha256);
    r2.seed(key, frame, { withSha256: true });
    const product = (await loadProduct(env, db, SLUG))!;
    const req = new Request(payloadUrl(CORE, VARIANT, sha("p")), {
      headers: { "accept-encoding": CHROMIUM_AE },
    });
    return servePayload(
      { req, env, db, product, hooks: {} as never, now: NOW },
      {} as ReleaseCatalog,
      {
        kind: "serve",
        key,
        publicCache: true,
        payload: {
          releaseId: `${CORE}@9.0.0`,
          gated: false,
          payload: { size, sha256: sha("p") },
          full: { sha256, bytes: frame.length, size, codec: "zstd" },
          deltas: [],
        },
      },
      { kind: "payload", packId: CORE, buildId: VARIANT, sha256: sha("p") },
    );
  }

  it("offers a payload of exactly 100 MiB, and none a byte over", async () => {
    expect(
      (await answer(MAX_DICTIONARY_BYTES)).headers.get("use-as-dictionary"),
    ).toBe(useAsDictionary(SLUG, CORE, VARIANT));
    const over = await answer(MAX_DICTIONARY_BYTES + 1);
    expect(over.status).toBe(200);
    expect(over.headers.get("content-encoding")).toBe("zstd");
    expect(over.headers.get("use-as-dictionary")).toBeNull();
  });
});

describe("pre-encoded bodies at the edge (P4-18)", () => {
  it("passes every other response through untouched", () => {
    const plain = new Response("x", {
      headers: { "content-type": "text/plain" },
    });
    expect(preEncoded(plain)).toBe(plain);
    const gz = new Response("x", { headers: { "content-encoding": "gzip" } });
    expect(preEncoded(gz)).toBe(gz);
    const z = new Response("x", {
      status: 200,
      headers: { "content-encoding": "zstd", vary: "Accept-Encoding" },
    });
    const out = preEncoded(z);
    expect(out).not.toBe(z);
    expect(out.headers.get("vary")).toBe("Accept-Encoding");
  });
});
