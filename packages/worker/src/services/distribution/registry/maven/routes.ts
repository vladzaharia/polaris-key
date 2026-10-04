/// <reference types="@cloudflare/workers-types" />
/**
 * The Maven feed's routes on the registry host (F-07, plans/F-01.md §6.2, §6.8):
 *
 *   /maven/<owner>/<group/as/path>/<artifactId>/maven-metadata.xml[.md5|.sha1|.sha256|.sha512]
 *   /maven/<owner>/<group/as/path>/<artifactId>/<version>/<file>[.md5|.sha1|.sha256|.sha512]
 *
 * That is the whole of a Maven repository's read side (https://maven.apache.org/repository/layout.html):
 * Gradle and Maven compute every URL from the coordinates, so nothing else is needed. The
 * paths are case-sensitive, as in any Maven repository: the group and artifact must equal the
 * declared `groupId:artifactId`.
 *
 * EVERY READ GOES THROUGH `serveFeedRead` (F-02): the access ladder first, from the settings
 * cache, then the Cache API for a public feed. The deliverable is looked up before that only to
 * name it to the ladder; an unknown artifact passes `null` and answers the not-found from inside,
 * so a non-public feed answers the same 401 for a package it holds and one it does not.
 *
 *   - `maven-metadata.xml` and its sidecars are rendered objects (`render.ts`) read from R2
 *     under `registry/maven/<owner>/`, `public, max-age=60, stale-while-revalidate=60` with a
 *     strong ETag of the body's SHA-256 (§6.7). Before answering, the stored object's render
 *     stamp is compared with the package's current state, and a missing or stale object is
 *     rendered again first (`readFreshRegistryObject`), so a publish, yank or channel move shows up
 *     on the next uncached read even before a queue drain has run.
 *   - A version's files are the publication's own bytes, from the blob store by SHA-256
 *     (`blobs/sha256/<hex>`, as F-03 addresses every package file), through `blobResponse`:
 *     strong ETag `"<sha256>"`, `Range`, and `public, max-age=31536000, immutable` (plus
 *     `no-transform`: the edge must not recompress bytes whose checksums are published).
 *   - A file's sidecar is the digest Release recorded at ingest, immutable like the file.
 *
 * Every success is `application/octet-stream`, which the host turns into an attachment: POMs,
 * `.module` files and the metadata are never served as XML or JSON (§6.1). Anything else, an
 * unknown version or file and a digest the file does not carry included, is the not-found.
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import {
  registryNotFound,
  registryOrigin,
  type RegistryRoute,
  type RegistryRouteContext,
} from "../../../../core/registryHost.js";
import { blobKey, blobResponse } from "../../../../core/blobs.js";
import { registryCacheHeaders } from "../cache.js";
import { registryPackageOf } from "../catalogSource.js";
import {
  SHA256_META,
  readFreshRegistryObject,
  type RegistryRenderer,
} from "../materialise.js";
import { feedRoute } from "../serve.js";
import {
  MAVEN_CONTENT_TYPE,
  MAVEN_METADATA,
  artifactDirectory,
  checksumBody,
  digestHex,
  isMavenChecksum,
  type MavenChecksum,
} from "./render.js";

/** A path segment of a Maven repository: no escapes, no empty, `.` or `..` segment. */
const SEGMENT = /^[A-Za-z0-9_+~-][A-Za-z0-9_.+~-]*$/;
const METADATA_FILE = /^maven-metadata\.xml(?:\.(md5|sha1|sha256|sha512))?$/;
const SIDECAR = /^(.+)\.(md5|sha1|sha256|sha512)$/;

/** The segments after `/maven/`, when every one is a plain repository segment. */
function segments(pathname: string): string[] | null {
  if (!pathname.startsWith("/maven/")) return null;
  const parts = pathname.slice("/maven/".length).split("/");
  return parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")
    ? parts
    : null;
}

/** `/maven/<owner>/<group…>/<artifactId>/maven-metadata.xml[.<algo>]`. */
export function matchMavenMetadata(
  pathname: string,
): { owner: string; params: Record<string, string> } | null {
  const s = segments(pathname);
  // owner, at least one group segment, the artifact, the file.
  if (!s || s.length < 4) return null;
  const m = METADATA_FILE.exec(s[s.length - 1]!);
  if (!m) return null;
  return {
    owner: s[0]!,
    params: {
      groupId: s.slice(1, -2).join("."),
      artifactId: s[s.length - 2]!,
      checksum: m[1] ?? "",
    },
  };
}

/** `/maven/<owner>/<group…>/<artifactId>/<version>/<file>`. */
export function matchMavenFile(
  pathname: string,
): { owner: string; params: Record<string, string> } | null {
  const s = segments(pathname);
  // owner, at least one group segment, the artifact, the version, the file.
  if (!s || s.length < 5) return null;
  const file = s[s.length - 1]!;
  if (file.startsWith(MAVEN_METADATA)) return null;
  return {
    owner: s[0]!,
    params: {
      groupId: s.slice(1, -3).join("."),
      artifactId: s[s.length - 3]!,
      version: s[s.length - 2]!,
      file,
    },
  };
}

/** The deliverable declared as exactly `groupId:artifactId` in the owner's Maven feed. */
async function mavenDeliverable(
  catalog: ReleaseCatalog | null,
  groupId: string,
  artifactId: string,
): Promise<{ id: string; name: string } | null> {
  if (!catalog) return null;
  const name = `${groupId}:${artifactId}`;
  const found = (await catalog.packageDeliverables()).find(
    (d) => d.ecosystem === "maven" && d.name === name,
  );
  return found ? { id: found.id, name: found.name } : null;
}

/** A Maven answer's headers: opaque bytes, an attachment named after the file. */
function mavenHeaders(file: string, extra: Record<string, string>): Headers {
  return new Headers({
    "content-type": MAVEN_CONTENT_TYPE,
    "content-disposition": `attachment; filename="${file}"`,
    ...extra,
  });
}

/** Strip the validators a public answer must not be computed with: the cache stores the full
 *  200 and `serveFeedRead` turns a matching `If-None-Match` into the 304 itself. */
function forCache(req: Request): Request {
  if (!req.headers.has("if-none-match")) return req;
  const headers = new Headers(req.headers);
  headers.delete("if-none-match");
  return new Request(req.url, { method: req.method, headers });
}

/** The catalog and the deliverable a request names, looked up before the ladder. */
interface MavenRead {
  readonly catalog: ReturnType<RegistryRouteContext["hooks"]["releaseCatalog"]>;
  readonly deliverable: Awaited<ReturnType<typeof mavenDeliverable>>;
}

async function resolveMaven(
  _req: Request,
  ctx: RegistryRouteContext,
): Promise<MavenRead> {
  const catalog = ctx.hooks.releaseCatalog();
  const deliverable = await mavenDeliverable(
    catalog,
    ctx.params.groupId!,
    ctx.params.artifactId!,
  );
  return { catalog, deliverable };
}

export function mavenRoutes(renderer: () => RegistryRenderer): RegistryRoute[] {
  const metadata = feedRoute<MavenRead>({
    name: "mavenMetadata",
    ecosystem: "maven",
    match: matchMavenMetadata,
    resolve: resolveMaven,
    deliverableId: (_params, { deliverable }) => deliverable?.id ?? null,
    async serve(_req, ctx, cache, { catalog, deliverable }) {
      const { groupId, artifactId, checksum } = ctx.params as Record<
        string,
        string
      >;
      const bucket = ctx.env.BLOBS;
      if (!deliverable || !catalog || !bucket) return registryNotFound("maven");
      const pkg = registryPackageOf(
        ctx.product.slug,
        "maven",
        deliverable,
        await catalog.packageVersions(deliverable.id),
        await catalog.packageChannelHeads(deliverable.id),
        deliverable.name.toLowerCase(),
      );
      const file = checksum ? `${MAVEN_METADATA}.${checksum}` : MAVEN_METADATA;
      const obj = await readFreshRegistryObject(
        {
          bucket,
          renderers: new Map([["maven", renderer()]]),
          source: { package: async () => pkg },
          origin: registryOrigin(ctx.env) ?? "",
        },
        {
          ecosystem: "maven",
          owner: ctx.product.slug,
          key: `${artifactDirectory(groupId!, artifactId!)}/${file}`,
          deliverableId: deliverable.id,
        },
      );
      if (!obj) return registryNotFound("maven");
      const sha256 = obj.customMetadata?.[SHA256_META] ?? "";
      return new Response(obj.body, {
        status: 200,
        headers: mavenHeaders(
          file,
          registryCacheHeaders(cache, "index", sha256),
        ),
      });
    },
  });

  const file = feedRoute<MavenRead>({
    name: "mavenFile",
    ecosystem: "maven",
    match: matchMavenFile,
    resolve: resolveMaven,
    deliverableId: (_params, { deliverable }) => deliverable?.id ?? null,
    async serve(req, ctx, cache, { catalog, deliverable }) {
      const { version, file: name } = ctx.params as Record<string, string>;
      const bucket = ctx.env.BLOBS;
      if (!deliverable || !catalog || !bucket) return registryNotFound("maven");
      const v = (await catalog.packageVersions(deliverable.id)).find(
        (x) => x.version === version,
      );
      if (!v) return registryNotFound("maven");
      const files = v.files.filter((f) => f.type === "maven-file");
      const exact = files.find((f) => f.name === name);
      // A digest that cannot name a blob (a hand-edited row) is the not-found, not a throw.
      if (exact && !/^[0-9a-f]{64}$/.test(exact.sha256))
        return registryNotFound("maven");
      if (exact)
        return blobResponse(
          cache === "public" ? forCache(req) : req,
          bucket,
          blobKey(exact.sha256),
          {
            sha256: exact.sha256,
            gated: cache === "private",
            env: ctx.env,
            filename: exact.name,
          },
        );
      const side = SIDECAR.exec(name!);
      const of = side ? files.find((f) => f.name === side[1]) : undefined;
      const algo = side?.[2];
      if (!of || !algo || !isMavenChecksum(algo))
        return registryNotFound("maven");
      const body = checksumBody(of, algo as MavenChecksum);
      if (body === null) return registryNotFound("maven");
      return new Response(body, {
        status: 200,
        headers: mavenHeaders(
          name!,
          registryCacheHeaders(cache, "immutable", digestHex("sha256", body)),
        ),
      });
    },
  });

  return [metadata, file];
}
