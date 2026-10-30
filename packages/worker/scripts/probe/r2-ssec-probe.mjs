// The R2 SSE-C probe (U-10.1; plans/U-10-U-11a-slices.md §2.8, D-8).
//
// Cloud Sync wants to keep a server-mode file under a customer-provided key (`ssecKey`), kept in
// the DO's `ssec_keys` table and shredded with the person's data. Whether R2 accepts `ssecKey`
// on every call the file path makes is a fact about R2, not something the code can assume, so
// this module asks it. It runs against any object shaped like an `R2Bucket`: miniflare's in the
// workerd lane (`test-workerd/syncFilesR2.test.ts`) and a real bucket through
// `scripts/probe/r2-ssec.mjs`.
//
// The verdict is binary and drives D-8:
//   `supported`  every check passed: the DO stores an SSE-C key per file (`ssec_keys`);
//   `fallback`   any check failed: server-mode files are sealed as `pkey-sync-file/1` under the
//                same per-principal key instead (plan §1.8). Neither path changes the wire.
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
 * @typedef {{ verdict: "supported" | "fallback"; supported: boolean; checks: ProbeCheck[] }} SsecReport
 */

/**
 * Ask a bucket whether SSE-C works on put, get, `createMultipartUpload` and `uploadPart`.
 * @param {R2Bucket} bucket
 * @param {{ prefix?: string }} [options]
 * @returns {Promise<SsecReport>}
 */
export async function probeSsec(bucket, options = {}) {
  const prefix = `${options.prefix ?? PROBE_PREFIX}${hex(random(8))}/`;
  const keyBytes = random(SSEC_KEY_BYTES);
  const otherBytes = random(SSEC_KEY_BYTES);
  const keyHex = hex(keyBytes);
  const secrets = [keyHex, hex(otherBytes)];
  const key = keyBytes.buffer.slice(0);
  const other = otherBytes.buffer.slice(0);
  /** @type {ProbeCheck[]} */
  const checks = [];
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

  const body = random(2048);
  const bodyHash = await digestStreamSha256(body);

  // 1. put: a streamed body with the `sha256` option and a key (D-7: the Worker streams the
  //    bytes, R2 verifies the digest).
  const single = `${prefix}single`;
  written.push(single);
  await check("put", async () => {
    const obj = await bucket.put(single, bodyOf(body), {
      sha256: bodyHash,
      ssecKey: key,
    });
    must(obj !== null, "put answered null");
    must(obj.size === body.length, "put stored the wrong size");
    must(
      typeof obj.ssecKeyMd5 === "string" && obj.ssecKeyMd5.length > 0,
      "the stored object carries no ssecKeyMd5, so the key was ignored",
    );
  });

  // 2. get: the right key returns the bytes, and the key does real work.
  await check("get", async () => {
    const got = await bucket.get(single, { ssecKey: key });
    must(got !== null, "get with the key found nothing");
    must(
      same(new Uint8Array(await got.arrayBuffer()), body),
      "get with the key returned other bytes",
    );
  });
  await check("get-without-key-refused", async () => {
    const r = await refuses(() => bucket.get(single));
    must(r === "refused", `get with no key was ${r}`);
  });
  await check("get-wrong-key-refused", async () => {
    const r = await refuses(() => bucket.get(single, { ssecKey: other }));
    must(r === "refused", `get with a wrong key was ${r}`);
  });
  await check("get-key-as-hex", async () => {
    const got = await bucket.get(single, { ssecKey: keyHex });
    must(got !== null, "get with the hex key found nothing");
    must(
      same(new Uint8Array(await got.arrayBuffer()), body),
      "get with the hex key returned other bytes",
    );
  });

  // 3. multipart: `createMultipartUpload` and `uploadPart` take the key, `complete` yields an
  //    object only that key opens. One part, so the 5 MiB minimum of a non-final part does not
  //    apply; the part is hashed with `DigestStream` as the Worker does.
  const multi = `${prefix}multi`;
  written.push(multi);
  const part = random(4096);
  await check("createMultipartUpload", async () => {
    open = await bucket.createMultipartUpload(multi, { ssecKey: key });
    must(open.uploadId.length > 0, "no upload id");
  });
  /** @type {R2UploadedPart | undefined} */
  let uploaded;
  await check("uploadPart", async () => {
    must(open !== undefined, "no multipart upload to add a part to");
    const hash = await digestStreamSha256(part);
    must(hash.length === 32, "DigestStream returned a short digest");
    uploaded = await open.uploadPart(1, bodyOf(part), { ssecKey: key });
    must(uploaded.partNumber === 1, "uploadPart answered another part number");
  });
  await check("complete", async () => {
    must(open !== undefined && uploaded !== undefined, "no uploaded part");
    const obj = await open.complete([uploaded]);
    open = undefined;
    must(obj.size === part.length, "complete stored the wrong size");
    must(
      typeof obj.ssecKeyMd5 === "string" && obj.ssecKeyMd5.length > 0,
      "the completed object carries no ssecKeyMd5",
    );
  });
  await check("multipart-get", async () => {
    const got = await bucket.get(multi, { ssecKey: key });
    must(got !== null, "get of the multipart object found nothing");
    must(
      same(new Uint8Array(await got.arrayBuffer()), part),
      "get of the multipart object returned other bytes",
    );
    const r = await refuses(() => bucket.get(multi));
    must(r === "refused", `get of the multipart object with no key was ${r}`);
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
  return { verdict: supported ? "supported" : "fallback", supported, checks };
}
