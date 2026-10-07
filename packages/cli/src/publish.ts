/**
 * `pkey release publish` (P2-06, README §3.4 "Publishing"): turn a directory of built files into
 * a release on Polaris Key, from a CI job, without a long-lived secret.
 *
 *   1. Load `.pkey/` and match every file under `--dir` against the deliverable's
 *      `artifacts[].match` (P2-04's artifact map). An entry matching no file is a warning and its
 *      build is omitted; an entry matching more than one is an error. `<file>.sig` and
 *      `<file>.sha256` beside a matched file ride along as its `signature` and `checksum`.
 *   2. Hash every file with a streamed SHA-256 (artifacts reach 2 GiB; the runner's memory does
 *      not), and read build numbers, minimum OS and `requires` from `--meta`. For an `ios`/`ipa`
 *      or `android`/`apk` build, read the payload's facts the storefront feeds need into
 *      `builds[].metadata` (P2b-05, `buildMetadata.ts`): the Worker never unzips an archive. A
 *      payload that cannot be read is a warning and its build carries no metadata.
 *   3. Build the release descriptor and validate it LOCALLY with `validateReleaseDescriptor` — the
 *      same function the Worker runs — so a mistake costs no round trip.
 *   4. Exchange credentials (`oidc.ts`), request an upload ticket, PUT every object the product
 *      does not already hold (`s3.ts`), and submit the descriptor. A refusal is printed with the
 *      server's reason and fails the job.
 *
 * `--dry-run` does steps 1–3, requests a ticket, and submits with `dryRun: true`: it prints the
 * descriptor and the server's verdict and uploads nothing and writes nothing. Without any CI
 * credential (a laptop), it stops after the local validation and says so.
 *
 * `--source github` uploads nothing: every file is located as an asset of the tagged GitHub
 * release, which the Worker requires to be IMMUTABLE and whose digests it cross-checks.
 *
 * ── SEQ AND THE RELEASE RECORD (P3-03) ───────────────────────────────────────────────────────
 *
 * The ticket request names the release (`releases: [{deliverable, version}]`), and the answer's
 * `seqs` carries its `seq`: the stored one when the release exists (the GitHub sync may have
 * created it), else the next one. A re-run gets the stored value again, so the descriptor — which
 * now carries that `seq` — is the same descriptor and the re-run stays a no-op. (`nextSeq` alone
 * could not do that: the first run moved it on.)
 *
 * With a release key (`PKEY_RELEASE_KEY`, or `--release-key-file`), the descriptor is then moved
 * into a release record (`descriptorToRecord`, plans/P3-01.md §2.4), signed as `pkey-release+jws`
 * through the `signRecord` seam, checked here with `verifyJws` and `releaseRecordClaims`, and
 * submitted as `record` beside the descriptor. The key never leaves this process: it is not
 * logged, and no request carries it. A product that declares `releaseKeys` must sign (or say
 * `--no-record`); a key that `.pkey/release` does not declare is refused before any request.
 * `--dry-run` prints the record unsigned and signs nothing.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
 *
 * Building, exporting, signing binaries, notarising and store uploads (vendor tools do those;
 * Polaris Key is not a build server).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  APP_DELIVERABLE_ID,
  buildLabel,
  descriptorToRecord,
  matchesArtifactGlob,
  parseManifest,
  validateReleaseDescriptor,
  type DescriptorArtifact,
  type DescriptorBuild,
  type DescriptorManifest,
  type ManifestArtifactEntry,
  type ManifestPackageDeliverable,
  type ManifestReleaseKey,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import {
  ciClient,
  CiRequestError,
  type Out,
  type Sleep,
  type StageProgress,
} from "./ci.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { MAX_SINGLE_PUT_BYTES, putFile } from "./s3.js";
import { buildMetadataFor } from "./buildMetadata.js";
import {
  contentInterfaceFingerprint,
  judgeContentInterface,
} from "./saveCompat.js";
import {
  checkSignedRecord,
  recordSigner,
  RELEASE_KEY_ENV,
} from "./releaseKeys.js";
import type { AppContent } from "@polaris-key/protocol/packs";
import {
  contentFor,
  contentRuleProblems,
  describeContent,
  embedsFor,
  markerPins,
  mergePins,
  readContentStamp,
  resolvePins,
  type SourcedPin,
} from "./contentStamp.js";
import { packContext, requirePacksDiscovery } from "./packManifest.js";

export const PUBLISH_USAGE =
  "Usage: pkey release publish --product <slug> --version <v> --dir <path> " +
  "[--deliverable app|<packId>|<packageId>] [--tag vX.Y.Z] [--channel <c>] [--source r2|github] " +
  "[--meta builds.json] [--base-url <url>] [--release-key-file <pem>] " +
  "[--min-supported-seq <n>] [--no-record] " +
  "[--content-stamp <file> | --embedded <dir> --pin <packId>@<version> ...] " +
  "[--out <dir>] [--bases <dir>] [--dry-run]";

/**
 * The sidecar suffixes picked up beside a matched file, and the role each plays. A `.zsync` is an
 * AppImage's zsync control file (`appimagetool -u`, `zsyncmake`): the Worker serves it at the
 * build's stable per-channel URL with its `URL:` rewritten (P3-09).
 */
const SIDECARS = [
  [".sig", "signature"],
  [".sha256", "checksum"],
  [".zsync", "checksum"],
] as const;

export type PublishSource = "r2" | "github";

export interface PublishOptions {
  /** Where `.pkey/` lives. */
  cwd: string;
  product: string;
  deliverable?: string;
  version?: string;
  tag?: string;
  channel?: string;
  /** The directory of built files (searched recursively). Relative to `cwd`. */
  dir: string;
  source?: PublishSource;
  /** `--meta`: a JSON file `{"<buildId>": {buildNumber, minOS, requires}}`. Relative to `cwd`. */
  meta?: string;
  dryRun?: boolean;
  baseUrl?: string;
  /** The process environment (GitHub's variables, `PKEY_CI_TOKEN`), passed in for testability. */
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  /**
   * The release key's PKCS#8 PEM (`--release-key-file`'s contents). Absent: `PKEY_RELEASE_KEY`
   * from `env`. Never logged, never sent.
   */
  releaseKeyPem?: string;
  /** `--min-supported-seq`: the record's `minSupportedSeq` (a floor for the targets it pins). */
  minSupportedSeq?: number;
  /** `--no-record`: publish without a release record although `releaseKeys` are declared. */
  noRecord?: boolean;
  /**
   * P2-06's seam, implemented here (P3-03; P4-03 reuses it for pack records): sign the release
   * record and return the compact JWS. Default: the release key, under the declared `kid` whose
   * public half matches it (`releaseKeys.ts`).
   */
  signRecord?: (record: ReleaseRecordDoc) => Promise<string>;
  /** Epoch seconds for the record's `issuedAt` (tests). */
  now?: number;
  /**
   * `--content-stamp` (P4-03): the `pkey-content/1` stamp the build embeds; its members become the
   * descriptor's `content`, which `descriptorToRecord` moves into the record (decision 37).
   */
  contentStamp?: string;
  /** `--embedded`: compute the content from the markers under this directory instead. */
  embedded?: string;
  /** `--pin <packId>@<version>`: pins for packs this build does not embed. */
  pins?: string[];
  /**
   * P4-20 `--content-interface`: the JSON registry of what the code references, hashed into the
   * release's content-interface fingerprint (`saveCompat.ts`), stored as unsigned metadata.
   */
  contentInterface?: string;
  /** P4-20 `--strict`: fail, not warn, when the fingerprint changed and contentApi did not. */
  strict?: boolean;
  /** The stages as they start (hashing, uploading, submitting): the CLI's spinner. */
  progress?: StageProgress;
}

export interface PublishResult {
  descriptor: ReleaseDescriptor;
  releaseId: string;
  dryRun: boolean;
  /** The server's answer to the submit; absent when a dry run had no credential. */
  server?: Record<string, unknown>;
  /** The release record (unsigned on a dry run), once the release's `seq` is known. */
  record?: ReleaseRecordDoc;
  /** The signed record, when one was submitted. */
  recordJws?: string;
  /** Storage keys uploaded, and those skipped as already held by the product. */
  uploaded: string[];
  skipped: string[];
  warnings: string[];
  /** The descriptor's `content` (P4-03), when the product declares packs. */
  content?: AppContent;
  /** P4-20: the content-interface fingerprint, when `--content-interface` was given. */
  contentInterface?: string;
}

// ── 1. Matching ──────────────────────────────────────────────────────────────────────────────

export interface FoundFile {
  /** Absolute path. */
  path: string;
  /** The file name (what a descriptor names, and what `match` is tested against). */
  name: string;
}

export interface MatchedFile extends FoundFile {
  role: DescriptorArtifact["role"];
}

export interface MatchedBuild {
  entry: ManifestArtifactEntry;
  /** The file playing the entry's role, then its sidecars. */
  files: MatchedFile[];
}

export interface MatchResult {
  builds: MatchedBuild[];
  warnings: string[];
  errors: string[];
}

/** Every regular file under `dir`, recursively (`actions/download-artifact` nests by artifact). */
export async function scanDir(dir: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push({ path: full, name: e.name });
    }
  }
  try {
    await walk(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`--dir ${dir} does not exist.`);
    throw e;
  }
  return out;
}

function isSidecarOf(name: string, all: ReadonlySet<string>): boolean {
  return SIDECARS.some(
    ([suffix]) =>
      name.endsWith(suffix) && all.has(name.slice(0, -suffix.length)),
  );
}

/**
 * Match files to artifact-map entries. Sidecars of another file never match an entry
 * themselves (a `diceroll-*` glob would otherwise claim `diceroll-1.0.zip.sha256`).
 */
export function matchArtifacts(
  files: readonly FoundFile[],
  entries: readonly ManifestArtifactEntry[],
): MatchResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const names = new Set(files.map((f) => f.name));
  const candidates = files.filter((f) => !isSidecarOf(f.name, names));
  const claimedBy = new Map<string, string>();
  const builds: MatchedBuild[] = [];
  for (const entry of entries) {
    const hits = candidates.filter((f) =>
      matchesArtifactGlob(entry.match, f.name),
    );
    if (hits.length === 0) {
      warnings.push(
        `artifacts entry ${entry.id} (${entry.match}) matched no file; build ${entry.id} is omitted.`,
      );
      continue;
    }
    if (hits.length > 1) {
      errors.push(
        `artifacts entry ${entry.id} (${entry.match}) matches ${hits.length} files: ${hits
          .map((h) => path.basename(h.path))
          .join(", ")}. Exactly one file may play a build's ${entry.role}.`,
      );
      continue;
    }
    const hit = hits[0]!;
    const prior = claimedBy.get(hit.path);
    if (prior) {
      errors.push(
        `${hit.name} matches both artifacts entries ${prior} and ${entry.id}; a file belongs to one build.`,
      );
      continue;
    }
    claimedBy.set(hit.path, entry.id);
    const matched: MatchedFile[] = [{ ...hit, role: entry.role }];
    for (const [suffix, role] of SIDECARS) {
      const side = files.find(
        (f) =>
          f.name === `${hit.name}${suffix}` &&
          path.dirname(f.path) === path.dirname(hit.path),
      );
      if (side) matched.push({ ...side, role });
    }
    builds.push({ entry, files: matched });
  }
  // Two files with one name (in different subdirectories) would be two artifacts with one name.
  const seen = new Map<string, string>();
  for (const b of builds)
    for (const f of b.files) {
      const other = seen.get(f.name);
      if (other && other !== f.path)
        errors.push(
          `${f.name} is found twice (${other} and ${f.path}); file names are unique within a release.`,
        );
      seen.set(f.name, f.path);
    }
  if (builds.length === 0 && errors.length === 0)
    errors.push(
      "No file under --dir matches any artifacts entry; nothing to publish.",
    );
  return { builds, warnings, errors };
}

// ── 2. Hashing and --meta ────────────────────────────────────────────────────────────────────

/** Streamed SHA-256 and size of one file; never holds more than one chunk. */
export async function hashFile(
  file: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    size += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), size };
}

export interface BuildMeta {
  buildNumber?: string;
  minOS?: string;
  requires?: Record<string, unknown>;
}

/** Read and check `--meta`. Unknown build ids and unknown fields are errors (they are typos). */
export async function readMeta(
  file: string,
  entryIds: readonly string[],
): Promise<Record<string, BuildMeta>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (e) {
    throw new Error(
      `--meta ${file} is not readable JSON: ${(e as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`--meta ${file} must be an object keyed by build id.`);
  const out: Record<string, BuildMeta> = {};
  const problems: string[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryIds.includes(id)) {
      problems.push(`${id} is not an artifacts entry of this deliverable`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${id} must be an object`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const m: BuildMeta = {};
    for (const key of Object.keys(v))
      if (!["buildNumber", "minOS", "requires"].includes(key))
        problems.push(
          `${id}.${key} is not one of buildNumber, minOS, requires`,
        );
    if (v.buildNumber !== undefined) {
      if (typeof v.buildNumber === "string") m.buildNumber = v.buildNumber;
      else if (
        Number.isSafeInteger(v.buildNumber) &&
        (v.buildNumber as number) >= 0
      )
        m.buildNumber = String(v.buildNumber);
      else
        problems.push(`${id}.buildNumber must be a string or a whole number`);
    }
    if (v.minOS !== undefined) {
      if (typeof v.minOS === "string") m.minOS = v.minOS;
      else problems.push(`${id}.minOS must be a string`);
    }
    if (v.requires !== undefined) {
      if (
        v.requires &&
        typeof v.requires === "object" &&
        !Array.isArray(v.requires)
      )
        m.requires = v.requires as Record<string, unknown>;
      else problems.push(`${id}.requires must be an object`);
    }
    out[id] = m;
  }
  if (problems.length)
    throw new Error(
      `--meta ${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  return out;
}

// ── 3. The descriptor ────────────────────────────────────────────────────────────────────────

export interface HashedFile extends MatchedFile {
  sha256: string;
  size: number;
}

/** `blobs/sha256/<hex>` — the content address an `r2` location names (P2-01). */
export function blobKey(sha256: string): string {
  return `blobs/sha256/${sha256}`;
}

/** Provenance from the Actions environment: the commit and the run's URL, when present. */
export function provenanceFrom(
  env: CiEnv,
): ReleaseDescriptor["provenance"] | undefined {
  const commit = env.GITHUB_SHA;
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  const out: NonNullable<ReleaseDescriptor["provenance"]> = {};
  if (commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    out.commit = commit;
  if (server?.startsWith("https://") && repo && run && /^\d+$/.test(run))
    out.workflowRun = `${server.replace(/\/+$/, "")}/${repo}/actions/runs/${run}`;
  return out.commit || out.workflowRun ? out : undefined;
}

export interface DescriptorInput {
  product: string;
  deliverable: string;
  version: string;
  tag?: string;
  channel?: string;
  source: PublishSource;
  builds: { entry: ManifestArtifactEntry; files: HashedFile[] }[];
  meta: Record<string, BuildMeta>;
  /** Per build id: what `buildMetadata.ts` read out of the payload (P2b-05). */
  extracted?: Record<string, NonNullable<DescriptorBuild["metadata"]>>;
  provenance?: ReleaseDescriptor["provenance"];
}

export function buildDescriptor(input: DescriptorInput): ReleaseDescriptor {
  const builds: DescriptorBuild[] = input.builds.map(({ entry, files }) => {
    const m = input.meta[entry.id] ?? {};
    return {
      id: entry.id,
      platform: entry.platform,
      arch: entry.arch,
      format: entry.format,
      ...(m.buildNumber !== undefined ? { buildNumber: m.buildNumber } : {}),
      ...(m.minOS !== undefined ? { minOS: m.minOS } : {}),
      ...(m.requires !== undefined ? { requires: m.requires } : {}),
      ...(input.extracted?.[entry.id]
        ? { metadata: input.extracted[entry.id] }
        : {}),
      artifacts: files.map((f) => ({
        name: f.name,
        role: f.role,
        sha256: f.sha256,
        size: f.size,
        locations:
          input.source === "github"
            ? [{ provider: "github" as const, asset: f.name }]
            : [{ provider: "r2" as const, key: blobKey(f.sha256) }],
      })),
    };
  });
  return {
    descriptorVersion: 1,
    product: input.product,
    deliverable: input.deliverable,
    kind: "app",
    version: input.version,
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
    builds,
  };
}

/** The manifest context `validateReleaseDescriptor` checks against, from the loaded `.pkey/`. */
export function descriptorManifestOf(docs: {
  product: unknown;
  schema?: unknown;
  release?: unknown;
  distribution?: unknown;
}): DescriptorManifest & {
  releaseKeys: ManifestReleaseKey[];
  /** F-03: the declared package deliverables, whole (their artifacts globs included). */
  packageDeliverables: ManifestPackageDeliverable[];
} {
  const files: Record<string, string> = {};
  for (const [name, doc] of Object.entries(docs))
    if (doc !== undefined) files[name] = JSON.stringify(doc);
  const res = parseManifest(files);
  if (!res.ok)
    throw new Error(`.pkey/ does not parse:\n  ${res.errors.join("\n  ")}`);
  return {
    product: { slug: res.manifest.product.slug },
    release: {
      app: res.manifest.release?.app ?? null,
      manualChannels: res.manifest.release?.manualChannels ?? [],
      // P4-02: the declared pack ids, the context a descriptor's `content` and `embeds` are
      // checked against (plans/P4-01.md decision 37).
      packs: (res.manifest.release?.packDeliverables ?? []).map((p) => p.id),
      // F-03: the declared packages, the context a `kind: package` descriptor is checked against.
      packages: (res.manifest.release?.packageDeliverables ?? []).map((p) => ({
        id: p.id,
        ecosystem: p.ecosystem,
        name: p.name,
      })),
    },
    releaseKeys: res.manifest.release?.releaseKeys ?? [],
    packageDeliverables: res.manifest.release?.packageDeliverables ?? [],
  };
}

// ── 4. The publish ───────────────────────────────────────────────────────────────────────────

interface TicketObjectAnswer {
  sha256: string;
  size: number;
  key: string;
  target: string;
  present: boolean;
}

interface TicketAnswer {
  ticket: string;
  /** P3-03: each named release's `seq` (absent from an older Worker). */
  seqs?: { deliverable: string; version: string; seq: number }[];
  credentials: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  objects: TicketObjectAnswer[];
}

function asTicket(body: Record<string, unknown>, where: string): TicketAnswer {
  const t = body as unknown as Partial<TicketAnswer>;
  if (
    typeof t.ticket !== "string" ||
    !t.credentials ||
    typeof t.credentials.endpoint !== "string" ||
    !Array.isArray(t.objects)
  )
    throw new Error(`${where} answered without a ticket and credentials.`);
  return t as TicketAnswer;
}

export async function publishRelease(
  opts: PublishOptions,
): Promise<PublishResult> {
  const out = opts.stdout;
  const source: PublishSource = opts.source ?? "r2";
  if (source !== "r2" && source !== "github")
    throw new Error(`--source must be r2 or github.\n${PUBLISH_USAGE}`);
  const deliverable = opts.deliverable?.trim() || APP_DELIVERABLE_ID;
  if (deliverable !== APP_DELIVERABLE_ID)
    throw new Error(
      `--deliverable ${deliverable}: publishRelease publishes the app; a pack publishes through publishPack (pkey release publish dispatches).`,
    );
  const tag = opts.tag?.trim() || undefined;
  const version = opts.version?.trim() || tag?.replace(/^v/, "");
  if (!version)
    throw new Error(`--version (or --tag) is required.\n${PUBLISH_USAGE}`);
  if (!opts.dir?.trim())
    throw new Error(`--dir is required.\n${PUBLISH_USAGE}`);
  if (opts.strict && opts.contentInterface === undefined)
    throw new Error("--strict needs --content-interface <file>.");
  // P4-20: hashed first, so a bad registry costs no upload.
  const fingerprint =
    opts.contentInterface !== undefined
      ? await contentInterfaceFingerprint(opts.cwd, opts.contentInterface)
      : null;
  if (fingerprint !== null) out.write(`Content interface: ${fingerprint}\n`);

  // 1. The manifest and the match.
  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  // The manifest's warnings (a build id that is a bare arch, …) are worth seeing at publish
  // time too: they never stop a publish, but they do shape how its builds read everywhere.
  for (const w of validation.warnings)
    opts.stderr.write(`warning: ${w.file}${w.path}: ${w.message}\n`);
  const context = descriptorManifestOf(loaded);
  const slug = context.product?.slug;
  if (slug !== opts.product)
    throw new Error(
      `--product ${opts.product} does not match .pkey/product's slug ${slug}.`,
    );
  const app = context.release?.app;
  if (!app || app.artifacts.length === 0)
    throw new Error(
      ".pkey/release declares no deliverables.app with an artifacts map; pkey release publish classifies files only by that map.",
    );

  const dir = path.resolve(opts.cwd, opts.dir);
  const match = matchArtifacts(await scanDir(dir), app.artifacts);
  for (const w of match.warnings) opts.stderr.write(`warning: ${w}\n`);
  if (match.errors.length) throw new Error(match.errors.join("\n"));

  // 2. Hashes and meta.
  const meta = opts.meta
    ? await readMeta(
        path.resolve(opts.cwd, opts.meta),
        app.artifacts.map((e) => e.id),
      )
    : {};
  const hashed: { entry: ManifestArtifactEntry; files: HashedFile[] }[] = [];
  const toHash = match.builds.reduce((n, b) => n + b.files.length, 0);
  opts.progress?.stage(`Hashing ${toHash} file${toHash === 1 ? "" : "s"}`);
  let hashedCount = 0;
  for (const b of match.builds) {
    const files: HashedFile[] = [];
    for (const f of b.files) {
      const { size } = await stat(f.path);
      if (source === "r2" && size > MAX_SINGLE_PUT_BYTES)
        throw new Error(
          `${f.name} is ${size} bytes; one upload is at most ${MAX_SINGLE_PUT_BYTES} bytes (a single-part PUT).`,
        );
      files.push({ ...f, ...(await hashFile(f.path)) });
      opts.progress?.advance((hashedCount += 1), toHash);
    }
    hashed.push({ entry: b.entry, files });
  }
  // The storefront feeds' facts, from inside each iOS and Android payload (P2b-05).
  const extracted: Record<
    string,
    NonNullable<DescriptorBuild["metadata"]>
  > = {};
  for (const b of hashed) {
    const payload = b.files.find((f) => f.role === b.entry.role);
    if (!payload) continue;
    try {
      const m = await buildMetadataFor(
        b.entry.platform,
        b.entry.format,
        payload.path,
      );
      if (m) extracted[b.entry.id] = m;
    } catch (e) {
      const w = `could not read ${payload.name} for build ${b.entry.id}'s metadata (${(e as Error).message}); the storefront feeds that need it will skip this build.`;
      opts.stderr.write(`warning: ${w}\n`);
      match.warnings.push(w);
    }
  }
  const fileCount = hashed.reduce((n, b) => n + b.files.length, 0);
  out.write(
    `Matched ${hashed.length} build${hashed.length === 1 ? "" : "s"} (${fileCount} files) in ${path.relative(opts.cwd, dir) || "."}\n`,
  );
  for (const b of hashed) {
    // Each build by platform and arch together ("macOS · Apple silicon (arm64)"), never by its
    // id or arch alone.
    const label = buildLabel(b.entry).long;
    for (const f of b.files)
      out.write(
        `- ${b.entry.id.padEnd(12)} ${f.role.padEnd(9)} ${f.name} (${label}; ${f.size} bytes, sha256 ${f.sha256.slice(0, 12)}…)\n`,
      );
  }

  // 3. The descriptor, validated as the Worker will validate it.
  const descriptor = buildDescriptor({
    product: opts.product,
    deliverable,
    version,
    ...(tag !== undefined ? { tag } : {}),
    ...(opts.channel?.trim() ? { channel: opts.channel.trim() } : {}),
    source,
    builds: hashed,
    meta,
    extracted,
    provenance: provenanceFrom(opts.env),
  });
  // P4-03: the packs this release pins and each build embeds (plans/P4-01.md decision 37): both go
  // into the DESCRIPTOR, and descriptorToRecord moves them into the record.
  const packs = packContext(loaded).packs;
  const contentApi = app.content?.contentApi;
  const wantsContent =
    opts.contentStamp !== undefined ||
    opts.embedded !== undefined ||
    (opts.pins?.length ?? 0) > 0;
  if (packs.length === 0 && wantsContent)
    throw new Error(
      ".pkey/release declares no pack deliverables; --content-stamp, --embedded and --pin stamp an app release's packs.",
    );
  if (opts.contentStamp !== undefined && (opts.embedded || opts.pins?.length))
    throw new Error(
      "--content-stamp is the stamp the build embedded; it cannot be combined with --embedded or --pin.",
    );
  if (packs.length > 0 && contentApi === undefined)
    throw new Error(
      ".pkey/release declares packs but no deliverables.app.content.contentApi; run pkey validate.",
    );
  if (packs.length > 0 && !wantsContent)
    throw new Error(
      ".pkey/release declares packs, so an app release states its pins: pass --content-stamp <file> (the pkey-content.json pkey release content-stamp wrote before the export).",
    );
  const embeds: Record<string, string[]> = {};
  if (packs.length > 0)
    for (const b of descriptor.builds) {
      const entry = app.artifacts.find((e) => e.id === b.id)!;
      b.embeds = embedsFor(entry, packs);
      embeds[b.id] = b.embeds;
    }
  const pinSources: SourcedPin[] = [];
  const setContent = (content: AppContent) => {
    const problems = contentRuleProblems(content, contentApi, packs, embeds);
    if (problems.length)
      throw new Error(
        `The release's content breaks the publish rules:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      );
    descriptor.content = content;
  };
  if (opts.contentStamp !== undefined)
    setContent(
      await readContentStamp(path.resolve(opts.cwd, opts.contentStamp)),
    );
  else if (opts.embedded !== undefined)
    pinSources.push(
      ...(await markerPins(path.resolve(opts.cwd, opts.embedded), {
        product: opts.product,
        releaseKeys: context.releaseKeys,
      })),
    );
  const pinsPending = (opts.pins?.length ?? 0) > 0;
  if (opts.contentStamp === undefined && wantsContent && !pinsPending)
    setContent(contentFor(contentApi!, packs, mergePins(pinSources)));
  const local = validateReleaseDescriptor(descriptor, context);
  if (!local.ok)
    throw new Error(
      `The release descriptor does not validate:\n${local.errors
        .map((e) => `  ${e.path} ${e.code}: ${e.message}`)
        .join("\n")}`,
    );
  // The release record (P3-03): who signs it, decided before any request.
  if (
    opts.minSupportedSeq !== undefined &&
    (!Number.isSafeInteger(opts.minSupportedSeq) || opts.minSupportedSeq < 1)
  )
    throw new Error(
      "--min-supported-seq must be a whole number of at least 1.",
    );
  // The key is read, never echoed: no `::add-mask::` either (that would put it on stdout; a
  // GitHub secret is masked by the runner already).
  const pem = opts.releaseKeyPem ?? opts.env[RELEASE_KEY_ENV] ?? undefined;
  const declared = context.releaseKeys;
  let sign: ((record: ReleaseRecordDoc) => Promise<string>) | null = null;
  if (!opts.noRecord && !opts.dryRun) {
    if (opts.signRecord) sign = opts.signRecord;
    else if (pem) sign = recordSigner(pem, declared);
    else if (declared.length > 0)
      throw new Error(
        `.pkey/release declares releaseKeys, so pkey signs a release record: set ${RELEASE_KEY_ENV} ` +
          "(the release-key input of polaris-key/publish) or --release-key-file, or pass --no-record.",
      );
  }
  const wantsRecord =
    !opts.noRecord &&
    (sign !== null || (opts.dryRun === true && (pem || declared.length > 0)));
  const result: PublishResult = {
    descriptor,
    releaseId: local.releaseId,
    dryRun: opts.dryRun === true,
    uploaded: [],
    skipped: [],
    warnings: match.warnings,
    ...(descriptor.content ? { content: descriptor.content } : {}),
    ...(fingerprint !== null ? { contentInterface: fingerprint } : {}),
  };
  const judge = (answer: unknown): void => {
    if (fingerprint === null) return;
    const verdict = judgeContentInterface(
      answer,
      fingerprint,
      descriptor.content?.contentApi ?? null,
      opts.strict === true,
    );
    out.write(`Content interface: ${verdict.note}\n`);
    if (verdict.warning) {
      result.warnings.push(verdict.warning);
      opts.stderr.write(`warning: ${verdict.warning}\n`);
    }
  };
  if (opts.dryRun) {
    out.write(
      `\nRelease descriptor (${local.releaseId}):\n${JSON.stringify(descriptor, null, 2)}\n`,
    );
    out.write("Local validation: ok\n");
    if (descriptor.content)
      describeContent(out, descriptor.content, pinSources);
    else if (pinsPending)
      out.write(
        "Content: --pin resolves through Polaris Key; shown once a CI credential is available\n",
      );
    if (packs.length > 0)
      for (const b of descriptor.builds)
        out.write(
          `  embeds ${b.id}: ${b.embeds?.length ? b.embeds.join(", ") : "none"}\n`,
        );
  }

  // 4. Credentials, the ticket, the uploads and the submit.
  let token: string;
  opts.progress?.stage("Getting a CI token");
  try {
    token = await resolveCiToken({
      baseUrl: opts.baseUrl,
      product: opts.product,
      env: opts.env,
      out,
      log: opts.stderr,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
  } catch (e) {
    if (opts.dryRun && !(e instanceof CiRequestError)) {
      if (wantsRecord) {
        // No ticket, so no seq yet: the record is shown without it.
        const { seq: _seq, ...record } = descriptorToRecord(descriptor, {
          seq: 1,
          issuedAt: opts.now ?? Math.floor(Date.now() / 1000),
          ...(opts.minSupportedSeq !== undefined
            ? { minSupportedSeq: opts.minSupportedSeq }
            : {}),
        });
        out.write(
          `\nRelease record (unsigned; seq is the upload route's answer):\n${JSON.stringify(record, null, 2)}\n`,
        );
      }
      out.write(`Server validation: skipped (${(e as Error).message})\n`);
      return result;
    }
    throw e;
  }
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
  // P4-03: no app record carries pins a Worker did not mirror (release.packs in discovery).
  if (packs.length > 0) await requirePacksDiscovery(client, opts.fetchImpl);
  if (pinsPending) {
    pinSources.push(...(await resolvePins(client, opts.pins!)));
    setContent(contentFor(contentApi!, packs, mergePins(pinSources)));
    const again = validateReleaseDescriptor(descriptor, context);
    if (!again.ok)
      throw new Error(
        `The release descriptor does not validate with its content:\n${again.errors
          .map((e) => `  ${e.path} ${e.code}: ${e.message}`)
          .join("\n")}`,
      );
    if (opts.dryRun) describeContent(out, descriptor.content!, pinSources);
  }
  if (descriptor.content) result.content = descriptor.content;

  const objects = new Map<string, HashedFile>();
  for (const b of hashed) for (const f of b.files) objects.set(f.sha256, f);
  opts.progress?.stage("Requesting an upload ticket");
  const ticket = asTicket(
    await client.postJson("release/publish/uploads", {
      what: "Requesting an upload ticket",
      body: {
        objects: [...objects.values()].map((f) => ({
          sha256: f.sha256,
          size: f.size,
        })),
        releases: [{ deliverable, version }],
      },
    }),
    client.url("release/publish/uploads"),
  );
  mask(opts.env, out, ticket.ticket);
  mask(opts.env, out, ticket.credentials.secretAccessKey);
  mask(opts.env, out, ticket.credentials.sessionToken);

  // The release's seq, into the descriptor and the record.
  const answered = Array.isArray(ticket.seqs)
    ? ticket.seqs.find(
        (s) => s.deliverable === deliverable && s.version === version,
      )
    : undefined;
  if (answered && Number.isSafeInteger(answered.seq) && answered.seq >= 1) {
    descriptor.seq = answered.seq;
    const again = validateReleaseDescriptor(descriptor, context);
    if (!again.ok)
      throw new Error(
        `The release descriptor does not validate with seq ${answered.seq}:\n${again.errors
          .map((e) => `  ${e.path} ${e.code}: ${e.message}`)
          .join("\n")}`,
      );
  } else if (wantsRecord) {
    throw new Error(
      `${client.url("release/publish/uploads")} answered no seq for ${deliverable} ${version} (an older Polaris Key?); a release record needs it. Pass --no-record to publish without one.`,
    );
  }
  let recordJws: string | undefined;
  if (wantsRecord && descriptor.seq !== undefined) {
    const record = descriptorToRecord(descriptor, {
      seq: descriptor.seq,
      issuedAt: opts.now ?? Math.floor(Date.now() / 1000),
      ...(opts.minSupportedSeq !== undefined
        ? { minSupportedSeq: opts.minSupportedSeq }
        : {}),
    });
    result.record = record;
    if (opts.dryRun) {
      out.write(
        `\nRelease record (unsigned; a dry run signs nothing):\n${JSON.stringify(record, null, 2)}\n`,
      );
    } else if (sign) {
      recordJws = await sign(record);
      await checkSignedRecord(recordJws, record, declared);
      result.recordJws = recordJws;
      out.write(
        `Signed the release record (seq ${record.seq}, sha256 ${createHash("sha256").update(recordJws).digest("hex").slice(0, 12)}…)\n`,
      );
    }
  }

  // P4-20: before anything is uploaded, ask the server (a dry run) for the channel's current
  // fingerprint, so --strict fails with nothing published. A dry run judges its own answer.
  if (fingerprint !== null && !opts.dryRun)
    judge(
      (
        await client.postJson("release/publish/submit", {
          what: "Comparing the content interface (dry run)",
          body: {
            ticket: ticket.ticket,
            descriptor,
            ...(recordJws !== undefined ? { record: recordJws } : {}),
            contentInterface: fingerprint,
            dryRun: true,
          },
        })
      ).contentInterface,
    );

  if (source === "r2") {
    const toUpload = opts.dryRun
      ? 0
      : ticket.objects.filter((o) => !o.present).length;
    if (toUpload > 0)
      opts.progress?.stage(
        `Uploading ${toUpload} object${toUpload === 1 ? "" : "s"}`,
      );
    for (const o of ticket.objects) {
      if (o.present) {
        result.skipped.push(o.target);
        continue;
      }
      const file = objects.get(o.sha256);
      if (!file)
        throw new Error(
          `The ticket names ${o.sha256}, which pkey did not ask for.`,
        );
      if (opts.dryRun) continue; // a dry run uploads nothing
      await putFile({
        creds: ticket.credentials,
        key: o.key,
        file: file.path,
        size: file.size,
        sha256: file.sha256,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: opts.stderr,
      });
      result.uploaded.push(o.target);
      opts.progress?.advance(result.uploaded.length, toUpload);
    }
    if (!opts.dryRun)
      out.write(
        `Uploaded ${result.uploaded.length} object${result.uploaded.length === 1 ? "" : "s"}; ${result.skipped.length} already stored\n`,
      );
  }

  opts.progress?.stage(
    opts.dryRun ? "Validating the release (dry run)" : "Submitting the release",
  );
  const server = await client.postJson("release/publish/submit", {
    what: opts.dryRun
      ? "Validating the release (dry run)"
      : "Submitting the release",
    body: {
      ticket: ticket.ticket,
      descriptor,
      ...(recordJws !== undefined ? { record: recordJws } : {}),
      ...(fingerprint !== null ? { contentInterface: fingerprint } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
    },
  });
  result.server = server;
  if (opts.dryRun) judge(server.contentInterface);
  if (opts.dryRun) {
    const unverified = Array.isArray(server.unverified)
      ? server.unverified.length
      : 0;
    out.write(
      `Server validation: ok — would be ${String(server.outcome)} as ${String(server.releaseId)}` +
        `${unverified ? ` (${unverified} object${unverified === 1 ? "" : "s"} judged as if uploaded)` : ""}\n`,
    );
    out.write("Dry run: nothing uploaded, nothing written.\n");
  } else {
    out.write(
      `Published ${String(server.releaseId)} (${String(server.outcome)})\n`,
    );
  }
  return result;
}
