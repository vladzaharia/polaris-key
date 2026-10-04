/** File discovery shared by the extractors: the declared globs over `--dir`. */

import { matchesArtifactGlob } from "@polaris-key/manifest";
import { scanDir, type FoundFile } from "../publish.js";
import { PackageExtractError, type ExtractInput } from "./types.js";

/** Every file under `--dir` that one of the declaration's `artifacts` globs matches, by name. */
export async function declaredFiles(input: ExtractInput): Promise<FoundFile[]> {
  const globs = Object.values(input.declaration.artifacts).map((a) => a.match);
  const all = await scanDir(input.dir);
  const hits = all.filter((f) =>
    globs.some((g) => matchesArtifactGlob(g, f.name)),
  );
  const seen = new Set<string>();
  for (const f of hits) {
    if (seen.has(f.name))
      throw new PackageExtractError(
        `two files under --dir are named ${f.name}; a package release names each file once.`,
      );
    seen.add(f.name);
  }
  return hits;
}

/** Exactly one of `files`, or a refusal naming what was expected. */
export function exactlyOne<T extends { name: string }>(
  files: readonly T[],
  what: string,
): T {
  if (files.length !== 1)
    throw new PackageExtractError(
      files.length === 0
        ? `no ${what} under --dir matches the package's artifacts globs.`
        : `${files.length} files match as the ${what} (${files.map((f) => f.name).join(", ")}); a release carries exactly one.`,
    );
  return files[0]!;
}
