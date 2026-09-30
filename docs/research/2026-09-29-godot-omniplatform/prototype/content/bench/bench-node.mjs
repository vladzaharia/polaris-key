import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import * as C from "../runners/js/content.mjs";
// Run from content/. VECTORS_DIR (default vectors) holds the large set; PACKS_DIR (default ../patching/out) the 160 MB pair.
const VL = (process.env.VECTORS_DIR || "vectors") + "/large/";
const L = VL + "blobs/",
  doc = JSON.parse(readFileSync(VL + "cases.json"));
const rd = (n) => new Uint8Array(readFileSync(L + n));
const sha = (u8) => createHash("sha256").update(u8).digest("hex");
const P = { windowLogMax: zlib.constants.ZSTD_d_windowLogMax };
const zstd = (u8, { dict } = {}) =>
  new Uint8Array(
    zlib.zstdDecompressSync(
      u8,
      dict
        ? { dictionary: dict, params: { [P.windowLogMax]: 31 } }
        : { params: { [P.windowLogMax]: 31 } },
    ),
  );
const prim = { sha256: sha, zstd };
const best = async (fn, n = 3) => {
  let b = Infinity,
    r;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    r = await fn();
    b = Math.min(b, performance.now() - t);
  }
  return [b, r];
};
const mb = (bytes, ms) => (bytes / 1e6 / (ms / 1e3)).toFixed(0) + " MB/s";
const res = {};
const full2 = rd("payload/v2.full.zst"),
  v1 = zstd(rd("payload/v1.full.zst"));
let [ms, v2] = await best(() => zstd(full2));
res.zstd_decompress = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)}`;
[ms] = await best(() => {
  const h = createHash("sha256");
  for (let o = 0; o < v2.length; o += 1 << 20)
    h.update(v2.subarray(o, o + (1 << 20)));
  return h.digest("hex");
});
res.sha256_stream = mb(v2.length, ms);
const cd = doc.applyCases.find((c) => c.id === "delta-whole-v1-to-v2").delta,
  art = rd(cd.artifact.blob);
[ms] = await best(() => zstd(art, { dict: v1 }));
res.delta_decode_only = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)}`;
[ms] = await best(() => C.applyDelta(prim, v1, cd, art));
res.delta_apply_verified = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)} (artifact+base+output SHA-256)`;
const cc = doc.applyCases.find((c) => c.id === "chunk-v1-to-v2"),
  six = rd("chunks/v1.pkc"),
  tix = rd("chunks/v2.pkc");
const bundles = Object.fromEntries(
  Object.entries(cc.bundles).map(([h, r]) => [h, rd(r.blob)]),
);
[ms] = await best(() =>
  C.applyChunk(
    prim,
    tix,
    [[v1, six]],
    async (h, o, l) => bundles[h].subarray(o, o + l),
    cc.expectedSha256,
    cc.expectedSize,
    false,
  ),
);
res.chunk_reassembly = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)} (81 fetched chunks, 1450 seeded, final SHA-256)`;
const fc = doc.applyCases.find((c) => c.id === "file-delta-v1-to-v2");
const dec = new TextDecoder(),
  i1 = JSON.parse(dec.decode(rd("files/v1.files.json"))),
  i2 = JSON.parse(dec.decode(rd("files/v2.files.json"))),
  gaps = zstd(rd("files/v2.gaps.zst"));
[ms] = await best(() =>
  C.applyFiles(
    prim,
    v1,
    i1,
    i2,
    gaps,
    "container",
    fc.fileDeltas,
    async (d) => rd(d.artifact.blob),
    fc.fileBlobs,
    async (h) => rd(fc.fileBlobs[h].blob),
    fc.expectedSha256,
    fc.expectedSize,
  ),
);
res.file_delta_rebuild = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)} (24 per-file deltas, 10 blobs, final SHA-256)`;
[ms] = await best(() => C.parseChunkIndex(tix), 20);
res.parse_chunk_index_1531 = `${ms.toFixed(2)} ms`;
// 160 MB whole-file delta with a 153 MiB window (needs windowLogMax > 27)
const B = (process.env.PACKS_DIR || "../patching/out") + "/",
  bo = new Uint8Array(readFileSync(B + "big_old.bin")),
  bd = new Uint8Array(readFileSync(B + "big.pf.zst"));
try {
  zlib.zstdDecompressSync(bd, { dictionary: bo });
  res.big_default_window = "decoded";
} catch (e) {
  res.big_default_window = "FAILS: " + e.code;
}
[ms, v2] = await best(() => zstd(bd, { dict: bo }), 2);
res.big_delta_decode = `${ms.toFixed(0)} ms, ${mb(v2.length, ms)}, sha ${sha(v2).slice(0, 12)}`;
const t = performance.now();
let n = 0;
await new Promise((ok, bad) => {
  const s = zlib.createZstdDecompress({
    dictionary: bo,
    params: { [P.windowLogMax]: 31 },
  });
  s.on("data", (c) => (n += c.length));
  s.on("end", ok);
  s.on("error", bad);
  s.end(bd);
});
res.big_delta_streaming = `${(performance.now() - t).toFixed(0)} ms, ${n} B out (createZstdDecompress + dictionary)`;
console.log(
  JSON.stringify(
    {
      node: process.version,
      zstd: process.versions.zstd,
      openssl: process.versions.openssl,
      ...res,
    },
    null,
    1,
  ),
);
