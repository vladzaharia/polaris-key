#!/usr/bin/env node
// Accept the portal's screenshot baselines from a CI run instead of re-recording them locally.
//
// A mismatched or missing baseline fails the e2e shard and writes `<name>.actual.png` (and
// `<name>.diff.png` for a pixel mismatch) to e2e/__baselines__/portal/.out; CI uploads that
// directory as the `portal-visual-diff-<shard>` artifact (e2e/portalHarness.ts). This copies each
// actual image over its linux baseline and prints old -> new for review. Nothing is accepted
// without running this; the diff is the commit.
//
//   scripts/accept-baselines.mjs <run-id> [--job <shard>] [--allow-new]
//   scripts/accept-baselines.mjs --from-dir <dir> [--allow-new]
//
// --job narrows to one artifact (a shard number or the full artifact name). --allow-new accepts
// an image whose baseline does not exist yet. --from-dir reads an already downloaded artifact
// tree and skips the network and the ancestry check. It refuses when the run's head commit is not
// an ancestor of HEAD, and when an image maps to no existing baseline.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ADMIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_DIR = join(ADMIN, "e2e/__baselines__/portal/linux");
export const ARTIFACT_PREFIX = "portal-visual-diff-";
/** The harness's per-channel tolerance (portalHarness.ts CHANNEL_TOLERANCE), for the % changed. */
const CHANNEL_TOLERANCE = 48;
const SUFFIX = ".actual.png";

export class Refusal extends Error {}

export function parseArgs(argv) {
  const o = { runId: null, job: null, fromDir: null, allowNew: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-new") o.allowNew = true;
    else if (a === "--job" || a === "--from-dir") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Refusal(`${a} needs a value`);
      if (a === "--job") o.job = v;
      else o.fromDir = v;
    } else if (a.startsWith("--")) throw new Refusal(`unknown option ${a}`);
    else if (o.runId === null) o.runId = a;
    else throw new Refusal(`unexpected argument ${a}`);
  }
  if (o.runId !== null && !/^\d+$/.test(o.runId))
    throw new Refusal(`run id must be numeric, got ${o.runId}`);
  if (o.runId === null && o.fromDir === null)
    throw new Refusal("give a run id or --from-dir <dir>");
  if (o.runId !== null && o.fromDir !== null)
    throw new Refusal("a run id and --from-dir are alternatives");
  if (o.job !== null && o.fromDir !== null)
    throw new Refusal(
      "--job selects a CI artifact; it does not apply to --from-dir",
    );
  return o;
}

/** The artifact name a --job value selects: `1` and `portal-visual-diff-1` are the same. */
export function artifactName(job) {
  return job.startsWith(ARTIFACT_PREFIX) ? job : `${ARTIFACT_PREFIX}${job}`;
}

/** Every `*.actual.png` under `dir`, as paths relative to it (sorted, `/` separated). */
export function findActuals(
  dir,
  walk = readdirSync,
  isDir = (p) => statSync(p).isDirectory(),
) {
  const found = [];
  const visit = (d) => {
    for (const e of walk(d).sort()) {
      const p = join(d, e);
      if (isDir(p)) visit(p);
      else if (e.endsWith(SUFFIX))
        found.push(relative(dir, p).split(sep).join("/"));
    }
  };
  visit(dir);
  return found;
}

/**
 * Map an artifact path to its baseline. The path is `<name>.actual.png`, optionally under the
 * artifact's own directory (`gh run download` nests each artifact under its name). Throws when it
 * escapes the baseline directory or the baseline does not exist (unless `allowNew`).
 */
export function mapToBaseline(
  rel,
  { baselineDir = BASELINE_DIR, allowNew = false, exists = existsSync } = {},
) {
  const parts = rel.split("/");
  if (parts[0].startsWith(ARTIFACT_PREFIX)) parts.shift();
  const file = parts.join("/");
  if (!file.endsWith(SUFFIX)) throw new Refusal(`${rel}: not a ${SUFFIX} file`);
  const name = file.slice(0, -SUFFIX.length);
  if (
    !name ||
    parts.some((p) => p === ".." || p === "." || p === "" || p.includes("\\"))
  )
    throw new Refusal(`${rel}: not a baseline name`);
  const dest = join(baselineDir, `${name}.png`);
  const isNew = !exists(dest);
  if (isNew && !allowNew)
    throw new Refusal(
      `${rel}: maps to no known baseline (${name}.png); pass --allow-new to add it`,
    );
  return { name, dest, isNew };
}

/** Refuse a run whose head commit is not part of the checked-out history. */
export function checkAncestry(headSha, isAncestor) {
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new Refusal(`the run reports no usable head SHA (${headSha})`);
  if (!isAncestor(headSha))
    throw new Refusal(
      `run head ${headSha.slice(0, 10)} is not an ancestor of HEAD; merge or rebase it first, or the images would be for different code`,
    );
}

/** Old -> new: dimensions, bytes and the share of pixels past the harness tolerance. */
export function summarize(name, oldBuf, newBuf) {
  const dims = (p) => `${p.width}x${p.height}`;
  const n = PNG.sync.read(newBuf);
  if (!oldBuf) return `${name}: new ${dims(n)} (${newBuf.length} B)`;
  const o = PNG.sync.read(oldBuf);
  const sizes = `${dims(o)} ${oldBuf.length} B -> ${dims(n)} ${newBuf.length} B`;
  if (o.width !== n.width || o.height !== n.height)
    return `${name}: ${sizes}, size changed`;
  let differing = 0;
  for (let i = 0; i < n.data.length; i += 4) {
    const d = Math.max(
      Math.abs(n.data[i] - o.data[i]),
      Math.abs(n.data[i + 1] - o.data[i + 1]),
      Math.abs(n.data[i + 2] - o.data[i + 2]),
    );
    if (d > CHANNEL_TOLERANCE) differing++;
  }
  const pct = ((differing / (n.width * n.height)) * 100).toFixed(2);
  return `${name}: ${sizes}, ${pct}% changed`;
}

/**
 * Plan every copy before writing any: all refusals surface first. Two artifacts carrying the same
 * name with different bytes refuse too.
 */
export function plan(dir, opts, io = {}) {
  const read = io.read ?? readFileSync;
  const rels = findActuals(dir, io.walk, io.isDir);
  if (rels.length === 0) throw new Refusal(`no ${SUFFIX} files under ${dir}`);
  const byName = new Map();
  for (const rel of rels) {
    const m = mapToBaseline(rel, opts);
    const bytes = read(join(dir, rel));
    const prior = byName.get(m.name);
    if (prior && !prior.bytes.equals(bytes))
      throw new Refusal(
        `${rel}: ${m.name} appears twice with different images`,
      );
    byName.set(m.name, { ...m, bytes });
  }
  return [...byName.values()];
}

export function apply(items, io = {}) {
  const read = io.read ?? readFileSync;
  const write =
    io.write ??
    ((dest, bytes) => {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    });
  const lines = [];
  for (const it of items) {
    const old = it.isNew ? null : read(it.dest);
    lines.push(summarize(it.name, old, it.bytes));
    write(it.dest, it.bytes);
  }
  return lines;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let dir = o.fromDir && resolve(o.fromDir);
  let tmp = null;
  try {
    if (o.runId) {
      const head = sh("gh", [
        "run",
        "view",
        o.runId,
        "--json",
        "headSha",
        "-q",
        ".headSha",
      ]);
      checkAncestry(head, (sha) => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      });
      tmp = mkdtempSync(join(tmpdir(), "pk-baselines-"));
      dir = tmp;
      const name = o.job ? artifactName(o.job) : `${ARTIFACT_PREFIX}*`;
      execFileSync("gh", ["run", "download", o.runId, "-p", name, "-D", tmp], {
        stdio: "inherit",
      });
    }
    const items = plan(dir, { allowNew: o.allowNew });
    const lines = apply(items);
    console.log(lines.join("\n"));
    console.log(
      `${items.length} baseline(s) updated; review the diff, then commit.`,
    );
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`accept-baselines: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
