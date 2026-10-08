/**
 * The PyPI simple repository documents (F-05, plans/F-01.md §6.8): pure functions from a
 * `RegistryPackage` to the PEP 691 JSON (API 1.1, PEP 700) and the PEP 503 HTML forms of one
 * project page, and from the owner's project names to the project list.
 *
 *   - FILES are the version's `wheel` and `sdist` files. A `core-metadata` file (the CLI extracts
 *     each wheel's `*.dist-info/METADATA` beside it, named `<wheel>.metadata`) is never listed: it
 *     is the PEP 658 metadata of its wheel, advertised as `core-metadata: {sha256}` (PEP 714's
 *     key; the old `dist-info-metadata` spelling is deliberately not sent, PEP 714 §"Backwards
 *     compatibility") and served at `<file url>.metadata`.
 *   - URLS are RELATIVE to the project page (`../../files/<sha256>/<filename>`), so a rendered
 *     document never bakes in the host and stays right in every environment. The byte URL embeds
 *     the file's SHA-256, so it is immutable by construction (§6.2). The `#sha256=` fragment and
 *     `hashes.sha256` protect against corruption only, never authenticity (S-12 §8.1).
 *   - YANK is PEP 592: a yanked version's files carry `yanked: "<reason>"` (or `true` without a
 *     reason) and `data-yanked`, stay listed and stay fetchable, so an exact pin still installs.
 *   - DEPRECATE has no PyPI equivalent (PEP 592 has only yank; PEP 792's status markers are
 *     per project), so a deprecated version is listed as live. CHANNELS have none either: pip
 *     and uv pick pre-releases by PEP 440 version, so the page lists every version and maps no
 *     tag (§6.3's channel → tag mapping is npm's and OCI's).
 *   - THE HTML is the host's single HTML answer (§6.1). Every value is escaped, and the page has
 *     no script, form, style, image, `on*` attribute or base element; the route serves it under
 *     `PYPI_DOCUMENT_CSP`, which `inertDocumentPolicy` accepts.
 */

import { escapeHtml } from "../../../../core/platform.js";
import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderedObject,
} from "../materialise.js";

/** PEP 691's JSON type, the one pip and uv ask for first. */
export const PYPI_JSON_TYPE = "application/vnd.pypi.simple.v1+json";
/** PEP 691's HTML type (`core/registryHost.ts` `PYPI_HTML_TYPE`, restated: a service never
 *  needs Core's value to render). */
export const PYPI_HTML_TYPE = "application/vnd.pypi.simple.v1+html";
/** The simple API version every document declares (PEP 700's `size`, `upload-time`, `versions`). */
export const PYPI_API_VERSION = "1.1";

/** The file types a project page lists; `core-metadata` rides on its wheel. */
const LISTED = new Set(["wheel", "sdist"]);

/** PEP 503 normalisation: lower case, every run of `-`, `_` and `.` becomes one `-`. */
export function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A PEP 508 project name (the manifest's grammar), at most 128 characters. */
export function isProjectName(name: string): boolean {
  return (
    name.length <= 128 &&
    /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)
  );
}

/** The R2 keys of one project page, relative to the owner's `registry/pypi/<owner>/` prefix. */
export function projectPageKey(norm: string, form: "json" | "html"): string {
  return `simple/${norm}/index.${form}`;
}

/** A file's URL relative to its project page (`…/simple/<norm>/`). */
export function fileHref(file: PackageFile): string {
  return `../../files/${file.sha256}/${encodeURIComponent(file.name)}`;
}

/** PEP 700's `upload-time`: `yyyy-mm-ddThh:mm:ss.ffffffZ`. */
export function uploadTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** PEP 592's value for a version: the reason, `true` without one, `false` when live. */
function yankedValue(v: PackageVersion): string | boolean {
  if (v.state !== "yanked") return false;
  return v.stateMessage !== null && v.stateMessage !== ""
    ? v.stateMessage
    : true;
}

function requiresPython(v: PackageVersion): string | null {
  const r = v.metadata.requiresPython;
  return typeof r === "string" && r !== "" ? r : null;
}

/** One listed file with what both forms say about it. */
interface ListedFile {
  readonly file: PackageFile;
  readonly version: PackageVersion;
  /** The SHA-256 of the wheel's PEP 658 metadata file, when the version carries one. */
  readonly coreMetadata: string | null;
}

/** Every listed file of the package, in publication order, then by name. */
export function listedFiles(pkg: RegistryPackage): ListedFile[] {
  const out: ListedFile[] = [];
  for (const version of pkg.versions) {
    const byName = new Map(version.files.map((f) => [f.name, f]));
    const files = version.files
      .filter((f) => LISTED.has(f.type))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const file of files) {
      const meta =
        file.type === "wheel" ? byName.get(`${file.name}.metadata`) : undefined;
      out.push({
        file,
        version,
        coreMetadata: meta?.type === "core-metadata" ? meta.sha256 : null,
      });
    }
  }
  return out;
}

/** The PEP 691 JSON project page (API 1.1). */
export function projectJson(pkg: RegistryPackage): string {
  const files = listedFiles(pkg).map(({ file, version, coreMetadata }) => {
    const rp = requiresPython(version);
    return {
      filename: file.name,
      url: fileHref(file),
      hashes: { sha256: file.sha256 },
      ...(rp !== null ? { "requires-python": rp } : {}),
      ...(coreMetadata !== null
        ? { "core-metadata": { sha256: coreMetadata } }
        : {}),
      yanked: yankedValue(version),
      size: file.size,
      "upload-time": uploadTime(version.publishedAt),
    };
  });
  return JSON.stringify({
    meta: { "api-version": PYPI_API_VERSION },
    name: pkg.nameNorm,
    versions: pkg.versions.map((v) => v.version),
    files,
  });
}

/** The PEP 503 HTML project page (PEP 691's `v1+html` form). Every value escaped. */
export function projectHtml(pkg: RegistryPackage): string {
  const name = escapeHtml(pkg.nameNorm);
  const links = listedFiles(pkg).map(({ file, version, coreMetadata }) => {
    const attrs = [
      `href="${escapeHtml(`${fileHref(file)}#sha256=${file.sha256}`)}"`,
    ];
    const rp = requiresPython(version);
    if (rp !== null) attrs.push(`data-requires-python="${escapeHtml(rp)}"`);
    if (coreMetadata !== null)
      attrs.push(`data-core-metadata="sha256=${coreMetadata}"`);
    const yanked = yankedValue(version);
    if (yanked !== false)
      attrs.push(
        yanked === true ? "data-yanked" : `data-yanked="${escapeHtml(yanked)}"`,
      );
    return `    <a ${attrs.join(" ")}>${escapeHtml(file.name)}</a><br>`;
  });
  return [
    "<!DOCTYPE html>",
    "<html>",
    "  <head>",
    `    <meta name="pypi:repository-version" content="${PYPI_API_VERSION}">`,
    `    <title>Links for ${name}</title>`,
    "  </head>",
    "  <body>",
    `    <h1>Links for ${name}</h1>`,
    ...links,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** One project of the owner's list: its declared name and its normalised one. */
export interface ListedProject {
  readonly name: string;
  readonly nameNorm: string;
}

function sortedProjects(projects: readonly ListedProject[]): ListedProject[] {
  return [...projects].sort((a, b) =>
    a.nameNorm < b.nameNorm ? -1 : a.nameNorm > b.nameNorm ? 1 : 0,
  );
}

/** The PEP 691 JSON project list. */
export function indexJson(projects: readonly ListedProject[]): string {
  return JSON.stringify({
    meta: { "api-version": PYPI_API_VERSION },
    projects: sortedProjects(projects).map((p) => ({ name: p.name })),
  });
}

/** The PEP 503 HTML project list: each project links to its normalised page. */
export function indexHtml(projects: readonly ListedProject[]): string {
  return [
    "<!DOCTYPE html>",
    "<html>",
    "  <head>",
    `    <meta name="pypi:repository-version" content="${PYPI_API_VERSION}">`,
    "    <title>Simple index</title>",
    "  </head>",
    "  <body>",
    ...sortedProjects(projects).map(
      (p) =>
        `    <a href="${escapeHtml(`${p.nameNorm}/`)}">${escapeHtml(p.name)}</a><br>`,
    ),
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Everything one package renders into R2: its project page in both forms. */
export function renderPypi(pkg: RegistryPackage): RenderedObject[] {
  return [
    {
      key: projectPageKey(pkg.nameNorm, "json"),
      body: projectJson(pkg),
      contentType: PYPI_JSON_TYPE,
    },
    {
      key: projectPageKey(pkg.nameNorm, "html"),
      body: projectHtml(pkg),
      contentType: PYPI_HTML_TYPE,
    },
  ];
}
