import { describe, expect, it } from "vitest";
import {
  memoryJournal,
  rangedBytes,
  TransferEngine,
  TransferError,
  TRANSFER_JOURNAL_VERSION,
  webCryptoSyncPort as port,
  type FileCallOptions,
  type FileReply,
  type FileTarget,
  type FileTransport,
  type JournalStore,
  type TransferEngineDeps,
  type TransferJournalRecord,
  type UploadRequest,
} from "../src/sync/index.js";
import { fail, hex, MIB, noise, ok } from "./syncTransferFixtures.js";
import type {
  BeginFileRequest,
  BeginFileResponse,
  FinalizeRequest,
  FinalizeResponse,
  UploadStatus,
} from "@polaris-key/protocol/sync";

type Reply<T> = FileReply<T>;

/** A fake U-10 server behind the FileTransport port: parts in any order, digests checked. */
class FakeServer implements FileTransport {
  uploads = new Map<
    string,
    {
      size: number;
      sha256: string;
      mode: "single" | "multipart";
      partBytes?: number;
      parts: Map<number, Uint8Array>;
      expiresAt: number;
      done?: FinalizeResponse;
    }
  >();
  calls: string[] = [];
  begins = 0;
  partPuts: number[] = [];
  /** The order parts were stored in, which parallel sends make differ from the order they were sent. */
  stored: number[] = [];
  inFlight = 0;
  maxInFlight = 0;
  seq = 0;
  version = 1;
  /** Per-call interceptors, consumed in order; return a reply to override. */
  hook: (kind: string, n?: number) => Reply<null> | Reply<never> | undefined =
    () => undefined;
  delay: (n: number) => number = () => 0;
  expiresAt = Math.floor(Date.now() / 1000) + 86_400;
  partBytes = 8 * MIB;

  begin = async (
    _t: FileTarget,
    r: BeginFileRequest,
  ): Promise<Reply<BeginFileResponse>> => {
    this.calls.push("begin");
    const h = this.hook("begin");
    if (h) return h as Reply<never>;
    this.begins++;
    const uploadId = `up${++this.seq}`;
    const single = r.size <= 16 * MIB;
    this.uploads.set(uploadId, {
      size: r.size,
      sha256: r.sha256,
      mode: single ? "single" : "multipart",
      ...(single ? {} : { partBytes: this.partBytes }),
      parts: new Map(),
      expiresAt: this.expiresAt,
    });
    return ok({
      uploadId,
      mode: single ? "single" : "multipart",
      ...(single ? {} : { partBytes: this.partBytes }),
      expiresAt: this.expiresAt,
    });
  };
  status = async (_t: FileTarget, id: string): Promise<Reply<UploadStatus>> => {
    this.calls.push("status");
    const h = this.hook("status");
    if (h) return h as Reply<never>;
    const u = this.uploads.get(id);
    if (!u) return fail(410, "upload_expired");
    return ok({
      mode: u.mode,
      size: u.size,
      ...(u.partBytes ? { partBytes: u.partBytes } : {}),
      received: [...u.parts.keys()].sort((a, b) => a - b),
      expiresAt: u.expiresAt,
    });
  };
  private async store(
    id: string,
    n: number,
    body: Uint8Array,
    digest: string,
  ): Promise<Reply<null>> {
    const u = this.uploads.get(id);
    if (!u) return fail(410, "upload_expired");
    if (hex(await port.sha256(body)) !== digest)
      return fail(400, "upload_mismatch");
    u.parts.set(n, Uint8Array.from(body));
    this.stored.push(n);
    return ok(null);
  }
  putSingle = async (
    _t: FileTarget,
    id: string,
    body: Uint8Array,
    digest: string,
  ) => {
    this.calls.push("putSingle");
    const h = this.hook("putSingle");
    if (h) return h as Reply<null>;
    return this.store(id, 1, body, digest);
  };
  putPart = async (
    _t: FileTarget,
    id: string,
    n: number,
    body: Uint8Array,
    digest: string,
  ) => {
    this.calls.push(`part${n}`);
    this.partPuts.push(n);
    const h = this.hook("putPart", n);
    if (h) return h as Reply<null>;
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.delay(n)));
      return await this.store(id, n, body, digest);
    } finally {
      this.inFlight--;
    }
  };
  abort = async (_t: FileTarget, id: string) => {
    this.calls.push("abort");
    this.uploads.delete(id);
    return ok(null);
  };
  finalize = async (
    _t: FileTarget,
    r: FinalizeRequest,
  ): Promise<Reply<FinalizeResponse>> => {
    this.calls.push("finalize");
    const h = this.hook("finalize");
    if (h) return h as Reply<never>;
    const u = this.uploads.get(r.uploadId);
    if (!u) return fail(410, "upload_expired");
    if (u.done) return ok(u.done);
    const want = u.mode === "single" ? 1 : Math.ceil(u.size / u.partBytes!);
    const missing = [];
    for (let n = 1; n <= want; n++) if (!u.parts.has(n)) missing.push(n);
    if (missing.length)
      return fail(409, "upload_incomplete", { body: { missing } });
    const whole = Buffer.concat(
      [...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
    );
    if (hex(await port.sha256(whole)) !== u.sha256)
      return fail(400, "upload_mismatch");
    u.done = {
      version: ++this.version,
      size: u.size,
      sha256: u.sha256,
      format: "whole",
    };
    return ok(u.done);
  };

  // Chunks and downloads are driven by syncTransferChunks.test.ts.
  planChunks = async (): Promise<Reply<never>> => {
    throw new Error("unused");
  };
  putChunk = this.planChunks;
  getFile = this.planChunks;
  getChunk = this.planChunks;
  revisions = this.planChunks;

  bytes(uploadId: string): Uint8Array {
    const u = this.uploads.get(uploadId)!;
    return Buffer.concat(
      [...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
    );
  }
}

async function request(
  data: Uint8Array,
  over: Partial<UploadRequest> = {},
): Promise<UploadRequest> {
  return {
    id: "t1",
    collection: "saves",
    record: "rec1",
    source: rangedBytes(data),
    size: data.length,
    sha256: hex(await port.sha256(data)),
    enc: "none",
    ...over,
  };
}

function engine(
  server: FileTransport,
  journal: JournalStore,
  over: Partial<TransferEngineDeps> = {},
) {
  const sleeps: number[] = [];
  const e = new TransferEngine({
    transport: server,
    journal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...over,
  });
  return { e, sleeps };
}

const big = noise(40 * MIB, 3); // 5 parts of 8 MiB
const small = noise(300_000, 9);

describe("TransferEngine upload", () => {
  it("uploads a single-mode file and clears the journal", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const { e } = engine(s, j);
    const out = await e.upload(await request(small));
    expect(out.size).toBe(small.length);
    expect(s.calls).toEqual(["begin", "putSingle", "finalize"]);
    expect(await j.list()).toEqual([]);
  });

  it("uploads multipart, at most 4 parts at once, in any order", async () => {
    const s = new FakeServer();
    s.partBytes = 4 * MIB; // 10 parts
    // Later parts finish first.
    s.delay = (n) => (n % 2 === 0 ? 1 : 15 - n);
    const j = memoryJournal();
    const { e } = engine(s, j);
    const sent: number[][] = [];
    const out = await e.upload(
      await request(big, {
        onProgress: (n) => sent.push([n]),
      }),
    );
    expect(s.maxInFlight).toBe(4);
    expect(s.partPuts.length).toBe(10);
    // Parts landed out of numeric order, and every one landed once.
    expect(s.stored).not.toEqual([...s.stored].sort((a, b) => a - b));
    expect([...s.stored].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const up = [...s.uploads.keys()][0]!;
    expect(hex(await port.sha256(s.bytes(up)))).toBe(out.sha256);
    expect(sent.at(-1)![0]).toBe(big.length);
    expect(await j.list()).toEqual([]);
  });

  it("journals parts in ascending order whichever finishes first", async () => {
    const s = new FakeServer();
    s.partBytes = 8 * MIB;
    s.delay = (n) => 30 - n * 5; // 5 finishes first, then 4, …
    const seen: number[][] = [];
    const j = memoryJournal();
    const put = j.put;
    j.put = async (id, rec) => {
      seen.push([...rec.done]);
      return put(id, rec);
    };
    const { e } = engine(s, j);
    await e.upload(await request(big));
    for (const d of seen) expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(seen.some((d) => d.length === 5)).toBe(true);
  });

  it("resumes from the journal after a crash mid-multipart, sending only the missing parts", async () => {
    const s = new FakeServer();
    s.partBytes = 8 * MIB;
    const j = memoryJournal();
    // First run: parts 1 and 2 land, then the process dies on part 3 (an unrecoverable throw).
    s.hook = (kind, n) => {
      if (kind === "putPart" && (n ?? 0) >= 3) throw new Error("killed");
      return undefined;
    };
    const first = engine(s, j, { maxAttempts: 1 });
    await expect(first.e.upload(await request(big))).rejects.toMatchObject({
      reason: "retries-exhausted",
    });
    const rec = (await j.get("t1")) as TransferJournalRecord;
    expect(rec.v).toBe(TRANSFER_JOURNAL_VERSION);
    expect(rec.state).toBe("uploading");
    expect(rec.done.length).toBeGreaterThanOrEqual(1);
    expect(rec.done.length).toBeLessThan(5);

    // Second run, a fresh engine over the same journal and server.
    s.hook = () => undefined;
    s.calls = [];
    s.partPuts = [];
    const second = engine(s, j);
    const out = await second.e.upload(await request(big));
    expect(s.begins).toBe(1);
    expect(s.calls[0]).toBe("status");
    for (const n of rec.done) expect(s.partPuts).not.toContain(n);
    expect(s.partPuts.length).toBe(5 - rec.done.length);
    expect(out.size).toBe(big.length);
    expect(await j.list()).toEqual([]);
  });

  it("resends a part the journal calls done but the server lost", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    s.hook = (kind, n) => {
      if (kind === "putPart" && n === 5) throw new Error("killed");
      return undefined;
    };
    const first = engine(s, j, { maxAttempts: 1 });
    await expect(first.e.upload(await request(big))).rejects.toBeInstanceOf(
      TransferError,
    );
    const rec = (await j.get("t1")) as TransferJournalRecord;
    expect(rec.done).toContain(2);
    s.uploads.get(rec.uploadId)!.parts.delete(2);
    s.hook = () => undefined;
    s.partPuts = [];
    await engine(s, j).e.upload(await request(big));
    expect(s.partPuts).toContain(2);
    expect(s.partPuts).not.toContain(1);
  });

  it("finalize's upload_incomplete resends the named parts", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    let dropped = false;
    const finalize = s.finalize;
    s.finalize = async (t, r) => {
      if (!dropped) {
        dropped = true;
        s.uploads.get(r.uploadId)!.parts.delete(3);
      }
      return finalize(t, r);
    };
    await engine(s, j).e.upload(await request(big));
    expect(s.partPuts.filter((n) => n === 3).length).toBe(2);
    expect(s.calls.filter((c) => c === "finalize").length).toBe(2);
  });

  it("restarts on a 410 at status, and on a 410 mid-parts, then succeeds", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    s.hook = (kind, n) => {
      if (kind === "putPart" && (n ?? 0) >= 3) throw new Error("killed");
      return undefined;
    };
    await expect(
      engine(s, j, { maxAttempts: 1 }).e.upload(await request(big)),
    ).rejects.toBeInstanceOf(TransferError);
    // The upload expired on the server while the app was away.
    s.uploads.clear();
    s.hook = () => undefined;
    s.begins = 0;
    const out = await engine(s, j).e.upload(await request(big));
    expect(s.begins).toBe(1);
    expect(out.size).toBe(big.length);

    // A 410 on a part restarts the whole upload once.
    const s2 = new FakeServer();
    let hit = false;
    s2.hook = (kind, n) => {
      if (kind === "putPart" && n === 2 && !hit) {
        hit = true;
        return fail(410, "upload_expired") as Reply<null>;
      }
      return undefined;
    };
    const j2 = memoryJournal();
    const out2 = await engine(s2, j2).e.upload(await request(big));
    expect(s2.begins).toBe(2);
    expect(out2.size).toBe(big.length);
    expect(await j2.list()).toEqual([]);
  });

  it("gives up with restarts-exhausted when the upload keeps vanishing", async () => {
    const s = new FakeServer();
    s.hook = (kind) =>
      kind === "putSingle"
        ? (fail(410, "upload_expired") as Reply<null>)
        : undefined;
    await expect(
      engine(s, memoryJournal(), { maxRestarts: 2 }).e.upload(
        await request(small),
      ),
    ).rejects.toMatchObject({ reason: "restarts-exhausted" });
    expect(s.begins).toBe(3);
  });

  it("begins afresh when the journal record is past expiresAt, without asking the server", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const req = await request(big);
    await j.put("t1", {
      v: 1,
      id: "t1",
      kind: "upload",
      collection: "saves",
      record: "rec1",
      uploadId: "old",
      mode: "multipart",
      partBytes: 8 * MIB,
      done: [1, 2],
      sha256: req.sha256,
      size: req.size,
      expiresAt: Math.floor(Date.now() / 1000) - 5,
      state: "uploading",
    });
    await engine(s, j).e.upload(req);
    expect(s.calls).not.toContain("status");
    expect(s.begins).toBe(1);
    expect(s.partPuts.length).toBe(5);
  });

  it("surfaces a 409 revision_conflict from begin with the server version, and retries nothing", async () => {
    const s = new FakeServer();
    s.hook = (kind) =>
      kind === "begin"
        ? (fail(409, "revision_conflict", {
            body: { server: { version: 7 } },
          }) as Reply<never>)
        : undefined;
    const j = memoryJournal();
    const err = await engine(s, j)
      .e.upload(await request(small, { baseVersion: 3 }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err).toMatchObject({
      reason: "conflict",
      status: 409,
      serverVersion: 7,
    });
    expect(s.calls).toEqual(["begin"]);
    expect(await j.list()).toEqual([]);
  });

  it("surfaces a 409 at finalize, aborts the upload and drops the journal", async () => {
    const s = new FakeServer();
    s.hook = (kind) =>
      kind === "finalize"
        ? (fail(409, "revision_conflict", {
            body: { server: { version: 9 } },
          }) as Reply<never>)
        : undefined;
    const j = memoryJournal();
    await expect(
      engine(s, j).e.upload(await request(small)),
    ).rejects.toMatchObject({
      reason: "conflict",
      serverVersion: 9,
    });
    expect(s.calls.at(-1)).toBe("abort");
    expect(await j.list()).toEqual([]);
  });

  it("honours Retry-After, holding every part, and backs off without it", async () => {
    const s = new FakeServer();
    s.partBytes = 8 * MIB;
    let first = true;
    s.hook = (kind, n) => {
      if (kind === "putPart" && n === 1 && first) {
        first = false;
        return fail(429, "rate_limited", {
          retryAfterSeconds: 7,
        }) as Reply<null>;
      }
      return undefined;
    };
    let clock = 1_000_000;
    const { e, sleeps } = engine(s, memoryJournal(), { now: () => clock });
    // The fake clock does not move, so every part sent after the 429 waits the full hold.
    const out = await e.upload(await request(big));
    expect(out.size).toBe(big.length);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 7000)).toBe(true);
    expect(s.partPuts.filter((n) => n === 1).length).toBe(2);

    // No Retry-After: exponential, jittered by random() = 0.5 -> 0.75 of 500, 1000, …
    const s2 = new FakeServer();
    let failures = 3;
    s2.hook = (kind) => {
      if (kind === "putSingle" && failures-- > 0)
        return fail(503, "unavailable") as Reply<null>;
      return undefined;
    };
    clock = 0;
    let t = 0;
    const r = engine(s2, memoryJournal(), {
      now: () => t,
      sleep: async (ms) => {
        r.sleeps.push(ms);
        t += ms;
      },
    });
    await r.e.upload(await request(small));
    expect(r.sleeps).toEqual([375, 750, 1500]);
  });

  it("retries a call that gets no answer, then gives up leaving the journal", async () => {
    const s = new FakeServer();
    s.hook = (kind) => {
      if (kind === "putSingle") throw new TypeError("network");
      return undefined;
    };
    const j = memoryJournal();
    await expect(
      engine(s, j, { maxAttempts: 3 }).e.upload(await request(small)),
    ).rejects.toMatchObject({ reason: "retries-exhausted" });
    expect(s.calls.filter((c) => c === "putSingle").length).toBe(3);
    expect((await j.get("t1")) as TransferJournalRecord).toMatchObject({
      state: "uploading",
    });
  });

  it("surfaces an upload_mismatch (400) without a retry", async () => {
    const s = new FakeServer();
    s.hook = (kind) =>
      kind === "putSingle"
        ? (fail(400, "upload_mismatch") as Reply<null>)
        : undefined;
    await expect(
      engine(s, memoryJournal()).e.upload(await request(small)),
    ).rejects.toMatchObject({
      reason: "mismatch",
    });
    expect(s.calls.filter((c) => c === "putSingle").length).toBe(1);
  });

  it("refuses a source whose hash is not the declared sha256, sending nothing", async () => {
    const s = new FakeServer();
    const req = await request(small);
    const other = noise(small.length, 77);
    await expect(
      engine(s, memoryJournal()).e.upload({
        ...req,
        source: rangedBytes(other),
      }),
    ).rejects.toMatchObject({ reason: "source-mismatch" });
    await expect(
      engine(s, memoryJournal()).e.upload({ ...req, size: req.size + 1 }),
    ).rejects.toMatchObject({ reason: "source-mismatch" });
    expect(s.calls).toEqual([]);
  });

  it("refuses a journal record with an unknown v and leaves it alone", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const req = await request(small);
    const future = { v: 2, id: "t1", whatever: true };
    await j.put("t1", future as unknown as TransferJournalRecord);
    await expect(engine(s, j).e.upload(req)).rejects.toMatchObject({
      reason: "journal-version",
    });
    expect(s.calls).toEqual([]);
    expect(await j.get("t1")).toEqual(future);
    // A malformed v1 record is refused the same way.
    await j.put("t1", { v: 1, id: "t1" } as unknown as TransferJournalRecord);
    await expect(engine(s, j).e.upload(req)).rejects.toMatchObject({
      reason: "journal-malformed",
    });
    expect(s.calls).toEqual([]);
  });

  it("drops a record for other bytes, aborting its upload, and begins anew", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const a = await request(small);
    s.hook = (kind) => {
      if (kind === "putSingle") throw new Error("killed");
      return undefined;
    };
    await engine(s, j, { maxAttempts: 1 })
      .e.upload(a)
      .catch(() => undefined);
    s.hook = () => undefined;
    const bytes = noise(1000, 5);
    await engine(s, j).e.upload(await request(bytes));
    expect(s.calls).toContain("abort");
    expect(s.begins).toBe(2);
  });

  it("stops on an abort signal and keeps the journal for a resume", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const ac = new AbortController();
    s.delay = () => 5;
    s.hook = (kind, n) => {
      if (kind === "putPart" && n === 3) ac.abort();
      return undefined;
    };
    await expect(
      engine(s, j).e.upload(await request(big, { signal: ac.signal })),
    ).rejects.toMatchObject({ reason: "aborted" });
    const rec = (await j.get("t1")) as TransferJournalRecord;
    expect(rec.state).toBe("uploading");
  });

  it("cancel aborts the server's upload and forgets the record", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    s.hook = (kind) => {
      if (kind === "putSingle") throw new Error("killed");
      return undefined;
    };
    const { e } = engine(s, j, { maxAttempts: 1 });
    await e.upload(await request(small)).catch(() => undefined);
    expect(await j.list()).toEqual(["t1"]);
    await e.cancel("t1");
    expect(s.calls.at(-1)).toBe("abort");
    expect(await j.list()).toEqual([]);
  });

  it("resumes a record in the finalizing state straight at finalize", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    let drop = true;
    s.finalize = ((orig) => async (t: FileTarget, r: FinalizeRequest) => {
      if (drop) {
        drop = false;
        await orig(t, r); // the server finished, the answer was lost
        throw new Error("killed");
      }
      return orig(t, r);
    })(s.finalize);
    await engine(s, j, { maxAttempts: 1 })
      .e.upload(await request(small))
      .catch(() => undefined);
    expect(((await j.get("t1")) as TransferJournalRecord).state).toBe(
      "finalizing",
    );
    s.calls = [];
    const out = await engine(s, j).e.upload(await request(small));
    expect(s.calls).toEqual(["finalize"]);
    expect(out.size).toBe(small.length);
  });
});

describe("parseJournalRecord", () => {
  it("rejects out-of-range done lists and a single record with partBytes", async () => {
    const { parseJournalRecord } = await import("../src/sync/index.js");
    const base = {
      v: 1,
      id: "t",
      kind: "upload",
      collection: "c",
      record: "r",
      uploadId: "u",
      mode: "multipart",
      partBytes: 8 * MIB,
      done: [1, 2],
      sha256: "a".repeat(64),
      size: 40 * MIB,
      expiresAt: 1,
      state: "uploading",
    };
    expect(parseJournalRecord(base).done).toEqual([1, 2]);
    for (const bad of [
      { ...base, done: [2, 1] },
      { ...base, done: [6] },
      { ...base, done: [0] },
      { ...base, mode: "single" },
      { ...base, sha256: "x" },
      { ...base, state: "done" },
    ])
      expect(() => parseJournalRecord(bad)).toThrow();
    expect(() => parseJournalRecord({ ...base, v: 9 })).toThrow(
      expect.objectContaining({ reason: "version" }),
    );
  });
});
