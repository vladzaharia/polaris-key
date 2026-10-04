/**
 * npm (F-04's feed): one `npm pack` / `pnpm pack` tarball. Its `package/package.json` gives the
 * name, the version and what the packument needs: the four dependency kinds, engines, bin,
 * exports, os and cpu (plans/F-01.md §6.8).
 */

import { readTarMember } from "./tar.js";
import { declaredFiles, exactlyOne } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractInput,
} from "./types.js";

const KEPT = [
  "description",
  "license",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "bin",
  "exports",
  "main",
  "types",
  "os",
  "cpu",
  "keywords",
  "homepage",
  "repository",
] as const;

export async function extractNpm(input: ExtractInput): Promise<Extracted> {
  const tgz = exactlyOne(await declaredFiles(input), "npm tarball (.tgz)");
  const member = await readTarMember(
    tgz.path,
    (p) => p === "package/package.json",
  );
  if (!member)
    throw new PackageExtractError(
      `${tgz.name} has no package/package.json; is it the output of npm pack?`,
    );
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(member.data.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new PackageExtractError(`${tgz.name}'s package.json is not JSON.`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
    throw new PackageExtractError(
      `${tgz.name}'s package.json carries no name and version.`,
    );
  if (pkg.name !== input.declaration.name)
    throw new PackageExtractError(
      `${tgz.name} packs ${pkg.name}, but .pkey/release declares ${input.declaration.id} as ${input.declaration.name}.`,
    );
  const metadata: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
  };
  for (const k of KEPT) if (pkg[k] !== undefined) metadata[k] = pkg[k];
  return {
    version: pkg.version,
    files: [{ path: tgz.path, name: tgz.name, type: "npm-tarball" }],
    metadata,
  };
}
