/**
 * The Maven feed's renderer (F-07, plans/F-01.md §6.5, §6.8): the one index document Maven has,
 * `maven-metadata.xml`, and its checksum sidecars, rendered from Release's package state.
 *
 * WHAT IS RENDERED, per package (`<groupId>:<artifactId>`), under the owner's feed prefix:
 *
 *   <group/as/path>/<artifactId>/maven-metadata.xml          the artifact-level metadata
 *   <group/as/path>/<artifactId>/maven-metadata.xml.<algo>   its md5, sha1, sha256, sha512
 *
 * The files of a version (the POM, the `.module`, the jar or AAR, sources, …) are the
 * publication's own bytes, served from the blob store by digest, and their sidecars come from
 * the digests Release computed at ingest (`checksumBody`). Nothing in a feed is ever uploaded
 * as a checksum or as metadata: both are derived, so they cannot disagree with the bytes.
 *
 * VERSIONS, CHANNELS AND STATES (§6.7; Maven has no yank or deprecation in its protocol):
 *   - `<versions>` lists every version that is not yanked, in publication order (Release's
 *     `seq`), oldest first, as a Maven repository manager writes it. A yanked version stays
 *     downloadable by its exact coordinates, so a build that pinned it keeps working, but no
 *     dynamic version (`1.+`, `[1.0,2.0)`, `LATEST`, `RELEASE`) can resolve to it any more.
 *   - A deprecated version is listed like a live one: the protocol cannot carry the message,
 *     which the console and the setup page show instead.
 *   - `<release>` is the `latest` tag (the `stable` channel's head under Release's resolution
 *     rules, yanks removed), omitted when the stable channel serves nothing. It is what Maven's
 *     `RELEASE` meta-version resolves to.
 *   - `<latest>` is the newest listed version of any channel (`LATEST`), so a beta published after
 *     the last stable is `latest` but never `release`.
 *   - `<lastUpdated>` is the newest listed version's publication time (UTC, `yyyyMMddHHmmss`),
 *     so equal state renders byte-identical documents.
 *
 * XML IS NEVER SERVED AS XML: every object here is `application/octet-stream`, and the host
 * forces `attachment` (THREAT-MODEL §3, "The registry host and package feeds"). Every value is
 * escaped all the same, although the name and version grammars admit no markup.
 */

import { createHash } from "node:crypto";
import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderedObject,
} from "../materialise.js";

/** The checksum sidecars a Maven repository carries, in Gradle's preference order. */
export const MAVEN_CHECKSUMS = ["sha512", "sha256", "sha1", "md5"] as const;
export type MavenChecksum = (typeof MAVEN_CHECKSUMS)[number];

export function isMavenChecksum(v: string): v is MavenChecksum {
  return (MAVEN_CHECKSUMS as readonly string[]).includes(v);
}

/** Every Maven document leaves as opaque bytes (never `xml`, plans/F-01.md §6.1). */
export const MAVEN_CONTENT_TYPE = "application/octet-stream";

/** The artifact-level metadata's file name. */
export const MAVEN_METADATA = "maven-metadata.xml";

/** `im.plrs.key:sdk` → `{ groupId: "im.plrs.key", artifactId: "sdk" }`, or null. */
export function mavenCoordinates(
  name: string,
): { groupId: string; artifactId: string } | null {
  const i = name.indexOf(":");
  if (i <= 0 || i === name.length - 1 || name.indexOf(":", i + 1) !== -1)
    return null;
  return { groupId: name.slice(0, i), artifactId: name.slice(i + 1) };
}

/** The repository directory of an artifact: `im/plrs/key/sdk`. */
export function artifactDirectory(groupId: string, artifactId: string): string {
  return `${groupId.split(".").join("/")}/${artifactId}`;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

/** Seconds since the epoch → Maven's `yyyyMMddHHmmss`, in UTC. */
export function mavenTimestamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    p(d.getUTCFullYear(), 4) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  );
}

/** The versions a feed lists: every one that is not yanked, in publication order. */
export function listedVersions(pkg: RegistryPackage): PackageVersion[] {
  return pkg.versions.filter((v) => v.state !== "yanked");
}

/** `maven-metadata.xml` for one package. */
export function mavenMetadataXml(pkg: RegistryPackage): string {
  const coords = mavenCoordinates(pkg.name);
  if (!coords)
    throw new Error("maven: the package name is not groupId:artifactId");
  const listed = listedVersions(pkg);
  const names = new Set(listed.map((v) => v.version));
  const release = pkg.tags.latest;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<metadata>`,
    `  <groupId>${xml(coords.groupId)}</groupId>`,
    `  <artifactId>${xml(coords.artifactId)}</artifactId>`,
    `  <versioning>`,
  ];
  const newest = listed[listed.length - 1];
  if (newest) lines.push(`    <latest>${xml(newest.version)}</latest>`);
  if (release !== undefined && names.has(release))
    lines.push(`    <release>${xml(release)}</release>`);
  if (listed.length === 0) lines.push(`    <versions/>`);
  else {
    lines.push(`    <versions>`);
    for (const v of listed)
      lines.push(`      <version>${xml(v.version)}</version>`);
    lines.push(`    </versions>`);
  }
  if (newest) {
    const last = Math.max(...listed.map((v) => v.publishedAt));
    lines.push(`    <lastUpdated>${mavenTimestamp(last)}</lastUpdated>`);
  }
  lines.push(`  </versioning>`, `</metadata>`, ``);
  return lines.join("\n");
}

/** The hex digest of `body` (a checksum sidecar's whole content). */
export function digestHex(
  algo: MavenChecksum,
  body: string | Uint8Array,
): string {
  return createHash(algo).update(body).digest("hex");
}

/**
 * A stored file's sidecar body, from the digests Release recorded at ingest (`files_json`):
 * SHA-256 is the blob key itself, SHA-512, SHA-1 and MD5 were streamed once after promotion.
 * `null` when the file carries no such digest (the sidecar is then the not-found).
 */
export function checksumBody(
  file: PackageFile,
  algo: MavenChecksum,
): string | null {
  const v = file[algo];
  return typeof v === "string" && /^[0-9a-f]+$/.test(v) ? v : null;
}

/** Every object of one package's Maven render: the metadata and its four sidecars. */
export function renderMaven(pkg: RegistryPackage): RenderedObject[] {
  const coords = mavenCoordinates(pkg.name);
  if (!coords) return [];
  const dir = artifactDirectory(coords.groupId, coords.artifactId);
  const body = mavenMetadataXml(pkg);
  const out: RenderedObject[] = [
    { key: `${dir}/${MAVEN_METADATA}`, body, contentType: MAVEN_CONTENT_TYPE },
  ];
  for (const algo of MAVEN_CHECKSUMS)
    out.push({
      key: `${dir}/${MAVEN_METADATA}.${algo}`,
      body: digestHex(algo, body),
      contentType: MAVEN_CONTENT_TYPE,
    });
  return out;
}
