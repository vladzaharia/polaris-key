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
// The Velopack feed is built by the Worker's own updaterFeeds.ts (velopackCandidatesFrom,
// velopackAssets): bare `FileName`s, as `vpk` writes them (notes/S-11 §5.1). The client resolves
// each against the feed URL; e2e/server.py answers that path with a 302 to the package's delivery
// URL for a listed file only (redirects.json), as the Worker's package route does.
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
  /** Velopack only: where the packages' "delivery URLs" live (default <origin>/bytes/velopack). */
  bytesUrl?: string;
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
  // The Worker's own Velopack code (updaterFeeds.ts): velopackCandidatesFrom over a selection of
  // these releases, then velopackAssets with each SHA-1 read from the local bytes. Every package
  // gets an immutable "delivery URL" under `bytesUrl`; redirects.json maps each LISTED FileName to
  // it, which e2e/server.py answers with a 302, as the Worker's package route does.
  const F = await import(worker("services/update/updaterFeeds.ts"));
  const bytesUrl =
    spec.bytesUrl ?? `${new URL(spec.baseUrl).origin}/bytes/velopack`;
  const files = new Map<string, string>();
  const artifact = (file: string, buildId: string, role: string) => {
    files.set(basename(file), file);
    return {
      releaseId: "",
      artifactId: basename(file),
      name: basename(file),
      buildId,
      role,
      platform: "windows",
      arch: "x86_64",
      contentType: "application/octet-stream",
      sizeBytes: statSync(file).size,
      sha256: digest(file, "sha256"),
      metadata: null,
      locations: [],
      url: `${bytesUrl}/${basename(file)}`,
    };
  };
  const entries = spec.releases.map((r, i) => {
    const e = entry(r, i);
    const payload = artifact(r.file, e.buildId, "payload");
    return {
      ...e,
      url: payload.url,
      payload,
      artifacts: (r.deltas ?? []).map((d) => ({
        ...artifact(d.file, e.buildId, "delta"),
        releaseId: e.releaseId,
      })),
    };
  });
  const candidates = F.velopackCandidatesFrom(entries);
  const assets = await F.velopackAssets(
    candidates,
    async (a: { name: string }) => {
      const file = files.get(a.name);
      return file ? digest(file, "sha1") : null;
    },
  );
  const listed = new Set(assets.map((x: { FileName: string }) => x.FileName));
  const redirects: Record<string, string> = {};
  for (const c of candidates)
    if (listed.has(c.asset.FileName)) redirects[c.asset.FileName] = c.url;
  writeFileSync(
    join(spec.outDir, "redirects.json"),
    `${JSON.stringify(redirects, null, 2)}\n`,
  );
  body = R.renderVelopackFeed(assets);
}

const out = join(spec.outDir, spec.feedName);
writeFileSync(out, body);
console.log(
  JSON.stringify({ feed: out, bytes: body.length, signatures: report }),
);
