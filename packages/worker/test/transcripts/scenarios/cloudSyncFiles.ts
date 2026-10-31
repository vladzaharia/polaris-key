/// <reference types="@cloudflare/workers-types" />
// The Cloud Sync file conversations (U-10.12; WIRE-CONTRACT-V5 §13.2, §13.8), recorded through the
// real router, the real `CloudSyncDO` over its SQLite mock and an `R2Mock` standing in for
// `SYNC_FILES`. Each proves `sync.files`, which no SDK marks implemented yet, so every replayer
// skips them; they pin the routes the SDKs' transfer engines (U-22, U-23) will be held to. The
// first also proves `sync.saves`. Server mode, `launch.syncFiles` on.
//
//   cloudsync-files-single     begin, one PUT, resume answer, finalize, download, revisions
//   cloudsync-files-multipart  a multipart session: begin, one part, upload_incomplete, abort
//   cloudsync-files-mismatch   upload_mismatch (digest header, then bytes), then the right bytes
//   cloudsync-files-conflict   revision_conflict at begin and at finalize
//   cloudsync-files-quota      quota_exceeded at begin
//   cloudsync-files-limits     rate_limited at begin (30 transfers an hour), Retry-After
//   cloudsync-files-expired    upload_expired on a PUT, a resume and a finalize after 24 h
//   cloudsync-files-revisions  kept revisions, ?version=, a record delete retiring the file
//
// Every upload id is deterministic (the recorder seeds the random stream), so request paths are
// literal. The client's own state (its `clientId`, mutation ids) is not asserted.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type {
  BeginFileResponse,
  FinalizeResponse,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import type {
  ExchangeSpec,
  StepRecorder,
  TranscriptRecorder,
  World,
} from "../recorder.js";
import { DEVICE, T0 } from "../client.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "../../cloudSyncDoMock.js";
import { installDigestStream } from "../../r2Mock.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import { syncLimiterShard } from "../../../src/services/sync/limits.js";
import type { JsonValue } from "../format.js";
import {
  nextMutationId,
  pushStep,
  recorder,
  resetMutationIds,
  syncWorld,
  hlcAt,
} from "./cloudSync.js";

const FEATURES = ["sync.files"];
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "saves", template: "saves" },
      { name: "docs", label: "Docs", files: { keepRevisions: 2 } },
    ],
  },
};

const MIB = 1024 * 1024;

/** A deterministic body of `n` bytes. */
const bytesOf = (n: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const sha256Hex = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
/** RFC 9530: `sha-256=:<base64>:`. */
const digestOf = (b: Uint8Array): string =>
  `sha-256=:${createHash("sha256").update(b).digest("base64")}:`;

const filesPath = (collection: string, id: string, tail = ""): string =>
  `/${PRODUCT}/sync/files/${collection}/${id}${tail === "" ? "" : `/${tail}`}`;
const uploadPath = (c: string, id: string, uploadId: string): string =>
  filesPath(c, id, `upload/${uploadId}`);

function scenario(
  id: string,
  description: string,
  body: (r: TranscriptRecorder, world: World, subject: string) => Promise<void>,
  features: string[] = FEATURES,
): Scenario {
  return {
    id,
    record: () =>
      pinned(id, async (pin) => {
        resetMutationIds();
        const { world, token, subject } = await syncWorld({
          catalog: CATALOG,
        });
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
        const r = recorder(id, description, pin, world, token, features);
        await body(r, world, subject);
        return r.transcript();
      }),
  };
}

// ── The one SDK call ───────────────────────────────────────────────────────────────────────────

type FileOp =
  | "begin"
  | "put"
  | "part"
  | "status"
  | "abort"
  | "finalize"
  | "download"
  | "revisions";

interface Out {
  res: Response;
  json: unknown;
}

/** The client-visible outcome of a file call: ok with the fields it needs, or the refusal. */
async function outcome(
  op: FileOp,
  res: Response,
): Promise<Record<string, JsonValue>> {
  if (res.status >= 400) {
    const body = (await res.clone().json()) as {
      error: { code: string };
      missing?: JsonValue;
      server?: { version: number };
    };
    const retry = res.headers.get("retry-after");
    return {
      result: "refused",
      status: res.status,
      code: body.error.code,
      ...(body.missing !== undefined ? { missing: body.missing } : {}),
      ...(body.server !== undefined
        ? { serverVersion: body.server.version }
        : {}),
      ...(retry !== null ? { retryAfter: Number(retry) } : {}),
    };
  }
  const base: Record<string, JsonValue> = { result: "ok", status: res.status };
  if (op === "begin") {
    const b = (await res.clone().json()) as BeginFileResponse;
    return {
      ...base,
      mode: b.mode,
      ...(b.partBytes !== undefined ? { partBytes: b.partBytes } : {}),
    };
  }
  if (op === "status") {
    const b = (await res.clone().json()) as {
      mode: string;
      size: number;
      received?: number[];
    };
    return {
      ...base,
      mode: b.mode,
      size: b.size,
      ...(b.received !== undefined ? { received: b.received } : {}),
    };
  }
  if (op === "finalize") {
    const b = (await res.clone().json()) as FinalizeResponse;
    return { ...base, version: b.version, size: b.size, sha256: b.sha256 };
  }
  if (op === "download") {
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    return { ...base, size: bytes.length, sha256: sha256Hex(bytes) };
  }
  if (op === "revisions") {
    const b = (await res.clone().json()) as {
      revisions: { version: number }[];
    };
    return { ...base, versions: b.revisions.map((x) => x.version) };
  }
  return base;
}

/** One `cloudSyncFile` step: `spec` is the single request, `args` what the SDK was asked. */
async function fileStep(
  r: TranscriptRecorder,
  op: FileOp,
  note: string,
  args: Record<string, JsonValue>,
  spec: ExchangeSpec,
  opts: { now?: number } = {},
): Promise<Out> {
  const out: Out = { res: new Response(), json: null };
  const exp: Record<string, JsonValue> = {};
  await r.step(
    {
      action: "cloudSyncFile",
      args: { op, ...args },
      note,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
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

const begin = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  bytes: Uint8Array | { size: number; sha256: string },
  note: string,
  extra: { baseVersion?: number | "*" } = {},
  opts: { now?: number; refused?: boolean } = {},
): Promise<Out> => {
  const body = {
    size: "size" in bytes ? bytes.size : bytes.length,
    sha256: "sha256" in bytes ? bytes.sha256 : sha256Hex(bytes),
    format: "whole",
    enc: "none",
    ...extra,
  };
  return fileStep(
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
    opts,
  );
};

const idOf = (o: Out): string => (o.json as BeginFileResponse).uploadId;

const put = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  bytes: Uint8Array,
  note: string,
  over: { digest?: string; part?: number; now?: number } = {},
): Promise<Out> =>
  fileStep(
    r,
    over.part === undefined ? "put" : "part",
    note,
    {
      collection,
      id,
      ...(over.part !== undefined ? { part: over.part } : {}),
      size: bytes.length,
    },
    {
      method: "PUT",
      path:
        over.part === undefined
          ? uploadPath(collection, id, uploadId)
          : `${uploadPath(collection, id, uploadId)}/parts/${over.part}`,
      bytes,
      assertHeaders: { "content-digest": over.digest ?? digestOf(bytes) },
      headers: { "content-length": String(bytes.length) },
    },
    over.now === undefined ? {} : { now: over.now },
  );

const status = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  note: string,
  opts: { now?: number } = {},
): Promise<Out> =>
  fileStep(
    r,
    "status",
    note,
    { collection, id },
    { method: "GET", path: uploadPath(collection, id, uploadId) },
    opts,
  );

const finalize = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  uploadId: string,
  note: string,
  opts: { now?: number } = {},
): Promise<Out> =>
  fileStep(
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
    opts,
  );

const download = (
  r: TranscriptRecorder,
  collection: string,
  id: string,
  note: string,
  version?: number,
): Promise<Out> =>
  fileStep(
    r,
    "download",
    note,
    { collection, id, ...(version !== undefined ? { version } : {}) },
    {
      method: "GET",
      path: `${filesPath(collection, id)}${version !== undefined ? `?version=${version}` : ""}`,
      binaryResponse: true,
    },
  );

/** begin + PUT + finalize for a small file. */
async function stored(
  r: TranscriptRecorder,
  collection: string,
  id: string,
  bytes: Uint8Array,
  extra: { baseVersion?: number | "*" } = {},
): Promise<FinalizeResponse> {
  const b = await begin(r, collection, id, bytes, "Open a session.", extra);
  expect(b.res.status).toBe(200);
  expect(
    (await put(r, collection, id, idOf(b), bytes, "Send the bytes.")).res
      .status,
  ).toBe(204);
  const f = await finalize(r, collection, id, idOf(b), "Commit it.");
  expect(f.res.status).toBe(200);
  return f.json as FinalizeResponse;
}

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────────

export const filesSingle = scenario(
  "cloudsync-files-single",
  'A small file (§13.8.1): begin answers mode single, one PUT carries the bytes with their Content-Digest, the resume answer then lists part 1, finalize commits version 1 and the download returns the same bytes. Create-only (baseVersion "*"), the saves template.',
  async (r) => {
    const bytes = bytesOf(5000);
    const b = await begin(
      r,
      "saves",
      "slot1",
      bytes,
      "Create-only: no such file.",
      {
        baseVersion: "*",
      },
    );
    expect(b.res.status).toBe(200);
    expect((b.json as BeginFileResponse).mode).toBe("single");
    const id = idOf(b);
    const p = await put(
      r,
      "saves",
      "slot1",
      id,
      bytes,
      "One PUT of the whole file.",
    );
    expect(p.res.status).toBe(204);
    const s = await status(
      r,
      "saves",
      "slot1",
      id,
      "Resume answer: part 1 received.",
    );
    expect(s.res.status).toBe(200);
    const f = await finalize(r, "saves", "slot1", id, "Commit.");
    expect(f.res.status).toBe(200);
    expect(f.json).toMatchObject({
      version: 1,
      size: 5000,
      sha256: sha256Hex(bytes),
    });
    const d = await download(
      r,
      "saves",
      "slot1",
      "The stored bytes, byte for byte.",
    );
    expect(d.res.status).toBe(200);
    expect(new Uint8Array(await d.res.arrayBuffer())).toEqual(bytes);
  },
  ["sync.files", "sync.saves"],
);

export const filesMultipart = scenario(
  "cloudsync-files-multipart",
  "A multipart session (§13.8.1): a file one byte over 16 MiB gets mode multipart with 8 MiB parts, so its third part is one byte. Part 3 is sent, the resume answer lists it, finalize answers 409 upload_incomplete with the missing parts 1 and 2, and the abort answers 204 and ends the session (the status is then 404).",
  async (r) => {
    const size = 16 * MIB + 1;
    const last = bytesOf(1, 3);
    const b = await begin(
      r,
      "docs",
      "big",
      { size, sha256: "ab".repeat(32) },
      "17 MiB declared; the bytes are never all sent here.",
    );
    expect(b.res.status).toBe(200);
    expect(b.json).toMatchObject({ mode: "multipart", partBytes: 8 * MIB });
    const id = idOf(b);
    const p = await put(
      r,
      "docs",
      "big",
      id,
      last,
      "The last part, one byte.",
      { part: 3 },
    );
    expect(p.res.status).toBe(204);
    expect(
      (
        (await status(r, "docs", "big", id, "Resume: only part 3 is there."))
          .json as { received: number[] }
      ).received,
    ).toEqual([3]);
    const f = await finalize(
      r,
      "docs",
      "big",
      id,
      "Parts 1 and 2 are missing.",
    );
    expect([
      f.res.status,
      (f.json as { error: { code: string } }).error.code,
    ]).toEqual([409, "upload_incomplete"]);
    expect((f.json as { missing: number[] }).missing).toEqual([1, 2]);
    await fileStep(
      r,
      "abort",
      "Abort: the session ends, the reservation is released.",
      { collection: "docs", id: "big" },
      {
        method: "DELETE",
        path: uploadPath("docs", "big", id),
      },
    );
    expect(
      (await status(r, "docs", "big", id, "The session is gone.")).res.status,
    ).toBe(404);
  },
);

export const filesMismatch = scenario(
  "cloudsync-files-mismatch",
  "Upload verification (§13.8.1, GF7): a Content-Digest other than the one begin declared answers 400 upload_mismatch before a byte is stored; bytes that do not hash to the declared value answer 400 upload_mismatch and store nothing; the session stays open, so the right bytes then go through and finalize commits.",
  async (r) => {
    const bytes = bytesOf(4000);
    const b = await begin(
      r,
      "docs",
      "d1",
      bytes,
      "Declare the hash of the real bytes.",
    );
    const id = idOf(b);
    const other = bytesOf(4000, 99);
    const wrongHeader = await put(
      r,
      "docs",
      "d1",
      id,
      bytes,
      "A digest header of other bytes.",
      {
        digest: digestOf(other),
      },
    );
    expect([
      wrongHeader.res.status,
      (wrongHeader.json as { error: { code: string } }).error.code,
    ]).toEqual([400, "upload_mismatch"]);
    const wrongBytes = await put(
      r,
      "docs",
      "d1",
      id,
      other,
      "Other bytes under their own digest: they do not hash to the declared value.",
    );
    expect([
      wrongBytes.res.status,
      (wrongBytes.json as { error: { code: string } }).error.code,
    ]).toEqual([400, "upload_mismatch"]);
    expect(
      (await status(r, "docs", "d1", id, "Nothing was recorded.")).res.status,
    ).toBe(200);
    expect(
      (await put(r, "docs", "d1", id, bytes, "The right bytes.")).res.status,
    ).toBe(204);
    expect((await finalize(r, "docs", "d1", id, "Commit.")).res.status).toBe(
      200,
    );
  },
);

export const filesConflict = scenario(
  "cloudsync-files-conflict",
  "Compare-and-swap (§13.8.1, GF2): create-only on a record that has a file answers 409 revision_conflict at begin, with the server's version; two sessions opened on version 1 both upload, the first finalize commits version 2 and the second answers 409 revision_conflict with the new version.",
  async (r) => {
    expect((await stored(r, "docs", "c1", bytesOf(3000))).version).toBe(1);
    const again = bytesOf(3100, 5);
    const star = await begin(
      r,
      "docs",
      "c1",
      again,
      "Create-only, but the file exists.",
      { baseVersion: "*" },
      { refused: true },
    );
    expect([
      star.res.status,
      (star.json as { error: { code: string } }).error.code,
    ]).toEqual([409, "revision_conflict"]);
    const a = bytesOf(3200, 11);
    const b2 = bytesOf(3300, 13);
    const ba = await begin(r, "docs", "c1", a, "Writer A on version 1.", {
      baseVersion: 1,
    });
    const bb = await begin(r, "docs", "c1", b2, "Writer B on version 1.", {
      baseVersion: 1,
    });
    expect(
      (await put(r, "docs", "c1", idOf(ba), a, "A's bytes.")).res.status,
    ).toBe(204);
    expect(
      (await put(r, "docs", "c1", idOf(bb), b2, "B's bytes.")).res.status,
    ).toBe(204);
    const fa = await finalize(
      r,
      "docs",
      "c1",
      idOf(ba),
      "A commits first: version 2.",
    );
    expect(fa.json).toMatchObject({ version: 2 });
    const fb = await finalize(r, "docs", "c1", idOf(bb), "B is stale now.");
    expect([
      fb.res.status,
      (fb.json as { error: { code: string } }).error.code,
    ]).toEqual([409, "revision_conflict"]);
    expect(fb.json).toMatchObject({ server: { version: 2 } });
  },
);

export const filesQuota = scenario(
  "cloudsync-files-quota",
  "Quota (§13.1, GF1): a licence granting 10,000 bytes of Cloud Sync storage refuses a begin whose size does not fit with 403 quota_exceeded and the scope; a file that fits is accepted, and a second one that no longer fits is refused again (the first one's bytes count once it is committed).",
  async (r, world) => {
    await world.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          polarisVpn: { state: "enforced", value: true, updatedAt: T0 },
          "pkey.cloudSync.bytes": {
            state: "enforced",
            value: 10_000,
            updatedAt: T0,
          },
        },
      }),
      PRODUCT,
    );
    const big = await begin(
      r,
      "docs",
      "q1",
      { size: 20_000, sha256: "cd".repeat(32) },
      "20,000 bytes against a 10,000 byte allowance.",
      {},
      { refused: true },
    );
    expect([
      big.res.status,
      (big.json as { error: { code: string } }).error.code,
    ]).toEqual([403, "quota_exceeded"]);
    expect((await stored(r, "docs", "q1", bytesOf(6000))).version).toBe(1);
    const next = await begin(
      r,
      "docs",
      "q2",
      { size: 6000, sha256: "ef".repeat(32) },
      "6,000 more does not fit beside the committed 6,000.",
      {},
      { refused: true },
    );
    expect([
      next.res.status,
      (next.json as { error: { code: string } }).error.code,
    ]).toEqual([403, "quota_exceeded"]);
  },
);

export const filesLimits = scenario(
  "cloudsync-files-limits",
  "The transfer limiter (§13.8.2): a device is allowed 30 file transfers an hour (a begin or a whole-file GET); the 31st begin answers 429 rate_limited with Retry-After and creates no session. Earlier transfers are spent outside the recording.",
  async (r, world, subject) => {
    const shard = syncLimiterShard(PRODUCT, subject);
    for (let i = 0; i < 30; i++)
      expect(
        await rateLimitOk(
          world.env,
          shard,
          { bucket: "syncFilesDevice", id: DEVICE, limit: 30, windowSec: 3600 },
          T0,
        ),
      ).toBe(true);
    const over = await begin(
      r,
      "docs",
      "l1",
      bytesOf(1000),
      "The 31st transfer of the hour.",
      {},
      { refused: true },
    );
    expect([
      over.res.status,
      (over.json as { error: { code: string } }).error.code,
    ]).toEqual([429, "rate_limited"]);
    expect(over.res.headers.get("retry-after")).not.toBeNull();
  },
);

export const filesExpired = scenario(
  "cloudsync-files-expired",
  "Session expiry (§13.8.1, GF5): an upload session lives 24 hours. A PUT, a resume and a finalize 25 hours after begin each answer 410 upload_expired (on three sessions: the first call to see an expired session ends it), and nothing is committed.",
  async (r) => {
    const bytes = bytesOf(2000);
    const later = T0 + 25 * 3600;
    const code = (o: Out) => [
      o.res.status,
      (o.json as { error: { code: string } }).error.code,
    ];
    // Each call finds its own session expired, so each gets one (the first call to see an expired
    // session ends it; the next finds nothing).
    const a = await begin(r, "docs", "x1", bytes, "Session 1.");
    expect(
      code(
        await put(r, "docs", "x1", idOf(a), bytes, "A PUT 25 hours later.", {
          now: later,
        }),
      ),
    ).toEqual([410, "upload_expired"]);
    const b = await begin(
      r,
      "docs",
      "x2",
      bytes,
      "Session 2.",
      {},
      { now: T0 },
    );
    expect(
      code(
        await status(r, "docs", "x2", idOf(b), "A resume 25 hours later.", {
          now: later,
        }),
      ),
    ).toEqual([410, "upload_expired"]);
    const c = await begin(
      r,
      "docs",
      "x3",
      bytes,
      "Session 3, bytes sent in time.",
    );
    expect(
      (await put(r, "docs", "x3", idOf(c), bytes, "In time.")).res.status,
    ).toBe(204);
    expect(
      code(
        await finalize(r, "docs", "x3", idOf(c), "A finalize 25 hours later.", {
          now: later,
        }),
      ),
    ).toEqual([410, "upload_expired"]);
  },
);

export const filesRevisions = scenario(
  "cloudsync-files-revisions",
  "Revisions and delete (§13.2, §13.8.4): docs keeps 2 older versions. Three writes make versions 1 to 3; the revisions list names the kept older ones, ?version= downloads one of them, and a record delete retires the file so the download answers 404.",
  async (r) => {
    const v1 = bytesOf(2000, 1);
    const v2 = bytesOf(2100, 2);
    const v3 = bytesOf(2200, 3);
    await stored(r, "docs", "rv", v1);
    await stored(r, "docs", "rv", v2);
    expect((await stored(r, "docs", "rv", v3)).version).toBe(3);
    const rev = await fileStep(
      r,
      "revisions",
      "The kept older versions.",
      { collection: "docs", id: "rv" },
      {
        method: "GET",
        path: filesPath("docs", "rv", "revisions"),
      },
    );
    expect(rev.res.status).toBe(200);
    const old = await download(r, "docs", "rv", "A kept version by number.", 2);
    expect(new Uint8Array(await old.res.arrayBuffer())).toEqual(v2);
    const del: SyncMutation = {
      mutationId: nextMutationId(),
      target: { record: ["docs", "rv"] },
      op: "delete",
      editedHlc: hlcAt(-1000),
    };
    const pushed = await pushStep(
      r,
      [del],
      "Delete the record: its file is retired.",
    );
    expect(pushed.status).toBe(200);
    expect(
      (await download(r, "docs", "rv", "The file is gone.")).res.status,
    ).toBe(404);
  },
);

export const CLOUD_SYNC_FILES_SCENARIOS: Scenario[] = [
  filesSingle,
  filesMultipart,
  filesMismatch,
  filesConflict,
  filesQuota,
  filesLimits,
  filesExpired,
  filesRevisions,
];
