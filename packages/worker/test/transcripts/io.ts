// Where transcripts live and how they are serialized (P1b-03).
//
//   conformance/transcripts/<id>.json                          the canonical files
//   sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/    the generator-owned Swift mirror
//
// The Swift test target cannot reach up the monorepo at test time, so — exactly as
// `tools/sign-corpus.ts` does for `Resources/v2/` — the generator writes a byte-identical copy
// into the test bundle and the drift check covers the copy like the source.
//
// Serialization is `JSON.stringify` then Prettier's JSON printer with the repo's (default)
// options, the same pipeline the corpus uses, so `pnpm format` never disagrees with a file the
// generator wrote.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import type { Transcript } from "./format.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");

export const TRANSCRIPTS_DIR = join(REPO_ROOT, "conformance", "transcripts");
export const SWIFT_TRANSCRIPTS_DIR = join(
  REPO_ROOT,
  "sdks",
  "swift",
  "Tests",
  "PolarisKeyTests",
  "Resources",
  "transcripts",
);

/** The environment variable that switches the Worker test from CHECK to WRITE. */
export const WRITE_FLAG = "PKEY_WRITE_TRANSCRIPTS";

export async function serialize(t: Transcript): Promise<string> {
  return format(JSON.stringify(t), { parser: "json" });
}

export interface Drift {
  file: string;
  problem: "missing" | "stale" | "unexpected";
}

/** Compare (or write) every rendered transcript in both locations. Files in either directory
 *  that no scenario produces are drift too: a deleted scenario must take its file with it. */
export function reconcile(
  rendered: Map<string, string>,
  write: boolean,
): Drift[] {
  const drift: Drift[] = [];
  for (const dir of [TRANSCRIPTS_DIR, SWIFT_TRANSCRIPTS_DIR]) {
    if (write) mkdirSync(dir, { recursive: true });
    const present = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".json"))
      : [];
    for (const [id, content] of rendered) {
      const file = join(dir, `${id}.json`);
      const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      if (current === content) continue;
      if (write) writeFileSync(file, content);
      else
        drift.push({
          file,
          problem: current === undefined ? "missing" : "stale",
        });
    }
    for (const name of present) {
      if (rendered.has(name.replace(/\.json$/, ""))) continue;
      const file = join(dir, name);
      if (write) rmSync(file);
      else drift.push({ file, problem: "unexpected" });
    }
  }
  return drift;
}
