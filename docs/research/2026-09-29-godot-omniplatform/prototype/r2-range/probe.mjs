#!/usr/bin/env node
// S-02 probe: Range, If-Range, HEAD, compression and cold/warm behaviour of R2-backed byte serving.
//
//   node probe.mjs --path B --size 8MiB --cold            one matrix row set (the brief's Verify line)
//   node probe.mjs --path all --size 1MiB,4MiB --reps 3   every configured path, three repetitions
//   node probe.mjs --etag-formats                         R2's native ETag, single-part vs multipart
//   node probe.mjs --runs runs.json --bundle <file>       the real v1->v2 chunk-run pattern (runs.py)
//
// Paths (base URLs come from the environment; the defaults are a local `wrangler dev` of worker/):
//   A        PROBE_BASE_A   R2 custom domain bound to the bucket (zone cache in front)
//   Aorigin  PROBE_BASE_AO  worker/ `/r/` mode: R2 pass-through, an emulation of path A's origin
//   B        PROBE_BASE_B   worker/ `/b/` mode: README §3.5 headers, one R2 read per request
//   Bc       PROBE_BASE_BC  worker/ `/c/` mode: the same plus caches.default for full 200s
//   Bw       PROBE_BASE_BW  worker/ deployed with wrangler.wcache.jsonc (Workers Caching)
//   C        PROBE_BASE_C   r2.dev (reference only)
// Uploads always go through the probe Worker: PROBE_PUT (its base URL) and PROBE_PUT_TOKEN. Every
// path reads the same bucket, so one upload serves every path. Keys carry the s02/ prefix.
//
// Every "cold" case uploads fresh random bytes under a new key (never purge), so edge state cannot
// leak between trials. Results go to out/<run>.csv and out/<run>.jsonl (git-ignored).
// No account ids or tokens are written anywhere.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.PROBE_LOCAL || "http://127.0.0.1:8787";
const BASES = {
  A: process.env.PROBE_BASE_A,
  Aorigin: process.env.PROBE_BASE_AO || `${LOCAL}/r/`,
  B: process.env.PROBE_BASE_B || `${LOCAL}/b/`,
  Bc: process.env.PROBE_BASE_BC || `${LOCAL}/c/`,
  Bw: process.env.PROBE_BASE_BW,
  C: process.env.PROBE_BASE_C,
};
const PUT = process.env.PROBE_PUT || LOCAL;
const TOKEN = process.env.PROBE_PUT_TOKEN || "local-only-token";

// ---------------------------------------------------------------- args

const args = parseArgs(process.argv.slice(2));
const RUN = args.run || new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const CSV = join(OUT, `${RUN}.csv`);
const JSONL = join(OUT, `${RUN}.jsonl`);
const COLS = [
  "run",
  "vantage",
  "path",
  "size",
  "rep",
  "case",
  "key",
  "method",
  "reqRange",
  "reqIfRange",
  "reqAE",
  "status",
  "contentRange",
  "contentLength",
  "contentType",
  "etag",
  "r2Etag",
  "acceptRanges",
  "contentEncoding",
  "r2Range",
  "cfCacheStatus",
  "age",
  "colo",
  "decision",
  "parts",
  "bytes",
  "ttfbMs",
  "totalMs",
  "mbps",
  "bodyOk",
  "note",
];
writeFileSync(CSV, COLS.join(",") + "\n");
const VANTAGE = args.vantage || "workstation";

const agents = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, "");
    const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
    o[k] = v;
  }
  return o;
}

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)?$/i.exec(String(s));
  if (!m) throw new Error(`bad size ${s}`);
  const mul = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }[
    (m[2] || "B").toLowerCase()
  ];
  return Math.round(Number(m[1]) * mul);
}

// ---------------------------------------------------------------- HTTP

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const t0 = performance.now();
    let ttfb = null;
    const req = lib.request(
      u,
      {
        method,
        headers: { "User-Agent": "pk-s02-probe/1", ...headers },
        agent: agents[u.protocol],
      },
      (res) => {
        const chunks = [];
        let n = 0;
        const tHead = performance.now();
        res.on("data", (c) => {
          if (ttfb === null) ttfb = performance.now() - t0;
          chunks.push(c);
          n += c.length;
        });
        res.on("end", () => {
          const total = performance.now() - t0;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks, n),
            ttfbMs: ttfb ?? tHead - t0,
            totalMs: total,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

// ---------------------------------------------------------------- uploads

function sha256(b) {
  return createHash("sha256").update(b).digest("hex");
}

async function upload(
  bytes,
  { kind = "blobs", multipart = false, partSize = 8 * 1024 * 1024 } = {},
) {
  const hex = sha256(bytes);
  const key = `s02/${kind}/sha256/${hex}`;
  if (!multipart && bytes.length <= 90 * 1024 * 1024) {
    const r = await request(`${PUT}/_probe/put/${key}`, {
      method: "PUT",
      headers: {
        "X-Probe-Token": TOKEN,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    if (r.status !== 201)
      throw new Error(`upload ${r.status} ${r.body.toString().slice(0, 200)}`);
    return { key, hex, bytes, meta: JSON.parse(r.body.toString()) };
  }
  const c = await request(`${PUT}/_probe/mpu/${key}?op=create`, {
    method: "POST",
    headers: { "X-Probe-Token": TOKEN },
  });
  if (c.status !== 200) throw new Error(`mpu create ${c.status} ${c.body}`);
  const { uploadId } = JSON.parse(c.body.toString());
  const parts = [];
  for (let off = 0, n = 1; off < bytes.length; off += partSize, n++) {
    const slice = bytes.subarray(off, Math.min(off + partSize, bytes.length));
    const p = await request(
      `${PUT}/_probe/mpu/${key}?op=part&n=${n}&uploadId=${encodeURIComponent(uploadId)}`,
      {
        method: "POST",
        headers: {
          "X-Probe-Token": TOKEN,
          "Content-Length": String(slice.length),
        },
        body: slice,
      },
    );
    if (p.status !== 200) throw new Error(`mpu part ${p.status} ${p.body}`);
    parts.push(JSON.parse(p.body.toString()));
  }
  const body = Buffer.from(JSON.stringify(parts));
  const f = await request(
    `${PUT}/_probe/mpu/${key}?op=complete&uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "POST",
      headers: {
        "X-Probe-Token": TOKEN,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    },
  );
  if (f.status !== 200) throw new Error(`mpu complete ${f.status} ${f.body}`);
  return {
    key,
    hex,
    bytes,
    meta: JSON.parse(f.body.toString()),
    parts: parts.length,
  };
}

// ---------------------------------------------------------------- checks

function spreadRanges(size, count, len = 1024) {
  // `count` ascending, non-overlapping ranges of `len` bytes spread across the object.
  const step = Math.floor(size / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = i * step;
    out.push([s, Math.min(s + len, s + step, size) - 1]);
  }
  return out;
}

function rangeHeader(ranges) {
  return "bytes=" + ranges.map(([s, e]) => `${s}-${e}`).join(",");
}

function parseMultipart(res) {
  const ct = String(res.headers["content-type"] || "");
  const m = /boundary=("?)([^";]+)\1/i.exec(ct);
  if (!/multipart\/byteranges/i.test(ct) || !m) return null;
  const b = Buffer.from(`--${m[2]}`);
  const parts = [];
  let i = res.body.indexOf(b);
  while (i >= 0) {
    const next = res.body.indexOf(b, i + b.length);
    if (next < 0) break;
    const seg = res.body.subarray(i + b.length, next);
    const hdrEnd = seg.indexOf("\r\n\r\n");
    if (hdrEnd >= 0) {
      const hdr = seg.subarray(0, hdrEnd).toString();
      const cr = /content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(hdr);
      const data = seg.subarray(hdrEnd + 4, seg.length - 2); // strip trailing CRLF
      if (cr) parts.push({ start: Number(cr[1]), end: Number(cr[2]), data });
    }
    i = next;
  }
  return parts;
}

function verify(res, obj, reqRanges) {
  if (res.status === 200)
    return res.body.length === 0 || res.body.equals(obj.bytes)
      ? "full-ok"
      : "full-BAD";
  if (res.status === 206) {
    const mp = parseMultipart(res);
    if (mp) {
      const ok = mp.every((p) =>
        p.data.equals(obj.bytes.subarray(p.start, p.end + 1)),
      );
      return `${ok ? "mp-ok" : "mp-BAD"}:${mp.length}`;
    }
    const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(
      String(res.headers["content-range"] || ""),
    );
    if (!cr) return "206-no-content-range";
    if (res.body.length === 0) return "head";
    return res.body.equals(obj.bytes.subarray(Number(cr[1]), Number(cr[2]) + 1))
      ? "range-ok"
      : "range-BAD";
  }
  return String(res.status);
}

function httpDate(offsetMs) {
  return new Date(Date.now() + offsetMs).toUTCString();
}

let rowsWritten = 0;
function record(row) {
  rowsWritten++;
  appendFileSync(JSONL, JSON.stringify(row) + "\n");
  const csv = COLS.map((c) => {
    const v = row[c] === undefined || row[c] === null ? "" : String(row[c]);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  });
  appendFileSync(CSV, csv.join(",") + "\n");
}

async function probe(
  ctx,
  name,
  { method = "GET", headers = {}, ranges = null, note = "" } = {},
) {
  const url = ctx.base + ctx.obj.key;
  const h = { "Accept-Encoding": "identity", ...headers };
  if (ranges && !h.Range) h.Range = rangeHeader(ranges);
  const res = await request(url, { method, headers: h });
  const H = res.headers;
  const bytes = res.body.length;
  const row = {
    run: RUN,
    vantage: VANTAGE,
    path: ctx.path,
    size: ctx.obj.bytes.length,
    rep: ctx.rep,
    case: name,
    key: ctx.obj.key,
    method,
    reqRange: h.Range
      ? h.Range.length > 60
        ? `${h.Range.slice(0, 40)}…(${h.Range.split(",").length})`
        : h.Range
      : "",
    reqIfRange: h["If-Range"] || h["If-None-Match"] || "",
    reqAE: h["Accept-Encoding"],
    status: res.status,
    contentRange: H["content-range"],
    contentLength: H["content-length"],
    contentType: String(H["content-type"] || "").slice(0, 60),
    etag: H.etag,
    r2Etag: H["x-r2-etag"],
    acceptRanges: H["accept-ranges"],
    contentEncoding: H["content-encoding"],
    r2Range: H["x-probe-r2-range"],
    cfCacheStatus: H["cf-cache-status"] || H["x-probe-cache"],
    age: H.age,
    colo: String(H["cf-ray"] || "").split("-")[1] || "",
    decision: H["x-probe-decision"],
    parts: (parseMultipart(res) || []).length || "",
    bytes,
    ttfbMs: res.ttfbMs.toFixed(1),
    totalMs: res.totalMs.toFixed(1),
    mbps:
      bytes > 65536
        ? ((bytes * 8) / 1e6 / (res.totalMs / 1000)).toFixed(0)
        : "",
    bodyOk: method === "HEAD" ? "head" : verify(res, ctx.obj, ranges),
    note,
  };
  record(row);
  if (!args.quiet) {
    console.log(
      `${ctx.path.padEnd(7)} ${String(ctx.obj.bytes.length).padStart(10)} ${name.padEnd(22)} ${String(res.status).padEnd(3)} ` +
        `${String(row.contentRange || "").padEnd(28)} bytes=${String(bytes).padStart(9)} ttfb=${row.ttfbMs.padStart(7)} ` +
        `cache=${row.cfCacheStatus || "-"} ${row.decision || ""} ${row.bodyOk}`,
    );
  }
  return res;
}

// ---------------------------------------------------------------- matrix

async function matrix(path, size, rep, { cold = true, obj: given } = {}) {
  const base = BASES[path];
  if (!base) {
    console.error(
      `skip path ${path}: no base URL (set PROBE_BASE_${path.toUpperCase()})`,
    );
    return;
  }
  const obj = given || (await upload(randomBytes(size)));
  const ctx = { path, base, obj, rep };
  const MiB = 1024 * 1024;
  const one = [[0, Math.min(MiB, size) - 1]];
  const mid = Math.floor(size / 2);

  // Cold: the very first request for this key is a single Range.
  await probe(ctx, "single-cold", {
    ranges: one,
    note: cold ? "first request for a fresh key" : "",
  });
  await probe(ctx, "single-warm", { ranges: one });
  await probe(ctx, "single-warm-mid", {
    ranges: [[mid, Math.min(mid + MiB, size) - 1]],
  });
  await probe(ctx, "suffix", { headers: { Range: "bytes=-65536" } });
  await probe(ctx, "open-end", { headers: { Range: `bytes=${size - 100}-` } });
  await probe(ctx, "past-end", { headers: { Range: `bytes=${size}-` } });
  await probe(ctx, "end-beyond-size", {
    headers: { Range: `bytes=${size - 10}-${size + 1000}` },
  });
  await probe(ctx, "zero-suffix", { headers: { Range: "bytes=-0" } });
  await probe(ctx, "inverted", { headers: { Range: "bytes=500-100" } });
  await probe(ctx, "unit-items", { headers: { Range: "items=0-9" } });
  await probe(ctx, "head", { method: "HEAD" });
  await probe(ctx, "head-range", { method: "HEAD", ranges: [[0, 99]] });

  for (const n of [2, 10, 300, 301])
    await probe(ctx, `multi-${n}`, { ranges: spreadRanges(size, n) });
  await probe(ctx, "multi-overlap", {
    headers: { Range: "bytes=0-999,500-1499" },
  });
  await probe(ctx, "multi-descending", {
    headers: { Range: "bytes=5000-5999,0-999" },
  });

  // If-Range: the design's validator (the SHA-256), R2's own ETag, a stale one, weak, and a date.
  const head = await request(base + obj.key, {
    method: "HEAD",
    headers: { "Accept-Encoding": "identity" },
  });
  const servedEtag = head.headers.etag;
  const r2Etag = obj.meta.httpEtag;
  const shaEtag = `"${obj.hex}"`;
  await probe(ctx, "ifrange-served-etag", {
    ranges: one,
    headers: { "If-Range": servedEtag || shaEtag },
  });
  if (servedEtag !== shaEtag)
    await probe(ctx, "ifrange-sha", {
      ranges: one,
      headers: { "If-Range": shaEtag },
    });
  if (servedEtag !== r2Etag)
    await probe(ctx, "ifrange-r2etag", {
      ranges: one,
      headers: { "If-Range": r2Etag },
    });
  await probe(ctx, "ifrange-stale", {
    ranges: one,
    headers: { "If-Range": `"${sha256(Buffer.from("other"))}"` },
  });
  await probe(ctx, "ifrange-weak", {
    ranges: one,
    headers: { "If-Range": `W/${servedEtag || shaEtag}` },
  });
  await probe(ctx, "ifrange-date-future", {
    ranges: one,
    headers: { "If-Range": httpDate(86400e3) },
  });
  await probe(ctx, "inm-match", {
    headers: { "If-None-Match": servedEtag || shaEtag },
  });

  // Compression requested: does Range survive, and does the ETag stay strong?
  for (const ae of ["gzip", "br", "zstd", "gzip, deflate, br, zstd"]) {
    await probe(
      ctx,
      `ae-range-${ae.split(",")[0]}${ae.includes(",") ? "-all" : ""}`,
      { ranges: one, headers: { "Accept-Encoding": ae } },
    );
  }
  await probe(ctx, "ae-full-gzip", {
    headers: { "Accept-Encoding": "gzip, br" },
  });

  // Full body, for TTFB and throughput by size (warm after the first full read above).
  await probe(ctx, "full", {});
  await probe(ctx, "full-again", {});
  return obj;
}

async function coldFull(path, size, rep) {
  const base = BASES[path];
  if (!base) return;
  const obj = await upload(randomBytes(size));
  const ctx = { path, base, obj, rep };
  await probe(ctx, "full-cold", { note: "first request for a fresh key" });
  await probe(ctx, "full-warm", {});
}

async function etagFormats() {
  const MiB = 1024 * 1024;
  const single = await upload(randomBytes(12 * MiB));
  const multi = await upload(randomBytes(12 * MiB), {
    multipart: true,
    partSize: 5 * MiB,
  });
  for (const [label, o] of [
    ["single-put", single],
    ["multipart-3", multi],
  ]) {
    const md5 = createHash("md5").update(o.bytes).digest("hex");
    // S3-style multipart ETag: md5 of the concatenated binary part md5s, "-", part count.
    const partMd5s = [];
    for (let off = 0; off < o.bytes.length; off += 5 * MiB) {
      partMd5s.push(
        createHash("md5")
          .update(o.bytes.subarray(off, off + 5 * MiB))
          .digest(),
      );
    }
    const mpEtag = `${createHash("md5").update(Buffer.concat(partMd5s)).digest("hex")}-${partMd5s.length}`;
    const res = await request((BASES.Aorigin || BASES.B) + o.key, {
      method: "HEAD",
    });
    const row = {
      run: RUN,
      vantage: VANTAGE,
      path: "Aorigin",
      size: o.bytes.length,
      rep: 0,
      case: `etag-${label}`,
      method: "HEAD",
      status: res.status,
      etag: res.headers.etag,
      r2Etag: o.meta.httpEtag,
      note: `md5(body)=${md5} sha256=${o.hex} etagIsMd5=${o.meta.etag === md5} etagIsS3Multipart=${o.meta.etag === mpEtag}`,
    };
    record(row);
    console.log(
      `${label}: R2 etag ${o.meta.etag} httpEtag ${o.meta.httpEtag} md5(body) ${md5} s3-multipart ${mpEtag} served ${res.headers.etag}`,
    );
  }
}

async function runsPattern(file, bundleFile) {
  // Fetch the real v1->v2 missing chunk runs of one bundle: as N single-range requests (serial and
  // 6-way parallel) and as one multi-range request.
  const plan = JSON.parse(readFileSync(file, "utf8"));
  const bytes = readFileSync(bundleFile);
  const hex = sha256(bytes);
  const entry = plan.bundles.find((b) => b.sha256 === hex);
  if (!entry) throw new Error(`bundle ${hex} not in ${file}`);
  const obj = await upload(bytes, { kind: "bundles" });
  for (const path of pathsFrom(args.path || "B")) {
    const base = BASES[path];
    if (!base) continue;
    const ctx = { path, base, obj, rep: 0 };
    const t0 = performance.now();
    for (const r of entry.runs) await probe(ctx, "run-serial", { ranges: [r] });
    const serial = performance.now() - t0;
    const t1 = performance.now();
    const q = [...entry.runs];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (q.length)
          await probe(ctx, "run-parallel6", { ranges: [q.shift()] });
      }),
    );
    const par = performance.now() - t1;
    await probe(ctx, "run-multirange", { ranges: entry.runs });
    await probe(ctx, "run-full-bundle", {});
    console.log(
      `${path}: ${entry.runs.length} runs, serial ${serial.toFixed(0)} ms, 6-parallel ${par.toFixed(0)} ms`,
    );
  }
}

function pathsFrom(s) {
  if (s === "all") return Object.keys(BASES).filter((k) => BASES[k]);
  return String(s).split(",");
}

// ---------------------------------------------------------------- main

const info = await request(`${PUT}/_probe/info`).catch((e) => ({
  status: 0,
  body: Buffer.from(String(e)),
}));
console.log(
  `probe run ${RUN} vantage ${VANTAGE}; worker info ${info.status} ${info.body.toString()}`,
);

if (args["etag-formats"]) {
  await etagFormats();
} else if (args.runs) {
  await runsPattern(args.runs, args.bundle);
} else {
  const sizes = String(args.size || "8MiB")
    .split(",")
    .map(parseSize);
  const reps = Number(args.reps || 1);
  for (let rep = 1; rep <= reps; rep++) {
    for (const size of sizes) {
      for (const path of pathsFrom(args.path || "B")) {
        if (args["full-only"]) await coldFull(path, size, rep);
        else
          await matrix(path, size, rep, {
            cold: args.cold !== undefined || true,
          });
      }
    }
  }
}
console.log(`${rowsWritten} rows -> ${CSV}`);
for (const a of Object.values(agents)) a.destroy();
