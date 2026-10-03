// S-11: render Sparkle / WinSparkle / Velopack feeds for local files with the Worker's OWN
// renderers (packages/worker/src/services/update/updaterRender.ts) and verify every
// `sparkle:edSignature` with the Worker's own streaming verifier (verifyEd25519OverBytes), the
// same check the Worker applies to CI's `.sig` sidecars before listing an enclosure.
//
//   REPO=<polaris-key checkout> npx tsx gen_feeds.mts spec.json
//
// spec: { "outDir": "...", "baseUrl": "http://127.0.0.1:8711/x", "publicKey": "<b64>",
//         "productName": "S11", "kind": "sparkle" | "winsparkle" | "velopack",
//         "releases": [ newest first: { "version", "build", "file", "sig"?, "format"?, "arch"?,
//                        "deltas"?: [ { "file", "sig"?, "deltaFrom"? } ] } ],
//         "feedName": "appcast.xml" }
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.REPO ?? (() => { throw new Error("set REPO to a polaris-key checkout"); })();
const W = (p: string) => pathToFileURL(join(REPO, "packages/worker/src", p)).href;
const R = await import(W("services/update/updaterRender.ts"));
const S = await import(W("services/release/sparkle.ts"));

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const memo = new Map<string, string>();
const env = {
  HOT: {
    get: async (k: string) => memo.get(k) ?? null,
    put: async (k: string, v: string) => void memo.set(k, v),
  },
} as never;

function digest(file: string, alg: string): string {
  return createHash(alg).update(readFileSync(file)).digest("hex");
}

function stream(file: string): ReadableStream<Uint8Array> {
  const rs = createReadStream(file);
  return new ReadableStream({
    start(c) {
      rs.on("data", (b) => c.enqueue(new Uint8Array(b as Buffer)));
      rs.on("end", () => c.close());
      rs.on("error", (e) => c.error(e));
    },
  });
}

const log: unknown[] = [];
async function verified(file: string, sig?: string): Promise<string | undefined> {
  if (!sig) return undefined;
  const sigText = readFileSync(sig, "utf8").trim();
  const size = statSync(file).size;
  const t0 = performance.now();
  const ok = await S.verifyEd25519OverBytes(env, "s11", {
    subject: `sha256:${digest(file, "sha256")}`,
    signature: sigText,
    publicKey: spec.publicKey,
    expectedSize: size,
    open: async () => stream(file),
  });
  log.push({ file: basename(file), size, verified: ok, ms: Math.round(performance.now() - t0) });
  return ok ? sigText : undefined; // the Worker leaves out an enclosure whose signature fails
}

function entry(r: any, file: string, i: number) {
  return {
    releaseId: `v${r.version}`,
    version: r.version,
    publishedAt: 1_790_000_000 + (spec.releases.length - i) * 86_400,
    title: null,
    notes: r.notes ?? `S-11 test release ${r.version}`,
    buildId: `${spec.kind}-${r.arch ?? "universal"}`,
    platform: spec.kind === "sparkle" ? "macos" : "windows",
    arch: r.arch ?? (spec.kind === "sparkle" ? "universal" : "x86_64"),
    format: r.format ?? null,
    buildNumber: r.build ?? null,
    minOs: r.minOs ?? null,
    metadata: null,
    name: basename(file),
    sha256: digest(file, "sha256"),
    size: statSync(file).size,
    url: `${spec.baseUrl}/${basename(file)}`,
    payload: {} as never,
    rollout: r.rollout ?? null,
    artifacts: [],
  };
}

let body: string;
if (spec.kind === "sparkle") {
  const sources = [];
  for (const [i, r] of spec.releases.entries()) {
    const deltas = [];
    for (const d of r.deltas ?? []) {
      const sig = await verified(d.file, d.sig);
      deltas.push({ url: `${spec.baseUrl}/${basename(d.file)}`, size: statSync(d.file).size, deltaFrom: d.deltaFrom, ...(sig ? { edSignature: sig } : {}) });
    }
    const sig = await verified(r.file, r.sig);
    sources.push({ entry: entry(r, r.file, i), ...(sig ? { edSignature: sig } : {}), deltas });
  }
  body = R.renderSparkleAppcast({
    channelTitle: `${spec.productName} stable`,
    link: spec.baseUrl,
    productName: spec.productName,
    scheme: "semver",
    sources,
    policy: spec.policy ?? null,
  });
} else if (spec.kind === "winsparkle") {
  const sources = [];
  for (const [i, r] of spec.releases.entries()) {
    const sig = await verified(r.file, r.sig);
    sources.push({ entry: entry(r, r.file, i), ...(sig ? { edSignature: sig } : {}) });
  }
  body = R.renderWinSparkleAppcast({ channelTitle: `${spec.productName} stable`, link: spec.baseUrl, productName: spec.productName, sources });
} else {
  // As updaterFeeds.ts: the newest release's -full.nupkg, then every listed release's deltas.
  const assets = [];
  for (const [i, r] of spec.releases.entries()) {
    const e = entry(r, r.file, i);
    const packageId = R.velopackPackageId(e.name, e.version);
    const notes = R.velopackNotes(e.notes);
    // spec.fileNameMode "basename": the proposed fix (FileName relative to the feed's base URL).
    const fname = (u: string) => (spec.fileNameMode === "basename" ? basename(new URL(u).pathname) : u);
    if (i === 0)
      assets.push({ PackageId: packageId, Version: e.version, Type: "Full", FileName: fname(e.url), SHA1: digest(r.file, "sha1").toUpperCase(), SHA256: e.sha256.toUpperCase(), Size: e.size, ...notes });
    for (const d of r.deltas ?? [])
      assets.push({ PackageId: packageId, Version: e.version, Type: "Delta", FileName: fname(`${spec.baseUrl}/${basename(d.file)}`), SHA1: digest(d.file, "sha1").toUpperCase(), SHA256: digest(d.file, "sha256").toUpperCase(), Size: statSync(d.file).size, ...notes });
  }
  body = R.renderVelopackFeed(assets);
}
writeFileSync(join(spec.outDir, spec.feedName), body);
console.log(JSON.stringify({ feed: join(spec.outDir, spec.feedName), bytes: body.length, signatures: log }));
