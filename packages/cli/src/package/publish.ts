/**
 * `pkey release publish --deliverable <package id>` (F-03, plans/F-01.md §3.2, §7.2): publish one
 * version of a `kind: package` deliverable to its package feed.
 *
 *   1. Load `.pkey/`, find the package declaration, and run its ecosystem's extractor over
 *      `--dir` (`extract.ts`): the files, their types and the metadata the feeds render from.
 *      `--version`, when given, must equal what the files carry.
 *   2. Hash every file and build the `kind: package` descriptor; validate it LOCALLY with the
 *      Worker's own validator.
 *   3. Credentials, an upload ticket, then ALWAYS a dry-run submit first. A Worker older than
 *      F-03 refuses `kind: package` with `invalid_descriptor` ("kind must be app"): that is
 *      reported as "this Polaris Key predates package releases (F-03)" and nothing is uploaded.
 *      The descriptor carries NO `seq`: the Worker takes the deliverable's next one atomically
 *      when it writes the row. A package's seq is publication order only (the feeds order
 *      versions by the scheme; replay is refused by unique-forever versions), and a seq pinned
 *      from the ticket loses to any publish of the same deliverable between ticket and submit:
 *      v0.8.22's stable `npm.zstd-wasm` lost seq 22 to a concurrent `main` prerelease
 *      (`0.8.23-main.9`) and was refused `seq_not_increasing`.
 *   4. Upload what the product does not hold, and submit. A package release carries no release
 *      record (`--release-key-file` and `PKEY_RELEASE_KEY` are not read): it is never signed.
 *
 * `--dry-run` stops after the server's dry-run verdict.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateReleaseDescriptor,
  type PackageReleaseDescriptor,
} from "@polaris-key/manifest";
import { ciClient, CiRequestError, type Out, type Sleep } from "../ci.js";
import { loadManifest, validateLoadedManifest } from "../manifest.js";
import { mask, resolveCiToken, type CiEnv } from "../oidc.js";
import { MAX_SINGLE_PUT_BYTES, putFile } from "../s3.js";
import { untrusted } from "../untrusted.js";
import {
  blobKey,
  descriptorManifestOf,
  hashFile,
  provenanceFrom,
} from "../publish.js";
import { extractPackage } from "./extract.js";
import type { ExtractedFile } from "./types.js";

export interface PackagePublishOptions {
  cwd: string;
  product: string;
  deliverable: string;
  version?: string;
  channel?: string;
  dir: string;
  dryRun?: boolean;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

export interface PackagePublishResult {
  descriptor: PackageReleaseDescriptor;
  releaseId: string;
  dryRun: boolean;
  server?: Record<string, unknown>;
  uploaded: string[];
  skipped: string[];
}

/** The message an old Worker's refusal of `kind: package` is reported with. */
export const PREDATES_PACKAGES =
  "this Polaris Key predates package releases (F-03): it accepts only app descriptors. Publish packages to a Worker deployed with F-03 or later.";

/** Is `id` a package deliverable of the `.pkey/` under `cwd`? (The publish dispatch asks.) */
export async function isPackageDeliverable(
  cwd: string,
  id: string,
): Promise<boolean> {
  try {
    const context = descriptorManifestOf(await loadManifest(cwd));
    return (context.release?.packages ?? []).some((p) => p.id === id);
  } catch {
    return false;
  }
}

/** Does this refusal say the Worker knows only app descriptors (a Worker older than F-03)? */
export function isPrePackageWorker(e: unknown): boolean {
  if (!(e instanceof CiRequestError) || e.status !== 400) return false;
  const body = e.body as {
    error?: unknown;
    message?: unknown;
    errors?: unknown;
  };
  if (body.error !== "invalid_descriptor") return false;
  const texts = [
    typeof body.message === "string" ? body.message : "",
    ...(Array.isArray(body.errors)
      ? body.errors.map((x) =>
          x &&
          typeof x === "object" &&
          typeof (x as { message?: unknown }).message === "string"
            ? (x as { message: string }).message
            : "",
        )
      : []),
  ];
  return texts.some((t) => /kind must be app\.?(\s|$|;)/.test(t));
}

export async function publishPackage(
  opts: PackagePublishOptions,
): Promise<PackagePublishResult> {
  const out = opts.stdout;
  if (!opts.dir?.trim()) throw new Error("--dir is required.");
  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const context = descriptorManifestOf(loaded);
  if (context.product?.slug !== opts.product)
    throw new Error(
      `--product ${opts.product} does not match .pkey/product's slug ${context.product?.slug}.`,
    );
  const declared = (context.packageDeliverables ?? []).find(
    (p) => p.id === opts.deliverable,
  );
  if (!declared)
    throw new Error(
      `--deliverable ${opts.deliverable} is not a package deliverable .pkey/release declares.`,
    );

  // 1. Extract.
  const workDir = await mkdtemp(path.join(tmpdir(), "pkey-package-"));
  try {
    const extracted = await extractPackage(declared.ecosystem, {
      declaration: declared,
      dir: path.resolve(opts.cwd, opts.dir),
      workDir,
      ...(opts.version?.trim() ? { version: opts.version.trim() } : {}),
    });
    const version = opts.version?.trim() || extracted.version;
    if (version !== extracted.version)
      throw new Error(
        `--version ${version} does not match the packed files' version ${extracted.version}.`,
      );

    // 2. Hash and describe.
    const hashed: (ExtractedFile & { sha256: string; size: number })[] = [];
    for (const f of extracted.files) {
      const { size } = await stat(f.path);
      if (size > MAX_SINGLE_PUT_BYTES)
        throw new Error(
          `${f.name} is ${size} bytes; one upload is at most ${MAX_SINGLE_PUT_BYTES} bytes (a single-part PUT).`,
        );
      hashed.push({ ...f, ...(await hashFile(f.path)) });
    }
    const provenance = provenanceFrom(opts.env);
    const descriptor: PackageReleaseDescriptor = {
      descriptorVersion: 1,
      product: opts.product,
      deliverable: declared.id,
      kind: "package",
      version,
      ...(opts.channel?.trim() ? { channel: opts.channel.trim() } : {}),
      ...(provenance ? { provenance } : {}),
      package: {
        ecosystem: declared.ecosystem,
        name: declared.name,
        files: hashed.map((f) => ({
          name: f.name,
          role: "payload" as const,
          type: f.type,
          sha256: f.sha256,
          size: f.size,
          ...(f.mediaType !== undefined ? { mediaType: f.mediaType } : {}),
          ...(f.classifier !== undefined ? { classifier: f.classifier } : {}),
          ...(f.extension !== undefined ? { extension: f.extension } : {}),
          locations: [{ provider: "r2" as const, key: blobKey(f.sha256) }],
        })),
        metadata: extracted.metadata,
      },
    };
    const v = validateReleaseDescriptor(descriptor, context);
    if (!v.ok)
      throw new Error(
        `The package descriptor does not validate:\n${v.errors
          .map((e) => `  ${e.path} ${e.code}: ${e.message}`)
          .join("\n")}`,
      );
    const releaseId = v.releaseId;
    out.write(
      `Package ${declared.name} ${version} (${declared.ecosystem}, ${hashed.length} file${hashed.length === 1 ? "" : "s"})\n`,
    );
    for (const f of hashed)
      out.write(
        `- ${f.type.padEnd(24)} ${f.name} (${f.size} bytes, sha256 ${f.sha256.slice(0, 12)}…)\n`,
      );
    const result: PackagePublishResult = {
      descriptor,
      releaseId,
      dryRun: opts.dryRun === true,
      uploaded: [],
      skipped: [],
    };
    if (opts.dryRun)
      out.write(
        `\nPackage descriptor (${releaseId}):\n${JSON.stringify(descriptor, null, 2)}\nLocal validation: ok\n`,
      );

    // 3. Credentials, the ticket, and the dry run every package publish starts with.
    let token: string;
    try {
      token = await resolveCiToken({
        baseUrl: opts.baseUrl,
        product: opts.product,
        env: opts.env,
        out,
        log: opts.stderr,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
      });
    } catch (e) {
      if (opts.dryRun && !(e instanceof CiRequestError)) {
        out.write(
          `Server validation: skipped (${untrusted((e as Error).message, opts.env)})\n`,
        );
        return result;
      }
      throw e;
    }
    const client = ciClient({
      baseUrl: opts.baseUrl,
      product: opts.product,
      token,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
      env: opts.env,
    });
    const objects = new Map(hashed.map((f) => [f.sha256, f]));
    const ticket = (await client.postJson("release/publish/uploads", {
      what: "Requesting an upload ticket",
      body: {
        objects: [...objects.values()].map((f) => ({
          sha256: f.sha256,
          size: f.size,
        })),
      },
    })) as {
      ticket?: unknown;
      credentials?: {
        endpoint: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken: string;
      };
      objects?: {
        sha256: string;
        size: number;
        key: string;
        target: string;
        present: boolean;
      }[];
    };
    if (
      typeof ticket.ticket !== "string" ||
      !ticket.credentials ||
      !Array.isArray(ticket.objects)
    )
      throw new Error(
        `${client.url("release/publish/uploads")} answered without a ticket and credentials.`,
      );
    mask(opts.env, out, ticket.ticket);
    mask(opts.env, out, ticket.credentials.secretAccessKey);
    mask(opts.env, out, ticket.credentials.sessionToken);
    let verdict: Record<string, unknown>;
    try {
      verdict = await client.postJson("release/publish/submit", {
        what: "Validating the package release (dry run)",
        body: { ticket: ticket.ticket, descriptor, dryRun: true },
      });
    } catch (e) {
      if (isPrePackageWorker(e)) throw new Error(PREDATES_PACKAGES);
      throw e;
    }
    if (opts.dryRun) {
      result.server = verdict;
      out.write(
        `Server validation: ok — would be ${untrusted(verdict.outcome, opts.env)} as ${untrusted(verdict.releaseId, opts.env)}\nDry run: nothing uploaded, nothing written.\n`,
      );
      return result;
    }

    // 4. Upload and submit.
    for (const o of ticket.objects) {
      if (o.present) {
        result.skipped.push(o.target);
        continue;
      }
      const file = objects.get(o.sha256);
      if (!file)
        throw new Error(
          `The ticket names ${o.sha256}, which pkey did not ask for.`,
        );
      await putFile({
        creds: ticket.credentials,
        key: o.key,
        file: file.path,
        size: file.size,
        sha256: file.sha256,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: opts.stderr,
        env: opts.env,
      });
      result.uploaded.push(o.target);
    }
    out.write(
      `Uploaded ${result.uploaded.length} object${result.uploaded.length === 1 ? "" : "s"}; ${result.skipped.length} already stored\n`,
    );
    const server = await client.postJson("release/publish/submit", {
      what: "Submitting the package release",
      body: { ticket: ticket.ticket, descriptor },
    });
    result.server = server;
    out.write(
      `Published ${untrusted(server.releaseId, opts.env)} (${untrusted(server.outcome, opts.env)})\n`,
    );
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
