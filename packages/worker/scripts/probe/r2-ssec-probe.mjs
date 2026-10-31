// The R2 SSE-C probe (U-10.1; plans/U-10-U-11a-slices.md §2.8, D-8; U-44 F4).
//
// Cloud Sync keeps a server-mode file under a customer-provided key (`ssecKey`), one random key
// per person, kept in the person's object (`ssec_keys`) and shredded with the person's data.
// Whether R2 accepts and enforces `ssecKey` on every call the file path makes is a fact about R2,
// not something the code can assume, so this module asks it, call by call: the key as the 64
// character hex string the code sends on every keyed call (with one raw-buffer cross-check), the
// metadata and checksum read of `head`, whole and ranged `get`, the create-only `put`, multipart
// through resumed handles, `list`, and the `delete` and `abort` that run after the key is shredded
// (they send no key). It runs against any object shaped like an `R2Bucket`: miniflare's in the
// workerd lane (`test-workerd/syncFilesR2.test.ts`) and a real bucket through
// `scripts/probe/r2-ssec.mjs`.
//
// The verdict is binary:
//   `supported`    every check passed: `launch.syncFiles` may be turned on;
//   `unsupported`  any check failed: `launch.syncFiles` stays off. There is no unsealed path for a
//                  server-mode file; any other storage path is its own work package and review.
//
// A check passes only when the key does real work, so a bucket that accepts the option and
// ignores it fails: an object stored under a key must refuse a read with no key or a wrong one.
//
// Everything the probe writes sits under a throwaway prefix and is removed afterwards. The keys
// are random per run and are never put in a report: an error message is scrubbed of them.

const PROBE_PREFIX = "probe/ssec/";
const SSEC_KEY_BYTES = 32;

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {number} n */
function random(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * SHA-256 of a byte stream with workerd's native `DigestStream`, as the part path hashes (Node
 * has none; `subtle.digest` gives the same bytes there).
 * @param {Uint8Array} bytes
 */
async function digestStreamSha256(bytes) {
  if (typeof crypto.DigestStream === "undefined")
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const ds = new crypto.DigestStream("SHA-256");
  const w = ds.getWriter();
  await w.write(bytes);
  await w.close();
  return new Uint8Array(await ds.digest);
}

/**
 * A body of known length, as the Worker streams a request into R2: workerd's `FixedLengthStream`
 * (R2 refuses a stream of unknown length). Outside workerd (the staging script runs in Node) the
 * bytes themselves go up, which exercises the same option handling on R2's side.
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array> | Uint8Array}
 */
function bodyOf(bytes) {
  if (typeof FixedLengthStream === "undefined") return bytes;
  const fixed = new FixedLengthStream(bytes.length);
  const w = fixed.writable.getWriter();
  void w.write(bytes).then(() => w.close());
  return fixed.readable;
}

/**
 * The first line of an error, with every key spelling removed.
 * @param {unknown} err @param {string[]} secrets
 */
function describe(err, secrets) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const s of secrets) msg = msg.split(s).join("[key]");
  return msg.split("\n")[0].slice(0, 160);
}

/** True when the call throws (a refusal is the expected answer for a missing or wrong key). */
/** @param {() => Promise<unknown>} f */
async function refuses(f) {
  try {
    const r = await f();
    // A conditional miss answers null: not a refusal, and not bytes either.
    return r === null ? "missing" : "served";
  } catch {
    return "refused";
  }
}

/**
 * @typedef {{ name: string; ok: boolean; detail?: string }} ProbeCheck
 * @typedef {{ verdict: "supported" | "unsupported"; supported: boolean; checks: ProbeCheck[] }} SsecReport
 */

/**
 * Ask a bucket whether SSE-C works on every call the file path makes.
 * @param {R2Bucket} bucket
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<SsecReport>}
 */
export async function probeSsec(bucket, options = {}) {
  const prefix = `${options.prefix ?? PROBE_PREFIX}${hex(random(8))}/`;
  const keyBytes = random(SSEC_KEY_BYTES);
  const otherBytes = random(SSEC_KEY_BYTES);
  const keyHex = hex(keyBytes);
  const otherHex = hex(otherBytes);
  const secrets = [keyHex, otherHex];
  const keyBuffer = keyBytes.buffer.slice(0);
  /** @type {ProbeCheck[]} */
  const checks = [];
  /** @type {string[]} */
  const written = [];
  /** @type {R2MultipartUpload | undefined} */
  let open;

  /** @param {string} name @param {() => Promise<string | undefined | void>} f */
  const check = async (name, f) => {
    try {
      const detail = await f();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (err) {
      checks.push({ name, ok: false, detail: describe(err, secrets) });
    }
  };
  /** @param {boolean} cond @param {string} why */
  const must = (cond, why) => {
    if (!cond) throw new Error(why);
  };
  /** @param {R2ObjectBody | null} got @param {Uint8Array} want @param {string} what */
  const mustRead = async (got, want, what) => {
    must(got !== null, `${what} found nothing`);
    must(
      same(new Uint8Array(await got.arrayBuffer()), want),
      `${what} returned other bytes`,
    );
  };

  const body = random(2048);
  const bodyHash = await digestStreamSha256(body);
  const single = `${prefix}single`;
  written.push(single);

  // 1. put: a streamed body with the `sha256` option, the hex key and the create-only condition
  //    (D-7: the Worker streams the bytes, R2 verifies the digest).
  await check("put", async () => {
    const obj = await bucket.put(single, bodyOf(body), {
      sha256: bodyHash,
      ssecKey: keyHex,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    must(obj !== null, "put answered null");
    must(obj.size === body.length, "put stored the wrong size");
    must(
      typeof obj.ssecKeyMd5 === "string" && obj.ssecKeyMd5.length > 0,
      "the stored object carries no ssecKeyMd5, so the key was ignored",
    );
  });
  // The resend of a landed PUT: the same create-only put answers null, it does not throw.
  await check("put-create-only", async () => {
    const again = await bucket.put(single, bodyOf(body), {
      sha256: bodyHash,
      ssecKey: keyHex,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    must(again === null, "a second create-only put was not refused with null");
  });
  // 2. head: no key, and the stored checksum finalize and the resend read.
  await check("head", async () => {
    const h = await bucket.head(single);
    must(h !== null, "head found nothing");
    must(h.size === body.length, "head answered the wrong size");
  });
  await check("head-checksum", async () => {
    const h = await bucket.head(single);
    must(h !== null, "head found nothing");
    const sum = h.checksums?.sha256;
    must(sum !== undefined, "head carries no stored sha256");
    must(
      same(new Uint8Array(sum), bodyHash),
      "head's stored sha256 is not the body's",
    );
  });

  // 3. get: whole and ranged, the hex key, and the key does real work.
  await check("get", async () => {
    await mustRead(await bucket.get(single, { ssecKey: keyHex }), body, "get");
  });
  await check("get-key-as-buffer", async () => {
    await mustRead(
      await bucket.get(single, { ssecKey: keyBuffer }),
      body,
      "get with the raw key",
    );
  });
  await check("get-without-key-refused", async () => {
    const r = await refuses(() => bucket.get(single));
    must(r === "refused", `get with no key was ${r}`);
  });
  await check("get-wrong-key-refused", async () => {
    const r = await refuses(() => bucket.get(single, { ssecKey: otherHex }));
    must(r === "refused", `get with a wrong key was ${r}`);
  });
  await check("ranged-get", async () => {
    await mustRead(
      await bucket.get(single, {
        ssecKey: keyHex,
        range: { offset: 100, length: 50 },
      }),
      body.subarray(100, 150),
      "ranged get",
    );
    await mustRead(
      await bucket.get(single, {
        ssecKey: keyHex,
        range: { offset: body.length - 50, length: 50 },
      }),
      body.subarray(body.length - 50),
      "ranged get to the last byte",
    );
  });
  await check("ranged-get-without-key-refused", async () => {
    const r = await refuses(() =>
      bucket.get(single, { range: { offset: 100, length: 50 } }),
    );
    must(r === "refused", `ranged get with no key was ${r}`);
  });

  // 4. multipart, through resumed handles as the Worker uses them. One part, so the 5 MiB
  //    minimum of a non-final part does not apply; the part is hashed with `DigestStream`.
  const multi = `${prefix}multi`;
  written.push(multi);
  const part = random(4096);
  /** @type {string | undefined} */
  let uploadId;
  await check("createMultipartUpload", async () => {
    open = await bucket.createMultipartUpload(multi, { ssecKey: keyHex });
    uploadId = open.uploadId;
    must(open.uploadId.length > 0, "no upload id");
  });
  /** @type {R2UploadedPart | undefined} */
  let uploaded;
  await check("uploadPart", async () => {
    must(uploadId !== undefined, "no multipart upload to add a part to");
    const hash = await digestStreamSha256(part);
    must(hash.length === 32, "DigestStream returned a short digest");
    const handle = bucket.resumeMultipartUpload(multi, uploadId);
    uploaded = await handle.uploadPart(1, bodyOf(part), { ssecKey: keyHex });
    must(uploaded.partNumber === 1, "uploadPart answered another part number");
  });
  await check("complete", async () => {
    must(uploadId !== undefined && uploaded !== undefined, "no uploaded part");
    const obj = await bucket
      .resumeMultipartUpload(multi, uploadId)
      .complete([uploaded]);
    open = undefined;
    must(obj.size === part.length, "complete stored the wrong size");
    must(
      typeof obj.ssecKeyMd5 === "string" && obj.ssecKeyMd5.length > 0,
      "the completed object carries no ssecKeyMd5",
    );
  });
  await check("multipart-head", async () => {
    const h = await bucket.head(multi);
    must(h !== null, "head of the multipart object found nothing");
    must(h.size === part.length, "head answered the wrong size");
    return h.checksums?.sha256 ? undefined : "no stored sha256 (recorded)";
  });
  await check("multipart-get", async () => {
    await mustRead(
      await bucket.get(multi, { ssecKey: keyHex }),
      part,
      "get of the multipart object",
    );
    const r = await refuses(() => bucket.get(multi));
    must(r === "refused", `get of the multipart object with no key was ${r}`);
  });

  // 5. abort with no key, as the erasure does after the key is shredded.
  const aborted = `${prefix}aborted`;
  /** @type {string | undefined} */
  let abortId;
  await check("abort", async () => {
    const up = await bucket.createMultipartUpload(aborted, { ssecKey: keyHex });
    abortId = up.uploadId;
    await bucket
      .resumeMultipartUpload(aborted, abortId)
      .uploadPart(1, bodyOf(part), { ssecKey: keyHex });
    await bucket.resumeMultipartUpload(aborted, abortId).abort();
    const left = await bucket.list({ prefix: aborted });
    must(
      left.objects.length === 0,
      "an aborted upload left an object in the listing",
    );
  });
  // R2's answer to a second abort, recorded for a later change (not a verdict input).
  await check("abort-again", async () => {
    if (abortId === undefined) return "no upload to abort again";
    try {
      await bucket.resumeMultipartUpload(aborted, abortId).abort();
      return "second abort resolved";
    } catch (err) {
      return `second abort threw: ${describe(err, secrets)}`;
    }
  });

  // 6. list and delete with no key, as the erasure does.
  await check("list", async () => {
    const listed = await bucket.list({ prefix });
    const names = listed.objects.map((o) => o.key);
    must(
      names.includes(single) && names.includes(multi),
      "list did not return the stored objects",
    );
  });
  await check("delete", async () => {
    await bucket.delete([single, multi]);
    must((await bucket.head(single)) === null, "delete left the single object");
    must(
      (await bucket.head(multi)) === null,
      "delete left the multipart object",
    );
  });

  // Clean up. Failures here are not a verdict, and the probe prefix is throwaway.
  try {
    if (open) await open.abort();
  } catch {
    /* already gone */
  }
  try {
    await bucket.delete(written);
  } catch {
    /* the bucket may refuse a delete of an object it could not read */
  }

  const supported = checks.every((c) => c.ok);
  return {
    verdict: supported ? "supported" : "unsupported",
    supported,
    checks,
  };
}
