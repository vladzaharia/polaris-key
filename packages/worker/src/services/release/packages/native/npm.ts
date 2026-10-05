/// <reference types="@cloudflare/workers-types" />
/**
 * `npm publish` (F-22): `PUT /npm/<owner>/<@scope%2fname | @scope/name>`.
 *
 * npm, pnpm, Yarn (`yarn npm publish`) and Bun all send libnpmpublish's document
 * (`npmBody.ts`): one version's `package.json` under `versions`, its dist-tag under `dist-tags`,
 * and the tarball, base64, under `_attachments`. It becomes one package release:
 *
 *   - the name in the path, the document's `name` and the version's `name` must agree, and the
 *     version is the one key of `versions`;
 *   - the dist-tag is the release channel: `latest` is `stable`, any other tag is the channel of
 *     that name (it must be one the product declares, as for `pkey release publish --channel`);
 *   - the tarball's SHA-512 and SHA-1 must equal the `dist.integrity` and `dist.shasum` npm
 *     computed, so a corrupted upload is refused rather than served;
 *   - the metadata is the version's `package.json` through the same allowlist the CLI's extractor
 *     keeps (`PACKAGE_METADATA_KEYS.npm`), so the packument renders as for a CLI publish.
 *
 * Only a publish is accepted on this path: `npm deprecate`, `npm unpublish` and the dist-tag
 * commands send other shapes and are refused (`npm-unsupported-operation`); deprecation and
 * yanks are the console's.
 */

import { createHash } from "node:crypto";
import { PACKAGE_METADATA_KEYS } from "@polaris-key/manifest";
import { json } from "../../../../core/errors.js";
import type { RegistryRoute } from "../../../../core/registryHost.js";
import { readCappedBody } from "./body.js";
import { parseNpmPublishBody } from "./npmBody.js";
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
} from "./publish.js";
import { publishRoute, refusalResponse } from "./route.js";
import { randomId } from "../../../../core/platform.js";

const OWNER = "([a-z0-9][a-z0-9-]{0,63})";
const ESCAPED = new RegExp(`^/npm/${OWNER}/(@[^/]+%2[fF][^/]+)$`);
const SPLIT = new RegExp(`^/npm/${OWNER}/(@[^/]+)/([^/@-][^/]*)$`);

/** The package name a publish path names, decoded (`@scope/name`), or `null`. */
function nameOf(raw: string): string | null {
  try {
    const name = decodeURIComponent(raw);
    return /^@[^/]+\/[^/]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function bad(message: string, reason = "npm-bad-publish") {
  return refusalResponse("npm", {
    status: 400,
    code: "bad_request",
    reason,
    message,
  });
}

function hashOf(
  alg: "sha512" | "sha1",
  bytes: Uint8Array,
  encoding: "base64" | "hex",
): string {
  return createHash(alg).update(bytes).digest(encoding);
}

export const NPM_PUBLISH_ROUTE: RegistryRoute = publishRoute({
  name: "npm.publish",
  ecosystem: "npm",
  method: "PUT",
  match(pathname) {
    const e = ESCAPED.exec(pathname);
    if (e) {
      const name = nameOf(e[2]!);
      return name ? { owner: e[1]!, params: { name } } : null;
    }
    const s = SPLIT.exec(pathname);
    if (s) {
      const name = nameOf(`${s[2]}/${s[3]}`);
      return name ? { owner: s[1]!, params: { name } } : null;
    }
    return null;
  },
  async handle({ req, ctx, principal, feed, params }) {
    const name = params.name!;
    const declared = await declaredPackage(
      ctx.db,
      ctx.product.slug,
      "npm",
      name,
    );
    if (!declared) {
      await req.body?.cancel().catch(() => undefined);
      return refusalResponse("npm", undeclared("npm", name));
    }
    const body = await readCappedBody(req);
    if (!body.ok)
      return body.reason === "too-large"
        ? refusalResponse("npm", {
            status: 413,
            code: "body_too_large",
            reason: "too-large",
            message:
              "the publish is over the 32 MiB native-publish limit; publish it with pkey release publish, which uploads straight to the blob store",
          })
        : bad("the request body could not be read");
    const parsed = parseNpmPublishBody(body.bytes);
    if (!parsed.ok) return bad(parsed.message);
    const doc = parsed.body.doc;
    const versions = doc.versions;
    if (
      versions === null ||
      typeof versions !== "object" ||
      Array.isArray(versions) ||
      parsed.body.attachments.size === 0
    )
      return bad(
        "only npm publish is accepted here (a document with versions and _attachments); deprecate and yank versions from the console",
        "npm-unsupported-operation",
      );
    if (doc.name !== name)
      return bad(`the document names ${String(doc.name)}, the path ${name}`);
    const keys = Object.keys(versions);
    if (keys.length !== 1 || parsed.body.attachments.size !== 1)
      return bad("a publish carries exactly one version and one tarball");
    const version = keys[0]!;
    const manifest = (versions as Record<string, unknown>)[version];
    if (manifest === null || typeof manifest !== "object")
      return bad(`versions["${version}"] is not a package.json`);
    const m = manifest as Record<string, unknown>;
    if (m.name !== name || m.version !== version)
      return bad(
        `versions["${version}"] names ${String(m.name)} ${String(m.version)}`,
      );
    // The dist-tag: npm sends exactly one (`latest`, or `--tag`).
    const tags = doc["dist-tags"];
    const tagNames =
      tags !== null && typeof tags === "object" && !Array.isArray(tags)
        ? Object.entries(tags as Record<string, unknown>)
            .filter(([, v]) => v === version)
            .map(([k]) => k)
        : [];
    if (tagNames.length > 1)
      return bad("a publish names one dist-tag (npm publish --tag <tag>)");
    const tag = tagNames[0] ?? "latest";
    const channel = tag === "latest" ? "stable" : tag;
    const [, tarball] = [...parsed.body.attachments][0]!;
    const att = (doc._attachments as Record<string, unknown>)[
      [...parsed.body.attachments.keys()][0]!
    ] as Record<string, unknown>;
    if (typeof att.length === "number" && att.length !== tarball.byteLength)
      return bad("the tarball's length is not the attachment's declared length");
    // npm's own digests of the bytes it meant to send.
    const dist = (m.dist ?? {}) as Record<string, unknown>;
    if (typeof dist.integrity === "string") {
      const want = /^sha512-([A-Za-z0-9+/=]+)$/.exec(dist.integrity.trim());
      if (
        want &&
        hashOf("sha512", tarball, "base64") !== want[1]!.trim()
      )
        return bad(
          "the tarball does not match dist.integrity",
          "integrity-mismatch",
        );
    }
    if (
      typeof dist.shasum === "string" &&
      hashOf("sha1", tarball, "hex") !== dist.shasum.toLowerCase()
    )
      return bad("the tarball does not match dist.shasum", "integrity-mismatch");

    const metadata: Record<string, unknown> = { name: declared.name, version };
    for (const k of PACKAGE_METADATA_KEYS.npm)
      if (m[k] !== undefined) metadata[k] = m[k];
    const unscoped = name.slice(name.indexOf("/") + 1);
    const file: NativeFile = {
      name: `${unscoped}-${version}.tgz`,
      type: "npm-tarball",
      sha256: await sha256Hex(tarball),
      size: tarball.byteLength,
    };
    const descriptor = nativeDescriptor({
      product: ctx.product.slug,
      deliverable: declared.id,
      ecosystem: "npm",
      name: declared.name,
      version,
      channel,
      files: [file],
      metadata,
    });
    const plan = await planNative(
      ctx,
      descriptor,
      feed,
      nativeSource(principal, "npm"),
    );
    if (!plan.ok) return refusalResponse("npm", plan);
    const staged = await stageFile(
      ctx.env,
      ctx.product.slug,
      randomId("npm").replace(/[^A-Za-z0-9_-]/g, ""),
      file,
      tarball,
    );
    if (!("staging" in staged)) return refusalResponse("npm", staged);
    const done = await commitNative(
      ctx,
      descriptor,
      [staged],
      feed,
      principal,
      "npm",
    );
    if (!done.ok) return refusalResponse("npm", done);
    return json(
      { ok: true, success: true, id: name, rev: done.releaseId },
      {
        status: done.outcome === "created" ? 201 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  },
});

