/// <reference types="@cloudflare/workers-types" />
/**
 * `swift package-registry publish` (F-22): `PUT /swift/<owner>/<scope>/<name>/<version>`, SE-0292
 * §4.6 ("Create a package release") as SE-0391 extends it.
 *
 * SwiftPM sends `multipart/form-data` with the `source-archive` (the zip `swift package
 * archive-source` builds), and, for a signed release, its `source-archive-signature` (CMS, with
 * `X-Swift-Package-Signature-Format: cms-1.0.0`); the optional `metadata` and
 * `metadata-signature` parts are accepted and not stored (the registry's release metadata is
 * rendered from the release, F-06). One request is one release, published at once.
 *
 *   - the manifests the feed serves (`Package.swift`, `Package@swift-*.swift`) are read out of the
 *     archive, under `swiftArchive.ts`'s bounds: they are the archive's own bytes, which SwiftPM
 *     checksums and, for a signed release, carry their signatures inside;
 *   - the feed's signing rule is the ingest's (`swift-unsigned`): an unsigned release is refused
 *     where the feed requires signing (the default, and always for the system product);
 *   - answers follow the registry protocol: `Content-Version: 1` on every answer, `201 Created`
 *     with the release's `Location`, `409` for a version that exists, `problem+json` refusals.
 */

import { json } from "../../../../core/errors.js";
import type { RegistryRoute } from "../../../../core/registryHost.js";
import { registryOrigin } from "../../../../core/registryHost.js";
import { randomId } from "../../../../core/platform.js";
import { readCappedBody } from "./body.js";
import { multipartBoundary, parseMultipart, part } from "./multipart.js";
import {
  commitNative,
  declaredPackage,
  nativeDescriptor,
  nativeSource,
  planNative,
  sha256Hex,
  stageFile,
  undeclared,
  type NativeFile,
  type StagedFile,
} from "./publish.js";
import { publishRoute, refusalResponse } from "./route.js";
import { swiftArchiveManifests } from "./swiftArchive.js";

const RELEASE =
  /^\/swift\/([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([0-9A-Za-z.+-]{1,64})$/;
const SIGNATURE_FORMAT = "cms-1.0.0";
const MAX_SIGNATURE_BYTES = 64 * 1024;

function problem(status: number, reason: string, message: string) {
  return refusalResponse("swift", {
    status,
    code: "bad_request",
    reason,
    message,
  });
}

export const SWIFT_PUBLISH_ROUTE: RegistryRoute = publishRoute({
  name: "swift.publish",
  ecosystem: "swift",
  method: "PUT",
  match(pathname) {
    const m = RELEASE.exec(pathname);
    // `…/<version>.zip` and `…/Package.swift` are reads; a version never ends in `.zip`.
    if (!m || m[4]!.endsWith(".zip")) return null;
    return {
      owner: m[1]!,
      params: { scope: m[2]!, name: m[3]!, version: m[4]! },
    };
  },
  async handle({ req, ctx, principal, feed, params }) {
    const owner = ctx.product.slug;
    const name = `${params.scope}.${params.name}`;
    const version = params.version!;
    const accept = req.headers.get("accept");
    if (
      accept !== null &&
      !/application\/vnd\.swift\.registry(\.v1)?(\+json)?|\*\/\*|application\/\*/i.test(
        accept,
      )
    ) {
      await req.body?.cancel().catch(() => undefined);
      return problem(
        415,
        "swift-accept",
        "this registry speaks application/vnd.swift.registry.v1+json",
      );
    }
    const declared = await declaredPackage(ctx.db, owner, "swift", name);
    if (!declared) {
      await req.body?.cancel().catch(() => undefined);
      return refusalResponse("swift", undeclared("swift", name));
    }
    const boundary = multipartBoundary(req.headers.get("content-type"));
    if (boundary === null) {
      await req.body?.cancel().catch(() => undefined);
      return problem(
        415,
        "swift-content-type",
        "a release is published as multipart/form-data",
      );
    }
    const body = await readCappedBody(req);
    if (!body.ok)
      return body.reason === "too-large"
        ? refusalResponse("swift", {
            status: 413,
            code: "body_too_large",
            reason: "too-large",
            message:
              "the release is over the 32 MiB native-publish limit; publish it with pkey release publish, which uploads straight to the blob store",
          })
        : problem(
            400,
            "swift-bad-publish",
            "the request body could not be read",
          );
    const parts = parseMultipart(body.bytes, boundary);
    if (parts === null)
      return problem(
        400,
        "swift-bad-publish",
        "the request is not well-formed multipart",
      );
    const archive = part(parts, "source-archive");
    if (!archive || archive.data.byteLength === 0)
      return problem(
        422,
        "swift-bad-publish",
        "the request carries no source-archive",
      );
    const signature = part(parts, "source-archive-signature");
    const format = req.headers.get("x-swift-package-signature-format");
    if (signature) {
      if (format === null || format.trim().toLowerCase() !== SIGNATURE_FORMAT)
        return problem(
          422,
          "swift-signature-format",
          `a signed release names X-Swift-Package-Signature-Format: ${SIGNATURE_FORMAT}`,
        );
      if (
        signature.data.byteLength === 0 ||
        signature.data.byteLength > MAX_SIGNATURE_BYTES
      )
        return problem(
          422,
          "swift-signature-format",
          "the source-archive-signature is empty or too large",
        );
    }
    const manifests = await swiftArchiveManifests(archive.data);
    if (!manifests.ok)
      return problem(422, "swift-bad-archive", manifests.message);

    const archiveName = `${name}-${version}.zip`;
    const items: { file: NativeFile; bytes: Uint8Array }[] = [
      {
        file: {
          name: archiveName,
          type: "source-archive",
          sha256: await sha256Hex(archive.data),
          size: archive.data.byteLength,
        },
        bytes: archive.data,
      },
    ];
    if (signature)
      items.push({
        file: {
          name: `${archiveName}.sig`,
          type: "source-archive-signature",
          sha256: await sha256Hex(signature.data),
          size: signature.data.byteLength,
        },
        bytes: signature.data,
      });
    for (const m of manifests.manifests)
      items.push({
        file: {
          name: m.name,
          type: "manifest",
          sha256: await sha256Hex(m.bytes),
          size: m.bytes.byteLength,
        },
        bytes: m.bytes,
      });
    const toolsVersions = manifests.manifests
      .map((m) => /^Package@swift-([0-9.]+)\.swift$/.exec(m.name)?.[1])
      .filter((v): v is string => v !== undefined);
    const descriptor = nativeDescriptor({
      product: owner,
      deliverable: declared.id,
      ecosystem: "swift",
      name: declared.name,
      version,
      channel: null,
      files: items.map((i) => i.file),
      metadata: {
        name: declared.name,
        version,
        ...(toolsVersions.length ? { toolsVersions } : {}),
        ...(signature ? { signatureFormat: SIGNATURE_FORMAT } : {}),
      },
    });
    const plan = await planNative(
      ctx,
      descriptor,
      feed,
      nativeSource(principal, "swift"),
    );
    if (!plan.ok)
      return refusalResponse(
        "swift",
        plan.reason === "package-version-taken" ||
          plan.reason === "release_exists"
          ? { ...plan, status: 409 }
          : plan.status === 400
            ? { ...plan, status: 422 }
            : plan,
      );
    const sessionId = randomId("swift").replace(/[^A-Za-z0-9_-]/g, "");
    const staged: StagedFile[] = [];
    for (const i of items) {
      const s = await stageFile(ctx.env, owner, sessionId, i.file, i.bytes);
      if (!("staging" in s)) return refusalResponse("swift", s);
      staged.push(s);
    }
    const done = await commitNative(
      ctx,
      descriptor,
      staged,
      feed,
      principal,
      "swift",
    );
    if (!done.ok)
      return refusalResponse(
        "swift",
        done.reason === "package-version-taken" ||
          done.reason === "release_exists"
          ? { ...done, status: 409 }
          : done,
      );
    // Registry.md §4.6: a release that exists is a 409, even when the same bytes are sent again.
    if (done.outcome === "unchanged")
      return problem(
        409,
        "package-version-taken",
        `${declared.name} ${version} is already published.`,
      );
    const origin = registryOrigin(ctx.env) ?? new URL(req.url).origin;
    return json(
      {},
      {
        status: 201,
        headers: {
          "content-version": "1",
          location: `${origin}/swift/${encodeURIComponent(owner)}/${params.scope}/${params.name}/${version}`,
          "cache-control": "no-store",
        },
      },
    );
  },
});
