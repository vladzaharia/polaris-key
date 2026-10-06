/**
 * The Go feed's renderer (F-31, plans/F-01.md §6.5, §6.8): the module proxy protocol's index
 * documents (https://go.dev/ref/mod#goproxy-protocol), rendered from Release's package state.
 *
 * WHAT IS RENDERED, per module, under the owner's feed prefix (`<module>` is the proxy's
 * case-encoded path, `!` spelled `%21` in the object key):
 *
 *   <module>/@v/list            every version that is not yanked, one `v<version>` per line
 *   <module>/@latest            the `latest` tag's info (omitted while the stable channel serves
 *                               nothing listed)
 *   <module>/@v/v<version>.info  {"Version","Time"} for every version, yanked ones included
 *   <module>/@v/<tag>.info      the info of the version a channel tag points at
 *
 * The `.mod` and `.zip` answers are the release's own bytes (`go-mod`, `go-zip`), served from the
 * blob store by digest (`routes.ts`): never rendered, never unzipped.
 *
 * VERSIONS, CHANNELS AND STATES:
 *   - A release version is semver without Go's `v`, which the feed adds: release 1.4.0 is module
 *     version v1.4.0 (`@polaris-key/manifest` `GO_PACKAGE_RULES`).
 *   - A yanked version leaves `@v/list` and can no longer be `@latest` or a tag's target, so no
 *     query (`@latest`, `@v1`, `@>=1.2`) resolves to it. Its `.info`, `.mod` and `.zip` stay, so a
 *     go.mod or go.sum that pins it keeps building (Go has no other yank; its `retract` directive
 *     lives in the module's own go.mod, which the feed never rewrites).
 *   - A channel is a query: `go get <module>@beta` asks for `@v/beta.info`, and the proxy answers
 *     with the canonical version the tag points at, exactly as for a branch name on a VCS. A tag
 *     spelled like a version (`v1…`) is skipped: a version's own `.info` always wins.
 *   - Deprecation has no place in the protocol (Go reads `// Deprecated:` from the module's own
 *     go.mod), so a deprecated version renders like a live one.
 *
 * `@v/list` goes out as `application/octet-stream` (the host never serves `text/*`); the go
 * command reads every answer as bytes, whatever its type.
 */

import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderedObject,
} from "../materialise.js";

export const GO_JSON_TYPE = "application/json";
export const GO_BYTES_TYPE = "application/octet-stream";

/** `module.EscapePath` / `EscapeVersion`: every upper-case letter becomes `!` and its lower case. */
export function goEscape(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

/** The inverse of `goEscape`, or null for a string the go command never sends (an upper-case
 *  letter, or `!` before anything but a lower-case letter). */
export function goUnescape(s: string): string | null {
  if (/[A-Z]/.test(s)) return null;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "!") {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined || !/[a-z]/.test(next)) return null;
    out += next.toUpperCase();
    i++;
  }
  return out;
}

/** The object-key spelling of an escaped path or version: `!` is not a key character. */
export function goKeyOf(escaped: string): string {
  return escaped.replace(/!/g, "%21");
}

/** The key prefix of one module's documents. */
export function goModuleKey(module: string): string {
  return goKeyOf(goEscape(module));
}

/** The Go version of a release version (`1.4.0` → `v1.4.0`). */
export function goVersionOf(version: string): string {
  return `v${version}`;
}

/** The release version a canonical Go version names (`v1.4.0` → `1.4.0`), or null. */
export function releaseVersionOf(goVersion: string): string | null {
  return /^v[0-9]/.test(goVersion) ? goVersion.slice(1) : null;
}

/** RFC 3339 in UTC, to the second, as the go command and proxy.golang.org write it. */
export function goTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A version's `.info` document. */
export function goInfo(v: PackageVersion): string {
  return `${JSON.stringify({
    Version: goVersionOf(v.version),
    Time: goTime(v.publishedAt),
  })}\n`;
}

/** The versions `@v/list` names: every one that is not yanked, in publication order. */
export function listedVersions(pkg: RegistryPackage): PackageVersion[] {
  return pkg.versions.filter((v) => v.state !== "yanked");
}

/** The one file of `type` a version carries (`go-zip`, `go-mod`), if it carries exactly one. */
export function goFileOf(
  v: Pick<PackageVersion, "files">,
  type: "go-zip" | "go-mod",
): PackageFile | null {
  const files = v.files.filter((f) => f.type === type);
  return files.length === 1 && /^[0-9a-f]{64}$/.test(files[0]!.sha256)
    ? files[0]!
    : null;
}

/** Every object of one module's render. */
export function renderGo(pkg: RegistryPackage): RenderedObject[] {
  const dir = goModuleKey(pkg.name);
  const listed = listedVersions(pkg);
  const byVersion = new Map(listed.map((v) => [v.version, v]));
  const out: RenderedObject[] = [
    {
      key: `${dir}/@v/list`,
      body: listed.map((v) => `${goVersionOf(v.version)}\n`).join(""),
      contentType: GO_BYTES_TYPE,
    },
  ];
  const latest =
    pkg.tags.latest !== undefined ? byVersion.get(pkg.tags.latest) : undefined;
  if (latest)
    out.push({
      key: `${dir}/@latest`,
      body: goInfo(latest),
      contentType: GO_JSON_TYPE,
    });
  for (const [tag, version] of Object.entries(pkg.tags).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const v = byVersion.get(version);
    if (!v || /^v[0-9]/.test(tag) || !/^[A-Za-z0-9._~-]+$/.test(tag)) continue;
    out.push({
      key: `${dir}/@v/${goKeyOf(goEscape(tag))}.info`,
      body: goInfo(v),
      contentType: GO_JSON_TYPE,
    });
  }
  for (const v of pkg.versions)
    out.push({
      key: `${dir}/@v/${goKeyOf(goEscape(goVersionOf(v.version)))}.info`,
      body: goInfo(v),
      contentType: GO_JSON_TYPE,
    });
  return out;
}
