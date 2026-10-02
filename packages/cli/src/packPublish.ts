/**
 * `pkey release publish --deliverable <packId>` (P4-03; plans/P4-01.md §6 "P4-03", decisions 2,
 * 3, 5, 7–10, 28, 32, 35, 36): turn the built payload of each declared variant into one CI-signed
 * `kind: pack` release record plus its patch artifacts, publish them in stage rounds, then submit
 * the record.
 *
 *   1. Load `.pkey/` and the pack's declaration. Each declared variant's payload is found under
 *      `--dir` at `<variant key, or "default">/` — the layout `--out` writes, so a cached release
 *      is also a valid `--dir`: for `godot.pck` the one `*.pck` file there, for `files.tree` the
 *      directory itself (without its `.pkey/`).
 *   2. Check, strip, lint (`pck.ts`, `packLint.ts`). Every failure names its path; nothing
 *      continues past a failure.
 *   3. Build every object (`packArtifacts.ts`) and prove it: `parseFilesIndex` under
 *      `MAX_PUBLISHED_INDEX_BYTES`, the byte-for-byte rebuild, `full`.
 *   4. Credentials, the discovery check (`release.packs`), then the uploads PREFLIGHT: the cached
 *      versions from `--bases` and the new one in `releases`, no objects. Its answer gives the new
 *      `seq`, the pack's delivery gate (`seqs[].entitlement`) and the cached records' hashes. The
 *      publish stops, before anything is uploaded, while `.pkey/release` asserts an `entitlement`
 *      the gate does not equal (decision 35).
 *   5. Delta bases are CI's own earlier output (`--bases`, written by `--out`), never the Worker's
 *      (CI credentials cannot read): a cached record counts only when its SHA-256 equals the
 *      answer's `seqs[].recordSha256`, and its payload only when it matches that record's variant
 *      `payload`. The `patch.deltaBases` highest-`seq` proven ones get a whole-payload delta (a
 *      container) and a packed `files` set. A missing or unproven base costs a delta and a warning,
 *      never the publish (decision 32).
 *   6. The record: signed under the declared release key, checked with `verifyJws` and
 *      `releaseRecordClaims`, under the record caps. The gate is signed as `entitlement`.
 *   7. Stage rounds of at most 256 objects (`MAX_TICKET_OBJECTS`): a ticket, a PUT of every object
 *      not `present`, then `publish/stage`; a failed round is retried once with a new ticket. Then
 *      the record submit (decision 28).
 *   8. The stripped PCK is written back in place, and a marker (`pkey-marker/1`) beside each
 *      payload (`X.pkey.json`, or `D/.pkey/pack.json` inside a tree), so the app export embeds the
 *      exact bytes the marker pins. `--out <dir>` keeps the record and the payloads at
 *      `<dir>/<packId>/<version>/` for the next publish's `--bases`, and each variant's stored
 *      chunk index as `<variant>/chunks.<sha256>`.
 *
 * CHUNK INDEXES (P4-22, plans/P4-10.md §2.4; `packChunks.ts`). A container variant of 4 MiB or
 * more gets a `pkey-chunks/1` index and shared chunk bundles when `chunk` is in
 * `patch.strategies` and discovery advertises `release.chunks`. Its chain (this deliverable, this
 * variant key, this gating class) continues from the newest proven cached release carrying an
 * index of the same gating class: the record proven by `seqs[].recordSha256`, the cached index
 * by that record's `chunks.sha256`. A chunk that index holds keeps its location only in a bundle
 * an upload ticket reports `present`; every other chunk is packed fresh from the payload, so a
 * lost cache, a gate change or an absent bundle costs storage, never a publish. An index above
 * `MAX_PUBLISHED_INDEX_BYTES` is not published: the variant omits `chunks` with a warning.
 *
 * `--dry-run` does 1–5 (with a credential; without one it stops before the network and uses
 * cached bases unproven), requests tickets only to learn which objects are already stored, and
 * prints the lint results, the objects (new and deduplicated), the bytes per strategy, the gate,
 * the skipped deltas, the re-import noise and the record, unsigned. It uploads, signs, writes and
 * submits nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManifestPackDeliverable } from "@polaris-key/manifest";
import {
  MARKER_FORMAT,
  MAX_RECORD_JWS_BYTES,
} from "@polaris-key/protocol/core";
import { MAX_PUBLISHED_INDEX_BYTES } from "@polaris-key/manifest";
import {
  MARKER_SUFFIX,
  TREE_MARKER_PATH,
  type PackRecordDoc,
  type PackVariant,
} from "@polaris-key/protocol/packs";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { parseChunkIndex, variantKey } from "@polaris-key/client-core/packs";
import { decode as wasmDecode } from "@polaris-key/zstd-wasm";
import { parseVersion } from "@polaris-key/client-core/version";
import {
  ciClient,
  CiRequestError,
  type CiClient,
  type Out,
  type Sleep,
} from "./ci.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { putFile } from "./s3.js";
import {
  checkSignedRecord,
  recordSigner,
  RELEASE_KEY_ENV,
} from "./releaseKeys.js";
import { provenanceFrom } from "./publish.js";
import {
  declaredVariants,
  packContext,
  requirePacksDiscovery,
  variantDirName,
} from "./packManifest.js";
import { readPck, stripPck } from "./pck.js";
import { lintPck, lintTreePaths } from "./packLint.js";
import {
  buildFilesDelta,
  buildPayload,
  buildPayloadDelta,
  containerPayload,
  filesRefOf,
  noiseReport,
  payloadIdentity,
  readTree,
  selfCheckPayload,
  sha256Hex,
  zstdCli,
  type BuiltPayload,
  type Payload,
  type PayloadFile,
  type Zstd,
} from "./packArtifacts.js";
import {
  buildChunks,
  chunkContainer,
  CHUNK_MIN_PAYLOAD_BYTES,
  priorLocations,
  type BuiltChunks,
  type Chunk,
  type ChunkChainBase,
} from "./packChunks.js";

/** At most this many objects per upload ticket (`MAX_TICKET_OBJECTS`, P2-02). */
export const STAGE_ROUND_OBJECTS = 256;
/**
 * The record payload cap (WIRE-CONTRACT-V4 §1: 65,536 bytes for a release record). Neither
 * `@polaris-key/protocol` nor `@polaris-key/manifest` exports it (only `shared-jws` holds it, as
 * the private `MAX_DOC_BYTES` that `signJws`/`verifyJws` enforce), so it is restated here as a
 * friendlier, earlier refusal; exporting it from `shared-protocol` would be a constants change of
 * its own (`gen:constants`).
 */
export const MAX_RECORD_PAYLOAD_BYTES = 65536;
/** At most this many releases one uploads request names (the Worker's `MAX_TICKET_RELEASES`). */
const MAX_PREFLIGHT_RELEASES = 16;

export interface PackPublishOptions {
  cwd: string;
  product: string;
  /** The pack id. */
  deliverable: string;
  version?: string;
  tag?: string;
  channel?: string;
  /** Where the variant payloads are: `<dir>/<variant key or "default">/`. Relative to `cwd`. */
  dir: string;
  /** `--out`: keep the record and payloads at `<out>/<packId>/<version>/`. */
  out?: string;
  /** `--bases`: read earlier releases kept by `--out`. */
  bases?: string;
  dryRun?: boolean;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  releaseKeyPem?: string;
  minSupportedSeq?: number;
  signRecord?: (record: ReleaseRecordDoc) => Promise<string>;
  now?: number;
  /** The zstd binary (tests). */
  zstdBin?: string;
  /** The smallest container payload that gets a chunk index (tests; default 4 MiB). */
  chunkMinPayloadBytes?: number;
  /** The largest chunk index published (tests; default `MAX_PUBLISHED_INDEX_BYTES`). */
  maxChunkIndexBytes?: number;
}

export interface PackVariantReport {
  key: string;
  payload: { size: number; sha256: string };
  stripped: string[];
  entries: number;
  lintWarnings: string[];
  bytes: {
    full: number;
    file: number;
    deltas: { from: string; version: string; scope: string; bytes: number }[];
  };
  skippedDeltas: string[];
  noise: string[];
  /** The chunk index (P4-22): what it holds and reuses, with the chain's base version. */
  chunks?: BuiltChunks["stats"] & {
    sha256: string;
    bytes: number;
    base: string | null;
  };
  /** Why an eligible variant ships without a chunk index. */
  chunksOmitted?: string;
}

export interface PackPublishResult {
  releaseId: string;
  dryRun: boolean;
  record?: PackRecordDoc;
  recordJws?: string;
  server?: Record<string, unknown>;
  /** The pack's delivery gate from the preflight (`null` = ungated), when it was asked. */
  gate?: string | null;
  /** Storage keys uploaded, and those skipped as already held by the product. */
  uploaded: string[];
  skipped: string[];
  /** Every object the release needs, by stored SHA-256. */
  objects: string[];
  warnings: string[];
  variants: PackVariantReport[];
  /** Marker files written (absolute paths). */
  markers: string[];
}

// ── 1. The declaration and the payloads ──────────────────────────────────────

/** The one `*.pck` file directly in `dir` (markers excluded). */
async function findPck(dir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".pck"))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${dir} does not exist.`);
    throw e;
  }
  if (names.length !== 1)
    throw new Error(
      `${dir} must hold exactly one .pck file (found ${names.length}${names.length ? `: ${names.join(", ")}` : ""}).`,
    );
  return path.join(dir, names[0]!);
}

interface LoadedVariant {
  variant: Record<string, string>;
  key: string;
  /** The payload file (a PCK) or directory (a tree). */
  location: string;
  payload: Payload;
  /** The stripped PCK bytes to write back, when the strip removed anything. */
  rewrite?: Uint8Array;
  stripped: string[];
  formatVersion: number;
  lintErrors: string[];
  lintWarnings: string[];
}

/** Read, check, strip and lint one variant's payload. Never throws for a lint failure. */
export async function loadVariant(
  pack: ManifestPackDeliverable,
  variant: Record<string, string>,
  root: string,
): Promise<LoadedVariant> {
  const key = variantKey(variant);
  const dir = path.join(root, variantDirName(variant));
  if (pack.type === "godot.pck") {
    const file = await findPck(dir);
    const src = new Uint8Array(await readFile(file));
    const name = path.basename(file);
    const strip = stripPck(src, name);
    const lint = lintPck(strip.directory, strip.bytes, {
      prefixes: pack.handler.prefixes ?? [],
      ...(pack.requires.engine ? { engine: pack.requires.engine } : {}),
    });
    const payload = containerPayload(strip.bytes, strip.directory);
    const paths = lintTreePaths(payload.files.map((f) => f.path));
    return {
      variant,
      key,
      location: file,
      payload,
      ...(strip.removed.length ? { rewrite: strip.bytes } : {}),
      stripped: strip.removed,
      formatVersion: strip.directory.header.formatVersion,
      lintErrors: [...lint.errors, ...paths.errors].map((e) => `${name}: ${e}`),
      lintWarnings: lint.warnings.map((w) => `${name}: ${w}`),
    };
  }
  const tree = await readTree(dir);
  const paths = lintTreePaths(tree.files.map((f) => f.path));
  return {
    variant,
    key,
    location: dir,
    payload: { layout: "tree", files: tree.files },
    stripped: [],
    formatVersion: 1,
    lintErrors: [...tree.errors, ...paths.errors].map(
      (e) => `${variantDirName(variant)}/${e}`,
    ),
    lintWarnings: [],
  };
}

// ── 4. Bases ────────────────────────────────────────────────────────────────

interface CachedRelease {
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  record: PackRecordDoc;
  dir: string;
}

function decodeJwsPayload(jws: string): unknown {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** The releases of `packId` kept under `<bases>/<packId>/<version>/record.jws`, newest first. */
async function cachedReleases(
  bases: string,
  packId: string,
  warn: (w: string) => void,
): Promise<CachedRelease[]> {
  const root = path.join(bases, packId);
  let versions: string[];
  try {
    versions = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: CachedRelease[] = [];
  for (const version of versions) {
    const dir = path.join(root, version);
    let jws: string;
    try {
      jws = (await readFile(path.join(dir, "record.jws"), "utf8")).trim();
    } catch {
      warn(`--bases: ${dir} has no record.jws; it is not a base.`);
      continue;
    }
    const record = decodeJwsPayload(jws) as PackRecordDoc | null;
    if (
      !record ||
      record.kind !== "pack" ||
      record.deliverable !== packId ||
      record.version !== version ||
      !Number.isSafeInteger(record.seq)
    ) {
      warn(
        `--bases: ${dir}/record.jws is not ${packId} ${version}'s pack record; it is not a base.`,
      );
      continue;
    }
    out.push({
      version,
      seq: record.seq,
      jws,
      recordSha256: sha256Hex(jws),
      record,
      dir,
    });
  }
  return out.sort((a, b) => b.seq - a.seq);
}

interface Base {
  release: CachedRelease;
  /** Per variant key: the base payload's bytes (a container) or files, proven against the
   *  cached record's variant. */
  payloads: Map<
    string,
    { sha256: string; bytes?: Uint8Array; files: PayloadFile[] }
  >;
}

async function loadBase(
  pack: ManifestPackDeliverable,
  release: CachedRelease,
  keys: readonly string[],
  warn: (w: string) => void,
): Promise<Base> {
  const payloads: Base["payloads"] = new Map();
  for (const key of keys) {
    const v = release.record.variants.find(
      (x) => variantKey(x.variant) === key,
    );
    const label = `${pack.id} ${release.version} (${key || "default"})`;
    if (!v) {
      warn(
        `base ${label}: the cached record has no such variant; no delta from it.`,
      );
      continue;
    }
    const dir = path.join(release.dir, key || "default");
    try {
      if (pack.type === "godot.pck") {
        const bytes = new Uint8Array(await readFile(await findPck(dir)));
        const sha = sha256Hex(bytes);
        if (sha !== v.payload.sha256 || bytes.byteLength !== v.payload.size) {
          warn(
            `base ${label}: the cached payload is not the record's (sha256 ${sha.slice(0, 12)}…); no delta from it.`,
          );
          continue;
        }
        const p = containerPayload(bytes, readPck(bytes, label));
        payloads.set(key, { sha256: sha, bytes, files: p.files });
      } else {
        const tree = await readTree(dir);
        const id = await payloadIdentity({ layout: "tree", files: tree.files });
        if (tree.errors.length || id.sha256 !== v.payload.sha256) {
          warn(
            `base ${label}: the cached tree is not the record's (treeDigest ${id.sha256.slice(0, 12)}…); no delta from it.`,
          );
          continue;
        }
        payloads.set(key, { sha256: id.sha256, files: tree.files });
      }
    } catch (e) {
      warn(`base ${label}: ${(e as Error).message} No delta from it.`);
    }
  }
  return { release, payloads };
}

/**
 * The chain a chunked variant continues (plans/P4-10.md §2.4): the newest proven cached release
 * whose record gives this variant a chunk index under the same gating class, with that index read
 * from the cache (`<variant>/chunks.<sha256>`, written by `--out`) and proven by the record's
 * `chunks` ref and payload. A record of another gating class is skipped (a gate change starts a
 * fresh chain); a missing or mismatched cached index falls back to the next older proven release,
 * and with none left costs reuse, never the publish.
 */
async function chunkChainBase(
  proven: readonly CachedRelease[],
  key: string,
  gateClass: string | null,
  warn: (w: string) => void,
): Promise<ChunkChainBase | null> {
  for (const c of proven) {
    const v = c.record.variants.find((x) => variantKey(x.variant) === key);
    if (!v?.chunks || (c.record.entitlement ?? null) !== gateClass) continue;
    const label = `${c.record.deliverable} ${c.version} (${key || "default"})`;
    const file = path.join(
      c.dir,
      key || "default",
      `chunks.${v.chunks.sha256}`,
    );
    let stored: Uint8Array;
    try {
      stored = new Uint8Array(await readFile(file));
    } catch {
      warn(
        `chunk chain ${label}: the cached index ${path.basename(file)} is missing; an older cached release is tried, else the chunks are packed fresh.`,
      );
      continue;
    }
    const parsed = await parseChunkIndex(stored, v.chunks, v.payload, {
      decode: (frame, size) => wasmDecode(frame, size),
      maxBytes: MAX_PUBLISHED_INDEX_BYTES,
    });
    if (!parsed.ok) {
      warn(
        `chunk chain ${label}: the cached index is not the record's (${parsed.error}); an older cached release is tried, else the chunks are packed fresh.`,
      );
      continue;
    }
    return { version: c.version, index: parsed.index };
  }
  return null;
}

// ── 6. The record and the marker ─────────────────────────────────────────────

export function markerJson(
  packId: string,
  version: string,
  jws: string,
): string {
  return `${JSON.stringify(
    { format: MARKER_FORMAT, packId, version, release: jws },
    null,
    2,
  )}\n`;
}

/** Where a variant's marker goes: beside a single file, inside a tree. */
export function markerPathFor(type: string, location: string): string {
  return type === "godot.pck"
    ? `${location}${MARKER_SUFFIX}`
    : path.join(location, ...TREE_MARKER_PATH.split("/"));
}

// ── The publish ──────────────────────────────────────────────────────────────

interface StagedObject {
  sha256: string;
  size: number;
  bytes: Uint8Array;
  label: string;
}

export async function publishPack(
  opts: PackPublishOptions,
): Promise<PackPublishResult> {
  const out = opts.stdout;
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    opts.stderr.write(`warning: ${w}\n`);
  };
  const packId = opts.deliverable;
  const tag = opts.tag?.trim() || undefined;
  const version = opts.version?.trim() || tag?.replace(/^v/, "");
  if (!version) throw new Error("--version (or --tag) is required.");
  if (
    opts.minSupportedSeq !== undefined &&
    (!Number.isSafeInteger(opts.minSupportedSeq) || opts.minSupportedSeq < 1)
  )
    throw new Error(
      "--min-supported-seq must be a whole number of at least 1.",
    );

  // 1. The manifest and the declaration.
  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const ctx = packContext({
    product: loaded.product,
    schema: loaded.schema,
    release: loaded.release,
    distribution: loaded.distribution,
  });
  if (ctx.slug !== opts.product)
    throw new Error(
      `--product ${opts.product} does not match .pkey/product's slug ${ctx.slug}.`,
    );
  const pack = ctx.packs.find((p) => p.id === packId);
  if (!pack)
    throw new Error(
      `--deliverable ${packId} is not a pack .pkey/release declares (declared: ${ctx.packs.map((p) => p.id).join(", ") || "none"}).`,
    );
  if (parseVersion(pack.versioning.scheme, version) === null)
    throw new Error(
      `--version ${version} does not parse under ${packId}'s ${pack.versioning.scheme} scheme.`,
    );
  const releaseId = `${packId}@${version}`;

  // 2. Payloads: check, strip, lint.
  const root = path.resolve(opts.cwd, opts.dir);
  const variants: LoadedVariant[] = [];
  for (const v of declaredVariants(pack))
    variants.push(await loadVariant(pack, v, root));
  const errors = variants.flatMap((v) => v.lintErrors);
  for (const v of variants) for (const w of v.lintWarnings) warn(w);
  const formats = new Set(variants.map((v) => v.formatVersion));
  if (formats.size > 1)
    errors.push(
      `the variants' PCKs have different format versions (${[...formats].join(", ")}); one record has one formatVersion.`,
    );
  out.write(
    `Pack ${releaseId} (${pack.type}), ${variants.length} variant${variants.length === 1 ? "" : "s"}\n`,
  );
  for (const v of variants) {
    const n = v.payload.files.length;
    out.write(
      `- ${(v.key || "default").padEnd(20)} ${path.relative(opts.cwd, v.location) || "."}: ${n} entr${n === 1 ? "y" : "ies"}` +
        `${v.stripped.length ? `; strip${opts.dryRun ? " would remove" : "s"} ${v.stripped.join(", ")}` : ""}\n`,
    );
  }
  if (errors.length)
    throw new Error(
      `Lint failed; nothing was published:\n${errors.map((e) => `  ${e}`).join("\n")}`,
    );
  out.write("Lint: ok\n");

  const work = mkdtempSync(path.join(os.tmpdir(), "pkey-pack-"));
  try {
    const z: Zstd = zstdCli(work, opts.zstdBin);

    // 3. Objects, proven.
    const built = new Map<string, BuiltPayload>();
    for (const v of variants) {
      const b = await buildPayload(z, v.payload);
      await selfCheckPayload(z, b);
      built.set(v.key, b);
    }
    out.write(
      `Self-check: every files index parses and rebuilds its payload byte for byte (zstd ${z.version})\n`,
    );
    // The chunker runs over every eligible variant now (it needs no server); bundles and the
    // index wait for the chain and the presence answers (plans/P4-10.md §2.4).
    const chunked = new Map<string, Chunk[]>();
    const chunksOmitted = new Map<string, string>();
    if (pack.patch.strategies.includes("chunk"))
      for (const v of variants) {
        const b = built.get(v.key)!;
        if (
          v.payload.layout === "container" &&
          b.payload.size >=
            (opts.chunkMinPayloadBytes ?? CHUNK_MIN_PAYLOAD_BYTES)
        )
          chunked.set(v.key, chunkContainer(v.payload.bytes, v.payload.files));
      }

    // 4. Credentials, discovery, the preflight.
    const pem = opts.releaseKeyPem ?? opts.env[RELEASE_KEY_ENV] ?? undefined;
    let sign: ((record: ReleaseRecordDoc) => Promise<string>) | null = null;
    if (!opts.dryRun) {
      if (opts.signRecord) sign = opts.signRecord;
      else if (pem) sign = recordSigner(pem, ctx.releaseKeys);
      else
        throw new Error(
          `A pack release is a signed release record: set ${RELEASE_KEY_ENV} (the release-key input of polaris-key/publish) or --release-key-file.`,
        );
    }
    let client: CiClient | null = null;
    try {
      const token = await resolveCiToken({
        baseUrl: opts.baseUrl,
        product: opts.product,
        env: opts.env,
        out,
        log: opts.stderr,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
      });
      client = ciClient({
        baseUrl: opts.baseUrl,
        product: opts.product,
        token,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: opts.stderr,
      });
    } catch (e) {
      if (!opts.dryRun || e instanceof CiRequestError) throw e;
      out.write(`Server checks: skipped (${(e as Error).message})\n`);
    }
    if (client) {
      const discovery = await requirePacksDiscovery(client, opts.fetchImpl);
      if (!discovery.chunks && chunked.size > 0) {
        for (const key of chunked.keys())
          chunksOmitted.set(
            key,
            "this Polaris Key does not advertise release.chunks (it predates chunk-index ingest)",
          );
        warn(
          `${client.url(".well-known/polaris.json")} does not advertise release.chunks: this release ships without chunk indexes.`,
        );
        chunked.clear();
      }
    }

    const deltaWanted =
      pack.patch.strategies.includes("delta") && pack.patch.deltaBases > 0;
    const cached =
      opts.bases && (deltaWanted || chunked.size > 0)
        ? (
            await cachedReleases(
              path.resolve(opts.cwd, opts.bases),
              packId,
              warn,
            )
          ).filter((c) => c.version !== version)
        : [];
    const listed = cached.slice(0, MAX_PREFLIGHT_RELEASES - 1);
    let seq: number | undefined;
    let gate: string | null | undefined;
    let proven: CachedRelease[] = [];
    if (client) {
      const answer = await client.postJson<{ seqs?: SeqAnswer[] }>(
        "release/publish/uploads",
        {
          what: "Asking for the release's seq and the pack's delivery gate",
          body: {
            releases: [
              { deliverable: packId, version },
              ...listed.map((c) => ({
                deliverable: packId,
                version: c.version,
              })),
            ],
          },
        },
      );
      const seqs = Array.isArray(answer.seqs) ? answer.seqs : [];
      const mine = seqs.find(
        (s) => s.deliverable === packId && s.version === version,
      );
      if (!mine || !Number.isSafeInteger(mine.seq) || mine.seq < 1)
        throw new Error(
          `${client.url("release/publish/uploads")} answered no seq for ${releaseId} (an older Polaris Key?).`,
        );
      if (mine.entitlement === undefined)
        throw new Error(
          `${client.url("release/publish/uploads")} answered no delivery gate for ${packId}: it does not know ${packId} as a pack yet (resync .pkey/release in the console) or predates pack releases.`,
        );
      if (mine.recordSha256)
        throw new Error(
          `${releaseId} is already published (record sha256 ${mine.recordSha256.slice(0, 12)}…); a pack release is never rewritten. Publish a new version.`,
        );
      seq = mine.seq;
      gate = mine.entitlement;
      out.write(
        `Release ${releaseId}: seq ${seq}; delivery gate: ${gate ?? "none (ungated)"}\n`,
      );
      if (pack.entitlement !== null && pack.entitlement !== gate)
        throw new Error(
          `.pkey/release asserts ${packId} is gated by ${pack.entitlement}, but its delivery gate is ${gate ?? "none"}: set it under Distribution → Access first (an operator decides who may download a pack). Nothing was uploaded.`,
        );
      for (const c of listed) {
        const s = seqs.find(
          (x) => x.deliverable === packId && x.version === c.version,
        );
        if (
          s?.recordSha256 === c.recordSha256 &&
          s.seq === c.seq &&
          c.seq < seq
        )
          proven.push(c);
        else
          warn(
            `base ${packId} ${c.version}: the cached record is not the one Polaris Key stores${s?.recordSha256 ? "" : " (no stored record)"}; no delta from it.`,
          );
      }
    } else {
      proven = listed;
      if (proven.length)
        warn(
          "the cached bases are used unproven: without a CI credential the dry run cannot ask Polaris Key for their record hashes.",
        );
    }
    const bases: Base[] = [];
    for (const c of deltaWanted ? proven.slice(0, pack.patch.deltaBases) : [])
      bases.push(
        await loadBase(
          pack,
          c,
          variants.map((v) => v.key),
          warn,
        ),
      );
    if (deltaWanted && cached.length > 0 && bases.length === 0)
      warn(
        `no proven delta base for ${packId}; this release ships without deltas.`,
      );
    else if (bases.length === 0 && (deltaWanted || !opts.bases))
      out.write(
        `No earlier release of ${packId} is cached${opts.bases ? "" : " (no --bases)"}; this release ships without deltas.\n`,
      );

    // The chunk chains: per chunked variant, the newest proven cached index of the same gating
    // class, then which of its bundles the product still holds (an upload ticket's `present`).
    const gated = gate !== null && gate !== undefined;
    const gateClass = gate === undefined ? pack.entitlement : gate;
    const chains = new Map<string, ChunkChainBase>();
    for (const key of chunked.keys()) {
      const base = await chunkChainBase(proven, key, gateClass, warn);
      if (base) chains.set(key, base);
    }
    const presentBundles = new Set<string>();
    {
      const ask = new Map<string, number>();
      for (const c of chains.values())
        for (const [sha, size] of c.index.bundles) ask.set(sha, size);
      const list = [...ask].map(([sha256, size]) => ({ sha256, size }));
      if (client)
        for (let i = 0; i < list.length; i += STAGE_ROUND_OBJECTS) {
          const ticket = await requestTicket(
            client,
            list.slice(i, i + STAGE_ROUND_OBJECTS),
            gated,
            opts,
          );
          for (const o of ticket.objects)
            if (o.present) presentBundles.add(o.sha256);
        }
      else if (list.length > 0) {
        for (const o of list) presentBundles.add(o.sha256);
        warn(
          "the cached chunk bundles are assumed stored: without a CI credential the dry run cannot ask Polaris Key which it holds.",
        );
      }
    }

    // 5. Deltas, per variant, newest base first.
    const objects = new Map<string, StagedObject>();
    const addObject = (bytes: Uint8Array, label: string) => {
      const sha256 = sha256Hex(bytes);
      if (!objects.has(sha256))
        objects.set(sha256, { sha256, size: bytes.byteLength, bytes, label });
    };
    const reports: PackVariantReport[] = [];
    const recordVariants: PackVariant[] = [];
    const builtChunks = new Map<string, BuiltChunks>();
    for (const v of variants) {
      const b = built.get(v.key)!;
      addObject(b.full.stored, `${v.key || "default"} full`);
      addObject(b.indexStored.stored, `${v.key || "default"} files index`);
      if (b.gaps) addObject(b.gaps.stored, `${v.key || "default"} gaps`);
      for (const [fileSha, s] of b.blobs)
        addObject(s.stored, `file ${fileSha.slice(0, 12)}…`);
      const deltas: NonNullable<PackVariant["deltas"]> = [];
      const report: PackVariantReport = {
        key: v.key,
        payload: b.payload,
        stripped: v.stripped,
        entries: b.files.length,
        lintWarnings: v.lintWarnings,
        bytes: {
          full: b.full.ref.bytes,
          file:
            b.indexStored.ref.bytes +
            (b.gaps?.ref.bytes ?? 0) +
            b.index.files.reduce((a, e) => a + e.blob.bytes, 0),
          deltas: [],
        },
        skippedDeltas: [],
        noise: [],
      };
      for (const base of bases) {
        const bp = base.payloads.get(v.key);
        if (!bp) continue;
        const from = base.release.version;
        report.noise.push(
          ...noiseReport(bp.files, b.files).map((n) => `against ${from}: ${n}`),
        );
        if (b.layout === "container" && bp.bytes) {
          const pd = buildPayloadDelta(
            z,
            { bytes: bp.bytes, sha256: bp.sha256 },
            b as BuiltPayload & { layout: "container" },
            (v.payload as { bytes: Uint8Array }).bytes,
          );
          if ("skipped" in pd)
            report.skippedDeltas.push(
              `payload delta from ${from}: ${pd.skipped}`,
            );
          else {
            deltas.push(pd.delta);
            addObject(
              pd.stored,
              `${v.key || "default"} payload delta from ${from}`,
            );
            report.bytes.deltas.push({
              from: bp.sha256,
              version: from,
              scope: "payload",
              bytes: pd.delta.artifact.bytes,
            });
          }
        }
        const fd = buildFilesDelta(
          z,
          { sha256: bp.sha256, files: bp.files },
          b,
        );
        if ("skipped" in fd)
          report.skippedDeltas.push(`files delta from ${from}: ${fd.skipped}`);
        else {
          for (const p of fd.magicBases)
            report.skippedDeltas.push(
              `files delta from ${from}: ${p}'s base starts with the zstd dictionary magic 37 A4 30 EC, so it ships as a blob entry (§2.7 rule 5)`,
            );
          deltas.push(fd.delta);
          addObject(fd.patchStored, `${v.key || "default"} patch from ${from}`);
          addObject(
            fd.dataStored,
            `${v.key || "default"} patch data from ${from}`,
          );
          report.bytes.deltas.push({
            from: bp.sha256,
            version: from,
            scope: "files",
            bytes:
              b.indexStored.ref.bytes +
              (b.gaps?.ref.bytes ?? 0) +
              fd.delta.patch.bytes +
              fd.delta.data.bytes,
          });
        }
      }
      const label = v.key || "default";
      for (const s of report.skippedDeltas) warn(`${label}: ${s}`);
      for (const n of report.noise) warn(`${label}: re-import noise ${n}`);

      // The chunk index and its new bundles (plans/P4-10.md §2.4).
      let chunksRef: PackVariant["chunks"];
      const omittedWhy = chunksOmitted.get(v.key);
      if (omittedWhy) report.chunksOmitted = omittedWhy;
      const list = chunked.get(v.key);
      if (list) {
        const base = chains.get(v.key) ?? null;
        const reuse = base
          ? priorLocations(base.index, (sha) => presentBundles.has(sha))
          : new Map();
        if (base) {
          const absent = base.index.bundles.filter(
            ([sha]) => !presentBundles.has(sha),
          ).length;
          if (absent > 0)
            warn(
              `${label}: ${absent} chunk bundle${absent === 1 ? "" : "s"} of the chain from ${base.version} ${absent === 1 ? "is" : "are"} not stored; their chunks are packed fresh.`,
            );
        }
        const outcome = await buildChunks(
          z,
          {
            bytes: (v.payload as { bytes: Uint8Array }).bytes,
            ...b.payload,
          },
          list,
          base,
          reuse,
          { maxIndexBytes: opts.maxChunkIndexBytes },
        );
        if ("omitted" in outcome) {
          report.chunksOmitted = outcome.omitted;
          warn(`${label}: no chunk index: ${outcome.omitted}.`);
        } else {
          chunksRef = outcome.ref;
          builtChunks.set(v.key, outcome);
          addObject(outcome.index.stored, `${label} chunk index`);
          for (const [sha, bytes] of outcome.bundles)
            addObject(bytes, `${label} chunk bundle ${sha.slice(0, 12)}…`);
          report.chunks = {
            ...outcome.stats,
            sha256: outcome.index.ref.sha256,
            bytes: outcome.index.ref.bytes,
            base: base?.version ?? null,
          };
        }
      }
      reports.push(report);
      recordVariants.push({
        variant: v.variant,
        payload: b.payload,
        full: b.full.ref,
        files: filesRefOf(b),
        ...(deltas.length ? { deltas } : {}),
        ...(chunksRef ? { chunks: chunksRef } : {}),
        // P4-12: the declaration's requirements, signed into every variant (the record is the
        // truth resolution reads: a release keeps the range it was published with).
        ...(pack.requires.engine ||
        pack.requires.contentApi ||
        pack.requires.packs
          ? {
              requires: {
                ...(pack.requires.engine
                  ? { engine: pack.requires.engine }
                  : {}),
                ...(pack.requires.contentApi
                  ? { contentApi: pack.requires.contentApi }
                  : {}),
                ...(pack.requires.packs ? { packs: pack.requires.packs } : {}),
              },
            }
          : {}),
        ...(pack.conflicts.length > 0 ? { conflicts: pack.conflicts } : {}),
      });
    }

    // 6. The record.
    const provenance = provenanceFrom(opts.env);
    const record: PackRecordDoc = {
      schemaVersion: 1,
      aud: opts.product,
      deliverable: packId,
      kind: "pack",
      version,
      seq: seq ?? 1,
      issuedAt: opts.now ?? Math.floor(Date.now() / 1000),
      ...(opts.minSupportedSeq !== undefined
        ? { minSupportedSeq: opts.minSupportedSeq }
        : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(opts.channel?.trim() ? { channel: opts.channel.trim() } : {}),
      ...(provenance ? { provenance } : {}),
      type: pack.type,
      formatVersion: variants[0]!.formatVersion,
      handler: {
        ...(pack.handler.mountOrder !== undefined
          ? { mountOrder: pack.handler.mountOrder }
          : {}),
        ...(pack.handler.prefixes ? { prefixes: pack.handler.prefixes } : {}),
        activation: pack.handler.activation,
      },
      ...(gate ? { entitlement: gate } : {}),
      variants: recordVariants,
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(record));
    if (payloadBytes > MAX_RECORD_PAYLOAD_BYTES)
      throw new Error(
        `The pack record is ${payloadBytes} bytes; a release record is at most ${MAX_RECORD_PAYLOAD_BYTES} (fewer variants or delta bases).`,
      );
    if (!releaseRecordClaims(record, { expectedAud: opts.product }))
      throw new Error(
        "Self-check: the pack record fails the record claims (WIRE-CONTRACT-V4 §2.5.1); nothing was published.",
      );

    printReport(out, reports, objects.size);

    const result: PackPublishResult = {
      releaseId,
      dryRun: opts.dryRun === true,
      record,
      ...(gate !== undefined ? { gate } : {}),
      uploaded: [],
      skipped: [],
      objects: [...objects.keys()],
      warnings,
      variants: reports,
      markers: [],
    };

    // 7. Tickets (a dry run asks only which objects are stored), rounds, the submit.
    const list = [...objects.values()];
    if (opts.dryRun) {
      if (client) {
        let present = 0;
        for (let i = 0; i < list.length; i += STAGE_ROUND_OBJECTS) {
          const ticket = await requestTicket(
            client,
            list.slice(i, i + STAGE_ROUND_OBJECTS),
            gated,
            opts,
          );
          present += ticket.objects.filter((o) => o.present).length;
        }
        out.write(
          `Objects: ${list.length - present} new, ${present} already stored (deduplicated)\n`,
        );
      }
      const { seq: _seq, ...shown } = record;
      out.write(
        `\nPack record (unsigned; a dry run signs nothing${seq === undefined ? "; seq is the preflight's answer" : ""}):\n${JSON.stringify(seq === undefined ? shown : record, null, 2)}\n`,
      );
      out.write("Dry run: nothing uploaded, signed or written.\n");
      return result;
    }

    const jws = await sign!(record as unknown as ReleaseRecordDoc);
    if (jws.length > MAX_RECORD_JWS_BYTES)
      throw new Error(
        `The signed pack record is ${jws.length} bytes; at most ${MAX_RECORD_JWS_BYTES}.`,
      );
    await checkSignedRecord(
      jws,
      record as unknown as ReleaseRecordDoc,
      ctx.releaseKeys,
    );
    result.recordJws = jws;
    const recordSha256 = sha256Hex(jws);
    out.write(
      `Signed the pack record (seq ${record.seq}, sha256 ${recordSha256.slice(0, 12)}…)\n`,
    );

    // The stripped PCK, in place: the embedded copy must be the bytes the marker pins.
    for (const v of variants)
      if (v.rewrite) {
        await writeFile(v.location, v.rewrite);
        out.write(
          `Wrote the stripped ${path.basename(v.location)} back in place\n`,
        );
      }

    const objDir = path.join(work, "objects");
    await mkdir(objDir, { recursive: true });
    for (let i = 0; i < list.length; i += STAGE_ROUND_OBJECTS) {
      const round = list.slice(i, i + STAGE_ROUND_OBJECTS);
      let attempt = 0;
      for (;;) {
        try {
          await stageRound(client!, round, gated, packId, objDir, opts, result);
          break;
        } catch (e) {
          attempt += 1;
          if (attempt > 1 || !(e instanceof CiRequestError)) throw e;
          opts.stderr.write(
            `Stage round failed (${e.message.split("\n")[0]}); retrying with a new ticket\n`,
          );
        }
      }
    }
    out.write(
      `Uploaded ${result.uploaded.length} object${result.uploaded.length === 1 ? "" : "s"}; ${result.skipped.length} already stored\n`,
    );
    const server = await client!.postJson("release/publish/submit", {
      what: "Submitting the pack record",
      body: { record: jws },
    });
    result.server = server;
    out.write(
      `Published ${String(server.releaseId ?? releaseId)} (${String(server.outcome)})\n`,
    );

    // 8. Markers beside the payloads, then the cache for the next publish's --bases.
    const marker = markerJson(packId, version, jws);
    for (const v of variants) {
      const file = markerPathFor(pack.type, v.location);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, marker);
      result.markers.push(file);
    }
    out.write(
      `Wrote ${result.markers.length} marker${result.markers.length === 1 ? "" : "s"} beside the payloads\n`,
    );
    if (opts.out) {
      const dest = path.join(path.resolve(opts.cwd, opts.out), packId, version);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "record.jws"), `${jws}\n`);
      for (const v of variants) {
        const vdir = path.join(dest, variantDirName(v.variant));
        await mkdir(vdir, { recursive: true });
        if (pack.type === "godot.pck")
          await writeFile(
            path.join(vdir, path.basename(v.location)),
            (v.payload as { bytes: Uint8Array }).bytes,
          );
        else
          await cp(v.location, vdir, {
            recursive: true,
            filter: (src) =>
              path.relative(v.location, src).split(path.sep)[0] !== ".pkey",
          });
        const ck = builtChunks.get(v.key);
        if (ck)
          await writeFile(
            path.join(vdir, `chunks.${ck.index.ref.sha256}`),
            ck.index.stored,
          );
      }
      out.write(
        `Kept the record and payloads at ${path.relative(opts.cwd, dest) || dest} (for --bases)\n`,
      );
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface SeqAnswer {
  deliverable: string;
  version: string;
  seq: number;
  recordSha256?: string;
  entitlement?: string | null;
}

interface TicketAnswer {
  ticket: string;
  credentials: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  objects: {
    sha256: string;
    size: number;
    key: string;
    target: string;
    present: boolean;
  }[];
}

async function requestTicket(
  client: CiClient,
  objects: readonly Pick<StagedObject, "sha256" | "size">[],
  gated: boolean,
  opts: PackPublishOptions,
): Promise<TicketAnswer> {
  const t = await client.postJson<Partial<TicketAnswer>>(
    "release/publish/uploads",
    {
      what: "Requesting an upload ticket",
      body: {
        objects: objects.map((o) => ({
          sha256: o.sha256,
          size: o.size,
          gated,
        })),
        // P4-22: `present` then means THIS pack uploaded the object (what ingest requires of a
        // chunk index and its bundles), not merely the product. A Worker before P4-22 ignores it.
        deliverable: opts.deliverable,
      },
    },
  );
  if (
    typeof t.ticket !== "string" ||
    !t.credentials ||
    !Array.isArray(t.objects)
  )
    throw new Error(
      `${client.url("release/publish/uploads")} answered without a ticket and credentials.`,
    );
  mask(opts.env, opts.stdout, t.ticket);
  mask(opts.env, opts.stdout, t.credentials.secretAccessKey);
  mask(opts.env, opts.stdout, t.credentials.sessionToken);
  return t as TicketAnswer;
}

/** One stage round: a ticket, a PUT of every object not present, then `publish/stage`. */
async function stageRound(
  client: CiClient,
  round: readonly StagedObject[],
  gated: boolean,
  packId: string,
  objDir: string,
  opts: PackPublishOptions,
  result: PackPublishResult,
): Promise<void> {
  const ticket = await requestTicket(client, round, gated, opts);
  const bySha = new Map(round.map((o) => [o.sha256, o]));
  // Every requested object must come back: one the ticket leaves out would never be staged,
  // and the record submit would then fail at ingest as pack-object.
  const answered = new Set(ticket.objects.map((o) => o.sha256));
  const missing = round.filter((o) => !answered.has(o.sha256));
  if (missing.length)
    throw new Error(
      `${client.url("release/publish/uploads")} answered a ticket without ${missing.length} of the ${round.length} requested objects (${missing
        .slice(0, 3)
        .map((o) => `${o.sha256.slice(0, 12)}…`)
        .join(
          ", ",
        )}${missing.length > 3 ? ", …" : ""}); nothing of this round was staged.`,
    );
  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const o of ticket.objects) {
    if (o.present) {
      skipped.push(o.target);
      continue;
    }
    const obj = bySha.get(o.sha256);
    if (!obj)
      throw new Error(
        `The ticket names ${o.sha256}, which pkey did not ask for.`,
      );
    const file = path.join(objDir, obj.sha256);
    await writeFile(file, obj.bytes);
    await putFile({
      creds: ticket.credentials,
      key: o.key,
      file,
      size: obj.size,
      sha256: obj.sha256,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
    });
    uploaded.push(o.target);
  }
  if (uploaded.length > 0)
    await client.postJson("release/publish/stage", {
      what: `Staging ${uploaded.length} object${uploaded.length === 1 ? "" : "s"} of ${packId}`,
      body: { ticket: ticket.ticket, deliverable: packId },
    });
  result.uploaded.push(...uploaded);
  result.skipped.push(...skipped);
}

function printReport(
  out: Out,
  reports: readonly PackVariantReport[],
  objectCount: number,
): void {
  for (const r of reports) {
    out.write(
      `\nVariant ${r.key || "default"}: payload ${r.payload.size} B, sha256 ${r.payload.sha256.slice(0, 12)}…, ${r.entries} entries\n`,
    );
    if (r.stripped.length) out.write(`  stripped: ${r.stripped.join(", ")}\n`);
    for (const w of r.lintWarnings) out.write(`  lint warning: ${w}\n`);
    out.write(
      `  bytes per strategy: full ${r.bytes.full}; file ${r.bytes.file}`,
    );
    for (const d of r.bytes.deltas)
      out.write(`; ${d.scope} delta from ${d.version} ${d.bytes}`);
    out.write("\n");
    if (r.chunks)
      out.write(
        `  chunks: ${r.chunks.chunks} (${r.chunks.uniqueChunks} distinct), index ${r.chunks.bytes} B; ` +
          `${r.chunks.newBundles} new bundle${r.chunks.newBundles === 1 ? "" : "s"} (${r.chunks.newBytes} B); ` +
          `reused ${r.chunks.reusedBytes} B in ${r.chunks.reusedBundles} bundle${r.chunks.reusedBundles === 1 ? "" : "s"}` +
          `${r.chunks.base ? ` from ${r.chunks.base}` : " (a fresh chain)"}\n`,
      );
    else if (r.chunksOmitted)
      out.write(`  chunks: none (${r.chunksOmitted})\n`);
    for (const s of r.skippedDeltas) out.write(`  skipped: ${s}\n`);
    for (const n of r.noise) out.write(`  re-import noise: ${n}\n`);
  }
  out.write(`\n${objectCount} distinct objects\n`);
}
