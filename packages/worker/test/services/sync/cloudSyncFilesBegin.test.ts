/**
 * U-10.5: the file routes' first three (WIRE-CONTRACT-V5 §13.8, plans/U-10-U-11a-slices.md §2.3):
 * `POST …/begin`, `GET …/upload/{uploadId}` and `DELETE …/upload/{uploadId}`, and the launch gate
 * `launch.syncFiles` in front of them. Driven through the real `dispatch` pipeline and the real
 * `CloudSyncDO` over the SQLite mock, with an `R2Mock` as `SYNC_FILES`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BeginFileResponse,
  PushResponse,
  SyncJson,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import { NOW } from "../../seed.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { fileObjectKey } from "../../../src/services/sync/engine/files.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";
import {
  SLUG,
  begin,
  beginBody,
  breakLimiter,
  bytesOf,
  call,
  count,
  errorCode,
  filesPath,
  filesWorld,
  meta,
  push,
  setGate,
  uploadPath,
  uploadRow,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";

afterEach(() => vi.useRealTimers());

const MIB = 1024 * 1024;
const GHOST = "up_AAAAAAAAAAAAAAAAAAAAAA";

const opened = async (
  w: FilesWorld,
  collection: string,
  id: string,
  body: unknown,
): Promise<BeginFileResponse> => {
  const res = await begin(w, collection, id, body);
  expect(res.status).toBe(200);
  return (await res.json()) as BeginFileResponse;
};

/** What open uploads have reserved, as the object keeps it. */
const reserved = (w: FilesWorld): number =>
  Number(meta(w, "usage_reserved_bytes") ?? 0);

const entitle = (w: FilesWorld, entitlements: Record<string, unknown>) =>
  w.db.run(
    "UPDATE licenses SET overrides_json = ? WHERE product = ?",
    JSON.stringify({
      config: {},
      secrets: {},
      entitlements: Object.fromEntries(
        Object.entries(entitlements).map(([k, value]) => [
          k,
          { state: "enforced", value, updatedAt: NOW },
        ]),
      ),
    }),
    SLUG,
  );

/** A record written through the push, so a `begin` has a version to compare. */
async function putRecord(
  w: FilesWorld,
  collection: string,
  id: string,
  value: SyncJson = { a: 1 },
): Promise<number> {
  const res = await push(w, [
    {
      mutationId: nextId(),
      target: { record: [collection, id] },
      op: "set",
      value,
      editedHlc: hlc,
    },
  ]);
  const out = (await res.json()) as PushResponse;
  const r = out.results[0] as { status: string; version: number };
  expect(r.status).toBe("ok");
  return r.version;
}

/** Status and error code of a `begin`. */
async function refused(
  w: FilesWorld,
  collection: string,
  id: string,
  body: unknown,
): Promise<[number, string]> {
  const res = await begin(w, collection, id, body);
  return [res.status, await errorCode(res)];
}

describe("the launch gate launch.syncFiles", () => {
  it("off: every file route is 404, whoever asks, and the object is never called", async () => {
    const w = await filesWorld();
    setGate(w, "off");
    const calls = w.ns.calls.length;
    for (const [method, path, json] of [
      ["POST", filesPath("saves", "s1", "begin"), beginBody(10)],
      ["GET", uploadPath("saves", "s1", GHOST), undefined],
      ["DELETE", uploadPath("saves", "s1", GHOST), undefined],
    ] as const) {
      expect((await call(w, method, path, { json })).status, path).toBe(404);
      // Not a 401: with the gate off the route does not exist, even for a caller with no bearer.
      expect(
        (await call(w, method, path, { json, anonymous: true })).status,
        path,
      ).toBe(404);
    }
    expect(w.ns.calls.length).toBe(calls);
  });

  it("unset reads off, and on turns the routes on", async () => {
    const w = await filesWorld();
    setGate(w, undefined);
    expect((await begin(w, "saves", "s1", beginBody(10))).status).toBe(404);
    setGate(w, "on");
    expect((await begin(w, "saves", "s1", beginBody(10))).status).toBe(200);
  });

  it("a Worker with no file store is 404 even with the gate on", async () => {
    const w = await filesWorld();
    delete (w.env as { SYNC_FILES?: unknown }).SYNC_FILES;
    expect((await begin(w, "saves", "s1", beginBody(10))).status).toBe(404);
  });

  it("an upload open when the gate goes off is not served, and nothing is lost", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s1", beginBody(10));
    setGate(w, "off");
    const path = uploadPath("saves", "s1", up.uploadId);
    expect((await call(w, "GET", path)).status).toBe(404);
    expect((await call(w, "DELETE", path)).status).toBe(404);
    // The session and its reservation are still there for the gate to come back to.
    expect(reserved(w)).toBe(10);
    setGate(w, "on");
    expect((await call(w, "GET", path)).status).toBe(200);
  });
});

describe("POST …/begin", () => {
  it("opens a single upload: a fresh id, 24 hours, the file's bytes reserved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    const res = await begin(w, "saves", "slot-1", beginBody(bytesOf(1000)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as BeginFileResponse;
    expect(body).toEqual({
      uploadId: expect.stringMatching(/^up_[A-Za-z0-9_-]{22}$/),
      mode: "single",
      expiresAt: NOW * 1000 + 86_400_000,
    });
    expect(reserved(w)).toBe(1000);
    expect(uploadRow(w, body.uploadId)).toMatchObject({
      collection: "saves",
      record_id: "slot-1",
      mode: "single",
      format: "whole",
      enc: "none",
      size: 1000,
      state: "open",
      multipart_id: null,
      reserved_bytes: 1000,
    });
    // Nothing is in R2 yet, and no record or file row exists: `begin` writes a session only.
    expect(w.r2.keys()).toEqual([]);
    expect(count(w, "files")).toBe(0);
    expect(count(w, "records")).toBe(0);
  });

  it("a file over 16 MiB is multipart: partBytes, and the multipart upload is made in R2", async () => {
    const w = await filesWorld();
    const body = await opened(w, "big", "b1", beginBody(20 * MIB));
    expect(body).toMatchObject({ mode: "multipart", partBytes: 8 * MIB });
    expect(w.r2.openUploads()).toBe(1);
    const row = uploadRow(w, body.uploadId);
    expect(row?.multipart_id).toEqual(expect.any(String));
    expect(row?.part_bytes).toBe(8 * MIB);
    // The R2 key is derived from the pin and the session id, never from the request.
    expect(
      fileObjectKey({ product: SLUG, subject: w.subject }, body.uploadId),
    ).toBe(`u/${SLUG}/${w.subject}/o/${body.uploadId}`);
  });

  it("refuses with 1 to 4 of §2.3 before the object is called, in order", async () => {
    const w = await filesWorld();
    const calls = w.ns.calls.length;
    // 1: a collection no declaration matches.
    expect(await refused(w, "nope", "x", beginBody(10))).toEqual([
      400,
      "collection_unknown",
    ]);
    // 2: a collection whose `requires` the licence does not grant.
    expect(await refused(w, "vip", "x", beginBody(10))).toEqual([
      403,
      "entitlement_required",
    ]);
    // 3: `enc` against the product's mode (server mode takes `none`).
    expect(
      await refused(w, "saves", "x", beginBody(10, { enc: "e2e" })),
    ).toEqual([400, "encryption_mismatch"]);
    // 4: over the collection's `files.maxBytes` (the saves template: 32 MiB).
    expect(await refused(w, "saves", "x", beginBody(32 * MIB + 1))).toEqual([
      413,
      "file_too_large",
    ]);
    // 1 comes before 2 to 4: an unknown collection with a wrong `enc` is `collection_unknown`.
    expect(
      await refused(w, "nope", "x", beginBody(10, { enc: "e2e" })),
    ).toEqual([400, "collection_unknown"]);
    expect(w.ns.calls.length).toBe(calls);
    // The limits of the saves template are met exactly, not past.
    await opened(w, "saves", "fits", beginBody(32 * MIB));
  });

  it("a licence that grants the entitlement lifts `requires`", async () => {
    const w = await filesWorld();
    await entitle(w, { "game.vip": true });
    expect((await begin(w, "vip", "x", beginBody(10))).status).toBe(200);
    // A value that is not exactly true is no grant.
    await entitle(w, { "game.vip": "yes" });
    expect((await begin(w, "vip", "y", beginBody(10))).status).toBe(403);
  });

  it("a quota with files off is entitlement_required, whatever the collection", async () => {
    const w = await filesWorld();
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ?",
      SLUG,
    );
    expect(await refused(w, "saves", "x", beginBody(10))).toEqual([
      403,
      "entitlement_required",
    ]);
  });

  it("the chunks format is not served yet: 400 bad_request, with or without files.delta", async () => {
    const w = await filesWorld();
    for (const c of ["delta", "saves"])
      expect(
        await refused(w, c, "x", beginBody(2 * MIB, { format: "chunks" })),
      ).toEqual([400, "bad_request"]);
    // Refused by the Worker: no object was even made.
    expect(w.ns.instances.size).toBe(0);
  });

  it("a body that is not a begin is 400, and one over its cap is 413", async () => {
    const w = await filesWorld();
    const bad: unknown[] = [
      "not an object",
      [],
      { ...beginBody(10), size: -1 },
      { ...beginBody(10), size: 1.5 },
      { ...beginBody(10), sha256: "AB".repeat(32) },
      { ...beginBody(10), sha256: "ab" },
      { ...beginBody(10), format: "zip" },
      { ...beginBody(10), enc: "maybe" },
      { ...beginBody(10), baseVersion: -2 },
      { ...beginBody(10), baseVersion: "x" },
    ];
    for (const b of bad)
      expect(await refused(w, "saves", "x", b), JSON.stringify(b)).toEqual([
        400,
        "bad_request",
      ]);
    const raw = await call(w, "POST", filesPath("saves", "x", "begin"), {
      bytes: new TextEncoder().encode("{"),
      headers: { "content-type": "application/json" },
    });
    expect([raw.status, await errorCode(raw)]).toEqual([400, "bad_request"]);
    const big = await call(w, "POST", filesPath("saves", "x", "begin"), {
      bytes: new TextEncoder().encode(
        JSON.stringify({ ...beginBody(10), pad: "x".repeat(5000) }),
      ),
      headers: { "content-type": "application/json" },
    });
    expect([big.status, await errorCode(big)]).toEqual([413, "body_too_large"]);
  });

  it("a request with no bearer is 401", async () => {
    const w = await filesWorld();
    const res = await call(w, "POST", filesPath("saves", "x", "begin"), {
      json: beginBody(10),
      anonymous: true,
    });
    expect(res.status).toBe(401);
  });

  it("end-to-end: `enc` must be e2e and the id blinded", async () => {
    const w = await filesWorld({
      catalog: {
        schemaVersion: 1,
        entries: [],
        cloudSync: { collections: [{ name: "saves", template: "saves" }] },
      },
    });
    const blinded = `x:${"A".repeat(43)}`;
    expect(await refused(w, "saves", blinded, beginBody(10))).toEqual([
      400,
      "encryption_mismatch",
    ]);
    expect(
      await refused(w, "saves", "slot-1", beginBody(10, { enc: "e2e" })),
    ).toEqual([400, "encryption_mismatch"]);
    const up = await opened(w, "saves", blinded, beginBody(10, { enc: "e2e" }));
    expect(uploadRow(w, up.uploadId)).toMatchObject({
      record_id: blinded,
      enc: "e2e",
    });
  });
});

describe("POST …/begin: against stored state", () => {
  it("baseVersion is compared with the record (409 revision_conflict carries the server's version)", async () => {
    const w = await filesWorld();
    const v = await putRecord(w, "saves", "slot-1", { playtime: 1 });
    const conflict = async (baseVersion: number | "*", id = "slot-1") => {
      const res = await begin(w, "saves", id, beginBody(10, { baseVersion }));
      return [
        res.status,
        res.status === 409
          ? ((await res.json()) as { error: { code: string }; server: unknown })
          : null,
      ] as const;
    };
    // A stale number, and create-only against a live record.
    const stale = await conflict(v - 1);
    expect(stale[0]).toBe(409);
    expect(stale[1]).toEqual({
      error: { code: "revision_conflict" },
      server: { version: v },
    });
    expect((await conflict("*"))[0]).toBe(409);
    // A number against a record the store has no row for is version 0.
    const missing = await conflict(5, "no-such");
    expect(missing[1]).toEqual({
      error: { code: "revision_conflict" },
      server: { version: 0 },
    });
    // The current version, create-only on a missing record, and no condition all begin.
    expect((await conflict(v))[0]).toBe(200);
    expect((await conflict("*", "fresh"))[0]).toBe(200);
    expect((await begin(w, "saves", "slot-1", beginBody(10))).status).toBe(200);
    // Each refusal reserved nothing.
    expect(reserved(w)).toBe(30);
  });

  it("at most four uploads are open: the fifth is 429, and ending one makes room", async () => {
    const w = await filesWorld();
    const ups: BeginFileResponse[] = [];
    for (let i = 0; i < 4; i++)
      ups.push(await opened(w, "saves", `s${i}`, beginBody(10)));
    const fifth = await begin(w, "saves", "s4", beginBody(10));
    expect([fifth.status, await errorCode(fifth)]).toEqual([
      429,
      "rate_limited",
    ]);
    expect(fifth.headers.get("retry-after")).toBe("60");
    expect(reserved(w)).toBe(40);
    expect(
      (await call(w, "DELETE", uploadPath("saves", "s0", ups[0]!.uploadId)))
        .status,
    ).toBe(204);
    expect((await begin(w, "saves", "s4", beginBody(10))).status).toBe(200);
  });

  it("what open uploads have reserved counts against the quota, and ending one gives it back", async () => {
    const w = await filesWorld();
    await entitle(w, { "pkey.cloudSync.bytes": 1_000_000 });
    const a = await opened(w, "saves", "a", beginBody(600_000));
    // 600,000 reserved + 600,000 asked > 1,000,000, though nothing is stored yet.
    const over = await begin(w, "saves", "b", beginBody(600_000));
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({
      error: { code: "quota_exceeded" },
      scope: "user",
    });
    // Exactly the room left is allowed.
    await opened(w, "saves", "c", beginBody(400_000));
    expect(reserved(w)).toBe(1_000_000);
    expect((await begin(w, "saves", "d", beginBody(1))).status).toBe(403);
    await call(w, "DELETE", uploadPath("saves", "a", a.uploadId));
    expect(reserved(w)).toBe(400_000);
    expect((await begin(w, "saves", "d", beginBody(600_000))).status).toBe(200);
  });

  it("a quota of zero is reads only", async () => {
    const w = await filesWorld();
    await entitle(w, { "pkey.cloudSync.bytes": 0 });
    const res = await begin(w, "saves", "a", beginBody(0));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { scope: string }).scope).toBe("user");
  });

  it("a create past maxRecords is scope collection; a begin on an existing record is not", async () => {
    const w = await filesWorld();
    await putRecord(w, "one", "only");
    const res = await begin(w, "one", "another", beginBody(10));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "quota_exceeded" },
      scope: "collection",
    });
    expect((await begin(w, "one", "only", beginBody(10))).status).toBe(200);
  });

  it("the operator's ceilings are scope product", async () => {
    const w = await filesWorld();
    await w.db.run(
      `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
       VALUES (?, ?, 0, 0, 0, 0, 0, '{}', 1)`,
      SLUG,
      50 * 1024 * 1024 * 1024,
    );
    const res = await begin(w, "saves", "a", beginBody(10));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "quota_exceeded" },
      scope: "product",
    });
    expect(reserved(w)).toBe(0);
  });

  it("a product at its users ceiling refuses a person who never held data, not one who does", async () => {
    const w = await filesWorld();
    await w.db.run(
      `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
       VALUES (?, 0, 100000, 0, 0, 0, 0, '{}', 1)`,
      SLUG,
    );
    const res = await begin(w, "saves", "a", beginBody(10));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { scope: string }).scope).toBe("product");
  });

  it("a product at its users ceiling still serves a person who already holds data", async () => {
    const w = await filesWorld();
    await putRecord(w, "big", "held");
    await w.db.run(
      `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
       VALUES (?, 0, 100000, 0, 0, 0, 0, '{}', 1)`,
      SLUG,
    );
    expect((await begin(w, "big", "held", beginBody(10))).status).toBe(200);
  });
});

describe("the limits", () => {
  it("30 begins an hour per device; the 31st is 429 with Retry-After, and costs the object nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    for (let i = 0; i < 30; i++) {
      const up = await opened(w, "saves", `s${i}`, beginBody(1));
      await call(w, "DELETE", uploadPath("saves", `s${i}`, up.uploadId));
    }
    const calls = w.ns.calls.length;
    const res = await begin(w, "saves", "late", beginBody(1));
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("retry-after")).toBe(String(3600 - (NOW % 3600)));
    expect(w.ns.calls.length).toBe(calls);
    // The next hour is open again.
    vi.setSystemTime((NOW + 3600) * 1000);
    expect((await begin(w, "saves", "late", beginBody(1))).status).toBe(200);
  });

  it("limiter down: it fails open and the begin goes through", async () => {
    const w = await filesWorld();
    breakLimiter(w);
    expect((await begin(w, "saves", "a", beginBody(1))).status).toBe(200);
  });

  it("paused writes refuse a begin (503, Retry-After 300) but not a status or an abort", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "a", beginBody(10));
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
    const res = await begin(w, "saves", "b", beginBody(10));
    expect([res.status, await errorCode(res)]).toEqual([503, "writes_paused"]);
    expect(res.headers.get("retry-after")).toBe("300");
    const path = uploadPath("saves", "a", up.uploadId);
    expect((await call(w, "GET", path)).status).toBe(200);
    expect((await call(w, "DELETE", path)).status).toBe(204);
  });
});

describe("GET …/upload/{uploadId}", () => {
  it("answers the session: a single upload with no part, a multipart one with its parts", async () => {
    const w = await filesWorld();
    const single = await opened(w, "saves", "s", beginBody(10));
    const r = await call(w, "GET", uploadPath("saves", "s", single.uploadId));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()) as UploadStatus).toEqual({
      mode: "single",
      size: 10,
      received: [],
      expiresAt: single.expiresAt,
    });
    const multi = await opened(w, "big", "m", beginBody(20 * MIB));
    expect(
      (await (
        await call(w, "GET", uploadPath("big", "m", multi.uploadId))
      ).json()) as UploadStatus,
    ).toEqual({
      mode: "multipart",
      size: 20 * MIB,
      partBytes: 8 * MIB,
      received: [],
      expiresAt: multi.expiresAt,
    });
  });

  it("is 404 for a session that is not this record's, one that was never opened, and one that ended", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s", beginBody(10));
    for (const path of [
      uploadPath("saves", "other", up.uploadId),
      uploadPath("big", "s", up.uploadId),
      uploadPath("saves", "s", GHOST),
    ])
      expect((await call(w, "GET", path)).status, path).toBe(404);
    // A malformed session id is no route at all.
    expect(
      (await call(w, "GET", uploadPath("saves", "s", "nope"))).status,
    ).toBe(404);
    await call(w, "DELETE", uploadPath("saves", "s", up.uploadId));
    expect(
      (await call(w, "GET", uploadPath("saves", "s", up.uploadId))).status,
    ).toBe(404);
  });

  it("is 404 for another person's session: the object is the person's", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s", beginBody(10));
    const r = await signIn(
      w.db,
      { issuerKey: "email", subject: "bob@example.com", kind: "email" },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (r.status !== "signed_in") throw new Error(r.status);
    expect(
      await setDeviceSubject(w.env, w.db, SLUG, "dev-attack-1", r.subject!),
    ).toBe(true);
    for (const method of ["GET", "DELETE"] as const)
      expect(
        (await call(w, method, uploadPath("saves", "s", up.uploadId))).status,
      ).toBe(404);
    // Alice's session is untouched by Bob's attempts on it.
    expect(uploadRow(w, up.uploadId)?.state).toBe("open");
    expect(reserved(w)).toBe(10);
  });

  it("an expired upload is 410 upload_expired once, and its R2 multipart and reservation are gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    const up = await opened(w, "big", "m", beginBody(20 * MIB));
    expect(w.r2.openUploads()).toBe(1);
    expect(reserved(w)).toBe(20 * MIB);
    const path = uploadPath("big", "m", up.uploadId);
    vi.setSystemTime((NOW + 86_399) * 1000);
    expect((await call(w, "GET", path)).status).toBe(200);
    vi.setSystemTime((NOW + 86_400) * 1000);
    const res = await call(w, "GET", path);
    expect([res.status, await errorCode(res)]).toEqual([410, "upload_expired"]);
    expect(w.r2.openUploads()).toBe(0);
    expect(reserved(w)).toBe(0);
    expect(uploadRow(w, up.uploadId)).toBeUndefined();
    // After that the session is simply unknown.
    expect((await call(w, "GET", path)).status).toBe(404);
  });
});

describe("DELETE …/upload/{uploadId}", () => {
  it("aborts: 204, the reservation released exactly once, the R2 multipart gone", async () => {
    const w = await filesWorld();
    const a = await opened(w, "big", "m", beginBody(20 * MIB));
    const b = await opened(w, "saves", "s", beginBody(100));
    expect(reserved(w)).toBe(20 * MIB + 100);
    const path = uploadPath("big", "m", a.uploadId);
    const first = await call(w, "DELETE", path);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(reserved(w)).toBe(100);
    expect(w.r2.openUploads()).toBe(0);
    // Repeated, it is the same answer and releases nothing more (b's 100 bytes stay held).
    expect((await call(w, "DELETE", path)).status).toBe(204);
    expect((await call(w, "DELETE", path)).status).toBe(204);
    expect(reserved(w)).toBe(100);
    expect(uploadRow(w, b.uploadId)?.state).toBe("open");
    expect(uploadRow(w, a.uploadId)).toMatchObject({
      state: "aborted",
      reserved_bytes: 0,
    });
  });

  it("is 404 for a session that is unknown or another record's, and releases nothing", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s", beginBody(10));
    expect(
      (await call(w, "DELETE", uploadPath("saves", "s", GHOST))).status,
    ).toBe(404);
    expect(
      (await call(w, "DELETE", uploadPath("saves", "other", up.uploadId)))
        .status,
    ).toBe(404);
    expect(reserved(w)).toBe(10);
  });

  it("keeps the reservation while R2 still holds the session's bytes (503, tried again later)", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s", beginBody(10));
    const real = w.r2.delete.bind(w.r2);
    w.r2.delete = () => Promise.reject(new Error("R2 is down"));
    const down = await call(w, "DELETE", uploadPath("saves", "s", up.uploadId));
    expect(down.status).toBe(503);
    expect(reserved(w)).toBe(10);
    expect(uploadRow(w, up.uploadId)?.state).toBe("open");
    w.r2.delete = real;
    expect(
      (await call(w, "DELETE", uploadPath("saves", "s", up.uploadId))).status,
    ).toBe(204);
    expect(reserved(w)).toBe(0);
  });

  it("deletes the object a single upload may already have put in R2", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s", beginBody(10));
    const key = fileObjectKey(
      { product: SLUG, subject: w.subject },
      up.uploadId,
    );
    await w.r2.put(key, bytesOf(10));
    expect(w.r2.has(key)).toBe(true);
    await call(w, "DELETE", uploadPath("saves", "s", up.uploadId));
    expect(w.r2.has(key)).toBe(false);
  });
});

describe("expiry at the next begin", () => {
  it("collects expired uploads first: their open slots and reservations are free again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    await entitle(w, { "pkey.cloudSync.bytes": 1_000_000 });
    for (let i = 0; i < 4; i++)
      await opened(w, "saves", `s${i}`, beginBody(200_000));
    expect(reserved(w)).toBe(800_000);
    // Four slots are taken and 800,000 are held: a fifth is refused while they are live.
    expect((await begin(w, "saves", "s4", beginBody(900_000))).status).toBe(
      429,
    );
    vi.setSystemTime((NOW + 90_000) * 1000);
    const fresh = await opened(w, "saves", "new", beginBody(900_000));
    expect(reserved(w)).toBe(900_000);
    expect(count(w, "uploads")).toBe(1);
    expect(uploadRow(w, fresh.uploadId)?.state).toBe("open");
  });

  it("an expired multipart upload is aborted in R2 when it is collected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    await opened(w, "big", "m", beginBody(20 * MIB));
    expect(w.r2.openUploads()).toBe(1);
    vi.setSystemTime((NOW + 90_000) * 1000);
    await opened(w, "saves", "s", beginBody(10));
    expect(w.r2.openUploads()).toBe(0);
  });
});
