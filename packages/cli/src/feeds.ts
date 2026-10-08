/**
 * `pkey feeds fdroid` (P2b-05, notes/E2 §C2): build, sign, upload and register one channel's
 * F-Droid repository. The Worker relays the result and never holds the repo key.
 *
 *   1. Read the generator's inputs: `GET /<p>/distribution/feeds/fdroid/<channel>`
 *      (`distribution:feeds`). They list the APKs the channel's feed selects, newest first, with
 *      each one's APK metadata from its release descriptor, and the files registered now.
 *   2. Build `index-v2.json` (the shape of F-Droid's `org.fdroid.index.v2.IndexV2`). Build
 *      `entry.json`, and a diff (`diff/<old timestamp>.json`, fdroidserver's `dict_diff`) against
 *      the index the relay serves now, when there is one. Write them under `--out`.
 *   3. Zip `entry.json` into `entry.jar` and sign it with `apksigner` (v1 scheme only, min SDK
 *      23, the same flags as fdroidserver), using the CI-held keystore (`--keystore`, `--alias`,
 *      the password in `$PKEY_FDROID_KS_PASS` or the variable `--ks-pass-env` names).
 *   4. Upload the files through an upload ticket (P2-02's uploads route accepts
 *      `distribution:feeds`), and register the set: `POST /<p>/distribution/feeds/fdroid/<channel>`.
 *
 * Without `--keystore` the command stops after step 2, writing the unsigned files. It does the
 * same with `--dry-run`. Either way nothing is uploaded or registered.
 *
 * Two rules from notes/E2 §C2 are checked before anything is written. `versionCode` must
 * strictly decrease down the list, which is newest first, so it increases across releases and
 * channels. Every APK must be of the outlet's package. An APK whose file name the relay could not
 * serve (outside `[A-Za-z0-9_~.-]`) is refused too.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ciClient, type CiClient, type Out, type Sleep } from "./ci.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { putFile } from "./s3.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";
import { withZip, zipStore } from "./zip.js";
import { apkSignerSha256 } from "./buildMetadata.js";

export const FEEDS_USAGE =
  "Usage: pkey feeds fdroid --product <slug> --channel <c> --out <dir>\n" +
  "              [--keystore <path> --alias <alias>] [--ks-pass-env NAME] [--apksigner <path>]\n" +
  "              [--icon <png>] [--base-url <url>] [--dry-run]";

/** fdroidserver's `METADATA_VERSION`, which it writes as the entry's `version`. */
export const FDROID_INDEX_VERSION = 30000;
export const DEFAULT_KS_PASS_ENV = "PKEY_FDROID_KS_PASS";
const LOCALE = "en-US";
const SAFE_NAME = /^[A-Za-z0-9_~.-]+$/;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── The inputs ───────────────────────────────────────────────────────────────────────────────

export interface FdroidInputVersion {
  releaseId: string;
  version: string;
  stable: boolean;
  publishedAt: number | null;
  notes: string | null;
  apk: {
    name: string;
    sha256: string | null;
    size: number | null;
    url: string;
  };
  metadata: Record<string, unknown> | null;
}

export interface FdroidInputs {
  product: string;
  channel: string;
  outlet: string;
  packageName: string | null;
  repo: { address: string; fingerprints: string[] };
  productName?: string;
  listing: {
    name?: string;
    subtitle?: string;
    description?: string;
    website?: string;
    developerName?: string;
  } | null;
  versions: FdroidInputVersion[];
  files: Array<{ path: string; sha256: string; size: number }>;
}

// ── Building the index ───────────────────────────────────────────────────────────────────────

/** JSON with object keys sorted (fdroidserver's encoder), compact. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort())
        out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

/** fdroidserver's `dict_diff`: a JSON Merge Patch (RFC 7386) from `source` to `target`. */
export function dictDiff(source: unknown, target: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(source) || !isObj(target)) return target;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(source)) if (!(k in target)) out[k] = null;
  for (const [k, v] of Object.entries(target)) {
    if (!(k in source)) out[k] = v;
    else if (sortedJson(v) !== sortedJson(source[k]))
      out[k] = dictDiff(source[k], v);
  }
  return out;
}

export interface IndexIcon {
  /** The repository path, `icons/<name>`. */
  path: string;
  sha256: string;
  size: number;
}

/** Check the inputs (see the file comment) and build the index. `timestamp` is epoch ms. */
export function buildFdroidIndex(
  inputs: FdroidInputs,
  timestamp: number,
  icon?: IndexIcon,
): Record<string, unknown> {
  const listing = inputs.listing ?? {};
  const name = listing.name ?? inputs.productName ?? inputs.product;
  const problems: string[] = [];
  const pkg =
    inputs.packageName ??
    (typeof inputs.versions[0]?.metadata?.packageName === "string"
      ? (inputs.versions[0].metadata.packageName as string)
      : null);
  if (!pkg)
    problems.push(
      "the fdroid-repo outlet names no packageName and no APK metadata does",
    );

  const versions: Record<string, unknown> = {};
  let previousCode = Number.POSITIVE_INFINITY;
  let hasBeta = false;
  let added = Number.POSITIVE_INFINITY;
  let lastUpdated = 0;
  let preferredSigner: string | undefined;
  const apkNames = new Set<string>();
  for (const v of inputs.versions) {
    const m = v.metadata ?? {};
    const where = `${v.releaseId} (${v.apk.name})`;
    if (!SAFE_NAME.test(v.apk.name))
      problems.push(
        `${where}: the file name must be [A-Za-z0-9_~.-] for the relay to serve it`,
      );
    // The relay finds an APK by its file name, so two listed releases sharing one would make
    // every client but the newest release's download the wrong bytes and refuse the install.
    if (apkNames.has(v.apk.name))
      problems.push(
        `${where}: another listed release has the same APK file name; the relay serves APKs by name, so give each release's APK a distinct name (put the version in it)`,
      );
    apkNames.add(v.apk.name);
    if (!v.apk.sha256 || v.apk.size === null)
      problems.push(`${where}: the APK has no recorded sha256 and size`);
    if (
      typeof m.versionCode !== "number" ||
      typeof m.versionName !== "string" ||
      typeof m.signerSha256 !== "string"
    ) {
      problems.push(
        `${where}: no APK metadata (publish it with a pkey that reads build metadata)`,
      );
      continue;
    }
    if (m.packageName !== pkg)
      problems.push(`${where}: package ${String(m.packageName)} is not ${pkg}`);
    if (!(m.versionCode < previousCode))
      problems.push(
        `${where}: versionCode ${m.versionCode} does not strictly decrease from the newer release's ${previousCode}; keep versionCode strictly increasing across releases and channels`,
      );
    previousCode = m.versionCode;
    const at = (v.publishedAt ?? timestamp / 1000) * 1000;
    added = Math.min(added, at);
    lastUpdated = Math.max(lastUpdated, at);
    preferredSigner ??= m.signerSha256;
    const minSdk = typeof m.minSdk === "number" ? m.minSdk : undefined;
    const targetSdk = typeof m.targetSdk === "number" ? m.targetSdk : undefined;
    const nativecode = Array.isArray(m.nativecode)
      ? (m.nativecode as string[])
      : [];
    if (!v.stable) hasBeta = true;
    versions[v.apk.sha256 ?? where] = {
      added: at,
      file: { name: `/${v.apk.name}`, sha256: v.apk.sha256, size: v.apk.size },
      manifest: {
        versionName: m.versionName,
        versionCode: m.versionCode,
        ...(minSdk !== undefined && targetSdk !== undefined
          ? { usesSdk: { minSdkVersion: minSdk, targetSdkVersion: targetSdk } }
          : {}),
        ...(nativecode.length ? { nativecode } : {}),
        signer: { sha256: [m.signerSha256] },
      },
      ...(v.stable ? {} : { releaseChannels: ["Beta"] }),
      ...(v.notes ? { whatsNew: { [LOCALE]: v.notes } } : {}),
    };
  }
  if (problems.length)
    throw new Error(
      `The F-Droid repository cannot be built:\n  ${problems.join("\n  ")}`,
    );

  const iconFile = icon
    ? {
        [LOCALE]: {
          name: `/${icon.path}`,
          sha256: icon.sha256,
          size: icon.size,
        },
      }
    : undefined;
  const packages: Record<string, unknown> = {};
  if (inputs.versions.length && pkg)
    packages[pkg] = {
      metadata: {
        added,
        lastUpdated,
        name: { [LOCALE]: name },
        ...(listing.subtitle
          ? { summary: { [LOCALE]: listing.subtitle } }
          : {}),
        ...(listing.description
          ? { description: { [LOCALE]: listing.description } }
          : {}),
        ...(listing.website ? { webSite: listing.website } : {}),
        ...(listing.developerName ? { authorName: listing.developerName } : {}),
        ...(preferredSigner ? { preferredSigner } : {}),
        ...(iconFile ? { icon: iconFile } : {}),
      },
      versions,
    };
  return {
    repo: {
      name: {
        [LOCALE]:
          inputs.channel === "stable" ? name : `${name} (${inputs.channel})`,
      },
      description: {
        [LOCALE]:
          listing.subtitle ??
          `${name}, ${inputs.channel} channel, from Polaris Key.`,
      },
      ...(iconFile ? { icon: iconFile } : {}),
      address: inputs.repo.address,
      timestamp,
      ...(hasBeta
        ? { releaseChannels: { Beta: { name: { [LOCALE]: "Beta" } } } }
        : {}),
    },
    packages,
  };
}

/**
 * Problems with an `index-v2.json` against F-Droid's own model (`org.fdroid.index.v2`: the
 * fields with no default are required). Empty = it parses as F-Droid parses it.
 */
export function indexV2Problems(index: unknown): string[] {
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const isInt = (v: unknown) => Number.isSafeInteger(v);
  const isLocalized = (v: unknown) =>
    v === undefined ||
    (isObj(v) && Object.values(v).every((s) => typeof s === "string"));
  const isFile = (v: unknown, needHash: boolean) =>
    isObj(v) &&
    typeof v.name === "string" &&
    v.name.startsWith("/") &&
    (needHash
      ? typeof v.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256)
      : true);
  if (!isObj(index)) return ["the index is not an object"];
  const repo = index.repo;
  if (!isObj(repo)) return ["repo is missing"];
  if (typeof repo.address !== "string")
    out.push("repo.address is not a string");
  if (!isInt(repo.timestamp)) out.push("repo.timestamp is not an integer");
  for (const k of ["name", "description"])
    if (!isLocalized(repo[k])) out.push(`repo.${k} is not localized text`);
  if (repo.releaseChannels !== undefined) {
    if (!isObj(repo.releaseChannels))
      out.push("repo.releaseChannels is not an object");
    else
      for (const [k, c] of Object.entries(repo.releaseChannels))
        if (!isObj(c) || !isLocalized(c.name) || c.name === undefined)
          out.push(`repo.releaseChannels.${k}.name is required`);
  }
  if (index.packages !== undefined && !isObj(index.packages)) {
    out.push("packages is not an object");
    return out;
  }
  for (const [id, p] of Object.entries(
    (index.packages ?? {}) as Record<string, unknown>,
  )) {
    if (!isObj(p) || !isObj(p.metadata)) {
      out.push(`packages.${id}.metadata is missing`);
      continue;
    }
    const meta = p.metadata;
    if (!isInt(meta.added))
      out.push(`packages.${id}.metadata.added is not an integer`);
    if (!isInt(meta.lastUpdated))
      out.push(`packages.${id}.metadata.lastUpdated is not an integer`);
    for (const k of ["name", "summary", "description"])
      if (!isLocalized(meta[k]))
        out.push(`packages.${id}.metadata.${k} is not localized text`);
    if (p.versions !== undefined && !isObj(p.versions)) {
      out.push(`packages.${id}.versions is not an object`);
      continue;
    }
    for (const [key, v] of Object.entries(
      (p.versions ?? {}) as Record<string, unknown>,
    )) {
      const at = `packages.${id}.versions.${key}`;
      if (!isObj(v)) {
        out.push(`${at} is not an object`);
        continue;
      }
      if (!isInt(v.added)) out.push(`${at}.added is not an integer`);
      if (!isFile(v.file, true))
        out.push(`${at}.file needs a /name and a sha256`);
      else if ((v.file as { sha256: string }).sha256 !== key)
        out.push(`${at} is not keyed by its file's sha256`);
      const m = v.manifest;
      if (!isObj(m)) {
        out.push(`${at}.manifest is missing`);
        continue;
      }
      if (typeof m.versionName !== "string")
        out.push(`${at}.manifest.versionName is required`);
      if (!isInt(m.versionCode))
        out.push(`${at}.manifest.versionCode is required`);
      if (
        m.usesSdk !== undefined &&
        !(
          isObj(m.usesSdk) &&
          isInt(m.usesSdk.minSdkVersion) &&
          isInt(m.usesSdk.targetSdkVersion)
        )
      )
        out.push(
          `${at}.manifest.usesSdk needs minSdkVersion and targetSdkVersion`,
        );
      if (
        m.signer !== undefined &&
        !(
          isObj(m.signer) &&
          Array.isArray(m.signer.sha256) &&
          m.signer.sha256.every((s) => typeof s === "string")
        )
      )
        out.push(`${at}.manifest.signer.sha256 must be a list`);
      if (
        v.releaseChannels !== undefined &&
        !(
          Array.isArray(v.releaseChannels) &&
          v.releaseChannels.every((c) => typeof c === "string")
        )
      )
        out.push(`${at}.releaseChannels must be a list of names`);
    }
  }
  return out;
}

export interface RepoFiles {
  /** Repository path → bytes, every file of the repository but `entry.jar`. */
  files: Map<string, Buffer>;
  index: Record<string, unknown>;
  entry: Record<string, unknown>;
}

/** The index, the entry and (with `previous`) one diff, as repository files. */
export function buildRepoFiles(
  inputs: FdroidInputs,
  timestamp: number,
  opts: {
    previous?: Record<string, unknown> | null;
    icon?: { name: string; bytes: Buffer };
  } = {},
): RepoFiles {
  const files = new Map<string, Buffer>();
  let icon: IndexIcon | undefined;
  if (opts.icon) {
    const p = `icons/${opts.icon.name}`;
    files.set(p, opts.icon.bytes);
    icon = {
      path: p,
      sha256: sha256(opts.icon.bytes),
      size: opts.icon.bytes.length,
    };
  }
  const index = buildFdroidIndex(inputs, timestamp, icon);
  const problems = indexV2Problems(index);
  if (problems.length)
    throw new Error(
      `index-v2.json would not parse:\n  ${problems.join("\n  ")}`,
    );
  const indexBytes = Buffer.from(sortedJson(index), "utf8");
  files.set("index-v2.json", indexBytes);
  const numPackages = Object.keys(index.packages as object).length;
  const entry: Record<string, unknown> = {
    timestamp,
    version: FDROID_INDEX_VERSION,
    index: {
      name: "/index-v2.json",
      sha256: sha256(indexBytes),
      size: indexBytes.length,
      numPackages,
    },
    diffs: {},
  };
  const prev = opts.previous;
  const prevTs = (prev?.repo as { timestamp?: unknown } | undefined)?.timestamp;
  if (prev && Number.isSafeInteger(prevTs) && (prevTs as number) < timestamp) {
    const diff = dictDiff(prev, index) as Record<string, unknown>;
    const bytes = Buffer.from(sortedJson(diff), "utf8");
    const p = `diff/${prevTs}.json`;
    files.set(p, bytes);
    (entry.diffs as Record<string, unknown>)[String(prevTs)] = {
      name: `/${p}`,
      sha256: sha256(bytes),
      size: bytes.length,
      numPackages: Object.keys((diff.packages as object | undefined) ?? {})
        .length,
    };
  }
  files.set("entry.json", Buffer.from(sortedJson(entry), "utf8"));
  return { files, index, entry };
}

// ── Signing ──────────────────────────────────────────────────────────────────────────────────

export interface SignOptions {
  apksigner?: string;
  keystore: string;
  alias: string;
  /** The environment variable holding the keystore password (`apksigner --ks-pass env:NAME`). */
  passEnv: string;
  env: CiEnv;
}

/** `apksigner` from `--apksigner`, else the newest Android SDK build-tools, else `$PATH`. */
export async function findApksigner(
  explicit: string | undefined,
  env: CiEnv,
): Promise<string> {
  if (explicit) return explicit;
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (sdk) {
    const bt = path.join(sdk, "build-tools");
    try {
      const versions = (await readdir(bt)).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      for (const v of versions.reverse()) {
        const p = path.join(bt, v, "apksigner");
        if (existsSync(p)) return p;
      }
    } catch {
      // No build-tools: fall through to PATH.
    }
  }
  return "apksigner";
}

/**
 * Sign `jar` in place with the repository key: the JAR (v1) scheme only, minimum SDK 23 —
 * fdroidserver's `signindex` flags, so every F-Droid client verifies it.
 */
export async function signEntryJar(
  jar: string,
  opts: SignOptions,
): Promise<void> {
  const tool = await findApksigner(opts.apksigner, opts.env);
  if (!opts.env[opts.passEnv])
    throw new Error(
      `The keystore password is not in $${opts.passEnv}; export it from the CI secret (never pass it on the command line).`,
    );
  const unsigned = `${jar}.unsigned`;
  await writeFile(unsigned, await readFile(jar));
  try {
    await promisify(execFile)(
      tool,
      [
        "sign",
        "--min-sdk-version",
        "23",
        "--v1-signing-enabled",
        "true",
        "--v2-signing-enabled",
        "false",
        "--v3-signing-enabled",
        "false",
        "--v4-signing-enabled",
        "false",
        "--ks",
        opts.keystore,
        "--ks-key-alias",
        opts.alias,
        "--ks-pass",
        `env:${opts.passEnv}`,
        "--out",
        jar,
        unsigned,
      ],
      { env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv },
    );
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`apksigner failed: ${(err.stderr || err.message).trim()}`);
  } finally {
    await rm(unsigned, { force: true });
  }
}

// ── The output directory ─────────────────────────────────────────────────────────────────────

/** The top-level names a repository under `--out` is made of; nothing else is ever removed. */
const OUT_FILES = new Set(["entry.jar", "entry.json", "index-v2.json"]);
const OUT_DIRS: Record<string, RegExp> = {
  diff: /^[0-9]+\.json$/,
  icons: /^[A-Za-z0-9_~.-]+\.(png|jpe?g|webp)$/,
};

/**
 * What a previous run left under `dir`, as the exact files to remove before writing a new
 * repository. Refuses an `--out` that is the working directory or one of its ancestors, and
 * one that holds anything this command does not write: `--out` is never deleted wholesale, so
 * a mistyped `--out .` or `--out build` cannot take the checkout, the APKs or the keystore with
 * it.
 */
export async function staleOutFiles(
  dir: string,
  cwd: string,
): Promise<{ files: string[]; dirs: string[] }> {
  const up = path.relative(dir, path.resolve(cwd));
  if (up === "" || (up.split(path.sep)[0] !== ".." && !path.isAbsolute(up)))
    throw new Error(
      `--out ${dir} is the working directory or one of its parents; point it at a directory of its own (for example --out fdroid-repo).`,
    );
  let top;
  try {
    top = await lstat(dir);
  } catch {
    return { files: [], dirs: [] };
  }
  if (!top.isDirectory())
    throw new Error(`--out ${dir} exists and is not a directory.`);
  const files: string[] = [];
  const dirs: string[] = [];
  const foreign: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const st = await lstat(full);
    if (OUT_FILES.has(name) && st.isFile()) {
      files.push(full);
      continue;
    }
    const pattern = OUT_DIRS[name];
    if (pattern && st.isDirectory()) {
      let clean = true;
      for (const inner of (await readdir(full)).sort()) {
        const f = path.join(full, inner);
        if (pattern.test(inner) && (await lstat(f)).isFile()) files.push(f);
        else {
          foreign.push(path.join(name, inner));
          clean = false;
        }
      }
      if (clean) dirs.push(full);
      continue;
    }
    foreign.push(name);
  }
  if (foreign.length)
    throw new Error(
      `--out ${dir} holds files pkey feeds fdroid did not write (${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", ..." : ""}); point --out at a new or empty directory.`,
    );
  return { files, dirs };
}

// ── The command ──────────────────────────────────────────────────────────────────────────────

export interface FdroidFeedOptions {
  cwd: string;
  product: string;
  channel: string;
  out: string;
  keystore?: string;
  alias?: string;
  ksPassEnv?: string;
  apksigner?: string;
  icon?: string;
  dryRun?: boolean;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  /** Epoch milliseconds (tests pin it). */
  now?: () => number;
  /** The signing seam (tests sign with a fake). Default: `signEntryJar`. */
  sign?: (jar: string, opts: SignOptions) => Promise<void>;
}

export interface FdroidFeedResult {
  channel: string;
  /** Repository path → absolute file written. */
  written: Record<string, string>;
  index: Record<string, unknown>;
  entry: Record<string, unknown>;
  signed: boolean;
  registered: boolean;
  uploaded: string[];
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
  objects: Array<{
    sha256: string;
    size: number;
    key: string;
    target: string;
    present: boolean;
  }>;
}

/** The index the relay serves now, when its bytes are the registered ones; else `null`. */
async function currentIndex(
  inputs: FdroidInputs,
  fetchImpl: typeof fetch,
  log: Out,
  env: UntrustedEnv,
): Promise<Record<string, unknown> | null> {
  const reg = inputs.files.find((f) => f.path === "index-v2.json");
  if (!reg) return null;
  try {
    const res = await fetchImpl(`${inputs.repo.address}/index-v2.json`);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== reg.sha256) return null;
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch (e) {
    log.write(
      `warning: could not read the current index (${untrusted((e as Error).message, env)}); no diff is written.\n`,
    );
    return null;
  }
}

export async function buildFdroidFeed(
  opts: FdroidFeedOptions,
): Promise<FdroidFeedResult> {
  const out = opts.stdout;
  if (!opts.channel?.trim() || !opts.out?.trim()) throw new Error(FEEDS_USAGE);
  if ((opts.keystore === undefined) !== (opts.alias === undefined))
    throw new Error(`--keystore and --alias go together.\n${FEEDS_USAGE}`);
  // Check --out before anything is fetched: a refused directory costs no token.
  const dir = path.resolve(opts.cwd, opts.out);
  await staleOutFiles(dir, opts.cwd);

  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const client: CiClient = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
    env: opts.env,
  });
  const route = `distribution/feeds/fdroid/${encodeURIComponent(opts.channel.trim())}`;
  const inputs = await client.getJson<FdroidInputs>(route, {
    what: "Reading the F-Droid feed inputs",
  });
  // The inputs are the server's: every field shown is cleaned (`untrusted.ts`).
  const u = (v: unknown) => untrusted(v, opts.env);
  out.write(
    `F-Droid ${u(inputs.channel)}: ${inputs.versions.length} APK${inputs.versions.length === 1 ? "" : "s"} for ${u(inputs.packageName ?? "(no package)")}\n`,
  );

  const previous = await currentIndex(
    inputs,
    opts.fetchImpl ?? fetch,
    opts.stderr,
    opts.env,
  );
  const now = (opts.now ?? Date.now)();
  const prevTs =
    (previous?.repo as { timestamp?: number } | undefined)?.timestamp ?? 0;
  const timestamp = Math.max(now, prevTs + 1);
  const icon = opts.icon
    ? {
        name: path.basename(opts.icon),
        bytes: await readFile(path.resolve(opts.cwd, opts.icon)),
      }
    : undefined;
  if (icon && !/^[A-Za-z0-9_~.-]+\.(png|jpe?g|webp)$/.test(icon.name))
    throw new Error(
      "--icon must be a .png, .jpg or .webp file with a plain name.",
    );
  const repo = buildRepoFiles(inputs, timestamp, {
    previous,
    ...(icon ? { icon } : {}),
  });

  // Write the repository under --out, replacing what a previous run left: only the files this
  // command writes are removed, never the directory itself (see staleOutFiles).
  const stale = await staleOutFiles(dir, opts.cwd);
  for (const f of stale.files) await rm(f, { force: true });
  for (const d of stale.dirs) await rmdir(d);
  const written: Record<string, string> = {};
  for (const [p, bytes] of repo.files) {
    const file = path.join(dir, ...p.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    written[p] = file;
  }
  const jar = path.join(dir, "entry.jar");
  await writeFile(
    jar,
    zipStore([{ name: "entry.json", data: repo.files.get("entry.json")! }]),
  );
  written["entry.jar"] = jar;

  const result: FdroidFeedResult = {
    channel: inputs.channel,
    written,
    index: repo.index,
    entry: repo.entry,
    signed: false,
    registered: false,
    uploaded: [],
  };
  if (!opts.keystore || !opts.alias) {
    out.write(
      `Wrote the unsigned repository to ${path.relative(opts.cwd, dir) || "."}; pass --keystore and --alias to sign, upload and register it.\n`,
    );
    return result;
  }
  await (opts.sign ?? signEntryJar)(jar, {
    keystore: path.resolve(opts.cwd, opts.keystore),
    alias: opts.alias,
    passEnv: opts.ksPassEnv ?? DEFAULT_KS_PASS_ENV,
    env: opts.env,
    ...(opts.apksigner ? { apksigner: opts.apksigner } : {}),
  });
  result.signed = true;
  // The key that signed must be the one users pin: a repository signed with any other key is
  // refused by every client that added it. Checked when the inventory names one.
  const signer = await withZip(jar, (z) => apkSignerSha256(z));
  if (!signer) throw new Error("entry.jar is not signed after apksigner ran.");
  if (
    inputs.repo.fingerprints.length &&
    !inputs.repo.fingerprints.includes(signer)
  )
    throw new Error(
      `entry.jar is signed by ${signer}, which is not an fdroid-repo key in the product's key inventory (${inputs.repo.fingerprints.join(", ")}). Check --keystore and --alias.`,
    );
  if (opts.dryRun) {
    out.write("Dry run: signed locally; nothing uploaded or registered.\n");
    return result;
  }

  // Upload every file that is not already one of this channel's registered feed files, then
  // register the whole set. `present` alone is not enough: it means the product holds a ref of
  // ANY kind, and the register route skips the upload only for a registered feed file.
  const all = await Promise.all(
    Object.entries(written).map(async ([p, file]) => {
      const bytes = await readFile(file);
      return { path: p, file, sha256: sha256(bytes), size: bytes.length };
    }),
  );
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const unique = new Map(all.map((f) => [f.sha256, f]));
  const ticket = (await client.postJson("release/publish/uploads", {
    what: "Requesting an upload ticket",
    body: {
      objects: [...unique.values()].map((f) => ({
        sha256: f.sha256,
        size: f.size,
      })),
    },
  })) as unknown as TicketAnswer;
  if (typeof ticket.ticket !== "string" || !Array.isArray(ticket.objects))
    throw new Error("The uploads route answered without a ticket.");
  mask(opts.env, out, ticket.ticket);
  mask(opts.env, out, ticket.credentials.secretAccessKey);
  mask(opts.env, out, ticket.credentials.sessionToken);
  const registered = new Set(inputs.files.map((f) => `${f.sha256}:${f.size}`));
  for (const o of ticket.objects) {
    if (o.present && registered.has(`${o.sha256}:${o.size}`)) continue;
    const f = unique.get(o.sha256);
    if (!f)
      throw new Error(
        `The ticket names ${o.sha256}, which pkey did not ask for.`,
      );
    await putFile({
      creds: ticket.credentials,
      key: o.key,
      file: f.file,
      size: f.size,
      sha256: f.sha256,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
      env: opts.env,
    });
    result.uploaded.push(f.path);
  }
  await client.postJson(route, {
    what: "Registering the F-Droid repository",
    body: {
      ticket: ticket.ticket,
      files: all.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    },
  });
  result.registered = true;
  out.write(
    `Registered ${all.length} files for ${u(inputs.channel)} (${result.uploaded.length} uploaded): ${u(inputs.repo.address)}\n`,
  );
  if (inputs.repo.fingerprints.length)
    out.write(
      `Add with: ${u(inputs.repo.address)}?fingerprint=${u(inputs.repo.fingerprints[0])}\n`,
    );
  else
    out.write(
      "warning: the key inventory has no fdroid-repo key; record the repo key's fingerprint in the console so users can verify the repository.\n",
    );
  return result;
}
