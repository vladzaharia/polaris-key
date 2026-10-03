// Renders the desktop updaters' feeds for local files with the Worker's OWN code, for P5-07's
// end-to-end runs (notes/S-11 §3): renderSparkleAppcast, renderWinSparkleAppcast and
// renderVelopackFeed from packages/worker/src/services/update/updaterRender.ts, and every
// `sparkle:edSignature` checked first with the Worker's streaming verifier
// (verifyEd25519OverBytes in services/release/sparkle.ts), as the Worker checks CI's `.sig`
// sidecars before it lists an enclosure. An enclosure whose signature does not verify is listed
// WITHOUT one, which is what the Worker does too.
//
//   pnpm exec tsx sdks/godot/native/e2e/gen_feeds.mts <spec.json>     (from the repository root,
//   after `pnpm install` and `pnpm --filter "@polaris-key/worker^..." build`)
//
// spec: {
//   "outDir": "…", "feedName": "appcast.xml", "baseUrl": "http://127.0.0.1:8711/sparkle",
//   "publicKey": "<base64>", "productName": "Game", "kind": "sparkle" | "winsparkle" | "velopack",
//   "releases": [ newest first: { "version", "build"?, "file", "sig"?, "format"?, "arch"?,
//                 "minOs"?, "notes"?, "deltas"?: [ { "file", "sig"?, "deltaFrom"? } ] } ]
// }
//
// Velopack `FileName`s are bare file names, as `vpk` writes them and as the Worker emits them
// since the delivery fix (notes/S-11 §5.1): the client resolves each against the feed URL, and
// e2e/server.py answers that path with a 302 to the bytes, as the Worker's package route does.
import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const worker = (p: string): string =>
  pathToFileURL(join(repo, "packages/worker/src", p)).href;
const R = await import(worker("services/update/updaterRender.ts"));
const S = await import(worker("services/release/sparkle.ts"));

interface Delta {
  file: string;
  sig?: string;
  deltaFrom?: string;
}
interface Release {
  version: string;
  build?: string;
  file: string;
  sig?: string;
  format?: string;
  arch?: string;
  minOs?: string;
  notes?: string;
  deltas?: Delta[];
}
interface Spec {
  outDir: string;
  feedName: string;
  baseUrl: string;
  publicKey: string;
  productName: string;
  kind: "sparkle" | "winsparkle" | "velopack";
  releases: Release[];
}

const specPath = process.argv[2];
if (!specPath) throw new Error("usage: gen_feeds.mts <spec.json>");
const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;

// The verifier memoises in HOT; an in-memory map stands in.
const memo = new Map<string, string>();
const env = {
  HOT: {
    get: async (k: string) => memo.get(k) ?? null,
    put: async (k: string, v: string) => void memo.set(k, v),
  },
} as never;

const digest = (file: string, alg: string): string =>
  createHash(alg).update(readFileSync(file)).digest("hex");

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

const report: Array<{ file: string; size: number; verified: boolean }> = [];
async function verified(
  file: string,
  sig?: string,
): Promise<string | undefined> {
  if (!sig) return undefined;
  const signature = readFileSync(sig, "utf8").trim();
  const size = statSync(file).size;
  const ok = (await S.verifyEd25519OverBytes(env, "e2e", {
    subject: `sha256:${digest(file, "sha256")}`,
    signature,
    publicKey: spec.publicKey,
    expectedSize: size,
    open: async () => stream(file),
  })) as boolean;
  report.push({ file: basename(file), size, verified: ok });
  return ok ? signature : undefined;
}

function entry(r: Release, i: number) {
  const mac = spec.kind === "sparkle";
  return {
    releaseId: `v${r.version}`,
    version: r.version,
    publishedAt: 1_790_000_000 + (spec.releases.length - i) * 86_400,
    title: null,
    notes: r.notes ?? `Test release ${r.version}`,
    buildId: `${spec.kind}-${r.arch ?? (mac ? "universal" : "x86_64")}`,
    platform: mac ? "macos" : "windows",
    arch: r.arch ?? (mac ? "universal" : "x86_64"),
    format: r.format ?? null,
    buildNumber: r.build ?? null,
    minOs: r.minOs ?? null,
    metadata: null,
    name: basename(r.file),
    sha256: digest(r.file, "sha256"),
    size: statSync(r.file).size,
    url: `${spec.baseUrl}/${basename(r.file)}`,
    payload: {} as never,
    rollout: null,
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
      deltas.push({
        url: `${spec.baseUrl}/${basename(d.file)}`,
        size: statSync(d.file).size,
        deltaFrom: d.deltaFrom ?? "",
        ...(sig ? { edSignature: sig } : {}),
      });
    }
    const sig = await verified(r.file, r.sig);
    sources.push({
      entry: entry(r, i),
      ...(sig ? { edSignature: sig } : {}),
      deltas,
    });
  }
  body = R.renderSparkleAppcast({
    channelTitle: `${spec.productName} stable`,
    link: spec.baseUrl,
    productName: spec.productName,
    scheme: "semver",
    sources,
    policy: null,
  });
} else if (spec.kind === "winsparkle") {
  const sources = [];
  for (const [i, r] of spec.releases.entries()) {
    const sig = await verified(r.file, r.sig);
    sources.push({ entry: entry(r, i), ...(sig ? { edSignature: sig } : {}) });
  }
  body = R.renderWinSparkleAppcast({
    channelTitle: `${spec.productName} stable`,
    link: spec.baseUrl,
    productName: spec.productName,
    sources,
  });
} else {
  // As updaterFeeds.ts: the newest release's -full.nupkg, then every listed release's deltas.
  const assets = [];
  for (const [i, r] of spec.releases.entries()) {
    const e = entry(r, i);
    const packageId = R.velopackPackageId(e.name, e.version);
    if (!packageId) throw new Error(`${e.name} carries no -${e.version}`);
    const notes = R.velopackNotes(e.notes);
    const asset = (file: string, type: "Full" | "Delta") => ({
      PackageId: packageId,
      Version: e.version,
      Type: type,
      FileName: basename(file),
      SHA1: digest(file, "sha1").toUpperCase(),
      SHA256: digest(file, "sha256").toUpperCase(),
      Size: statSync(file).size,
      ...notes,
    });
    if (i === 0) assets.push(asset(r.file, "Full"));
    for (const d of r.deltas ?? []) assets.push(asset(d.file, "Delta"));
  }
  body = R.renderVelopackFeed(assets);
}

const out = join(spec.outDir, spec.feedName);
writeFileSync(out, body);
console.log(
  JSON.stringify({ feed: out, bytes: body.length, signatures: report }),
);
