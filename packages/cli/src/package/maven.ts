/**
 * Maven (F-07's feed): one version's directory of a Maven publication (Gradle's
 * `publishAllPublicationsToLocalRepository` into `build/repo/<group path>/<artifact>/<version>/`).
 * Every file the artifacts globs match is a `maven-file` with its extension and classifier read
 * from its name (`<artifactId>-<version>[-<classifier>].<extension>`); checksum and signature
 * sidecars are left behind, because the Worker derives the checksums. The POM gives the
 * coordinates and the packaging.
 */

import { readFile } from "node:fs/promises";
import { declaredFiles } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

const SIDECAR = /\.(md5|sha1|sha256|sha512|asc)$/;

/** A top-level element of a POM (outside `<parent>`, `<dependencies>` and the like). */
export function pomField(xml: string, field: string): string | null {
  // Drop comments and every nested block that repeats the coordinates.
  const flat = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(parent|dependencies|dependencyManagement|build|plugins|profiles|reporting|distributionManagement|modules|licenses|developers|scm)\b[\s\S]*?<\/\1>/g,
      "",
    );
  const m = new RegExp(`<${field}>\\s*([^<\\s][^<]*?)\\s*</${field}>`).exec(
    flat,
  );
  return m ? m[1]! : null;
}

export async function extractMaven(input: ExtractInput): Promise<Extracted> {
  const found = (await declaredFiles(input)).filter(
    (f) => !SIDECAR.test(f.name),
  );
  const poms = found.filter((f) => f.name.endsWith(".pom"));
  if (poms.length !== 1)
    throw new PackageExtractError(
      poms.length === 0
        ? "no POM (.pom) under --dir matches the package's artifacts globs."
        : `${poms.length} POMs match (${poms.map((p) => p.name).join(", ")}); one version's directory has one.`,
    );
  const pom = await readFile(poms[0]!.path, "utf8");
  const artifactId = pomField(pom, "artifactId");
  const version = pomField(pom, "version");
  const groupId =
    pomField(pom, "groupId") ??
    // A POM may inherit its groupId from its parent.
    /<parent>[\s\S]*?<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(pom)?.[1] ??
    null;
  if (!groupId || !artifactId || !version)
    throw new PackageExtractError(
      `${poms[0]!.name} carries no groupId, artifactId and version.`,
    );
  if (`${groupId}:${artifactId}` !== input.declaration.name)
    throw new PackageExtractError(
      `the POM is ${groupId}:${artifactId}, but .pkey/release declares ${input.declaration.id} as ${input.declaration.name}.`,
    );
  const stem = `${artifactId}-${version}`;
  const files: ExtractedFile[] = [];
  for (const f of found) {
    if (!f.name.startsWith(stem))
      throw new PackageExtractError(
        `${f.name} is not a file of ${stem} (a Maven file is named <artifactId>-<version>[-<classifier>].<extension>).`,
      );
    const rest = f.name.slice(stem.length);
    const m =
      /^(?:-([A-Za-z0-9][A-Za-z0-9_.-]*?))?\.([a-z0-9][a-z0-9.]*)$/.exec(rest);
    if (!m)
      throw new PackageExtractError(
        `${f.name} has no extension pkey can read.`,
      );
    files.push({
      path: f.path,
      name: f.name,
      type: "maven-file",
      extension: m[2]!,
      ...(m[1] ? { classifier: m[1] } : {}),
    });
  }
  const packaging = pomField(pom, "packaging") ?? "jar";
  return {
    version,
    files,
    metadata: {
      name: input.declaration.name,
      version,
      groupId,
      artifactId,
      packaging,
    },
  };
}
