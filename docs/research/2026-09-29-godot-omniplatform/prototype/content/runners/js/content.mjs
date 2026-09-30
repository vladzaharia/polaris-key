// Isomorphic content-delivery core (pkey-chunks/1, pkey-files/1, apply, paths, planner).
// Platform primitives are injected: prim = { sha256(u8) -> hex | Promise<hex>,
//   zstd(u8, { dict?: u8, size?: number }) -> u8 | Promise<u8> }.
export const MAGIC = [0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b]; // "PKEYCHNK"
export const HDR = 64,
  REC = 48,
  FLAG_FILE_AWARE = 1;
export const REQUEST_WEIGHT = 16384;
const RANK = { noop: 0, platform: 1, delta: 2, chunk: 3, file: 4, full: 5 };

export class ContentError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
  verdict() {
    return { ok: false, error: this.code, ...this.detail };
  }
}
const E = (code, detail) => new ContentError(code, detail);

export function hex(u8, o = 0, n = u8.length - o) {
  let s = "";
  for (let i = o; i < o + n; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

export function mutate(u8, muts) {
  if (!muts || !muts.length) return u8;
  let b = new Uint8Array(u8);
  for (const m of muts) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (m.op === "truncate") b = b.slice(0, m.length);
    else if (m.op === "xor") b[m.offset] ^= m.value;
    else if (m.op === "putU16") dv.setUint16(m.offset, m.value, true);
    else if (m.op === "putU32") dv.setUint32(m.offset, m.value, true);
    else if (m.op === "putU64")
      dv.setBigUint64(m.offset, BigInt(m.value), true);
    else throw new Error(m.op);
  }
  return b;
}

// ------------------------------------------------------------------ pkey-chunks/1
export function parseChunkIndex(b) {
  if (b.length < HDR) throw E("chunks.bad_length");
  for (let i = 0; i < 8; i++)
    if (b[i] !== MAGIC[i]) throw E("chunks.bad_magic");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ver = dv.getUint16(8, true),
    rs = dv.getUint16(10, true),
    flags = dv.getUint32(12, true);
  const n = dv.getUint32(16, true),
    nb = dv.getUint32(20, true),
    psize = Number(dv.getBigUint64(24, true));
  if (ver !== 1) throw E("chunks.unsupported_version");
  if (rs !== REC) throw E("chunks.bad_record_size");
  if (flags & ~FLAG_FILE_AWARE) throw E("chunks.bad_flags");
  if (b.length !== HDR + REC * (n + nb)) throw E("chunks.bad_length");
  const bundles = [];
  for (let j = 0; j < nb; j++) {
    const o = HDR + REC * (n + j);
    if (dv.getBigUint64(o + 40, true) !== 0n)
      throw E("chunks.reserved_nonzero", { bundle: j });
    bundles.push([hex(b, o, 32), Number(dv.getBigUint64(o + 32, true))]);
  }
  const records = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = HDR + REC * i;
    const ln = dv.getUint32(o + 32, true),
      cl = dv.getUint32(o + 36, true);
    const bi = dv.getUint32(o + 40, true),
      bo = dv.getUint32(o + 44, true);
    if (ln === 0) throw E("chunks.zero_length", { chunk: i });
    if (cl === 0 || cl > ln) throw E("chunks.bad_clen", { chunk: i });
    if (bi >= nb) throw E("chunks.bad_bundle_ref", { chunk: i });
    if (bo + cl > bundles[bi][1])
      throw E("chunks.bad_bundle_range", { chunk: i });
    total += ln;
    records.push([hex(b, o, 32), ln, cl, bi, bo]);
  }
  if (total !== psize) throw E("chunks.size_mismatch");
  return {
    flags,
    payloadSize: psize,
    payloadSha256: hex(b, 32, 32),
    records,
    bundles,
  };
}

export function indexSummary(ix) {
  const r = ix.records;
  return {
    ok: true,
    chunkCount: r.length,
    bundleCount: ix.bundles.length,
    payloadSize: ix.payloadSize,
    payloadSha256: ix.payloadSha256,
    fileAware: !!(ix.flags & FLAG_FILE_AWARE),
    uniqueChunks: new Set(r.map((x) => x[0])).size,
    rawStored: r.filter((x) => x[1] === x[2]).length,
    sumClen: r.reduce((a, x) => a + x[2], 0),
    first: r.length ? r[0] : null,
    last: r.length ? r[r.length - 1] : null,
  };
}

// ------------------------------------------------------------------ paths
const BAD = new Set('\\:*?"<>|');
const DEVICES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ..."123456789".split("").flatMap((d) => ["com" + d, "lpt" + d]),
]);
const utf8len = (s) => new TextEncoder().encode(s).length;
function pathOk(p) {
  const n = utf8len(p);
  if (n < 1 || n > 1024) return false;
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c > 0x7e || BAD.has(ch)) return false;
  }
  for (const s of p.split("/")) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.endsWith(" ") || s.endsWith(".")) return false;
    if (DEVICES.has(s.split(".")[0].toLowerCase())) return false;
  }
  return true;
}
export function checkPaths(paths) {
  const seen = new Set(),
    lower = new Set(),
    dirs = new Set();
  for (const p of paths) {
    if (!pathOk(p)) return { error: "files.unsafe_path", path: p };
    if (seen.has(p)) return { error: "files.duplicate_path", path: p };
    const lp = p.toLowerCase();
    if (lower.has(lp)) return { error: "files.case_collision", path: p };
    const parts = lp.split("/"),
      prefixes = [];
    for (let k = 1; k < parts.length; k++)
      prefixes.push(parts.slice(0, k).join("/"));
    if (dirs.has(lp) || prefixes.some((x) => lower.has(x)))
      return { error: "files.path_conflict", path: p };
    seen.add(p);
    lower.add(lp);
    prefixes.forEach((x) => dirs.add(x));
  }
  return { ok: true };
}

// ------------------------------------------------------------------ apply
async function tryZ(prim, data, opts, code, detail) {
  try {
    return await prim.zstd(data, opts);
  } catch {
    throw E(code, detail);
  }
}

export async function applyFull(prim, blob, expSha, expSize) {
  const out = await tryZ(prim, blob, { size: expSize }, "full.corrupt");
  if (out.length !== expSize || (await prim.sha256(out)) !== expSha)
    throw E("full.corrupt");
  return out;
}

export async function applyDelta(
  prim,
  base,
  d,
  artifact,
  skipBaseCheck = false,
  detail = {},
) {
  if ((await prim.sha256(artifact)) !== d.artifactSha256)
    throw E("delta.artifact_mismatch", detail);
  if (!skipBaseCheck && (await prim.sha256(base)) !== d.from)
    throw E("delta.base_mismatch", detail);
  const out = await tryZ(
    prim,
    artifact,
    { dict: base, size: d.size },
    "delta.apply_failed",
    detail,
  );
  if (out.length !== d.size || (await prim.sha256(out)) !== d.to)
    throw E("delta.apply_failed", detail);
  return out;
}

// seeds: [[payloadU8, indexU8]]; fetch(bundleSha, offset, length) -> u8 (may be short)
export async function applyChunk(
  prim,
  targetIx,
  seeds,
  fetch,
  expSha,
  expSize,
  repair,
) {
  const T = parseChunkIndex(targetIx);
  if (T.payloadSha256 !== expSha || T.payloadSize !== expSize)
    throw E("chunks.payload_mismatch");
  const S = new Map();
  seeds.forEach(([, ib], si) => {
    let off = 0;
    for (const [id, ln] of parseChunkIndex(ib).records) {
      if (!S.has(id)) S.set(id, [si, off]);
      off += ln;
    }
  });
  // Pre-compute request runs (same rule as the planner); each run is fetched with one Range request.
  const runOf = new Map(),
    runs = [];
  {
    const seen = new Set();
    let prev = null;
    T.records.forEach((r, i) => {
      const [id, , cl, bi, bo] = r;
      if (S.has(id) || seen.has(id)) return;
      seen.add(id);
      if (prev === null || bi !== prev[3] || bo !== prev[4] + prev[2])
        runs.push({ bi, start: bo, len: 0, buf: null });
      const run = runs[runs.length - 1];
      run.len = bo + cl - run.start;
      runOf.set(i, run);
      prev = r;
    });
  }
  const decode = async (i, [id, ln, cl], raw) => {
    const data =
      cl === ln
        ? raw
        : await tryZ(prim, raw, { size: ln }, "chunk.corrupt", { chunk: i });
    if (data.length !== ln || (await prim.sha256(data)) !== id)
      throw E("chunk.corrupt", { chunk: i });
    return data;
  };
  const fetchRec = async (i, r) => {
    const [, , cl, bi, bo] = r;
    const run = runOf.get(i);
    let raw;
    if (run) {
      run.buf ??= await fetch(T.bundles[run.bi][0], run.start, run.len);
      raw = run.buf.subarray(bo - run.start, bo - run.start + cl);
    } else raw = await fetch(T.bundles[bi][0], bo, cl); // repair pass: per-chunk
    if (raw.length < cl) throw E("bundle.truncated", { chunk: i });
    return decode(i, r, raw);
  };
  const out = new Uint8Array(T.payloadSize),
    first = new Map(),
    kinds = [];
  const st = {
    fetchedChunks: 0,
    fetchedBytes: 0,
    requests: runs.length,
    seedChunks: 0,
    selfChunks: 0,
  };
  let pos = 0;
  for (let i = 0; i < T.records.length; i++) {
    const r = T.records[i],
      [id, ln, cl] = r;
    let data;
    if (S.has(id)) {
      const [si, so] = S.get(id);
      data = seeds[si][0].subarray(so, so + ln);
      kinds.push("seed");
      st.seedChunks++;
    } else if (first.has(id)) {
      const f = first.get(id);
      data = out.subarray(f, f + ln);
      kinds.push("self");
      st.selfChunks++;
    } else {
      data = await fetchRec(i, r);
      kinds.push("fetch");
      st.fetchedChunks++;
      st.fetchedBytes += cl;
    }
    if (!first.has(id)) first.set(id, pos);
    out.set(data, pos);
    pos += ln;
  }
  const repaired = [];
  if ((await prim.sha256(out)) !== expSha) {
    if (!repair) throw E("payload.hash_mismatch");
    pos = 0;
    for (let i = 0; i < T.records.length; i++) {
      const r = T.records[i],
        ln = r[1];
      if (
        kinds[i] === "seed" &&
        (await prim.sha256(out.subarray(pos, pos + ln))) !== r[0]
      ) {
        runOf.delete(i);
        out.set(await fetchRec(i, r), pos);
        repaired.push(i);
      }
      pos += ln;
    }
    if ((await prim.sha256(out)) !== expSha) throw E("payload.hash_mismatch");
  }
  return [
    out,
    {
      ok: true,
      sha256: expSha,
      size: out.length,
      ...st,
      repairedChunks: repaired,
    },
  ];
}

// loadDelta(d) -> u8 artifact; loadBlob(sha) -> u8 raw blob
export async function applyFiles(
  prim,
  instPayload,
  instIx,
  tgtIx,
  gaps,
  layout,
  fileDeltas,
  loadDelta,
  fileBlobs,
  loadBlob,
  expSha,
  expSize,
) {
  const files = tgtIx.files;
  const pc = checkPaths(files.map((f) => f.path));
  if (!pc.ok) throw E(pc.error, { path: pc.path });
  if (layout === "container") {
    let pos = 0,
      gapTotal = 0;
    for (const f of files) {
      if (f.offset < pos) throw E("files.layout_mismatch");
      gapTotal += f.offset - pos;
      pos = f.offset + f.size;
    }
    const size = tgtIx.payload.size;
    if (size < pos || size !== expSize) throw E("files.layout_mismatch");
    gapTotal += size - pos;
    if (!gaps || gaps.length !== gapTotal) throw E("files.layout_mismatch");
  }
  const H = new Map();
  for (const f of instIx.files)
    if (!H.has(f.sha256)) H.set(f.sha256, [f.offset, f.size]);
  const dmap = new Map(fileDeltas.map((d) => [d.path, d]));
  const st = {
    reusedFiles: 0,
    deltaFiles: 0,
    blobFiles: 0,
    downloadedBytes: 0,
  };
  const datas = [];
  for (const f of files) {
    const h = f.sha256,
      path = f.path,
      d = dmap.get(path);
    let data;
    if (H.has(h)) {
      const [o, s] = H.get(h);
      data = instPayload.subarray(o, o + s);
      st.reusedFiles++;
    } else if (d && d.to === h) {
      if (!H.has(d.from)) throw E("delta.base_mismatch", { path });
      const [o, s] = H.get(d.from),
        art = await loadDelta(d);
      data = await applyDelta(
        prim,
        instPayload.subarray(o, o + s),
        d,
        art,
        false,
        { path },
      );
      st.deltaFiles++;
      st.downloadedBytes += art.length;
    } else if (fileBlobs[h]) {
      const raw = await loadBlob(h);
      data =
        fileBlobs[h].codec === "zstd"
          ? await tryZ(prim, raw, { size: f.size }, "file.corrupt", { path })
          : raw;
      if (data.length !== f.size || (await prim.sha256(data)) !== h)
        throw E("file.corrupt", { path });
      st.blobFiles++;
      st.downloadedBytes += raw.length;
    } else throw E("file.source_missing", { path });
    datas.push(data);
  }
  if (layout === "tree") {
    const lines = [];
    for (let k = 0; k < files.length; k++) {
      const f = files[k];
      if (
        datas[k].length !== f.size ||
        (await prim.sha256(datas[k])) !== f.sha256
      )
        throw E("file.corrupt", { path: f.path });
      lines.push([f.path, `${f.sha256} ${f.size} ${f.path}\n`]);
    }
    lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const digest = await prim.sha256(
      new TextEncoder().encode(lines.map((l) => l[1]).join("")),
    );
    return [
      datas,
      {
        ok: true,
        files: files.length,
        bytes: files.reduce((a, f) => a + f.size, 0),
        treeDigest: digest,
        ...st,
      },
    ];
  }
  const out = new Uint8Array(tgtIx.payload.size);
  let pos = 0,
    gp = 0;
  files.forEach((f, k) => {
    const g = f.offset - pos;
    out.set(gaps.subarray(gp, gp + g), pos);
    gp += g;
    out.set(datas[k], f.offset);
    pos = f.offset + f.size;
  });
  out.set(gaps.subarray(gp), pos);
  if ((await prim.sha256(out)) !== expSha) throw E("payload.hash_mismatch");
  return [out, { ok: true, sha256: expSha, size: out.length, ...st }];
}

// ------------------------------------------------------------------ planner (pure, synchronous)
export function plan(inp, loadIndex) {
  const t = inp.target,
    inst = inp.installed,
    caps = inp.caps;
  if (inst.some((i) => i.payloadSha256 === t.payload.sha256))
    return {
      strategy: "noop",
      bytes: 0,
      requests: 0,
      cost: 0,
      peakDisk: 0,
      fallbacks: [],
    };
  if (t.platform) {
    if ((caps.transports || []).includes(t.platform.transport))
      return {
        strategy: "platform",
        transport: t.platform.transport,
        fallbacks: [],
      };
    return { error: "plan.transport_unsupported" };
  }
  const strategies = new Set(caps.strategies || []),
    have = new Set(inst.map((i) => i.payloadSha256));
  const cands = [];
  if (strategies.has("delta"))
    (t.deltas || []).forEach((d, k) => {
      if (
        (caps.patchMethods || []).includes(d.method) &&
        have.has(d.from) &&
        d.memBytes <= caps.memBudget
      )
        cands.push({
          strategy: "delta",
          delta: d.id,
          bytes: d.artifacts.reduce((a, x) => a + x.bytes, 0),
          requests: d.artifacts.length,
          ord: k,
        });
    });
  const seeds = inst.filter((i) => i.chunks).map((i) => i.chunks);
  if (strategies.has("chunk") && t.chunks && seeds.length) {
    const S = new Set();
    for (const s of seeds)
      for (const id of s.ids ||
        parseChunkIndex(loadIndex(s.index)).records.map((r) => r[0]))
        S.add(id);
    const recs =
      t.chunks.records || parseChunkIndex(loadIndex(t.chunks.index)).records;
    const seen = new Set();
    let prev = null,
      runs = 0,
      bytes = t.chunks.indexBytes;
    for (const r of recs) {
      const [id, , cl, bi, bo] = r;
      if (S.has(id) || seen.has(id)) continue;
      seen.add(id);
      bytes += cl;
      if (prev === null || bi !== prev[3] || bo !== prev[4] + prev[2]) runs++;
      prev = r;
    }
    cands.push({ strategy: "chunk", bytes, requests: 1 + runs, ord: 0 });
  }
  const instFiles = inst.filter((i) => i.files != null).map((i) => i.files);
  if (strategies.has("file") && t.files && instFiles.length) {
    const H = new Set(instFiles.flat()),
      missing = new Map();
    for (const f of t.files.files)
      if (!H.has(f.sha256) && !missing.has(f.sha256))
        missing.set(f.sha256, f.blobBytes);
    let bytes = t.files.indexBytes + t.files.gapsBytes;
    for (const v of missing.values()) bytes += v;
    cands.push({
      strategy: "file",
      bytes,
      requests: 1 + (t.files.gapsBytes > 0 ? 1 : 0) + missing.size,
      ord: 0,
    });
  }
  if (t.full)
    cands.push({ strategy: "full", bytes: t.full.bytes, requests: 1, ord: 0 });
  if (!cands.length) return { error: "plan.no_strategy" };
  const w = caps.requestWeight ?? REQUEST_WEIGHT;
  for (const c of cands) {
    c.cost = c.bytes + w * c.requests;
    c.peakDisk = t.payload.size + c.bytes;
  }
  const feas = cands.filter((c) => c.peakDisk <= caps.freeDisk);
  if (!feas.length) return { error: "plan.insufficient_disk" };
  feas.sort(
    (a, b) =>
      a.cost - b.cost || RANK[a.strategy] - RANK[b.strategy] || a.ord - b.ord,
  );
  const [chosen, ...rest0] = feas;
  const rest = [
    ...rest0.filter((c) => c.strategy !== "full"),
    ...rest0.filter((c) => c.strategy === "full"),
  ];
  const pub = (c, full) => {
    const o = { strategy: c.strategy };
    if (c.delta !== undefined) o.delta = c.delta;
    Object.assign(o, { bytes: c.bytes, requests: c.requests, cost: c.cost });
    if (full) o.peakDisk = c.peakDisk;
    return o;
  };
  return { ...pub(chosen, true), fallbacks: rest.map((c) => pub(c, false)) };
}
