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
 * ── SEQ ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The descriptor carries no `seq`, so the Worker assigns the next one (P2-04). Copying the
 * ticket's `nextSeq` in would make a re-run of the same publish a DIFFERENT descriptor (the
 * first run moved `nextSeq` on) and turn the intended no-op into `release_exists`.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
 *
 * Building, exporting, signing binaries, notarising and store uploads (vendor tools do those;
 * Polaris Key is not a build server). Signing the release RECORD with the release key is wire v4
 * (P3-02/P3-03): `signRecord` is the seam it plugs into, called on the validated descriptor
 * before the submit.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  APP_DELIVERABLE_ID,
  matchesArtifactGlob,
  parseManifest,
  validateReleaseDescriptor,
  type DescriptorArtifact,
  type DescriptorBuild,
  type DescriptorManifest,
  type ManifestArtifactEntry,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import { ciClient, CiRequestError, type Out, type Sleep } from "./ci.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { MAX_SINGLE_PUT_BYTES, putFile } from "./s3.js";
import { buildMetadataFor } from "./buildMetadata.js";

export const PUBLISH_USAGE =
  "Usage: pkey release publish --product <slug> --version <v> --dir <path> " +
  "[--deliverable app] [--tag vX.Y.Z] [--channel <c>] [--source r2|github] " +
  "[--meta builds.json] [--base-url <url>] [--dry-run]";

/** The sidecar suffixes picked up beside a matched file, and the role each plays. */
const SIDECARS = [
  [".sig", "signature"],
  [".sha256", "checksum"],
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
  /** The wire-v4 seam (P3-03, P4-03): sign the release record. Not called with a value yet. */
  signRecord?: (descriptor: ReleaseDescriptor) => Promise<void>;
}

export interface PublishResult {
  descriptor: ReleaseDescriptor;
  releaseId: string;
  dryRun: boolean;
  /** The server's answer to the submit; absent when a dry run had no credential. */
  server?: Record<string, unknown>;
  /** Storage keys uploaded, and those skipped as already held by the product. */
  uploaded: string[];
  skipped: string[];
  warnings: string[];
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
}): DescriptorManifest {
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
    },
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
      `--deliverable ${deliverable}: only the app deliverable publishes until pack releases land (P4-02).`,
    );
  const tag = opts.tag?.trim() || undefined;
  const version = opts.version?.trim() || tag?.replace(/^v/, "");
  if (!version)
    throw new Error(`--version (or --tag) is required.\n${PUBLISH_USAGE}`);
  if (!opts.dir?.trim())
    throw new Error(`--dir is required.\n${PUBLISH_USAGE}`);

  // 1. The manifest and the match.
  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
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
  for (const b of match.builds) {
    const files: HashedFile[] = [];
    for (const f of b.files) {
      const { size } = await stat(f.path);
      if (source === "r2" && size > MAX_SINGLE_PUT_BYTES)
        throw new Error(
          `${f.name} is ${size} bytes; one upload is at most ${MAX_SINGLE_PUT_BYTES} bytes (a single-part PUT).`,
        );
      files.push({ ...f, ...(await hashFile(f.path)) });
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
  for (const b of hashed)
    for (const f of b.files)
      out.write(
        `- ${b.entry.id.padEnd(12)} ${f.role.padEnd(9)} ${f.name} (${f.size} bytes, sha256 ${f.sha256.slice(0, 12)}…)\n`,
      );

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
  const local = validateReleaseDescriptor(descriptor, context);
  if (!local.ok)
    throw new Error(
      `The release descriptor does not validate:\n${local.errors
        .map((e) => `  ${e.path} ${e.code}: ${e.message}`)
        .join("\n")}`,
    );
  await opts.signRecord?.(descriptor);
  const result: PublishResult = {
    descriptor,
    releaseId: local.releaseId,
    dryRun: opts.dryRun === true,
    uploaded: [],
    skipped: [],
    warnings: match.warnings,
  };
  if (opts.dryRun) {
    out.write(
      `\nRelease descriptor (${local.releaseId}):\n${JSON.stringify(descriptor, null, 2)}\n`,
    );
    out.write("Local validation: ok\n");
  }

  // 4. Credentials, the ticket, the uploads and the submit.
  let token: string;
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

  const objects = new Map<string, HashedFile>();
  for (const b of hashed) for (const f of b.files) objects.set(f.sha256, f);
  const ticket = asTicket(
    await client.postJson("release/publish/uploads", {
      what: "Requesting an upload ticket",
      body: {
        objects: [...objects.values()].map((f) => ({
          sha256: f.sha256,
          size: f.size,
        })),
      },
    }),
    client.url("release/publish/uploads"),
  );
  mask(opts.env, out, ticket.ticket);
  mask(opts.env, out, ticket.credentials.secretAccessKey);
  mask(opts.env, out, ticket.credentials.sessionToken);

  if (source === "r2") {
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
    }
    if (!opts.dryRun)
      out.write(
        `Uploaded ${result.uploaded.length} object${result.uploaded.length === 1 ? "" : "s"}; ${result.skipped.length} already stored\n`,
      );
  }

  const server = await client.postJson("release/publish/submit", {
    what: opts.dryRun
      ? "Validating the release (dry run)"
      : "Submitting the release",
    body: {
      ticket: ticket.ticket,
      descriptor,
      ...(opts.dryRun ? { dryRun: true } : {}),
    },
  });
  result.server = server;
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
