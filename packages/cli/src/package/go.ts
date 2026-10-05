/**
 * Go (F-31's module proxy): one module version, as its module zip and its `go.mod`.
 *
 * TWO INPUTS. The artifacts globs match either
 *   - a module zip someone else built (`golang.org/x/mod/zip`, `gorelease`, a proxy's own `.zip`),
 *     whose every entry sits under `<module>@v<version>/`; the version is the zip's, or
 *   - a `go.mod`: its directory is the module root, and the CLI builds the module zip itself, by
 *     the rules `golang.org/x/mod/zip` `CreateFromDir` applies (below), with `--version` naming the
 *     version, so a Go developer publishes straight from the source tree with no extra tool.
 *
 * THE go.sum HASHES. The CLI computes both `h1:` dirhashes the go command writes into go.sum
 * (`golang.org/x/mod/sumdb/dirhash` `Hash1`): the zip's, over its entry names (which carry the
 * `<module>@<version>/` prefix), and the go.mod's, over the one name `go.mod`. They go into the
 * metadata (`h1`, `goModH1`), so the console can show the line a go.sum must hold. The go
 * command computes the same hashes from the bytes the feed serves.
 *
 * The release version is semver without Go's `v` (release 1.4.0 is module version v1.4.0), and a
 * v2+ module's path must end in `/v<major>` (`goMajorProblem`).
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { goMajorProblem, matchesArtifactGlob } from "@polaris-key/manifest";
import { scanDir } from "../publish.js";
import { withZip, zipStore } from "../zip.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

/** `golang.org/x/mod/zip`'s ceilings. */
export const GO_MAX_ZIP_BYTES = 500 << 20;
export const GO_MAX_GO_MOD_BYTES = 16 << 20;
export const GO_MAX_LICENSE_BYTES = 16 << 20;

const SEMVER_NO_BUILD =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** One file of a module zip: its entry name (with the `<module>@<version>/` prefix) and bytes. */
export interface GoZipFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * `dirhash.Hash1`: the SHA-256 of the lines `<sha256 hex>  <name>\n`, one per file in name order,
 * as `h1:<base64>`.
 */
export function goHash1(files: readonly GoZipFile[]): string {
  const sorted = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
  const summary = createHash("sha256");
  for (const f of sorted) {
    if (f.name.includes("\n"))
      throw new PackageExtractError(
        `${JSON.stringify(f.name)}: a file name with a newline cannot be hashed.`,
      );
    const h = createHash("sha256").update(f.data).digest("hex");
    summary.update(`${h}  ${f.name}\n`);
  }
  return `h1:${summary.digest("base64")}`;
}

/** The go.sum hash of a `go.mod` (the `/go.mod` line): `Hash1` over the one name `go.mod`. */
export function goModHash1(data: Uint8Array): string {
  return goHash1([{ name: "go.mod", data }]);
}

/** A go.mod's module path and go directive (enough for publishing; not a full parser). */
export function parseGoMod(text: string): { module?: string; go?: string } {
  const out: { module?: string; go?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const m = /^module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))$/.exec(line);
    if (m && out.module === undefined) out.module = m[1] ?? m[2] ?? m[3];
    const g = /^go\s+([0-9][0-9A-Za-z.]*)$/.exec(line);
    if (g && out.go === undefined) out.go = g[1];
  }
  return out;
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** `module.CheckFilePath`: why a path inside a module cannot be in its zip, or null. */
export function goFilePathProblem(rel: string): string | null {
  if (rel === "" || rel.startsWith("/") || rel.endsWith("/"))
    return "not a relative file path";
  for (const elem of rel.split("/")) {
    if (elem === "" || elem === "." || elem === "..")
      return "an empty, '.' or '..' path element";
    if (elem.endsWith(".")) return "a path element ending in '.'";
    for (const ch of elem)
      if (!/[A-Za-z0-9!#$%&()+,\-.=@[\]^_{}~ ]/.test(ch) && !/\p{L}/u.test(ch))
        return `the character ${JSON.stringify(ch)}`;
    const short = elem.split(".")[0]!.toUpperCase();
    if (WINDOWS_RESERVED.has(short)) return `the Windows reserved name ${elem}`;
  }
  return null;
}

/** `isVendoredPackage`: a file inside a package under a vendor directory, never zipped. */
export function goVendored(rel: string): boolean {
  let rest: string;
  if (rel.startsWith("vendor/")) rest = rel.slice("vendor/".length);
  else {
    const j = rel.indexOf("/vendor/");
    if (j < 0) return false;
    rest = rel.slice(j + "/vendor/".length);
  }
  return rest.includes("/");
}

function isLicense(rel: string): boolean {
  return rel === "LICENSE";
}

/** Check a module's files as `golang.org/x/mod/zip` does: paths, case collisions, ceilings. */
function checkModuleFiles(files: readonly { rel: string; size: number }[]) {
  const folded = new Map<string, string>();
  let total = 0;
  for (const f of files) {
    const problem = goFilePathProblem(f.rel);
    if (problem !== null)
      throw new PackageExtractError(
        `${f.rel} cannot be in a Go module zip: ${problem}.`,
      );
    const key = f.rel.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined)
      throw new PackageExtractError(
        `${f.rel} and ${other} differ only in case; a Go module zip refuses both.`,
      );
    folded.set(key, f.rel);
    if (f.rel === "go.mod" && f.size > GO_MAX_GO_MOD_BYTES)
      throw new PackageExtractError("go.mod is larger than 16 MiB.");
    if (isLicense(f.rel) && f.size > GO_MAX_LICENSE_BYTES)
      throw new PackageExtractError("LICENSE is larger than 16 MiB.");
    total += f.size;
  }
  if (total > GO_MAX_ZIP_BYTES)
    throw new PackageExtractError(
      "the module's files total more than 500 MiB, Go's module zip ceiling.",
    );
}

/**
 * The files `CreateFromDir` puts in a module zip, relative to `root`: every regular file, not in
 * a VCS directory (`.bzr`, `.git`, `.hg`, `.svn`), not in a nested module (a subdirectory holding
 * its own go.mod) and not inside a vendored package. Symbolic links are left out, as Go does.
 */
export async function goModuleFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if ([".bzr", ".git", ".hg", ".svn"].includes(e.name)) continue;
        const nested = await lstat(path.join(full, "go.mod")).catch(() => null);
        if (nested?.isFile()) continue;
        await walk(full, r);
      } else if (e.isFile() && !goVendored(r)) out.push(r);
    }
  }
  await walk(root, "");
  return out;
}

/** The module zip of the source tree at `root`, as `<module>@v<version>/…` entries. */
export async function goZipFromDir(
  root: string,
  module: string,
  version: string,
): Promise<GoZipFile[]> {
  const rels = await goModuleFiles(root);
  const files = await Promise.all(
    rels.map(async (rel) => ({
      rel,
      data: new Uint8Array(await readFile(path.join(root, ...rel.split("/")))),
    })),
  );
  checkModuleFiles(files.map((f) => ({ rel: f.rel, size: f.data.length })));
  const prefix = `${module}@v${version}/`;
  return files.map((f) => ({ name: prefix + f.rel, data: f.data }));
}

/** A module zip's files, checked: one `<module>@v<version>/` prefix, files only, valid paths. */
async function readModuleZip(
  zipPath: string,
  zipName: string,
  module: string,
): Promise<{ version: string; files: GoZipFile[] }> {
  return withZip(zipPath, async (z) => {
    if (z.entries.length === 0)
      throw new PackageExtractError(`${zipName} is empty.`);
    const head = /^(.+?)@(v[^/]+)\//.exec(z.entries[0]!.name);
    if (!head || head[1] !== module)
      throw new PackageExtractError(
        `${zipName} is not a module zip of ${module}: its entries must sit under ${module}@v<version>/.`,
      );
    const goVersion = head[2]!;
    const version = goVersion.slice(1);
    if (!SEMVER_NO_BUILD.test(version))
      throw new PackageExtractError(
        `${zipName}'s version ${goVersion} is not a semantic version without build metadata.`,
      );
    const prefix = `${module}@${goVersion}/`;
    const files: GoZipFile[] = [];
    const rels: { rel: string; size: number }[] = [];
    for (const e of z.entries) {
      if (!e.name.startsWith(prefix))
        throw new PackageExtractError(
          `${zipName}: ${e.name} is outside ${prefix}; a module zip holds one module version.`,
        );
      if (e.name.endsWith("/"))
        throw new PackageExtractError(
          `${zipName}: ${e.name} is a directory entry; a module zip holds files only.`,
        );
      const rel = e.name.slice(prefix.length);
      if (goVendored(rel))
        throw new PackageExtractError(
          `${zipName}: ${rel} is inside a vendored package, which a module zip never holds.`,
        );
      rels.push({ rel, size: e.size });
      files.push({ name: e.name, data: new Uint8Array(await z.read(e)) });
    }
    checkModuleFiles(rels);
    return { version, files };
  });
}

export async function extractGo(
  input: ExtractInput & { version?: string },
): Promise<Extracted> {
  const module = input.declaration.name;
  // Not `declaredFiles`: a source tree holds nested modules' go.mod files too, which the module
  // zip leaves out, so a repeated go.mod is not a conflict here.
  const globs = Object.values(input.declaration.artifacts).map((a) => a.match);
  const found = (await scanDir(input.dir)).filter((f) =>
    globs.some((g) => matchesArtifactGlob(g, f.name)),
  );
  const zips = found.filter((f) => f.name.endsWith(".zip"));
  const mods = found.filter((f) => f.name === "go.mod");
  if (zips.length > 1)
    throw new PackageExtractError(
      `${zips.length} module zips match (${zips.map((z) => z.name).join(", ")}); a release carries one.`,
    );

  let version: string;
  let zipFile: ExtractedFile;
  let zipFiles: GoZipFile[];
  if (zips[0]) {
    const read = await readModuleZip(zips[0].path, zips[0].name, module);
    version = read.version;
    zipFiles = read.files;
    zipFile = { path: zips[0].path, name: zips[0].name, type: "go-zip" };
  } else {
    if (mods.length === 0)
      throw new PackageExtractError(
        "no module zip and no go.mod under --dir matches the package's artifacts globs.",
      );
    if (!input.version)
      throw new PackageExtractError(
        "a Go module's source tree carries no version: pass --version (semver, without the v).",
      );
    if (!SEMVER_NO_BUILD.test(input.version))
      throw new PackageExtractError(
        `--version ${input.version} is not a semantic version without the v and without build metadata.`,
      );
    version = input.version;
    // The module root is the shallowest matching go.mod's directory; deeper ones are nested
    // modules, which its zip leaves out anyway.
    const depth = (p: string) => p.split(path.sep).length;
    const root = path.dirname(
      [...mods].sort((a, b) => depth(a.path) - depth(b.path))[0]!.path,
    );
    zipFiles = await goZipFromDir(root, module, version);
    const out = path.join(input.workDir, `v${version}.zip`);
    await writeFile(out, zipStore(zipFiles));
    zipFile = { path: out, name: `v${version}.zip`, type: "go-zip" };
  }

  const major = goMajorProblem(module, version);
  if (major !== null) throw new PackageExtractError(major);
  const goModEntry = zipFiles.find(
    (f) => f.name === `${module}@v${version}/go.mod`,
  );
  if (!goModEntry)
    throw new PackageExtractError(
      `the module has no go.mod at its root; the feed serves a module's own go.mod.`,
    );
  const parsed = parseGoMod(Buffer.from(goModEntry.data).toString("utf8"));
  if (parsed.module !== module)
    throw new PackageExtractError(
      `go.mod declares module ${parsed.module ?? "(none)"}, not ${module}: the module path is the package name.`,
    );
  // The `.mod` answer is the zip's own go.mod, byte for byte (the Worker never unzips).
  const goModPath = path.join(input.workDir, "go.mod");
  await writeFile(goModPath, goModEntry.data);
  return {
    version,
    files: [zipFile, { path: goModPath, name: "go.mod", type: "go-mod" }],
    metadata: {
      name: module,
      version,
      h1: goHash1(zipFiles),
      goModH1: goModHash1(goModEntry.data),
      ...(parsed.go ? { goVersion: parsed.go } : {}),
    },
  };
}
