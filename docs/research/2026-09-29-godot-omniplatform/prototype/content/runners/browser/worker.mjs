// Module worker: runs the shared vector suite and browser benchmarks.
import { Store, runAll } from "../js/cases.mjs";
import * as C from "../js/content.mjs";
import * as ZW from "/npm/node_modules/@bokuweb/zstd-wasm/dist/web/index.web.js";
import { sha256 as nobleSha256 } from "/npm/node_modules/@noble/hashes/sha2.js";
import { createSHA256 } from "/npm/node_modules/hash-wasm/dist/index.esm.js";

let zwReady = null,
  hw = null,
  custom = null;
const toHex = (buf) => C.hex(new Uint8Array(buf));
const SHA = {
  webcrypto: async (u8) => toHex(await crypto.subtle.digest("SHA-256", u8)),
  noble: (u8) => C.hex(nobleSha256(u8)),
  hashwasm: (u8) => {
    hw.init();
    hw.update(u8);
    return hw.digest("hex");
  },
};
async function zstdPrim(kind) {
  if (kind === "bokuweb") {
    zwReady ??= ZW.init();
    await zwReady;
    return (u8, { dict } = {}) =>
      dict
        ? ZW.decompressUsingDict(ZW.createDCtx(), u8, dict)
        : ZW.decompress(u8);
  }
  if (kind === "custom") {
    custom ??= await import("./zstddec-prefix.mjs").then((m) =>
      m.load("/runners/browser/zstddec-prefix.wasm"),
    );
    return (u8, { dict, size } = {}) => custom.decompress(u8, dict, size);
  }
  throw new Error(kind);
}
async function prim(shaKind, zKind) {
  if (shaKind === "hashwasm" && !hw) hw = await createSHA256();
  return { sha256: SHA[shaKind], zstd: await zstdPrim(zKind) };
}
const loader = (base) => ({
  raw: async (n) =>
    new Uint8Array(await (await fetch(`${base}/blobs/${n}`)).arrayBuffer()),
  range: async (n, off, len) => {
    const r = await fetch(`${base}/blobs/${n}`, {
      headers: { Range: `bytes=${off}-${off + len - 1}` },
    });
    if (r.status === 416) return new Uint8Array(0);
    if (r.status !== 206) throw new Error("expected 206, got " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  },
});
const mbps = (bytes, ms) => +(bytes / 1e6 / (ms / 1e3)).toFixed(1);
async function timeit(fn, reps = 3) {
  let best = Infinity,
    r;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    r = await fn();
    best = Math.min(best, performance.now() - t);
  }
  return [best, r];
}

async function suite({ set, sha, z, range }) {
  const p = await prim(sha, z);
  const base = `/vectors/${set}`;
  const doc = await (await fetch(`${base}/cases.json`)).json();
  const ld = loader(base);
  if (!range) delete ld.range;
  const store = new Store(ld, p);
  const logs = [];
  const t0 = performance.now();
  const r = await runAll(doc, store, (s) => logs.push(s));
  return {
    n: r.n,
    bad: r.bad,
    ms: +(performance.now() - t0).toFixed(0),
    logs,
    results: r.results,
    timings: r.timings,
  };
}

async function caps() {
  const out = {};
  out.decompressionStream = {};
  for (const f of ["gzip", "deflate", "deflate-raw", "br", "brotli", "zstd"]) {
    try {
      new DecompressionStream(f);
      out.decompressionStream[f] = true;
    } catch {
      out.decompressionStream[f] = false;
    }
  }
  out.compressionStream = {};
  for (const f of ["gzip", "deflate", "deflate-raw", "brotli", "zstd"]) {
    try {
      new CompressionStream(f);
      out.compressionStream[f] = true;
    } catch {
      out.compressionStream[f] = false;
    }
  }
  out.subtleDigest = typeof crypto?.subtle?.digest === "function";
  out.isSecureContext = self.isSecureContext;
  // OPFS + sync access handle (dedicated worker only)
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("bench.bin", { create: true });
    const h = await fh.createSyncAccessHandle();
    const blk = new Uint8Array(1 << 20).fill(7),
      N = 128;
    let t = performance.now();
    h.truncate(0);
    for (let i = 0; i < N; i++) h.write(blk, { at: i << 20 });
    h.flush();
    const wms = performance.now() - t;
    const rb = new Uint8Array(1 << 20);
    t = performance.now();
    for (let i = 0; i < N; i++) h.read(rb, { at: i << 20 });
    const rms = performance.now() - t;
    // random-offset writes, as a chunk applier does
    t = performance.now();
    for (let i = N - 1; i >= 0; i--)
      h.write(blk.subarray(0, 65536), { at: i << 20 });
    h.flush();
    const rwms = performance.now() - t;
    out.opfs = {
      syncAccessHandle: true,
      writeMBps: mbps(N << 20, wms),
      readMBps: mbps(N << 20, rms),
      size: h.getSize(),
      scatteredWrite64KiBx128ms: +rwms.toFixed(1),
    };
    h.close();
    await root.removeEntry("bench.bin");
  } catch (e) {
    out.opfs = { error: String(e) };
  }
  try {
    out.storage = await navigator.storage.estimate();
  } catch (e) {
    out.storage = String(e);
  }
  // Cache API and partial responses
  try {
    const c = await caches.open("t");
    const r = await fetch("/vectors/small/cases.json", {
      headers: { Range: "bytes=0-99" },
    });
    out.rangeStatus = r.status;
    try {
      await c.put("/x", r);
      out.cachePut206 = "accepted";
    } catch (e) {
      out.cachePut206 = "rejected: " + e.name + ": " + e.message;
    }
  } catch (e) {
    out.cache = String(e);
  }
  return out;
}

async function bench({ z }) {
  const res = {};
  const L = "/vectors/large/blobs";
  const get = async (n) =>
    new Uint8Array(await (await fetch(`${L}/${n}`)).arrayBuffer());
  const full1 = await get("payload/v1.full.zst"),
    full2 = await get("payload/v2.full.zst");
  const zp = await zstdPrim(z);
  const [msD, v2] = await timeit(() => zp(full2, { size: 37697544 }));
  res.zstdDecompress = {
    lib: z,
    outBytes: v2.length,
    ms: +msD.toFixed(1),
    MBps: mbps(v2.length, msD),
  };
  const v1 = zp(full1, {});
  // DecompressionStream zstd, if the browser has it
  try {
    const [ms, n] = await timeit(async () => {
      const s = new Blob([full2])
        .stream()
        .pipeThrough(new DecompressionStream("zstd"));
      const b = new Uint8Array(await new Response(s).arrayBuffer());
      return b.length;
    });
    res.decompressionStreamZstd = {
      outBytes: n,
      ms: +ms.toFixed(1),
      MBps: mbps(n, ms),
    };
  } catch (e) {
    res.decompressionStreamZstd = String(e);
  }
  // SHA-256
  hw ??= await createSHA256();
  const [a] = await timeit(() => crypto.subtle.digest("SHA-256", v2));
  res.sha256_webcrypto_oneshot = mbps(v2.length, a);
  const [b] = await timeit(() => {
    const h = nobleSha256.create();
    for (let o = 0; o < v2.length; o += 1 << 20)
      h.update(v2.subarray(o, o + (1 << 20)));
    return h.digest();
  });
  res.sha256_noble_streaming = mbps(v2.length, b);
  const [c] = await timeit(() => {
    hw.init();
    for (let o = 0; o < v2.length; o += 1 << 20)
      hw.update(v2.subarray(o, o + (1 << 20)));
    return hw.digest("hex");
  });
  res.sha256_hashwasm_streaming = mbps(v2.length, c);
  const small = [];
  for (let o = 0; o < v2.length; o += 65536)
    small.push(v2.subarray(o, o + 65536));
  const [d] = await timeit(() =>
    Promise.all(small.map((x) => crypto.subtle.digest("SHA-256", x))),
  );
  res.sha256_webcrypto_64KiB_chunks = mbps(v2.length, d);
  // delta apply (whole payload, 37 MB)
  const delta = await get("deltas/v1-v2.pf.zst");
  const [e, out] = await timeit(() => zp(delta, { dict: v1, size: 37697544 }));
  res.deltaApply = {
    ms: +e.toFixed(1),
    outMBps: mbps(out.length, e),
    ok: SHA.noble(out) === SHA.noble(v2),
  };
  // chunk reassembly, in-memory bundles and via HTTP Range
  const doc = await (await fetch("/vectors/large/cases.json")).json();
  const cc = doc.applyCases.find((x) => x.id === "chunk-v1-to-v2");
  const p = { sha256: SHA.hashwasm, zstd: zp };
  const tix = await get("chunks/v2.pkc"),
    six = await get("chunks/v1.pkc");
  const bundles = {};
  for (const [h, ref] of Object.entries(cc.bundles))
    bundles[h] = await get(ref.blob);
  const [f, rr] = await timeit(() =>
    C.applyChunk(
      p,
      tix,
      [[v1, six]],
      async (h, o, l) => bundles[h].subarray(o, o + l),
      cc.expectedSha256,
      cc.expectedSize,
      false,
    ),
  );
  res.chunkReassembly_memory = {
    ms: +f.toFixed(1),
    outMBps: mbps(37697544, f),
    ...rr[1],
  };
  const ld = loader("/vectors/large");
  const [g, rr2] = await timeit(
    () =>
      C.applyChunk(
        p,
        tix,
        [[v1, six]],
        (h, o, l) => ld.range(cc.bundles[h].blob, o, l),
        cc.expectedSha256,
        cc.expectedSize,
        false,
      ),
    2,
  );
  res.chunkReassembly_httpRange = {
    ms: +g.toFixed(1),
    outMBps: mbps(37697544, g),
    requestsMade: rr2[1].fetchedChunks,
    runs: rr2[1].requests,
  };
  return res;
}

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data;
  try {
    const fn = { suite, caps, bench }[op];
    self.postMessage({ id, ok: true, value: await fn(args || {}) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.stack) || e) });
  }
};
