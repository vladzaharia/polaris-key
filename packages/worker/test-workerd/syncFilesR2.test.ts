/// <reference types="@cloudflare/workers-types" />
// ── Cloud Sync's file store on miniflare's R2 (U-10.1) ───────────────────────────────────
//
// The file path (plans/U-10-U-11a-slices.md D-7) streams a body into `put(key, {sha256})`, hashes
// each multipart part with `DigestStream`, and may keep a customer-provided key (`ssecKey`) per
// file (D-8). This lane runs those calls against the real binding, and runs the SSE-C probe the
// staging script runs against a real bucket (`scripts/probe/r2-ssec.mjs`), so the answer to "does
// R2 accept SSE-C" is recorded here and not assumed.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { probeSsec } from "../scripts/probe/r2-ssec-probe.mjs";

const R2_LANE = { timeout: 60_000 };

function bucket(): R2Bucket {
  if (!env.SYNC_FILES)
    throw new Error("SYNC_FILES is not bound in the workerd lane");
  return env.SYNC_FILES;
}

/** A deterministic body of `n` bytes (the contents do not matter to what is probed). */
function bytesOf(n: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
}

async function digestStream(bytes: Uint8Array): Promise<ArrayBuffer> {
  const ds = new crypto.DigestStream("SHA-256");
  const w = ds.getWriter();
  await w.write(bytes);
  await w.close();
  return ds.digest;
}

describe("the SYNC_FILES binding (workerd)", () => {
  it("is bound, and starts empty", R2_LANE, async () => {
    expect((await bucket().list({ prefix: "u/" })).objects).toEqual([]);
  });

  it("verifies a streamed put against the sha256 option", R2_LANE, async () => {
    const body = bytesOf(300_000);
    const sha = await digestStream(body);
    const stream = new FixedLengthStream(body.length);
    const writing = (async () => {
      const w = stream.writable.getWriter();
      await w.write(body);
      await w.close();
    })();
    const obj = await bucket().put("u/t/s/o/stream", stream.readable, {
      sha256: sha,
    });
    await writing;
    expect(obj.size).toBe(body.length);
    // A body that misses the option is refused and stores nothing.
    await expect(
      bucket().put("u/t/s/o/bad", bytesOf(64), { sha256: sha }),
    ).rejects.toThrow();
    expect(await bucket().head("u/t/s/o/bad")).toBeNull();
    await bucket().delete("u/t/s/o/stream");
  });

  it("is create-only with onlyIf etagDoesNotMatch *", R2_LANE, async () => {
    const k = "u/t/s/o/once";
    await bucket().put(k, bytesOf(16));
    const second = await bucket().put(k, bytesOf(16), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    expect(second).toBeNull();
    await bucket().delete(k);
  });

  it(
    "answers the SSE-C probe on put, get, createMultipartUpload and uploadPart",
    R2_LANE,
    async () => {
      const report = await probeSsec(bucket());
      expect(report.checks.map((c) => c.name)).toEqual([
        "put",
        "get",
        "get-without-key-refused",
        "get-wrong-key-refused",
        "get-key-as-hex",
        "createMultipartUpload",
        "uploadPart",
        "complete",
        "multipart-get",
      ]);
      expect(report.supported).toBe(report.checks.every((c) => c.ok));
      // Recorded 2026-10-29 (miniflare in the pinned pool): the binding ACCEPTS `ssecKey` on put,
      // get, `createMultipartUpload`, `uploadPart` and `complete` (those calls and the key-bearing
      // reads pass), but it does not ENFORCE it: the stored object carries no `ssecKeyMd5`, and a
      // read with no key or a wrong one is served. So miniflare proves the calls are shaped right
      // and cannot prove R2 keeps the bytes sealed; the verdict is `fallback` here. The staging
      // script (`scripts/probe/r2-ssec.mjs`) asks the real bucket. If miniflare starts enforcing,
      // this list empties and the verdict flips: update this expectation then.
      expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        "put",
        "get-without-key-refused",
        "get-wrong-key-refused",
        "complete",
        "multipart-get",
      ]);
      expect(report.verdict).toBe("fallback");
      // The probe leaves nothing behind.
      expect((await bucket().list({ prefix: "probe/" })).objects).toEqual([]);
    },
  );
});
