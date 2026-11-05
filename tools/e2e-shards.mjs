#!/usr/bin/env node
/**
 * Duration-balanced shards of the console and portal e2e files (CS-1).
 *
 * vitest's own `--shard` splits by file count, which is useless when one file takes a hundred
 * times another. This assigns every `packages/admin/e2e/*.e2e.test.ts` to one of N shards,
 * longest first onto the least-loaded shard, from `tools/e2e-shard-timings.json` (seconds per
 * file, measured on CI; a file it does not list costs `_default`). Refresh the manifest from a
 * CI run's per-file durations when the split drifts; a stale shard is slow, never wrong.
 *
 *   node tools/e2e-shards.mjs files <index> <count>   the files of shard <index> (0-based), one per line
 *   node tools/e2e-shards.mjs plan <count>            every shard with its estimated minutes
 *   node tools/e2e-shards.mjs check <count>           every file lands in exactly one shard
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = join(HERE, "..", "packages", "admin", "e2e");
export const TIMINGS_FILE = join(HERE, "e2e-shard-timings.json");
const SUFFIX = ".e2e.test.ts";

/** Forks vitest runs per CI job (availableParallelism() - 1 on a 4-vCPU runner). */
export const FORKS = 3;

export function e2eFiles(dir = E2E_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .sort();
}

export function loadTimings(file = TIMINGS_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Seconds a file takes, from the manifest (its name without `.e2e.test.ts`). */
export function costOf(file, timings) {
  return timings[file.slice(0, -SUFFIX.length)] ?? timings._default ?? 30;
}

/** Longest-processing-time-first: shards[i] = { files, load } (load in manifest seconds). */
export function assign(files, count, timings) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be a positive integer, got ${count}`);
  const shards = Array.from({ length: count }, () => ({ files: [], load: 0 }));
  const order = [...files].sort(
    (a, b) => costOf(b, timings) - costOf(a, timings) || (a < b ? -1 : 1),
  );
  for (const f of order) {
    let best = shards[0];
    for (const s of shards) if (s.load < best.load) best = s;
    best.files.push(f);
    best.load += costOf(f, timings);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/** Problems with a plan: a file in no shard or in two, or a manifest entry with no file. */
export function problems(files, shards, timings) {
  const out = [];
  const seen = new Map();
  shards.forEach((s, i) => {
    for (const f of s.files) seen.set(f, [...(seen.get(f) ?? []), i]);
  });
  for (const f of files) {
    const at = seen.get(f) ?? [];
    if (at.length !== 1)
      out.push(`${f} is in ${at.length} shards (${at.join(", ") || "none"})`);
  }
  const names = new Set(files.map((f) => f.slice(0, -SUFFIX.length)));
  for (const k of Object.keys(timings))
    if (k !== "_default" && !names.has(k))
      out.push(`e2e-shard-timings.json lists ${k}, which is not an e2e file`);
  return out;
}

function main(argv) {
  const [cmd, a, b] = argv;
  const files = e2eFiles();
  const timings = loadTimings();
  if (cmd === "files") {
    const index = Number(a);
    const shards = assign(files, Number(b), timings);
    if (!Number.isInteger(index) || index < 0 || index >= shards.length)
      throw new Error(`shard index ${a} is outside 0..${shards.length - 1}`);
    for (const f of shards[index].files) console.log(`e2e/${f}`);
  } else if (cmd === "plan") {
    const shards = assign(files, Number(a), timings);
    shards.forEach((s, i) =>
      console.log(
        `shard ${i}: ${s.files.length} files, ~${(s.load / FORKS / 60).toFixed(1)} min (${s.load} s over ${FORKS} forks)`,
      ),
    );
  } else if (cmd === "check") {
    const shards = assign(files, Number(a), timings);
    const bad = problems(files, shards, timings);
    if (bad.length) {
      console.error(bad.join("\n"));
      process.exit(1);
    }
    console.log(
      `${files.length} e2e files, each in exactly one of ${a} shards`,
    );
  } else {
    console.error(
      "usage: e2e-shards.mjs files <index> <count> | plan <count> | check <count>",
    );
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
