// Case interpreter shared by the Node and browser runners. loader.raw(name) -> Promise<Uint8Array>.
import * as C from "./content.mjs";

export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}

export class Store {
  constructor(loader, prim) {
    this.loader = loader;
    this.prim = prim;
    this.cache = new Map();
    this.dec = new Map();
  }
  async raw(name) {
    if (!this.cache.has(name))
      this.cache.set(name, await this.loader.raw(name));
    return this.cache.get(name);
  }
  async rawMutated(ref) {
    return C.mutate(await this.raw(ref.blob), ref.mutate);
  }
  async materialize(ref) {
    let b = await this.raw(ref.blob);
    if (ref.codec === "zstd") {
      if (!this.dec.has(ref.blob))
        this.dec.set(ref.blob, await this.prim.zstd(b, {}));
      b = this.dec.get(ref.blob);
    }
    return C.mutate(b, ref.mutate);
  }
}

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof C.ContentError) return e.verdict();
    throw e;
  }
};

export const runIndex = (s, c) =>
  wrap(async () =>
    C.indexSummary(C.parseChunkIndex(await s.rawMutated(c.index))),
  );

export const runApply = (s, c) =>
  wrap(async () => {
    const p = s.prim;
    if (c.strategy === "full") {
      const out = await C.applyFull(
        p,
        await s.rawMutated(c.full),
        c.expectedSha256,
        c.expectedSize,
      );
      return { ok: true, sha256: c.expectedSha256, size: out.length };
    }
    if (c.strategy === "delta") {
      const d = c.delta;
      const out = await C.applyDelta(
        p,
        await s.materialize(c.base),
        d,
        await s.rawMutated(d.artifact),
        !!c.skipBaseCheck,
      );
      return {
        ok: true,
        sha256: d.to,
        size: out.length,
        artifactBytes: (await s.raw(d.artifact.blob)).length,
      };
    }
    if (c.strategy === "chunk") {
      const bundles = {};
      for (const [h, ref] of Object.entries(c.bundles)) bundles[h] = ref;
      const bcache = new Map();
      const fetch = async (h, off, len) => {
        const ref = bundles[h];
        if (s.loader.range && !ref.mutate)
          return s.loader.range(ref.blob, off, len); // HTTP Range in the browser
        if (!bcache.has(h)) bcache.set(h, await s.rawMutated(ref));
        return bcache.get(h).subarray(off, off + len);
      };
      const seeds = [];
      for (const sd of c.seeds)
        seeds.push([
          await s.materialize(sd.payload),
          await s.rawMutated(sd.index),
        ]);
      const [, v] = await C.applyChunk(
        p,
        await s.rawMutated(c.target.index),
        seeds,
        fetch,
        c.expectedSha256,
        c.expectedSize,
        c.repair,
      );
      return v;
    }
    if (c.strategy === "file") {
      const t = c.target,
        dec = new TextDecoder();
      const gaps = t.gaps ? await s.materialize(t.gaps) : null;
      const [, v] = await C.applyFiles(
        p,
        await s.materialize(c.installed.payload),
        JSON.parse(dec.decode(await s.raw(c.installed.files.blob))),
        JSON.parse(dec.decode(await s.raw(t.files.blob))),
        gaps,
        t.layout,
        c.fileDeltas,
        (d) => s.rawMutated(d.artifact),
        c.fileBlobs,
        (h) => s.raw(c.fileBlobs[h].blob),
        c.expectedSha256,
        c.expectedSize,
      );
      return v;
    }
    throw new Error(c.strategy);
  });

export async function runPlan(s, c) {
  // the planner is synchronous: preload any referenced binary indexes
  const refs = [];
  const t = c.input.target;
  if (t.chunks?.index) refs.push(t.chunks.index);
  for (const i of c.input.installed)
    if (i.chunks?.index) refs.push(i.chunks.index);
  const m = new Map();
  for (const r of refs) m.set(r.blob, await s.rawMutated(r));
  return C.plan(c.input, (ref) => m.get(ref.blob));
}

export async function runAll(doc, store, log = console.log, verbose = false) {
  let n = 0,
    bad = 0;
  const results = {},
    timings = {};
  for (const [name, meta] of Object.entries(doc.blobs)) {
    if ((await store.prim.sha256(await store.raw(name))) !== meta.sha256) {
      log("VECTOR INTEGRITY FAIL " + name);
      bad++;
    }
  }
  const groups = [
    ["chunkIndexCases", runIndex],
    ["applyCases", runApply],
    ["planCases", runPlan],
    ["pathCases", async (s, c) => C.checkPaths(c.paths)],
  ];
  for (const [g, fn] of groups) {
    for (const c of doc[g] || []) {
      const t0 = performance.now();
      const got = await fn(store, c);
      timings[c.id] = performance.now() - t0;
      n++;
      results[c.id] = got;
      if (canon(got) !== canon(c.expected)) {
        bad++;
        log(
          `FAIL ${g}/${c.id}\n  got      ${canon(got).slice(0, 400)}\n  expected ${canon(c.expected).slice(0, 400)}`,
        );
      } else if (verbose)
        log(`ok   ${g}/${c.id} ${timings[c.id].toFixed(1)} ms`);
    }
  }
  return { n, bad, results, timings };
}
