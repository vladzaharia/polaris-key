// Where transcripts live and how they are serialized (P1b-03).
//
//   conformance/transcripts/<id>.json                          the canonical files
//   sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/    the generator-owned Swift mirror
//   sdks/godot/tests/transcripts/                              the generator-owned Godot mirror
//
// Neither the Swift test target nor an exported Godot pack (which reads only `res://`) can reach
// up the monorepo at test time, so — exactly as `tools/sign-corpus.ts` does for the corpus — the
// generator writes a byte-identical copy into each and the drift check covers the copies like
// the source.
//
// Serialization is `JSON.stringify` (with invisible and bidi code points escaped) then Prettier's
// JSON printer with the repo's (default) options, the same pipeline the corpus uses, so
// `pnpm format` never disagrees with a file the generator wrote.

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
export const GODOT_TRANSCRIPTS_DIR = join(
  REPO_ROOT,
  "sdks",
  "godot",
  "tests",
  "transcripts",
);

/** The environment variable that switches the Worker test from CHECK to WRITE. */
export const WRITE_FLAG = "PKEY_WRITE_TRANSCRIPTS";

/**
 * Invisible and direction-changing code points (WIRE-CONTRACT-V4 §12.7.1 step 2, outside the C0
 * and C1 controls JSON already escapes), written as `\uXXXX` so no bidi override or zero-width
 * character sits literally in a committed file (PX-W13's `devicecode-label` carries one on
 * purpose). Every replayer's JSON parser reads the escape as the same code point.
 */
const INVISIBLE =
  /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export async function serialize(t: Transcript): Promise<string> {
  const json = JSON.stringify(t).replace(
    INVISIBLE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return format(json, { parser: "json" });
}

export interface Drift {
  file: string;
  problem: "missing" | "stale" | "unexpected";
}

/** Compare (or write) every rendered transcript in every location. Files in any of the
 *  directories that no scenario produces are drift too: a deleted scenario must take its file
 *  with it. */
export function reconcile(
  rendered: Map<string, string>,
  write: boolean,
): Drift[] {
  const drift: Drift[] = [];
  for (const dir of [
    TRANSCRIPTS_DIR,
    SWIFT_TRANSCRIPTS_DIR,
    GODOT_TRANSCRIPTS_DIR,
  ]) {
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
