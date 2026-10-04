/**
 * PyPI (F-05's feed): the wheels and the sdist of one version. Each wheel's
 * `*.dist-info/METADATA` is extracted into a `core-metadata` file beside it (PEP 658 serves it as
 * `<wheel>.metadata`); `Requires-Python` and the summary go into the metadata.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withZip } from "../zip.js";
import { readTarMember } from "./tar.js";
import { declaredFiles } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

/** RFC 822-style headers of a METADATA file (the body after the blank line is ignored). */
export function parseCoreMetadata(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break;
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (m && !out.has(m[1]!.toLowerCase()))
      out.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return out;
}

export async function extractPypi(input: ExtractInput): Promise<Extracted> {
  const found = await declaredFiles(input);
  const wheels = found.filter((f) => f.name.endsWith(".whl"));
  const sdists = found.filter((f) => f.name.endsWith(".tar.gz"));
  if (wheels.length + sdists.length === 0)
    throw new PackageExtractError(
      "no wheel (.whl) or sdist (.tar.gz) under --dir matches the package's artifacts globs.",
    );
  const files: ExtractedFile[] = [];
  let headers: Map<string, string> | null = null;
  for (const w of wheels) {
    const text = await withZip(w.path, async (zip) => {
      const entry = zip.entries.find((e) =>
        /^[^/]+\.dist-info\/METADATA$/.test(e.name),
      );
      if (!entry)
        throw new PackageExtractError(`${w.name} has no *.dist-info/METADATA.`);
      return (await zip.read(entry)).toString("utf8");
    });
    const metaName = `${w.name}.metadata`;
    const metaPath = path.join(input.workDir, metaName);
    await writeFile(metaPath, text);
    files.push(
      { path: w.path, name: w.name, type: "wheel" },
      { path: metaPath, name: metaName, type: "core-metadata" },
    );
    headers ??= parseCoreMetadata(text);
  }
  for (const s of sdists) {
    files.push({ path: s.path, name: s.name, type: "sdist" });
    if (!headers) {
      const pkgInfo = await readTarMember(s.path, (p) =>
        /^[^/]+\/PKG-INFO$/.test(p),
      );
      if (pkgInfo) headers = parseCoreMetadata(pkgInfo.data.toString("utf8"));
    }
  }
  const name = headers?.get("name");
  const version = headers?.get("version");
  if (!name || !version)
    throw new PackageExtractError(
      "the wheel's METADATA (or the sdist's PKG-INFO) carries no Name and Version.",
    );
  const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");
  if (norm(name) !== norm(input.declaration.name))
    throw new PackageExtractError(
      `the files are ${name}, but .pkey/release declares ${input.declaration.id} as ${input.declaration.name}.`,
    );
  const metadata: Record<string, unknown> = {
    name: input.declaration.name,
    version,
  };
  const summary = headers?.get("summary");
  if (summary) metadata.summary = summary;
  const requiresPython = headers?.get("requires-python");
  if (requiresPython) metadata.requiresPython = requiresPython;
  const license = headers?.get("license");
  if (license) metadata.license = license;
  return { version, files, metadata };
}
