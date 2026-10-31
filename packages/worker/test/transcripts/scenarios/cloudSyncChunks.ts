/// <reference types="@cloudflare/workers-types" />
// The Cloud Sync delta-file conversations (U-37.6; WIRE-CONTRACT-V5 §13.8.1 to §13.8.3), recorded
// through the real router, the real `CloudSyncDO` over its SQLite mock and an `R2Mock` standing in
// for `SYNC_FILES`. Each proves `sync.files.delta`, which no SDK marks implemented yet, so every
// replayer skips them; they pin the routes the SDKs' transfer engines (U-22, U-23) will be held to.
// Server mode, `launch.syncFiles` on, the `delta` collection (`files.delta: true`).
//
//   cloudsync-chunks        begin in chunks mode, the plan call (missing, then present), the chunk
//                           PUTs, upload_incomplete (chunk ids, then the manifest), finalize, the
//                           manifest's download, a chunk GET, and the refusals of each route
//   cloudsync-chunks-delta  version 2 of a file: the plan says the shared chunks are present, only
//                           the changed chunk is sent, the old version stays a revision with its
//                           chunks readable
//
// Every upload id is deterministic (the recorder seeds the random stream), so request paths are
// literal. The chunk objects are server-mode objects (`0x00 ‖ codec 0 ‖ chunk`, the id the plain
// SHA-256) and the manifest is a real `pkey-sync-chunks/1` stream, so a replaying SDK can read both
// back. The client's own state is not asserted.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type {
  BeginFileResponse,
  ChunkPlanResponse,
  FinalizeResponse,
} from "@polaris-key/protocol/sync";
import type {
  ExchangeSpec,
  StepRecorder,
  TranscriptRecorder,
  World,
} from "../recorder.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "../../cloudSyncDoMock.js";
import { installDigestStream } from "../../r2Mock.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import type { JsonValue } from "../format.js";
import { recorder, resetMutationIds, syncWorld } from "./cloudSync.js";

const FEATURES = ["sync.files.delta"];
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      {
        name: "delta",
        label: "Delta",
        files: { delta: true, maxBytes: 10_485_760, keepRevisions: 2 },
      },
      { name: "plain", label: "Plain", files: { keepRevisions: 1 } },
    ],
  },
};

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

/** A deterministic body of `n` bytes. */
const bytesOf = (n: number, seed: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const sha256 = (b: Uint8Array): Buffer =>
  createHash("sha256").update(b).digest();
const sha256Hex = (b: Uint8Array): string => sha256(b).toString("hex");
/** RFC 9530: `sha-256=:<base64>:`. */
const digestOf = (b: Uint8Array): string =>
  `sha-256=:${sha256(b).toString("base64")}:`;

interface Chunk {
  plain: Uint8Array;
  /** The chunk id: the plain SHA-256 (server mode). */
  id: string;
  /** The stored object: `0x00 ‖ codec 0 ‖ chunk`. */
  object: Uint8Array;
}

function chunk(seed: number, plainLen: number): Chunk {
  const plain = bytesOf(plainLen, seed);
  const object = new Uint8Array(plain.length + 2);
  object.set(plain, 2);
  return { plain, id: sha256Hex(plain), object };
}

/** A `pkey-sync-chunks/1` manifest over `chunks`, in file order (§13.8.3). */
function manifestOf(chunks: Chunk[]): Uint8Array {
  const out = Buffer.alloc(64 + 48 * chunks.length);
  out.write("PKSYNCCH", 0, "ascii");
  out.writeUInt16LE(1, 8);
  out.writeUInt16LE(48, 10);
  out.writeUInt32LE(0, 12);
  out.writeUInt32LE(chunks.length, 16);
  out.writeUInt32LE(0, 20);
  const plain = Buffer.concat(chunks.map((c) => c.plain));
  out.writeBigUInt64LE(BigInt(plain.length), 24);
  sha256(plain).copy(out, 32);
  chunks.forEach((c, i) => {
    const at = 64 + 48 * i;
    Buffer.from(c.id, "hex").copy(out, at);
    out.writeUInt32LE(c.plain.length, at + 32);
  });
  return new Uint8Array(out);
}

const filesPath = (collection: string, id: string, tail = ""): string =>
  `/${PRODUCT}/sync/files/${collection}/${id}${tail === "" ? "" : `/${tail}`}`;
const uploadPath = (c: string, id: string, uploadId: string): string =>
  filesPath(c, id, `upload/${uploadId}`);
const chunkPath = (c: string, id: string, uploadId: string, chunkId: string) =>
  `${uploadPath(c, id, uploadId)}/chunks/${chunkId}`;

function scenario(
  id: string,
  description: string,
  body: (r: TranscriptRecorder, world: World) => Promise<void>,
): Scenario {
  return {
    id,
    record: () =>
      pinned(id, async (pin) => {
        resetMutationIds();
        const { world, token } = await syncWorld({ catalog: CATALOG });
        (world.env as unknown as Record<string, string>).LAUNCH_SYNC_FILES =
          "on";
        // The object reads `SYNC_FILES` from the env it is built with, and its alarm writes the
        // directory to D1 (a stub that takes the batch: the directory has its own tests).
        installDigestStream();
        world.env.CLOUD_SYNC = asCloudSyncNamespace(
          new CloudSyncNamespaceMock(
            {
              db: () => ({
                batch: async () => undefined,
                batchChanges: async (st: unknown[]) => st.map(() => 1),
              }),
            },
            world.env,
          ),
        );
        invalidatePlatformSettings(world.env, world.db);
        const r = recorder(id, description, pin, world, token, FEATURES);
        await body(r, world);
        return r.transcript();
      }),
  };
}

// ── The one SDK call ───────────────────────────────────────────────────────────────────────────

type ChunkOp =
  | "begin"
  | "plan"
  | "putChunk"
  | "putManifest"
  | "status"
  | "finalize"
  | "downloadManifest"
  | "getChunk"
  | "revisions";

interface Out {
  res: Response;
  json: unknown;
}

/** The client-visible outcome of a call: ok with the fields it needs, or the refusal. */
async function outcome(
  op: ChunkOp,
  res: Response,
): Promise<Record<string, JsonValue>> {
  if (res.status >= 400) {
    const body = (await res.clone().json()) as {
      error: { code: string };
      missing?: JsonValue;
      server?: { version: number };
    };
    return {
      result: "refused",
      status: res.status,
      code: body.error.code,
      ...(body.missing !== undefined ? { missing: body.missing } : {}),
      ...(body.server !== undefined
        ? { serverVersion: body.server.version }
        : {}),
    };
  }
  const base: Record<string, JsonValue> = { result: "ok", status: res.status };
  if (op === "begin") {
    const b = (await res.clone().json()) as BeginFileResponse;
    return { ...base, mode: b.mode };
  }
  if (op === "plan") {
    const b = (await res.clone().json()) as ChunkPlanResponse;
    return {
      ...base,
      missing: [...b.missing].sort(),
      present: b.present
        .map(([id, bytes]) => [id, bytes] as [string, number])
        .sort((a, b2) => (a[0] < b2[0] ? -1 : 1)),
    };
  }
  if (op === "status") {
    const b = (await res.clone().json()) as {
      mode: string;
      size: number;
      received?: number[];
      missing?: string[];
    };
    return {
      ...base,
      mode: b.mode,
      size: b.size,
      ...(b.received !== undefined ? { received: b.received } : {}),
      ...(b.missing !== undefined ? { missing: [...b.missing].sort() } : {}),
    };
  }
  if (op === "finalize") {
    const b = (await res.clone().json()) as FinalizeResponse;
    return {
      ...base,
      version: b.version,
      size: b.size,
      sha256: b.sha256,
      format: b.format,
    };
  }
  if (op === "downloadManifest" || op === "getChunk") {
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    return { ...base, size: bytes.length, sha256: sha256Hex(bytes) };
  }
  if (op === "revisions") {
    const b = (await res.clone().json()) as {
      revisions: { version: number; format: string }[];
    };
    return {
      ...base,
      versions: b.revisions.map((x) => x.version),
      formats: b.revisions.map((x) => x.format),
    };
  }
  return base;
}

/** One `cloudSyncChunk` step: `spec` is the single request, `args` what the SDK was asked. */
async function step(
  r: TranscriptRecorder,
  op: ChunkOp,
  note: string,
  args: Record<string, JsonValue>,
  spec: ExchangeSpec,
): Promise<Out> {
  const out: Out = { res: new Response(), json: null };
  const exp: Record<string, JsonValue> = {};
  await r.step(
    { action: "cloudSyncChunk", args: { op, ...args }, note },
    async (s: StepRecorder) => {
      out.res = await s.send({
        bearer: "token",
        recordHeaders: ["etag"],
        ...spec,
      });
      Object.assign(exp, await outcome(op, out.res));
    },
    exp,
  );
  if (out.res.headers.get("content-type")?.includes("application/json"))
    out.json = await out.res.clone().json();
  return out;
}

const idOf = (o: Out): string => (o.json as BeginFileResponse).uploadId;

const begin = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  manifest: Uint8Array,
  note: string,
  extra: { baseVersion?: number | "*" } = {},
  opts: { refused?: boolean } = {},
): Promise<Out> => {
  const body = {
    size: manifest.length,
    sha256: sha256Hex(manifest),
    format: "chunks",
    enc: "none",
    ...extra,
  };
  return step(
    r,
    "begin",
    note,
    { collection, id, size: body.size },
    {
      method: "POST",
      path: filesPath(collection, id, "begin"),
      body,
      expectBody: { json: body as never, match: "exact" },
      ...(opts.refused ? {} : { capture: { uploadId: "$.uploadId" } }),
    },
  );
};

const plan = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  chunks: Chunk[],
  note: string,
): Promise<Out> => {
  const body = { chunks: chunks.map((c) => [c.id, c.object.length]) };
  return step(
    r,
    "plan",
    note,
    { collection, id, count: chunks.length },
    {
      method: "POST",
      path: `${uploadPath(collection, id, uploadId)}/chunks`,
      body,
      expectBody: { json: body as never, match: "exact" },
    },
  );
};

const putChunk = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  c: Chunk,
  note: string,
  over: { digest?: string; chunkId?: string } = {},
): Promise<Out> =>
  step(
    r,
    "putChunk",
    note,
    { collection, id, chunk: over.chunkId ?? c.id, size: c.object.length },
    {
      method: "PUT",
      path: chunkPath(collection, id, uploadId, over.chunkId ?? c.id),
      bytes: c.object,
      assertHeaders: { "content-digest": over.digest ?? digestOf(c.object) },
      headers: { "content-length": String(c.object.length) },
    },
  );

const putManifest = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  manifest: Uint8Array,
  note: string,
): Promise<Out> =>
  step(
    r,
    "putManifest",
    note,
    { collection, id, size: manifest.length },
    {
      method: "PUT",
      path: uploadPath(collection, id, uploadId),
      bytes: manifest,
      assertHeaders: { "content-digest": digestOf(manifest) },
      headers: { "content-length": String(manifest.length) },
    },
  );

const status = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  note: string,
): Promise<Out> =>
  step(
    r,
    "status",
    note,
    { collection, id },
    { method: "GET", path: uploadPath(collection, id, uploadId) },
  );

const finalize = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  note: string,
): Promise<Out> =>
  step(
    r,
    "finalize",
    note,
    { collection, id },
    {
      method: "POST",
      path: filesPath(collection, id, "finalize"),
      body: { uploadId },
      expectBody: { json: { uploadId }, match: "exact" },
    },
  );

const downloadManifest = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  note: string,
  version?: number,
): Promise<Out> =>
  step(
    r,
    "downloadManifest",
    note,
    { collection, id, ...(version !== undefined ? { version } : {}) },
    {
      method: "GET",
      path: `${filesPath(collection, id)}${version !== undefined ? `?version=${version}` : ""}`,
      binaryResponse: true,
    },
  );

const getChunk = (
  r: TranscriptRecorder,
  collection: string,
  chunkId: string,
  note: string,
): Promise<Out> =>
  step(
    r,
    "getChunk",
    note,
    { collection, chunk: chunkId },
    {
      method: "GET",
      path: `/${PRODUCT}/sync/files/${collection}/chunks/${chunkId}`,
      binaryResponse: true,
    },
  );

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────────

export const chunksUpload = scenario(
  "cloudsync-chunks",
  "A delta file (§13.8.1 to §13.8.3). begin in chunks format answers mode chunks, and its size and sha256 are the stored manifest's. The plan call names the file's chunks: all missing, then all present once they are sent. A chunk the plan did not name, a wrong digest and a plan with a repeated id are refused. finalize answers upload_incomplete with the chunk ids still missing, then with part 1 while the manifest is absent; the manifest goes to the single PUT. The resume answer lists no chunk missing, finalize commits format chunks, the download is the manifest and a chunk GET returns the stored object. A chunk of a collection without delta is not found.",
  async (r) => {
    const a = chunk(1, 3000);
    const b = chunk(2, 4000);
    const c = chunk(3, 5000);
    const manifest = manifestOf([a, b, c]);
    const refuse = await begin(
      r,
      "plain",
      "slot1",
      manifest,
      "A collection without files.delta refuses the chunks format.",
      {},
      { refused: true },
    );
    expect(refuse.res.status).toBe(400);
    const open = await begin(
      r,
      "delta",
      "slot1",
      manifest,
      "Create-only: the manifest's size and hash.",
      { baseVersion: "*" },
    );
    expect(open.res.status).toBe(200);
    expect((open.json as BeginFileResponse).mode).toBe("chunks");
    const up = idOf(open);

    const p1 = await plan(
      r,
      "delta",
      "slot1",
      up,
      [a, b, c],
      "The plan call: three ids, none stored yet.",
    );
    expect((p1.json as ChunkPlanResponse).missing).toHaveLength(3);
    const dup = await step(
      r,
      "plan",
      "A repeated id is a bad request, and nothing is taken.",
      { collection: "delta", id: "slot1", count: 2 },
      {
        method: "POST",
        path: `${uploadPath("delta", "slot1", up)}/chunks`,
        body: {
          chunks: [
            [a.id, a.object.length],
            [a.id, a.object.length],
          ],
        },
        expectBody: {
          json: {
            chunks: [
              [a.id, a.object.length],
              [a.id, a.object.length],
            ],
          } as never,
          match: "exact",
        },
      },
    );
    expect(dup.res.status).toBe(400);

    expect(
      (await putChunk(r, "delta", "slot1", up, a, "Send the first chunk.")).res
        .status,
    ).toBe(204);
    const stray = chunk(9, 1000);
    const notPlanned = await putChunk(
      r,
      "delta",
      "slot1",
      up,
      stray,
      "A chunk the plan did not name is refused.",
    );
    expect(notPlanned.res.status).toBe(400);
    const wrong = await putChunk(
      r,
      "delta",
      "slot1",
      up,
      b,
      "A digest that is not the object's is refused and nothing is stored.",
      { digest: digestOf(a.object) },
    );
    expect(wrong.res.status).toBe(400);

    const early = await finalize(
      r,
      "delta",
      "slot1",
      up,
      "Two chunks are missing: the ids come back.",
    );
    expect(early.res.status).toBe(409);
    expect(
      (await putChunk(r, "delta", "slot1", up, b, "Send the second chunk.")).res
        .status,
    ).toBe(204);
    expect(
      (await putChunk(r, "delta", "slot1", up, c, "Send the third chunk.")).res
        .status,
    ).toBe(204);
    const mid = await plan(
      r,
      "delta",
      "slot1",
      up,
      [a, b, c],
      "Naming the ids again: all present now, with their stored sizes.",
    );
    expect((mid.json as ChunkPlanResponse).present).toHaveLength(3);
    const noManifest = await finalize(
      r,
      "delta",
      "slot1",
      up,
      "Every chunk is there; the manifest (part 1) is not.",
    );
    expect(noManifest.res.status).toBe(409);
    expect(
      (
        await putManifest(
          r,
          "delta",
          "slot1",
          up,
          manifest,
          "The manifest goes up through the single PUT.",
        )
      ).res.status,
    ).toBe(204);
    const s = await status(
      r,
      "delta",
      "slot1",
      up,
      "Resume answer: the manifest is part 1, no chunk is missing.",
    );
    expect(s.res.status).toBe(200);
    const f = await finalize(r, "delta", "slot1", up, "Commit.");
    expect(f.res.status).toBe(200);
    expect(f.json).toMatchObject({
      version: 1,
      size: manifest.length,
      sha256: sha256Hex(manifest),
      format: "chunks",
    });
    const d = await downloadManifest(
      r,
      "delta",
      "slot1",
      "The file the record points at is its manifest.",
    );
    expect(d.res.status).toBe(200);
    for (const k of [a, c]) {
      const g = await getChunk(
        r,
        "delta",
        k.id,
        "One chunk object, as stored.",
      );
      expect(g.res.status).toBe(200);
      expect(new Uint8Array(await g.res.clone().arrayBuffer())).toEqual(
        k.object,
      );
    }
    const none = await getChunk(
      r,
      "delta",
      stray.id,
      "A chunk no file references is not found.",
    );
    expect(none.res.status).toBe(404);
    const other = await getChunk(
      r,
      "plain",
      a.id,
      "The same id in another collection is not found.",
    );
    expect(other.res.status).toBe(404);
  },
);

export const chunksDelta = scenario(
  "cloudsync-chunks-delta",
  "Version 2 of a delta file (§13.8.3): the plan call answers the chunks the person already stores as present, so only the changed chunk is sent and the quota is charged only for it. finalize returns the new version, the old one stays a revision whose manifest and chunks still download, and the unchanged chunks are the same objects.",
  async (r) => {
    const a = chunk(1, 3000);
    const b = chunk(2, 4000);
    const c = chunk(3, 5000);
    const d = chunk(4, 6000);
    const m1 = manifestOf([a, b, c]);
    const m2 = manifestOf([a, b, d]);

    const o1 = await begin(r, "delta", "slot1", m1, "Version 1.", {
      baseVersion: "*",
    });
    const u1 = idOf(o1);
    await plan(
      r,
      "delta",
      "slot1",
      u1,
      [a, b, c],
      "Three chunks, all missing.",
    );
    for (const k of [a, b, c])
      expect(
        (await putChunk(r, "delta", "slot1", u1, k, "Send a chunk.")).res
          .status,
      ).toBe(204);
    await putManifest(r, "delta", "slot1", u1, m1, "The manifest.");
    const f1 = await finalize(r, "delta", "slot1", u1, "Commit version 1.");
    expect(f1.res.status).toBe(200);
    const v1 = (f1.json as FinalizeResponse).version;

    const o2 = await begin(
      r,
      "delta",
      "slot1",
      m2,
      "Version 2: the file changed in its last chunk.",
      { baseVersion: v1 },
    );
    const u2 = idOf(o2);
    const p = await plan(
      r,
      "delta",
      "slot1",
      u2,
      [a, b, d],
      "A and B are stored already; only D is missing.",
    );
    expect(p.json).toMatchObject({ missing: [d.id] });
    expect(
      (p.json as ChunkPlanResponse).present.map((x) => x[0]).sort(),
    ).toEqual([a.id, b.id].sort());
    expect(
      (await putChunk(r, "delta", "slot1", u2, d, "Send only the new chunk."))
        .res.status,
    ).toBe(204);
    await putManifest(r, "delta", "slot1", u2, m2, "The new manifest.");
    const f2 = await finalize(r, "delta", "slot1", u2, "Commit version 2.");
    expect(f2.res.status).toBe(200);
    const v2 = (f2.json as FinalizeResponse).version;
    expect(v2).toBeGreaterThan(v1);

    const dl = await downloadManifest(
      r,
      "delta",
      "slot1",
      "The live file is the new manifest.",
    );
    expect(dl.res.status).toBe(200);
    const old = await downloadManifest(
      r,
      "delta",
      "slot1",
      "The kept version is the old manifest.",
      v1,
    );
    expect(old.res.status).toBe(200);
    const revs = await step(
      r,
      "revisions",
      "The old version is listed as a chunks revision.",
      { collection: "delta", id: "slot1" },
      { method: "GET", path: filesPath("delta", "slot1", "revisions") },
    );
    expect(revs.res.status).toBe(200);
    for (const k of [a, c, d]) {
      const g = await getChunk(
        r,
        "delta",
        k.id,
        "A chunk of either version is still stored.",
      );
      expect(g.res.status).toBe(200);
    }
  },
);

export const CLOUD_SYNC_CHUNKS_SCENARIOS: Scenario[] = [
  chunksUpload,
  chunksDelta,
];
