/**
 * Swift (F-06's registry): the scratch directory of `swift package-registry publish --dry-run`
 * (plans/F-01.md §5.3): the source archive (the zip the artifacts globs match), its CMS signature
 * (`*.sig` beside it, when the release is signed) and every signed manifest (`Package.swift`,
 * `Package@swift-*.swift`) — the Worker serves the signed manifest copies, never ones re-extracted
 * from the zip. The version is `--version`'s (a registry archive does not carry one).
 */

import path from "node:path";
import { readdir } from "node:fs/promises";
import { declaredFiles, exactlyOne } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

export async function extractSwift(
  input: ExtractInput & { version?: string },
): Promise<Extracted> {
  const zip = exactlyOne(
    (await declaredFiles(input)).filter((f) => f.name.endsWith(".zip")),
    "Swift source archive (.zip)",
  );
  if (!input.version)
    throw new PackageExtractError(
      "a Swift registry archive carries no version: pass --version.",
    );
  const dir = path.dirname(zip.path);
  const names = (await readdir(dir)).sort();
  const files: ExtractedFile[] = [
    { path: zip.path, name: zip.name, type: "source-archive" },
  ];
  const sigs = names.filter((n) => n.endsWith(".sig"));
  if (sigs.length > 1)
    throw new PackageExtractError(
      `${sigs.length} signatures sit beside ${zip.name} (${sigs.join(", ")}); a release has one.`,
    );
  if (sigs[0])
    files.push({
      path: path.join(dir, sigs[0]),
      name: sigs[0],
      type: "source-archive-signature",
    });
  const manifests = names.filter((n) =>
    /^Package(@swift-[0-9][0-9.]*)?\.swift$/.test(n),
  );
  for (const m of manifests)
    files.push({ path: path.join(dir, m), name: m, type: "manifest" });
  const toolsVersions = manifests
    .map((m) => /^Package@swift-([0-9.]+)\.swift$/.exec(m)?.[1])
    .filter((v): v is string => v !== undefined);
  return {
    version: input.version,
    files,
    metadata: {
      name: input.declaration.name,
      version: input.version,
      ...(toolsVersions.length ? { toolsVersions } : {}),
      ...(sigs[0] ? { signatureFormat: "cms-1.0.0" } : {}),
    },
  };
}
