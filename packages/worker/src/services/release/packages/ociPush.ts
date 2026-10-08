/// <reference types="@cloudflare/workers-types" />
/**
 * Native `docker push` to an owner's OCI feed (F-23, plans/F-01.md §6.8 and S-12 §9; the
 * distribution-spec push workflow,
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md#push):
 *
 *   POST   /v2/<owner>/<repository…>/blobs/uploads/[?digest=|?mount=&from=]   start (202), or a
 *                                                                            monolithic upload
 *                                                                            or a mount (201)
 *   GET    /v2/<owner>/<repository…>/blobs/uploads/<uuid>                    progress (204)
 *   PATCH  /v2/<owner>/<repository…>/blobs/uploads/<uuid>                    one chunk, in order
 *                                                                            (`Content-Range`)
 *   PUT    /v2/<owner>/<repository…>/blobs/uploads/<uuid>?digest=sha256:…    finish (201)
 *   DELETE /v2/<owner>/<repository…>/blobs/uploads/<uuid>                    cancel (204)
 *   PUT    /v2/<owner>/<repository…>/manifests/<tag | sha256:…>              a manifest (201)
 *
 * WHY RELEASE. A push publishes: a manifest pushed under a VERSION TAG becomes a package release,
 * the same `release_metadata`, `release_artifacts`, `blob_refs` and `release_packages` rows a
 * ticket publish writes (`pkey release publish`, `../publish.ts`), through the same ingest
 * (`ingest.ts`) with the same refusals. Only Release may write those (rule 6), so these routes
 * are Release's (`service: "release"`, marked `FEED_PUSH_ROUTE`), and they read Distribution's
 * feed settings only through the `delivery` hook, like the ticket publish does.
 *
 * WHO MAY PUSH. Only a request bearing an OCI token from `/v2/token` granting `push` on this
 * repository, whose subject still resolves to a publisher (`core/registryTokens.ts`
 * `registryPublisher`: an owner-bound `pkeyr_` with `publish`, or a `pkeyci_` with
 * `release:publish`). Anything else is 401 with the Bearer challenge naming `pull,push`, before
 * the repository is even looked up, so the routes are no oracle for what exists.
 *
 * THE RULES ON TOP OF THE INGEST'S:
 *   - the repository must be a declared package deliverable of the owner (products are data,
 *     rule 5: `docker push` never creates one), and its feed enabled at every level;
 *   - a tag is a version, and versions never move: `latest`, `stable`, `beta`, `pr-<n>` and the
 *     product's manual channel names are refused (`TAG_INVALID`), because channel tags are
 *     moved by `pkey release promote`, never by a push;
 *   - a manifest pushed by digest is stored and held, and publishes nothing (an image index's
 *     platform manifests, or a manifest a later tag will name);
 *   - every object a manifest names must be one this product holds (its own push, or an earlier
 *     release's), so a push can never earn a ref to another tenant's bytes;
 *   - each request is bounded by the zone's body limit (100 MB on Free and Pro). A layer above it
 *     needs a client that sends chunks (`PATCH` with `Content-Range`), or the ticket path.
 *
 * Every answer is body-less or OCI's error JSON, `no-store`, with
 * `Docker-Distribution-API-Version: registry/2.0`.
 */

import {
  PACKAGE_ECOSYSTEM_RULES,
  type PackageReleaseDescriptor,
} from "@polaris-key/manifest";
import type { PackageFeedSettings } from "../../../core/hooks.js";
import {
  FEED_PUSH_ROUTE,
  registryHostname,
  registryOrigin,
  type RegistryMethod,
  type RegistryRoute,
  type RegistryRouteContext,
} from "../../../core/registryHost.js";
import { json } from "../../../core/errors.js";
import {
  OCI_PUSH_REF,
  blobKey,
  landUpload,
  recordRef,
  referencedKeys,
  storedObjects,
} from "../../../core/blobs.js";
import {
  isPullToken,
  lookupRegistrySubject,
  registryPublisher,
  verifyPullToken,
  type RegistryPublisher,
} from "../../../core/registryTokens.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { appendAudit } from "../../../core/data.js";
import { randomId, sha256Hex } from "../../../core/platform.js";
import {
  classifyChannel,
  isMovingSelector,
  parseManualChannels,
} from "../channels.js";
import { getReleaseConfig } from "../config.js";
import { bumpReleaseGeneration } from "../ghCache.js";
import {
  ingestPackageDescriptor,
  readPackageDeliverables,
  type PackageIngestResult,
} from "./ingest.js";
import {
  MAX_CHUNK_BYTES,
  MIN_PART_BYTES,
  appendChunk,
  completeUpload,
  discardUpload,
  readUpload,
  startUpload,
  uploadRange,
  type Chunk,
  type LoadedUpload,
  type UploadRefusal,
} from "./ociUpload.js";

/** The distribution API version every `/v2/` answer names. */
const API_VERSION = "registry/2.0";

/** The largest manifest a `PUT` takes (the distribution spec's recommended floor, 4 MiB). */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** The most manifests and indexes one tag push walks (the CLI extractor's bound). */
export const MAX_PUSH_DOCUMENTS = 256;

/** The longest `<owner>/<repository>` (the reference grammar's 255-character limit). */
const MAX_NAME = 255;

/** `registryOciPush`: per push subject, fail closed (the routes write). */
const PUSH_LIMIT = { limit: 1200, windowSec: 60 };

const OCI_DIGEST_RE = /^sha256:([0-9a-f]{64})$/;
const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = PACKAGE_ECOSYSTEM_RULES.oci.name.pattern;

const INDEX_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

const UPLOADS = /^\/v2\/([^/]+)\/(.+)\/blobs\/uploads\/?$/;
const UPLOAD = /^\/v2\/([^/]+)\/(.+)\/blobs\/uploads\/([^/]+)$/;
const MANIFEST = /^\/v2\/([^/]+)\/(.+)\/manifests\/([^/]+)$/;

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

/** A push error code (distribution-spec "Error Codes"). */
export type OciPushErrorCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DENIED"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "TAG_INVALID"
  | "TOOMANYREQUESTS"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "UNSUPPORTED";

const BASE_HEADERS = {
  "docker-distribution-api-version": API_VERSION,
  "cache-control": "no-store",
} as const;

function ociError(
  status: number,
  code: OciPushErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    { errors: [{ code, message }] },
    { status, headers: { ...BASE_HEADERS, ...headers } },
  );
}

/** A body-less answer (201, 202, 204). */
function empty(status: number, headers: Record<string, string>): Response {
  return new Response(null, {
    status,
    headers: { ...BASE_HEADERS, "content-length": "0", ...headers },
  });
}

// ── The push context ─────────────────────────────────────────────────────────────────────────

/** What every push handler gets once the request is authorised and the repository located. */
interface Push {
  readonly ctx: RegistryRouteContext;
  readonly owner: string;
  readonly repository: string;
  readonly deliverableId: string;
  readonly feed: PackageFeedSettings;
  readonly publisher: RegistryPublisher;
  readonly bucket: R2Bucket;
  /** `/v2/<owner>/<repository>`, the base of every `Location`. */
  readonly base: string;
}

/** The Bearer challenge a push without a push token gets (it names `pull,push`). */
function pushChallenge(
  ctx: RegistryRouteContext,
  owner: string,
  repository: string,
): Response {
  const host = registryHostname(ctx.env) ?? "pkg.plrs.im";
  const origin = registryOrigin(ctx.env) ?? `https://${host}`;
  return ociError(401, "UNAUTHORIZED", "authentication required", {
    "www-authenticate": `Bearer realm="${origin}/v2/token",service="${host}",scope="repository:${owner}/${repository}:pull,push"`,
  });
}

/**
 * The publisher behind the request's push token, or `null`: a Bearer OCI token, signed and live,
 * of this owner, granting `push` on this repository, whose subject still resolves (through the
 * 30 s cache) to a credential that may publish here.
 */
async function pushPublisher(
  req: Request,
  ctx: RegistryRouteContext,
  repository: string,
): Promise<RegistryPublisher | null> {
  const m = /^bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || !isPullToken(m[1]!)) return null;
  const owner = ctx.product.slug;
  const claims = await verifyPullToken(ctx.env, m[1]!, ctx.now);
  if (
    !claims ||
    claims.own !== owner ||
    !claims.push?.includes(`${owner}/${repository}`)
  )
    return null;
  const resolved = await lookupRegistrySubject(
    ctx.db,
    owner,
    claims.sub,
    ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {},
  );
  const publisher = registryPublisher(resolved, owner, "oci");
  return publisher && publisher.sub === claims.sub ? publisher : null;
}

/**
 * Authorise, then locate: the push token first (so nothing about the repository leaks to an
 * unauthorised caller), then the budget, the declared deliverable, the feed's switches and the
 * blob store.
 */
async function preparePush(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Push | Response> {
  const owner = ctx.product.slug;
  const repository = ctx.params.repository!;
  const publisher = await pushPublisher(req, ctx, repository);
  if (!publisher) return pushChallenge(ctx, owner, repository);
  if (
    !(await rateLimitOk(
      ctx.env,
      owner,
      { bucket: "registryOciPush", id: publisher.sub, ...PUSH_LIMIT },
      ctx.now,
    ))
  )
    return ociError(429, "TOOMANYREQUESTS", "too many requests", {
      "retry-after": "60",
    });
  const deliverable = (await readPackageDeliverables(ctx.db, owner)).find(
    (d) => d.ecosystem === "oci" && d.name === repository,
  );
  const feed = await ctx.hooks.delivery()?.packageFeed("oci");
  if (
    !deliverable ||
    !feed ||
    !feed.enabled ||
    !feed.ownerEnabled ||
    !feed.policyEnabled
  )
    return ociError(
      404,
      "NAME_UNKNOWN",
      "repository name not known to registry",
    );
  const bucket = ctx.env.BLOBS;
  if (!bucket)
    return ociError(503, "UNAVAILABLE", "the blob store is not configured");
  return {
    ctx,
    owner,
    repository,
    deliverableId: deliverable.id,
    feed,
    publisher,
    bucket,
    base: `/v2/${owner}/${repository}`,
  };
}

/** `owner`, `repository` and the last segment, when the path is a well-formed push path. */
function matchRepository(
  re: RegExp,
  pathname: string,
): { owner: string; params: Record<string, string> } | null {
  const m = re.exec(pathname);
  if (!m) return null;
  const owner = m[1]!;
  const repository = m[2]!;
  if (!REPOSITORY_RE.test(repository) || repository.length > 255) return null;
  if (owner.length + 1 + repository.length > MAX_NAME) return null;
  return {
    owner,
    params: { repository, ...(m[3] !== undefined ? { last: m[3] } : {}) },
  };
}

function pushRoute(
  name: string,
  re: RegExp,
  methods: readonly RegistryMethod[],
  handle: (req: Request, push: Push) => Promise<Response>,
): RegistryRoute {
  return {
    [FEED_PUSH_ROUTE]: true,
    name,
    service: "release",
    ecosystem: "oci",
    methods,
    match: (p) => matchRepository(re, p),
    async handle(req, ctx) {
      const push = await preparePush(req, ctx);
      if (push instanceof Response) {
        await discardBody(req.body);
        return push;
      }
      return handle(req, push);
    },
  };
}

/**
 * Read and drop what is left of a body an answer does not need (bounded by the request limit),
 * so an early refusal never leaves an unread upload on the connection; a client that keeps the
 * connection alive (HTTP/1.1) would otherwise see the next request fail.
 */
async function discardBody(
  body: ReadableStream<Uint8Array> | Uint8Array | null | undefined,
): Promise<void> {
  if (!body || body instanceof Uint8Array) return;
  let read = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.byteLength;
      if (read > MAX_CHUNK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    // Already read or locked: nothing left to drop.
  }
}

// ── Request bodies ───────────────────────────────────────────────────────────────────────────

/**
 * The request body as a chunk of known length: streamed when `Content-Length` says how long it is,
 * else read into memory up to `max` (a client sending `Transfer-Encoding: chunked`; R2 needs every
 * stream's length up front). Only for small bodies (a manifest, at most `MAX_MANIFEST_BYTES`): it
 * holds the body and a copy of it at once. A blob's bytes go through `appendRequest`, which never
 * holds more than `SPOOL_BYTES`. A `Response` when it is over `max`.
 */
async function requestChunk(
  req: Request,
  max: number,
): Promise<Chunk | Response> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared))
      return ociError(400, "SIZE_INVALID", "Content-Length is not a length");
    const length = Number(declared);
    if (length > max)
      return ociError(
        413,
        "SIZE_INVALID",
        `a request carries at most ${max} bytes`,
      );
    if (length === 0 || !req.body)
      return { body: new Uint8Array(0), length: 0 };
    return { body: req.body as ReadableStream<Uint8Array>, length };
  }
  if (!req.body) return { body: new Uint8Array(0), length: 0 };
  const parts: Uint8Array[] = [];
  let length = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => undefined);
      return ociError(
        413,
        "SIZE_INVALID",
        `a request carries at most ${max} bytes`,
      );
    }
    parts.push(value);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.byteLength;
  }
  return { body, length };
}

/** `Content-Range: <start>-<end>`, `undefined` when absent, `null` when it is not a range. */
function contentRange(
  req: Request,
): { start: number; length: number } | undefined | null {
  const raw = req.headers.get("content-range");
  if (raw === null) return undefined;
  const m = /^(?:bytes[ =])?(\d{1,15})-(\d{1,15})$/.exec(raw.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end >= start ? { start, length: end - start + 1 } : null;
}

/**
 * How much of a body without `Content-Length` (and without `Content-Range`) is held before it is
 * appended to the upload. `docker push` and go-containerregistry send each layer as one `PATCH`
 * with chunked transfer encoding, so R2, which needs every stream's length, can only be fed such a
 * body in pieces of known length: the isolate holds one piece at a time (Core's blob-store rule,
 * `core/blobs.ts`: never buffer an object; the isolate has 128 MB). At least `MIN_PART_BYTES`, so
 * the first piece of a fresh upload fixes a real part size.
 */
export const SPOOL_BYTES = 16 * 1024 * 1024;

/** Byte arrays as one stream (a spooled piece, handed to `appendChunk` without a copy). */
function streamOf(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < pieces.length) c.enqueue(pieces[i++]!);
      else c.close();
    },
  });
}

/**
 * Append the request's body to the upload (a `PATCH`, or the final body of a `PUT` or monolithic
 * `POST`), and answer the upload it leaves, or the refusal:
 *
 * - `Content-Length`: one chunk, streamed (a `Content-Range`, when sent, must match it);
 * - no `Content-Length` but a `Content-Range`: one chunk of the range's length, streamed (a body
 *   of any other length is refused by `appendChunk`);
 * - neither: read in pieces of `SPOOL_BYTES`, each appended as a chunk of known length as soon as
 *   it is full, so the isolate never holds more than one piece. A refusal part-way leaves the
 *   pieces already appended in the upload (its `Range` says how far it got, as the spec allows).
 *
 * Every request carries at most `MAX_CHUNK_BYTES` (the zone's body limit).
 */
async function appendRequest(
  req: Request,
  push: Push,
  up: LoadedUpload,
  badRange: (up: LoadedUpload) => Response,
): Promise<LoadedUpload | Response> {
  const tooLarge = () =>
    ociError(
      413,
      "SIZE_INVALID",
      `a request carries at most ${MAX_CHUNK_BYTES} bytes`,
    );
  const range = contentRange(req);
  if (range === null) {
    await discardBody(req.body);
    return badRange(up);
  }
  const declared = req.headers.get("content-length");
  let chunk: Chunk | null = null;
  if (declared !== null) {
    const sized = await requestChunk(req, MAX_CHUNK_BYTES);
    if (sized instanceof Response) return sized;
    // An empty body appends nothing (a final `PUT` that only names the digest).
    if (sized.length === 0) return up;
    chunk = sized;
  } else if (range !== undefined) {
    if (range.length > MAX_CHUNK_BYTES) {
      await discardBody(req.body);
      return tooLarge();
    }
    chunk = {
      body:
        (req.body as ReadableStream<Uint8Array> | null) ?? new Uint8Array(0),
      length: range.length,
    };
  }
  if (chunk !== null) {
    if (range !== undefined && range.length !== chunk.length) {
      await discardBody(chunk.body);
      return badRange(up);
    }
    const next = await appendChunk(push.bucket, up, chunk, {
      ceiling: push.feed.maxPackageBytes,
      ...(range !== undefined ? { start: range.start } : {}),
    });
    if (typeof next === "string") {
      await discardBody(chunk.body);
      return refusalAnswer(push, up, next);
    }
    return next;
  }
  // No length at all: spool it, one bounded piece at a time.
  if (!req.body) return up;
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  let current = up;
  let pieces: Uint8Array[] = [];
  let held = 0;
  let read = 0;
  const flush = async (): Promise<Response | null> => {
    const piece: Chunk = { body: streamOf(pieces), length: held };
    pieces = [];
    held = 0;
    const next = await appendChunk(push.bucket, current, piece, {
      ceiling: push.feed.maxPackageBytes,
    });
    if (typeof next === "string") return refusalAnswer(push, current, next);
    current = next;
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > MAX_CHUNK_BYTES) return tooLarge();
      pieces.push(value);
      held += value.byteLength;
      if (held >= SPOOL_BYTES) {
        const refused = await flush();
        if (refused) return refused;
      }
    }
    if (held > 0) {
      const refused = await flush();
      if (refused) return refused;
    }
    return current;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ── Blob uploads ─────────────────────────────────────────────────────────────────────────────

function uploadHeaders(push: Push, up: LoadedUpload): Record<string, string> {
  return {
    location: `${push.base}/blobs/uploads/${up.state.id}`,
    range: uploadRange(up.state),
    "docker-upload-uuid": up.state.id,
  };
}

function refusalAnswer(
  push: Push,
  up: LoadedUpload,
  r: UploadRefusal,
): Response {
  switch (r) {
    case "range":
      return ociError(
        416,
        "BLOB_UPLOAD_INVALID",
        "the chunk does not start where the upload ends",
        uploadHeaders(push, up),
      );
    case "too_large":
      return ociError(
        413,
        "SIZE_INVALID",
        `a blob of this feed is at most ${push.feed.maxPackageBytes} bytes`,
      );
    case "too_many_parts":
      return ociError(
        400,
        "BLOB_UPLOAD_INVALID",
        "too many chunks: send larger ones",
      );
    case "size_invalid":
      return ociError(
        400,
        "SIZE_INVALID",
        "the body is not the length it declared",
      );
    case "changed":
      return ociError(
        409,
        "BLOB_UPLOAD_INVALID",
        "the upload changed under this request; resume from its range",
        uploadHeaders(push, up),
      );
  }
}

/** Hold `hex` for the deliverable: the possession ref a later manifest `PUT` relies on. */
async function hold(push: Push, hex: string): Promise<void> {
  await recordRef(
    push.ctx.db,
    {
      product: push.owner,
      storageKey: blobKey(hex),
      refKind: OCI_PUSH_REF,
      refId: push.deliverableId,
    },
    push.ctx.now,
  );
}

/** Land a finished upload's bytes, hold them, and answer 201 (or the refusal). */
async function landBlob(
  push: Push,
  stagingKey: string,
  hex: string,
  size: number,
): Promise<Response> {
  const landed = await landUpload(
    push.bucket,
    { stagingKey },
    { sha256: hex, size },
    { db: push.ctx.db, now: push.ctx.now, product: push.owner },
  );
  if (!landed.ok) {
    if (landed.reason === "digest_mismatch")
      return ociError(
        400,
        "DIGEST_INVALID",
        "the bytes do not match the digest",
      );
    if (landed.reason === "size_mismatch")
      return ociError(400, "SIZE_INVALID", "the upload is not the size it was");
    return ociError(
      503,
      "UNAVAILABLE",
      `the blob could not be stored (${landed.reason}); push it again`,
    );
  }
  await hold(push, hex);
  return empty(201, {
    location: `${push.base}/blobs/sha256:${hex}`,
    "docker-content-digest": `sha256:${hex}`,
  });
}

/** Finish an upload: append a final chunk when there is one, then land it as `digest`. */
async function finish(
  req: Request,
  push: Push,
  up: LoadedUpload,
  hex: string,
): Promise<Response> {
  const current = await appendRequest(req, push, up, () =>
    ociError(
      400,
      "BLOB_UPLOAD_INVALID",
      "Content-Range does not match the body",
    ),
  );
  if (current instanceof Response) return current;
  const done = await completeUpload(push.bucket, current);
  if (done === "changed") {
    await discardUpload(push.bucket, current.state);
    return ociError(
      404,
      "BLOB_UPLOAD_UNKNOWN",
      "the upload's bytes are gone; start it again",
    );
  }
  const res = await landBlob(push, done.stagingKey, hex, current.state.size);
  await discardUpload(push.bucket, current.state, { completed: true });
  return res;
}

const startOrMonolithic = async (
  req: Request,
  push: Push,
): Promise<Response> => {
  const url = new URL(req.url);
  const mount = url.searchParams.get("mount");
  const digest = url.searchParams.get("digest");
  // A mount: the product already holds the object (any repository, any release of its own), so
  // this repository holds it too. Anything else falls back to a plain upload, as the spec says.
  if (mount !== null) {
    const hex = OCI_DIGEST_RE.exec(mount)?.[1];
    if (hex !== undefined) {
      const key = blobKey(hex);
      const held = await referencedKeys(push.ctx.db, push.owner, [key]);
      if (held.has(key) && (await storedObjects(push.ctx.db, [key])).has(key)) {
        await hold(push, hex);
        return empty(201, {
          location: `${push.base}/blobs/${mount}`,
          "docker-content-digest": mount,
        });
      }
    }
  }
  if (digest !== null && OCI_DIGEST_RE.exec(digest) === null)
    return ociError(400, "DIGEST_INVALID", "the digest is not a sha256 digest");
  const up = await startUpload(push.bucket, {
    owner: push.owner,
    repository: push.repository,
    deliverableId: push.deliverableId,
    sub: push.publisher.sub,
    createdAt: push.ctx.now,
  });
  if (!up)
    return ociError(503, "UNAVAILABLE", "the upload could not be started");
  // A monolithic upload: the whole blob in this POST.
  if (digest !== null)
    return finish(req, push, up, OCI_DIGEST_RE.exec(digest)![1]!);
  await discardBody(req.body);
  return empty(202, {
    ...uploadHeaders(push, up),
    "oci-chunk-min-length": String(MIN_PART_BYTES),
  });
};

async function loadUpload(
  push: Push,
  id: string,
): Promise<LoadedUpload | Response> {
  const up = await readUpload(
    push.bucket,
    push.owner,
    push.repository,
    id,
    push.ctx.now,
  );
  return (
    up ??
    ociError(404, "BLOB_UPLOAD_UNKNOWN", "blob upload unknown to registry")
  );
}

const uploadOp = async (req: Request, push: Push): Promise<Response> => {
  const up = await loadUpload(push, push.ctx.params.last!);
  if (up instanceof Response) {
    await discardBody(req.body);
    return up;
  }
  switch (req.method) {
    case "GET":
    case "HEAD":
      return empty(204, uploadHeaders(push, up));
    case "DELETE":
      await discardUpload(push.bucket, up.state);
      return empty(204, {});
    case "PATCH": {
      const next = await appendRequest(req, push, up, (at) =>
        ociError(
          416,
          "BLOB_UPLOAD_INVALID",
          "Content-Range does not match the body",
          uploadHeaders(push, at),
        ),
      );
      if (next instanceof Response) return next;
      return empty(202, uploadHeaders(push, next));
    }
    default: {
      // PUT ?digest=: the end of the upload.
      const hex = OCI_DIGEST_RE.exec(
        new URL(req.url).searchParams.get("digest") ?? "",
      )?.[1];
      if (hex === undefined) {
        await discardBody(req.body);
        return ociError(
          400,
          "DIGEST_INVALID",
          "the digest is not a sha256 digest",
        );
      }
      return finish(req, push, up, hex);
    }
  }
};

// ── Manifests ────────────────────────────────────────────────────────────────────────────────

/** One descriptor a manifest names. */
interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly hex: string;
  readonly size: number;
  readonly platform?: { os?: string; architecture?: string; variant?: string };
}

type ParsedManifest =
  | { kind: "index"; children: OciDescriptor[] }
  | { kind: "manifest"; config: OciDescriptor; layers: OciDescriptor[] };

function descriptorOf(v: unknown): OciDescriptor | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const hex =
    typeof d.digest === "string"
      ? OCI_DIGEST_RE.exec(d.digest)?.[1]
      : undefined;
  if (
    hex === undefined ||
    typeof d.mediaType !== "string" ||
    d.mediaType.length === 0 ||
    d.mediaType.length > 255 ||
    typeof d.size !== "number" ||
    !Number.isSafeInteger(d.size) ||
    d.size < 0
  )
    return null;
  const p = d.platform as Record<string, unknown> | undefined;
  const platform =
    p &&
    typeof p === "object" &&
    typeof p.os === "string" &&
    typeof p.architecture === "string"
      ? {
          os: p.os,
          architecture: p.architecture,
          ...(typeof p.variant === "string" ? { variant: p.variant } : {}),
        }
      : undefined;
  return {
    mediaType: d.mediaType,
    digest: d.digest as string,
    hex,
    size: d.size,
    ...(platform ? { platform } : {}),
  };
}

/** A manifest or index of `mediaType`, parsed and shape-checked; a string says why not. */
export function parseOciManifest(
  bytes: Uint8Array,
  mediaType: string,
): ParsedManifest | string {
  let doc: unknown;
  try {
    doc = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return "the manifest is not JSON";
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return "the manifest is not a JSON object";
  const m = doc as Record<string, unknown>;
  if (m.schemaVersion !== 2) return "schemaVersion must be 2";
  if (m.mediaType !== undefined && m.mediaType !== mediaType)
    return `the manifest's mediaType ${String(m.mediaType)} is not its Content-Type ${mediaType}`;
  if (INDEX_TYPES.has(mediaType)) {
    if (!Array.isArray(m.manifests)) return "an index lists its manifests";
    const children: OciDescriptor[] = [];
    for (const c of m.manifests) {
      const d = descriptorOf(c);
      if (!d) return "an index entry is not a sha256 descriptor";
      if (!INDEX_TYPES.has(d.mediaType) && !MANIFEST_TYPES.has(d.mediaType))
        return `an index entry's media type ${d.mediaType} is not a manifest type this registry serves`;
      children.push(d);
    }
    return { kind: "index", children };
  }
  const config = descriptorOf(m.config);
  if (!config) return "a manifest names its config as a sha256 descriptor";
  if (m.layers !== undefined && !Array.isArray(m.layers))
    return "layers must be an array";
  const layers: OciDescriptor[] = [];
  for (const l of (m.layers as unknown[] | undefined) ?? []) {
    const d = descriptorOf(l);
    if (!d)
      return "a layer is not a sha256 descriptor (foreign layers are not served)";
    layers.push(d);
  }
  return { kind: "manifest", config, layers };
}

function directRefs(p: ParsedManifest): OciDescriptor[] {
  return p.kind === "index" ? p.children : [p.config, ...p.layers];
}

/** Are all of `refs` objects this product holds, stored at the size the manifest declares? */
async function heldRefs(
  push: Push,
  refs: readonly OciDescriptor[],
): Promise<Response | null> {
  const keys = refs.map((r) => blobKey(r.hex));
  const held = await referencedKeys(push.ctx.db, push.owner, keys);
  const stored = await storedObjects(push.ctx.db, keys);
  for (const r of refs) {
    const key = blobKey(r.hex);
    const obj = stored.get(key);
    if (!held.has(key) || !obj)
      return ociError(
        400,
        "MANIFEST_BLOB_UNKNOWN",
        `${r.digest} is not an object of this repository's owner: push it first`,
      );
    if (obj.size !== r.size)
      return ociError(
        400,
        "MANIFEST_INVALID",
        `${r.digest} is ${obj.size} bytes, not the ${r.size} the manifest declares`,
      );
  }
  return null;
}

/** The package files of a tag push, walked as `pkey release publish`'s extractor walks a layout. */
async function walkImage(
  push: Push,
  root: {
    digest: string;
    hex: string;
    mediaType: string;
    size: number;
    parsed: ParsedManifest;
  },
): Promise<
  | { files: PackageReleaseDescriptor["package"]["files"]; platforms: string[] }
  | Response
> {
  const seen = new Map<
    string,
    { hex: string; type: string; mediaType: string; size: number }
  >();
  const platforms = new Set<string>();
  let documents = 0;
  const visit = async (
    d: {
      digest: string;
      hex: string;
      mediaType: string;
      size: number;
      platform?: OciDescriptor["platform"];
    },
    parsed?: ParsedManifest,
  ): Promise<Response | null> => {
    if (seen.has(d.digest)) return null;
    if (d.platform?.os && d.platform.architecture)
      platforms.add(
        `${d.platform.os}/${d.platform.architecture}${d.platform.variant ? `/${d.platform.variant}` : ""}`,
      );
    const isDoc =
      INDEX_TYPES.has(d.mediaType) || MANIFEST_TYPES.has(d.mediaType);
    seen.set(d.digest, {
      hex: d.hex,
      type: INDEX_TYPES.has(d.mediaType)
        ? "oci-index"
        : isDoc
          ? "oci-manifest"
          : "oci-blob",
      mediaType: d.mediaType,
      size: d.size,
    });
    if (!isDoc) return null;
    if (++documents > MAX_PUSH_DOCUMENTS)
      return ociError(
        400,
        "MANIFEST_INVALID",
        `the image names more than ${MAX_PUSH_DOCUMENTS} manifests`,
      );
    let doc = parsed;
    if (!doc) {
      // A platform manifest: held (checked by the parent's `heldRefs`), read back to walk it.
      const obj = await push.bucket.get(blobKey(d.hex));
      if (!obj || !("body" in obj) || obj.size > MAX_MANIFEST_BYTES)
        return ociError(
          400,
          "MANIFEST_BLOB_UNKNOWN",
          `${d.digest} could not be read back`,
        );
      const next = parseOciManifest(
        new Uint8Array(await obj.arrayBuffer()),
        d.mediaType,
      );
      if (typeof next === "string")
        return ociError(400, "MANIFEST_INVALID", `${d.digest}: ${next}`);
      doc = next;
    }
    const refs = directRefs(doc);
    const refused = await heldRefs(push, refs);
    if (refused) return refused;
    for (const child of refs) {
      const r = await visit(child);
      if (r) return r;
    }
    return null;
  };
  const refused = await visit(root, root.parsed);
  if (refused) return refused;
  const files = [...seen].map(([digest, f]) => ({
    name: digest,
    role: "payload" as const,
    type: f.type,
    sha256: f.hex,
    size: f.size,
    mediaType: f.mediaType,
    locations: [{ provider: "r2" as const, key: blobKey(f.hex) }],
  }));
  return { files, platforms: [...platforms].sort() };
}

/** An ingest refusal as OCI's error. */
function ingestRefusal(
  r: Extract<PackageIngestResult, { ok: false }>,
): Response {
  switch (r.reason) {
    case "package-version-taken":
    case "release_exists":
      return ociError(
        409,
        "DENIED",
        `${r.message} (a version tag never moves)`,
      );
    case "package-too-large":
      return ociError(413, "SIZE_INVALID", r.message);
    case "package-namespace":
    case "distribution_disabled":
      return ociError(403, "DENIED", r.message);
    case "r2_object_missing":
    case "r2_ref_not_owned":
      return ociError(400, "MANIFEST_BLOB_UNKNOWN", r.message);
    case "package-shape":
      return ociError(400, "MANIFEST_INVALID", r.message);
    default:
      return ociError(409, "DENIED", r.message);
  }
}

const putManifest = async (req: Request, push: Push): Promise<Response> => {
  const reference = push.ctx.params.last!;
  const refHex = OCI_DIGEST_RE.exec(reference)?.[1];
  if (refHex === undefined && !OCI_TAG_RE.test(reference)) {
    await discardBody(req.body);
    return ociError(
      400,
      "TAG_INVALID",
      "the reference is neither a tag nor a sha256 digest",
    );
  }
  const mediaType = (
    (req.headers.get("content-type") ?? "").split(";")[0] ?? ""
  )
    .trim()
    .toLowerCase();
  if (!INDEX_TYPES.has(mediaType) && !MANIFEST_TYPES.has(mediaType)) {
    await discardBody(req.body);
    return ociError(
      400,
      "MANIFEST_INVALID",
      `${mediaType || "a missing Content-Type"} is not a manifest type this registry serves`,
    );
  }
  if (refHex === undefined) {
    // A version tag. Channel tags are moved by `pkey release promote`, never pushed.
    const cfg = await getReleaseConfig(push.ctx.db, push.owner);
    const sel = classifyChannel(
      reference,
      parseManualChannels(cfg?.manual_channels_json),
    );
    if (sel && isMovingSelector(sel)) {
      await discardBody(req.body);
      return ociError(
        400,
        "TAG_INVALID",
        `${reference} is a channel tag: push a version tag and move the channel with pkey release promote`,
      );
    }
  }
  const chunk = await requestChunk(req, MAX_MANIFEST_BYTES);
  if (chunk instanceof Response) return chunk;
  const bytes =
    chunk.body instanceof Uint8Array
      ? chunk.body
      : new Uint8Array(await new Response(chunk.body).arrayBuffer());
  if (
    bytes.byteLength !== chunk.length ||
    bytes.byteLength > MAX_MANIFEST_BYTES
  )
    return ociError(
      400,
      "SIZE_INVALID",
      "the manifest is not the length it declared",
    );
  const hex = await sha256Hex(bytes);
  const digest = `sha256:${hex}`;
  if (refHex !== undefined && refHex !== hex)
    return ociError(
      400,
      "DIGEST_INVALID",
      "the manifest does not match the digest it was pushed by",
    );
  const parsed = parseOciManifest(bytes, mediaType);
  if (typeof parsed === "string")
    return ociError(400, "MANIFEST_INVALID", parsed);
  const refused = await heldRefs(push, directRefs(parsed));
  if (refused) return refused;

  // Walk the image before storing anything for a tag, so a refusal stores nothing.
  const walked =
    refHex === undefined
      ? await walkImage(push, {
          digest,
          hex,
          mediaType,
          parsed,
          size: bytes.byteLength,
        })
      : null;
  if (walked instanceof Response) return walked;

  const landed = await landUpload(
    push.bucket,
    { bytes },
    { sha256: hex, size: bytes.byteLength },
    { db: push.ctx.db, now: push.ctx.now, product: push.owner },
  );
  if (!landed.ok)
    return ociError(
      503,
      "UNAVAILABLE",
      `the manifest could not be stored (${landed.reason}); push it again`,
    );
  await hold(push, hex);
  const created = {
    location: `${push.base}/manifests/${digest}`,
    "docker-content-digest": digest,
  };
  if (!walked) return empty(201, created);

  // A version tag: publish it, exactly as a ticket publish of the same image would.
  const files = walked.files;
  const descriptor: PackageReleaseDescriptor = {
    descriptorVersion: 1,
    product: push.owner,
    deliverable: push.deliverableId,
    kind: "package",
    version: reference,
    package: {
      ecosystem: "oci",
      name: push.repository,
      files,
      metadata: {
        name: push.repository,
        version: reference,
        root: digest,
        mediaType,
        ...(walked.platforms.length ? { platforms: walked.platforms } : {}),
      },
    },
  };
  const source = {
    kind: push.publisher.kind,
    ...(push.publisher.kind === "oidc"
      ? { publisher: push.publisher.actor }
      : {}),
    tokenId: push.publisher.tokenId,
    via: "oci-push",
  } as const;
  const result = await ingestPackageDescriptor(
    push.ctx.db,
    push.ctx.env,
    push.owner,
    descriptor,
    {
      now: push.ctx.now,
      feed: push.feed,
      source,
    },
  );
  if (!result.ok) return ingestRefusal(result);
  if (result.outcome !== "unchanged") {
    await appendAudit(push.ctx.db, {
      product: push.owner,
      id: randomId("aud"),
      at: push.ctx.now,
      actor_sub: push.publisher.actor,
      actor_name: push.publisher.kind === "registry" ? "Registry token" : "CI",
      actor_email: null,
      action: "release.publish",
      target_kind: "release",
      target_id: result.releaseId,
      parent_id: null,
      summary: `Published package ${push.repository} ${reference} (${result.releaseId}, ${result.outcome}) with docker push`,
    });
    await bumpReleaseGeneration(push.ctx.env, push.owner, push.ctx.now);
  }
  return empty(201, created);
};

// ── The routes ───────────────────────────────────────────────────────────────────────────────

/** Release's routes on the registry host (`mount.ts` spreads them into `REGISTRY_ROUTES`). */
export const OCI_PUSH_ROUTES: readonly RegistryRoute[] = [
  pushRoute("oci.push.uploads", UPLOADS, ["POST"], startOrMonolithic),
  pushRoute(
    "oci.push.upload",
    UPLOAD,
    ["GET", "HEAD", "PATCH", "PUT", "DELETE"],
    uploadOp,
  ),
  pushRoute("oci.push.manifest", MANIFEST, ["PUT"], putManifest),
];

/**
 * The push routes' OpenAPI rows (rule 10), in `FeedAdapter.openapi`'s shape: `routeCoverage`
 * adds them to its `REGISTRY_PATHS` and checks them against the spec and the routes.
 */
export const OCI_PUSH_OPENAPI: readonly (readonly [
  string,
  readonly string[],
  string,
])[] = [
  ["/v2/{owner}/{repository}/blobs/uploads/", ["post"], "oci.push.uploads"],
  [
    "/v2/{owner}/{repository}/blobs/uploads/{uuid}",
    ["get", "head", "patch", "put", "delete"],
    "oci.push.upload",
  ],
  [
    "/v2/{owner}/{repository}/manifests/{reference}",
    ["put"],
    "oci.push.manifest",
  ],
];
