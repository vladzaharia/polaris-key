/// <reference types="@cloudflare/workers-types" />
/**
 * Maven and Gradle deploys (F-22): `PUT /maven/<owner>/<group/as/path>/<artifactId>/…`.
 *
 * `mvn deploy` and Gradle's `maven-publish` PUT a version file by file into the repository
 * layout, then each file's checksum sidecars, then the artifact's `maven-metadata.xml` (and its
 * sidecars). That order is what this adapter keys on:
 *
 *   `<g>/<a>/<v>/<a>-<v>[-<classifier>].<ext>`  a file of version `v`: staged into the version's
 *                                               upload session (`sessions.ts`) after the version
 *                                               as gathered so far plans cleanly; `201`;
 *   `…/<file>.{md5,sha1,sha256,sha512}`          a checksum sidecar: checked against the staged
 *                                               file's own digest (a mismatch is refused, so a
 *                                               corrupted upload never publishes) and not stored:
 *                                               the feed derives every sidecar (F-07); `201`;
 *   `…/<file>.asc`                               a signature: accepted and not stored, as the CLI
 *                                               leaves it (the feed serves no `.asc`); `201`;
 *   `<g>/<a>/maven-metadata.xml`                 the artifact's metadata, uploaded LAST: it
 *                                               publishes this token's open sessions of the
 *                                               artifact as releases; the uploaded document is
 *                                               discarded (the feed renders its own); `201`;
 *   `…/maven-metadata.xml.{md5,sha1,…}`          accepted and discarded; `201`.
 *
 * The group and artifact are matched against the product's declared Maven packages (the name is
 * `groupId:artifactId`); a PUT under any other coordinates is refused (`package-undeclared`).
 * `-SNAPSHOT` versions are refused at once (`maven-snapshot`: a feed's versions never change).
 * A POM must name the coordinates of its path; its `packaging` becomes the release's.
 */

import { createHash } from "node:crypto";
import { packageNameNorm } from "@polaris-key/manifest";
import type { RegistryRoute } from "../../../../core/registryHost.js";
import { readCappedBody } from "./body.js";
import {
  nativeDescriptor,
  nativeSource,
  planNative,
  sha256Hex,
  stageFile,
  type StagedFile,
} from "./publish.js";
import { publishRoute, refusalResponse, type PublishCall } from "./route.js";
import {
  finalizeSession,
  openSession,
  readSession,
  saveSession,
  touchSessions,
  withFile,
  principalId,
  type SessionKey,
} from "./sessions.js";
import { readPackageDeliverables } from "../ingest.js";

const PATH = /^\/maven\/([a-z0-9][a-z0-9-]{0,63})\/(.+)$/;
const SEGMENT = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/;
const SUMS = ["md5", "sha1", "sha256", "sha512"] as const;
type Sum = (typeof SUMS)[number];
const METADATA_MAX = 1024 * 1024;

/** A staged Maven file, with the digests its sidecars are checked against. */
interface MavenStaged extends StagedFile {
  readonly md5?: string;
  readonly sha1?: string;
  readonly sha512?: string;
}

function created(): Response {
  return new Response(null, {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
}

function bad(message: string, reason = "maven-bad-deploy", status = 400) {
  return refusalResponse("maven", {
    status,
    code: "bad_request",
    reason,
    message,
  });
}

/** A top-level POM element (outside `<parent>`, `<dependencies>` and the like), as the CLI reads it. */
export function pomField(xml: string, field: string): string | null {
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

/** Read and discard a small body (metadata, a signature), so the client sees a clean 201. */
async function discard(req: Request): Promise<boolean> {
  const body = await readCappedBody(req, METADATA_MAX);
  return body.ok;
}

async function handle({
  req,
  ctx,
  principal,
  feed,
  params,
}: PublishCall): Promise<Response> {
  const owner = ctx.product.slug;
  const segments = params.path!.split("/");
  if (
    segments.length < 3 ||
    segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")
  ) {
    await req.body?.cancel().catch(() => undefined);
    return bad("not a Maven repository path");
  }
  await touchSessions(ctx.db, owner, "maven", principal);
  // Which declared package the path is under: `<group as path>/<artifactId>/`.
  const lower = segments.map((s) => s.toLowerCase());
  const declared = (await readPackageDeliverables(ctx.db, owner))
    .filter((p) => p.ecosystem === "maven")
    .map((p) => {
      const [group = "", artifact = ""] = p.name.split(":");
      return { ...p, prefix: [...group.split("."), artifact], artifact };
    })
    .find(
      (p) =>
        p.prefix.length < segments.length &&
        p.prefix.every((s, i) => s.toLowerCase() === lower[i]),
    );
  if (!declared) {
    await req.body?.cancel().catch(() => undefined);
    return refusalResponse("maven", {
      status: 403,
      code: "forbidden",
      reason: "package-undeclared",
      message: `${segments.join("/")} is not under a Maven package this product declares; add it to .pkey/release (a package deliverable) and sync the manifest before deploying it.`,
    });
  }
  const rest = segments.slice(declared.prefix.length);
  const nameNorm = packageNameNorm("maven", declared.name);

  // The artifact's metadata (and its sidecars): the deploy is done.
  if (rest.length === 1) {
    const file = rest[0]!;
    if (!/^maven-metadata\.xml(\.(md5|sha1|sha256|sha512|asc))?$/.test(file)) {
      await req.body?.cancel().catch(() => undefined);
      return bad(`${file} is not a file of the repository layout`);
    }
    if (!(await discard(req))) return bad("the metadata is too large");
    if (file !== "maven-metadata.xml") return created();
    const open = await ctx.db.all<{ version: string }>(
      `SELECT version FROM release_native_uploads
        WHERE product = ? AND ecosystem = 'maven' AND name_norm = ? AND principal_id = ?
          AND state = 'open' ORDER BY created_at`,
      owner,
      nameNorm,
      principalId(principal),
    );
    for (const { version } of open) {
      const res = await finalizeSession(
        ctx,
        { product: owner, ecosystem: "maven", nameNorm, version },
        null,
      );
      if (!res.ok && !("skipped" in res)) return refusalResponse("maven", res);
    }
    return created();
  }
  if (rest.length !== 2) {
    await req.body?.cancel().catch(() => undefined);
    return bad(`${segments.join("/")} is not a file of the repository layout`);
  }
  const [version, file] = rest as [string, string];
  if (/-SNAPSHOT$/i.test(version)) {
    await req.body?.cancel().catch(() => undefined);
    return bad(
      `${version} is a Maven snapshot; a package version is immutable, so snapshots are never published to a feed.`,
      "maven-snapshot",
    );
  }
  // A version-level metadata file exists only for snapshots; anything else there is discarded.
  if (/^maven-metadata\.xml/.test(file))
    return (await discard(req)) ? created() : bad("the metadata is too large");
  const key: SessionKey = {
    product: owner,
    ecosystem: "maven",
    nameNorm,
    version,
  };
  if (file.endsWith(".asc"))
    return (await discard(req)) ? created() : bad("the signature is too large");
  const sum = SUMS.find((s) => file.endsWith(`.${s}`));
  if (sum) return checksum(req, ctx.db, key, file, sum);

  const stem = `${declared.artifact}-${version}`;
  const tail = file.startsWith(stem) ? file.slice(stem.length) : null;
  const m =
    tail === null
      ? null
      : /^(?:-([A-Za-z0-9][A-Za-z0-9_.-]*?))?\.([a-z0-9][a-z0-9.]*)$/.exec(
          tail,
        );
  if (!m) {
    await req.body?.cancel().catch(() => undefined);
    return bad(
      `${file} is not a file of ${stem} (a Maven file is named <artifactId>-<version>[-<classifier>].<extension>)`,
      "maven-file-name",
    );
  }
  const body = await readCappedBody(req);
  if (!body.ok)
    return body.reason === "too-large"
      ? refusalResponse("maven", {
          status: 413,
          code: "body_too_large",
          reason: "too-large",
          message:
            "the file is over the 32 MiB native-publish limit; publish it with pkey release publish, which uploads straight to the blob store",
        })
      : bad("the request body could not be read");
  const bytes = body.bytes;
  const [group, artifact] = declared.name.split(":") as [string, string];
  const session = await openSession(ctx.db, {
    key,
    deliverableId: declared.id,
    name: declared.name,
    principal,
    client: "maven",
    channel: null,
    now: ctx.now,
  });
  if (!("sessionId" in session)) return refusalResponse("maven", session);
  const metadata: Record<string, unknown> = {
    groupId: group,
    artifactId: artifact,
    packaging: "jar",
    ...session.metadata,
  };
  if (m[2] === "pom" && m[1] === undefined) {
    const pom = new TextDecoder().decode(bytes);
    const pomGroup =
      pomField(pom, "groupId") ??
      /<parent>[\s\S]*?<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(pom)?.[1] ??
      null;
    if (
      pomGroup !== group ||
      pomField(pom, "artifactId") !== artifact ||
      (pomField(pom, "version") ??
        /<parent>[\s\S]*?<version>\s*([^<\s]+)\s*<\/version>/.exec(
          pom,
        )?.[1]) !== version
    )
      return bad(
        `the POM does not name ${group}:${artifact}:${version}`,
        "maven-pom-mismatch",
      );
    metadata.packaging = pomField(pom, "packaging") ?? "jar";
  }
  const staged0 = {
    name: file,
    type: "maven-file",
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    extension: m[2]!,
    ...(m[1] ? { classifier: m[1] } : {}),
  };
  const pending = withFile(session, { ...staged0, staging: "" });
  if (!Array.isArray(pending)) return refusalResponse("maven", pending);
  const plan = await planNative(
    ctx,
    nativeDescriptor({
      product: owner,
      deliverable: declared.id,
      ecosystem: "maven",
      name: declared.name,
      version,
      channel: null,
      files: pending,
      metadata: { ...metadata, name: declared.name, version },
    }),
    feed,
    nativeSource(principal, "maven"),
  );
  if (!plan.ok) return refusalResponse("maven", plan);
  const staged = await stageFile(
    ctx.env,
    owner,
    session.sessionId,
    staged0,
    bytes,
  );
  if (!("staging" in staged)) return refusalResponse("maven", staged);
  const withDigests: MavenStaged = {
    ...staged,
    md5: createHash("md5").update(bytes).digest("hex"),
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  };
  const files = withFile(session, withDigests);
  if (!Array.isArray(files)) return refusalResponse("maven", files);
  const seq = await saveSession(ctx.db, session, files, metadata, ctx.now);
  if (seq === null)
    return bad(
      `the upload of ${declared.name} ${version} changed while this file was being stored; retry`,
      "upload-in-progress",
      409,
    );
  return created();
}

/** A checksum sidecar: must agree with the staged file it names; never stored. */
async function checksum(
  req: Request,
  db: PublishCall["ctx"]["db"],
  key: SessionKey,
  file: string,
  sum: Sum,
): Promise<Response> {
  const body = await readCappedBody(req, 4 * 1024);
  if (!body.ok) return bad("a checksum is a short hex digest");
  const text = new TextDecoder().decode(body.bytes).trim().toLowerCase();
  // Some tools write `<hex>  <file name>`; the digest is the first token.
  const hex = text.split(/\s+/)[0] ?? "";
  const base = file.slice(0, -(sum.length + 1));
  const session = await readSession(db, key);
  const staged = session?.files.find((f) => f.name === base) as
    | MavenStaged
    | undefined;
  // A sidecar of a file this session does not hold (a signature's, say) has nothing to check.
  if (!staged) return created();
  const want = sum === "sha256" ? staged.sha256 : staged[sum];
  if (want !== undefined && hex !== want)
    return bad(
      `${file} does not match the ${base} uploaded; the upload is corrupt, deploy again`,
      "integrity-mismatch",
    );
  return created();
}

export const MAVEN_DEPLOY_ROUTE: RegistryRoute = publishRoute({
  name: "maven.deploy",
  ecosystem: "maven",
  method: "PUT",
  match(pathname) {
    const m = PATH.exec(pathname);
    return m ? { owner: m[1]!, params: { path: m[2]! } } : null;
  },
  handle,
});
