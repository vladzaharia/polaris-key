/// <reference types="@cloudflare/workers-types" />
/**
 * `twine upload` (F-22): `POST /pypi/<owner>/legacy/`, the legacy upload API PyPI itself serves
 * at `upload.pypi.org/legacy/` (`--repository-url https://pkg.plrs.im/pypi/<owner>/legacy/`).
 *
 * twine POSTs one `multipart/form-data` request per file: `:action=file_upload`,
 * `protocol_version=1`, the core metadata as fields (`name`, `version`, `summary`,
 * `requires_python`, `license`, …), `filetype` (`bdist_wheel` or `sdist`), the digests
 * (`sha256_digest`, `md5_digest`, …) and the file as `content`. The wheels and the sdist of one
 * version arrive one after another, so they are gathered in the version's upload session
 * (`sessions.ts`) and published together once the uploads settle.
 *
 * Checks per file: the file is a wheel (`.whl`, `bdist_wheel`) or an sdist (`.tar.gz`, `sdist`)
 * whose filename names the same project (PEP 503) and version; `sha256_digest` and `md5_digest`,
 * when sent, match the bytes; the version as gathered so far plans cleanly (namespace, ceiling,
 * version not taken, …). The Worker does not open the wheel, so no `core-metadata` file is
 * served for a twine upload (PEP 658 is optional: pip and uv then read the wheel itself); the
 * summary, `Requires-Python` and licence come from twine's fields.
 */

import { createHash } from "node:crypto";
import { packageNameNorm } from "@polaris-key/manifest";
import { json } from "../../../../core/errors.js";
import type { RegistryRoute } from "../../../../core/registryHost.js";
import { readCappedBody } from "./body.js";
import { field, multipartBoundary, parseMultipart, part } from "./multipart.js";
import {
  declaredPackage,
  nativeDescriptor,
  nativeSource,
  planNative,
  sha256Hex,
  stageFile,
  undeclared,
  type NativeFile,
} from "./publish.js";
import { publishRoute, refusalResponse } from "./route.js";
import {
  openSession,
  saveSession,
  settleSession,
  touchSessions,
  withFile,
  type SessionKey,
} from "./sessions.js";

const LEGACY = /^\/pypi\/([a-z0-9][a-z0-9-]{0,63})\/legacy\/?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,254}$/;

function bad(message: string, reason = "pypi-bad-upload", status = 400) {
  return refusalResponse("pypi", {
    status,
    code: "bad_request",
    reason,
    message,
  });
}

/** PEP 440 versions compare after normalisation; this is enough to tie a filename to `version`. */
function versionNorm(v: string): string {
  return v.trim().toLowerCase().replace(/_/g, "-");
}

/** The project and version a wheel or sdist filename names, or `null`. */
export function pypiFileIdentity(
  filename: string,
): { kind: "wheel" | "sdist"; project: string; version: string } | null {
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    // name-version(-build)?-python-abi-platform
    if (parts.length !== 5 && parts.length !== 6) return null;
    return { kind: "wheel", project: parts[0]!, version: parts[1]! };
  }
  if (filename.endsWith(".tar.gz")) {
    const stem = filename.slice(0, -7);
    const dash = stem.lastIndexOf("-");
    if (dash <= 0) return null;
    return {
      kind: "sdist",
      project: stem.slice(0, dash),
      version: stem.slice(dash + 1),
    };
  }
  return null;
}

export const PYPI_UPLOAD_ROUTE: RegistryRoute = publishRoute({
  name: "pypi.upload",
  ecosystem: "pypi",
  method: "POST",
  match(pathname) {
    const m = LEGACY.exec(pathname);
    return m ? { owner: m[1]!, params: {} } : null;
  },
  async handle({ req, ctx, principal, feed }) {
    const owner = ctx.product.slug;
    // Before the body: a settle of this token's open sessions waits for this upload to answer.
    await touchSessions(ctx.db, owner, "pypi", principal);
    const boundary = multipartBoundary(req.headers.get("content-type"));
    if (boundary === null) {
      await req.body?.cancel().catch(() => undefined);
      return bad("the upload is multipart/form-data (twine upload)");
    }
    const body = await readCappedBody(req);
    if (!body.ok)
      return body.reason === "too-large"
        ? refusalResponse("pypi", {
            status: 413,
            code: "body_too_large",
            reason: "too-large",
            message:
              "the file is over the 32 MiB native-publish limit; publish it with pkey release publish, which uploads straight to the blob store",
          })
        : bad("the request body could not be read");
    const parts = parseMultipart(body.bytes, boundary);
    if (parts === null) return bad("the upload is not well-formed multipart");
    const action = field(parts, ":action");
    if (action !== "file_upload")
      return bad(
        "only :action=file_upload is accepted (twine upload)",
        "pypi-unsupported-operation",
      );
    const name = field(parts, "name")?.trim();
    const version = field(parts, "version")?.trim();
    const filetype = field(parts, "filetype");
    const content = part(parts, "content");
    if (!name || !version || !content || content.filename === null)
      return bad("the upload carries name, version and the file as content");
    const filename = content.filename.split(/[\\/]/).pop() ?? "";
    const id = FILE_NAME.test(filename) ? pypiFileIdentity(filename) : null;
    if (!id)
      return bad(
        `${filename} is not a wheel (.whl) or an sdist (.tar.gz)`,
        "pypi-file-type",
      );
    if (
      (id.kind === "wheel" && filetype !== "bdist_wheel") ||
      (id.kind === "sdist" && filetype !== "sdist")
    )
      return bad(
        `${filename} is a ${id.kind}, but filetype is ${filetype ?? "missing"}`,
        "pypi-file-type",
      );
    if (packageNameNorm("pypi", id.project) !== packageNameNorm("pypi", name))
      return bad(`${filename} is not a file of ${name}`, "pypi-file-name");
    if (versionNorm(id.version) !== versionNorm(version))
      return bad(`${filename} is not version ${version}`, "pypi-file-name");
    const bytes = content.data;
    const sha256 = await sha256Hex(bytes);
    const sentSha = field(parts, "sha256_digest")?.trim().toLowerCase();
    if (sentSha && sentSha !== sha256)
      return bad(
        `${filename} does not match sha256_digest`,
        "integrity-mismatch",
      );
    const sentMd5 = field(parts, "md5_digest")?.trim().toLowerCase();
    if (sentMd5 && sentMd5 !== createHash("md5").update(bytes).digest("hex"))
      return bad(`${filename} does not match md5_digest`, "integrity-mismatch");

    const declared = await declaredPackage(ctx.db, owner, "pypi", name);
    if (!declared) return refusalResponse("pypi", undeclared("pypi", name));
    const key: SessionKey = {
      product: owner,
      ecosystem: "pypi",
      nameNorm: packageNameNorm("pypi", declared.name),
      version,
    };
    const session = await openSession(ctx.db, {
      key,
      deliverableId: declared.id,
      name: declared.name,
      principal,
      client: "twine",
      channel: null,
      now: ctx.now,
    });
    if (!("sessionId" in session)) return refusalResponse("pypi", session);
    const file: NativeFile = {
      name: filename,
      type: id.kind,
      sha256,
      size: bytes.byteLength,
    };
    const metadata: Record<string, unknown> = { ...session.metadata };
    const summary = field(parts, "summary")?.trim();
    const requiresPython = field(parts, "requires_python")?.trim();
    const license = field(parts, "license")?.trim();
    if (summary && metadata.summary === undefined)
      metadata.summary = summary.slice(0, 512);
    if (requiresPython && metadata.requiresPython === undefined)
      metadata.requiresPython = requiresPython.slice(0, 256);
    if (license && metadata.license === undefined)
      metadata.license = license.slice(0, 512);
    // The version as gathered so far, with this file, must plan cleanly before it is staged.
    const pendingFiles = withFile(session, { ...file, staging: "" });
    if (!Array.isArray(pendingFiles))
      return refusalResponse("pypi", pendingFiles);
    const plan = await planNative(
      ctx,
      nativeDescriptor({
        product: owner,
        deliverable: declared.id,
        ecosystem: "pypi",
        name: declared.name,
        version,
        channel: null,
        files: pendingFiles,
        metadata: { ...metadata, name: declared.name, version },
      }),
      feed,
      nativeSource(principal, "twine"),
    );
    if (!plan.ok) return refusalResponse("pypi", plan);
    const staged = await stageFile(
      ctx.env,
      owner,
      session.sessionId,
      file,
      bytes,
    );
    if (!("staging" in staged)) return refusalResponse("pypi", staged);
    const files = withFile(session, staged);
    if (!Array.isArray(files)) return refusalResponse("pypi", files);
    const seq = await saveSession(ctx.db, session, files, metadata, ctx.now);
    if (seq === null)
      return bad(
        `the upload of ${declared.name} ${version} changed while this file was being stored; retry`,
        "upload-in-progress",
        409,
      );
    // twine sends nothing after its last file: publish once the uploads settle.
    ctx.waitUntil?.(settleSession(ctx, key, seq));
    return json(
      { ok: true, file: filename, project: declared.name, version },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
});
