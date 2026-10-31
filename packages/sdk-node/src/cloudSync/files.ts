// The Cloud Sync file transport (U-22.4): the `FileTransport` port of client-core's transfer engine,
// over bearer HTTP. It carries bytes to and from the product's own `/<p>/sync/files/…` routes
// (WIRE-CONTRACT-V5 §13.2, §13.8) and nothing else.
//
//   Paths       every URL is built from validated parts and then tested against a closed list of
//               route shapes (`isFilesPath`). The collection, the record id and the upload id use
//               the key charset (`SYNC_KEY_PATTERN`) and may not be `.` or `..` (a save id may
//               contain dots); a chunk id is 64 lowercase hex characters; a part number is 1…9999.
//               A value that fails is a `TransferError`, never a request.
//   Redirects   none are followed (the bare fetcher, `redirect: "manual"`): a 3xx is a refusal, so
//               the bearer token and the file never leave the product's origin.
//   Bodies      a request carries `Content-Digest: sha-256=:…:` of its body. An answer is read under
//               a cap equal to what the call expects: a ranged `GET` the length asked for, a chunk
//               `GET` `SERVER_CHUNK_MAX_STORED_BYTES`, a whole-file `GET` the manifest's
//               largest stored size, a JSON answer 1 MiB, an error body 64 KiB. A longer body is
//               cancelled and answered as `bad_response`, so a hostile server cannot make the
//               client buffer more than it asked for.
//   Retries     none here: the engine owns them. A request that gets no answer throws (the engine
//               retries it); an answer is a `FileReply`, with `Retry-After` parsed.
//
// The device bearer is read per request and never logged or put in an error. A transport with no
// bearer answers `401 unauthorized` and sends nothing.

import {
  SYNC_CHUNK_ID_PATTERN,
  SYNC_KEY_PATTERN,
  SYNC_MAX_PARTS,
  type BeginFileRequest,
  type BeginFileResponse,
  type ChunkPlanRequest,
  type ChunkPlanResponse,
  type FileRevisionsResponse,
  type FinalizeRequest,
  type FinalizeResponse,
  type UploadStatus,
} from "@polaris-key/protocol/sync";
import {
  SERVER_CHUNK_MAX_STORED_BYTES,
  TransferError,
  type FileBody,
  type FileCallOptions,
  type FileQuery,
  type FileReply,
  type FileTarget,
  type FileTransport,
} from "@polaris-key/client-core/sync";
import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import { readCappedBytes, readCappedText } from "../core/boundedBody.js";
import type { CoreContext } from "../core/context.js";
import {
  codeForStatus,
  parseErrorBody,
  retryAfterSeconds,
} from "../core/http.js";

/** The most a JSON answer of a file route may be. */
export const FILES_JSON_MAX_BYTES = 1_048_576;
/** The most an error body is read to. */
export const FILES_ERROR_MAX_BYTES = 65_536;
/** The most an unranged file `GET` returns: a `chunks` file's manifest (786,496 bytes plain, sealed). */
export const FILES_MANIFEST_MAX_BYTES = 2 * 1_048_576;
/** A transfer slower than this is cut off: the deadline of a body grows by its size over this rate. */
export const FILES_MIN_BYTES_PER_SECOND = 65_536;

const KEY = new RegExp(SYNC_KEY_PATTERN);
const CHUNK_ID = new RegExp(SYNC_CHUNK_ID_PATTERN);
const SEGMENT = "[A-Za-z0-9._:-]{1,128}";
const HEX64 = "[0-9a-f]{64}";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `pathAndQuery` is one of the file routes of §13.2 for `product`. Dot segments are
 * refused outright; the only query is `version=<digits>` on the file `GET`.
 */
export function isFilesPath(product: string, pathAndQuery: string): boolean {
  if (!KEY.test(product)) return false;
  const q = pathAndQuery.indexOf("?");
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  const query = q < 0 ? "" : pathAndQuery.slice(q + 1);
  if (path.split("/").some((s) => s === "." || s === "..")) return false;
  const base = `/${escape(product)}/sync/files/${SEGMENT}`;
  const rec = `${base}/${SEGMENT}`;
  const upload = `${rec}/upload/${SEGMENT}`;
  const shapes = [
    `${rec}/(?:begin|finalize|revisions)`,
    rec,
    upload,
    `${upload}/parts/[0-9]{1,4}`,
    `${upload}/chunks`,
    `${upload}/chunks/${HEX64}`,
    `${base}/chunks/${HEX64}`,
  ];
  if (!shapes.some((s) => new RegExp(`^${s}$`).test(path))) return false;
  if (query === "") return true;
  return (
    new RegExp(`^${rec}$`).test(path) && /^version=[0-9]{1,9}$/.test(query)
  );
}

export interface NodeFileTransportDeps {
  ctx: Pick<
    CoreContext,
    "product" | "baseUrl" | "headers" | "plainFetcher" | "requestTimeoutMs"
  >;
  /** The device bearer now, or null when signed out. */
  token: () => string | null;
}

type Refusal = Extract<FileReply<unknown>, { ok: false }>;

const toBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

const bad = (detail: string): TransferError =>
  new TransferError("rejected", { code: "bad_path", detail });

/** The routes of §13.2 as an engine `FileTransport`. */
export class NodeFileTransport implements FileTransport {
  readonly #d: NodeFileTransportDeps;

  constructor(deps: NodeFileTransportDeps) {
    this.#d = deps;
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────

  #seg(value: string, what: string): string {
    if (!KEY.test(value) || value === "." || value === "..") throw bad(what);
    return value;
  }

  #base(collection: string): string {
    return `/${this.#d.ctx.product}/sync/files/${this.#seg(collection, "collection")}`;
  }

  #record(t: FileTarget): string {
    return `${this.#base(t.collection)}/${this.#seg(t.record, "record")}`;
  }

  #upload(t: FileTarget, uploadId: string): string {
    return `${this.#record(t)}/upload/${this.#seg(uploadId, "uploadId")}`;
  }

  #chunkId(id: string): string {
    if (!CHUNK_ID.test(id)) throw bad("chunkId");
    return id;
  }

  // ── The exchange ──────────────────────────────────────────────────────────────────────────

  /** One request. A refusal is returned as a value; a request that gets no answer throws. */
  async #exchange(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: FileCallOptions,
    sent: {
      json?: unknown;
      body?: Uint8Array;
      sha256?: string;
      range?: { start: number; end: number };
      ifMatch?: string;
    } = {},
    expectBytes = 0,
  ): Promise<{ res: Response } | { refusal: Refusal }> {
    const { ctx } = this.#d;
    if (!isFilesPath(ctx.product, path)) throw bad("route"); // The builders already checked; this is the closed list.
    const token = this.#d.token();
    if (token === null)
      return {
        refusal: { ok: false, status: 401, code: ErrorCode.unauthorized },
      };
    const headers = ctx.headers({
      authorization: `Bearer ${token}`,
      accept: "application/octet-stream, application/json",
    });
    let body: Uint8Array | string | undefined;
    if (sent.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(sent.json);
    } else if (sent.body !== undefined) {
      headers["content-type"] = "application/octet-stream";
      if (sent.sha256 === undefined || !/^[0-9a-f]{64}$/.test(sent.sha256))
        throw bad("digest");
      headers["content-digest"] = `sha-256=:${toBase64(sent.sha256)}:`;
      body = sent.body;
    }
    if (sent.range)
      headers["range"] = `bytes=${sent.range.start}-${sent.range.end - 1}`;
    if (sent.ifMatch !== undefined) headers["if-match"] = sent.ifMatch;
    const bytes = Math.max(expectBytes, sent.body ? sent.body.byteLength : 0);
    const deadline =
      ctx.requestTimeoutMs > 0
        ? AbortSignal.timeout(
            ctx.requestTimeoutMs +
              Math.ceil(bytes / FILES_MIN_BYTES_PER_SECOND) * 1000,
          )
        : undefined;
    const signals = [deadline, options.signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const init: RequestInit = {
      method,
      headers,
      redirect: "manual",
      ...(body !== undefined ? { body } : {}),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    };
    let res: Response;
    try {
      res = await ctx.plainFetcher()(`${ctx.baseUrl}${path}`, init);
    } catch (e) {
      // Local-only is a refusal to dial, not a network failure: nothing is retried.
      if (e instanceof PolarisError && e.code === ErrorCode.localOnly)
        throw new TransferError("rejected", { code: e.code });
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return {
        refusal: { ok: false, status: res.status, code: "redirect_refused" },
      };
    }
    return { res };
  }

  /** The refusal an error answer is: the server's code, `Retry-After`, and the body's extra members. */
  async #refusal(res: Response): Promise<Refusal> {
    const text = await readCappedText(res, FILES_ERROR_MAX_BYTES);
    const parsed = parseErrorBody(text ?? "");
    const seconds = retryAfterSeconds(res.headers.get("retry-after"));
    // Extra members (`missing`, `server`) sit beside `error` or inside it; both are read.
    const nested =
      typeof parsed.body.error === "object" && parsed.body.error !== null
        ? (parsed.body.error as Record<string, unknown>)
        : {};
    const { error: _error, ...top } = parsed.body;
    const { code: _code, message: _message, ...inner } = nested;
    return {
      ok: false,
      status: res.status,
      code: parsed.code ?? codeForStatus(res.status),
      ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
      body: { ...top, ...inner },
    };
  }

  /** A route whose success carries no body. */
  async #empty(
    r: { res: Response } | { refusal: Refusal },
  ): Promise<FileReply<null>> {
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    if (!res.ok) return this.#refusal(res);
    await res.body?.cancel().catch(() => undefined);
    return { ok: true, value: null };
  }

  /** A route whose success is a JSON object under the cap. */
  async #json<T>(
    r: { res: Response } | { refusal: Refusal },
    accept: (v: Record<string, unknown>) => boolean = () => true,
  ): Promise<FileReply<T>> {
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    if (!res.ok) return this.#refusal(res);
    const text = await readCappedText(res, FILES_JSON_MAX_BYTES);
    let value: unknown = null;
    try {
      value = text === null ? null : JSON.parse(text);
    } catch {
      value = null;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !accept(value as Record<string, unknown>)
    )
      return { ok: false, status: res.status, code: ErrorCode.badResponse };
    return { ok: true, value: value as T };
  }

  // ── FileTransport ─────────────────────────────────────────────────────────────────────────

  async begin(
    target: FileTarget,
    request: BeginFileRequest,
    options: FileCallOptions,
  ): Promise<FileReply<BeginFileResponse>> {
    const path = `${this.#record(target)}/begin`;
    return this.#json<BeginFileResponse>(
      await this.#exchange("POST", path, options, { json: request }),
      (v) =>
        typeof v.uploadId === "string" &&
        KEY.test(v.uploadId) &&
        v.uploadId !== "." &&
        v.uploadId !== ".." &&
        (v.mode === "single" ||
          v.mode === "multipart" ||
          v.mode === "chunks") &&
        typeof v.expiresAt === "number" &&
        Number.isFinite(v.expiresAt) &&
        (v.partBytes === undefined || typeof v.partBytes === "number"),
    );
  }

  async status(
    target: FileTarget,
    uploadId: string,
    options: FileCallOptions,
  ): Promise<FileReply<UploadStatus>> {
    const path = this.#upload(target, uploadId);
    return this.#json<UploadStatus>(
      await this.#exchange("GET", path, options),
      (v) => typeof v.mode === "string",
    );
  }

  async putSingle(
    target: FileTarget,
    uploadId: string,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>> {
    const path = this.#upload(target, uploadId);
    return this.#empty(
      await this.#exchange("PUT", path, options, { body, sha256 }),
    );
  }

  async putPart(
    target: FileTarget,
    uploadId: string,
    n: number,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>> {
    if (!Number.isInteger(n) || n < 1 || n > SYNC_MAX_PARTS) throw bad("part");
    const path = `${this.#upload(target, uploadId)}/parts/${n}`;
    return this.#empty(
      await this.#exchange("PUT", path, options, { body, sha256 }),
    );
  }

  async abort(
    target: FileTarget,
    uploadId: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>> {
    const path = this.#upload(target, uploadId);
    return this.#empty(await this.#exchange("DELETE", path, options));
  }

  async finalize(
    target: FileTarget,
    request: FinalizeRequest,
    options: FileCallOptions,
  ): Promise<FileReply<FinalizeResponse>> {
    const path = `${this.#record(target)}/finalize`;
    return this.#json<FinalizeResponse>(
      await this.#exchange("POST", path, options, { json: request }),
      (v) =>
        Number.isSafeInteger(v.version) &&
        Number.isSafeInteger(v.size) &&
        typeof v.sha256 === "string" &&
        (v.format === "whole" || v.format === "chunks"),
    );
  }

  async planChunks(
    target: FileTarget,
    uploadId: string,
    request: ChunkPlanRequest,
    options: FileCallOptions,
  ): Promise<FileReply<ChunkPlanResponse>> {
    const path = `${this.#upload(target, uploadId)}/chunks`;
    return this.#json<ChunkPlanResponse>(
      await this.#exchange("POST", path, options, { json: request }),
    );
  }

  async putChunk(
    target: FileTarget,
    uploadId: string,
    chunkId: string,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>> {
    if (body.byteLength > SERVER_CHUNK_MAX_STORED_BYTES) throw bad("chunk");
    const path = `${this.#upload(target, uploadId)}/chunks/${this.#chunkId(chunkId)}`;
    return this.#empty(
      await this.#exchange("PUT", path, options, { body, sha256 }),
    );
  }

  async getFile(
    target: FileTarget,
    query: FileQuery,
    options: FileCallOptions,
  ): Promise<FileReply<FileBody>> {
    const { range } = query;
    if (
      range !== undefined &&
      !(
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start
      )
    )
      throw bad("range");
    if (
      query.version !== undefined &&
      !(
        Number.isSafeInteger(query.version) &&
        query.version >= 0 &&
        query.version < 1e9
      )
    )
      throw bad("version");
    const path = `${this.#record(target)}${
      query.version !== undefined ? `?version=${query.version}` : ""
    }`;
    // The body is bounded by the range asked, even for a `200` (a server that ignores `Range`
    // and sends more is refused, never buffered).
    const cap = range ? range.end - range.start : FILES_MANIFEST_MAX_BYTES;
    const r = await this.#exchange(
      "GET",
      path,
      options,
      {
        ...(range ? { range } : {}),
        ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {}),
      },
      cap,
    );
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    if (!res.ok) return this.#refusal(res);
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, code: ErrorCode.badResponse };
    }
    const bytes = await readCappedBytes(res, cap);
    if (bytes === null)
      return { ok: false, status: res.status, code: ErrorCode.badResponse };
    const etag = res.headers.get("etag");
    const m = /^bytes ([0-9]{1,15})-([0-9]{1,15})\/([0-9]{1,15})$/.exec(
      res.headers.get("content-range") ?? "",
    );
    const contentRange = m
      ? { start: Number(m[1]), end: Number(m[2]) + 1, total: Number(m[3]) }
      : undefined;
    return {
      ok: true,
      value: {
        status: res.status,
        bytes,
        ...(etag !== null ? { etag } : {}),
        ...(contentRange ? { contentRange } : {}),
      },
    };
  }

  async revisions(
    target: FileTarget,
    options: FileCallOptions,
  ): Promise<FileReply<FileRevisionsResponse>> {
    const path = `${this.#record(target)}/revisions`;
    return this.#json<FileRevisionsResponse>(
      await this.#exchange("GET", path, options),
      (v) => Array.isArray(v.revisions),
    );
  }

  async getChunk(
    collection: string,
    chunkId: string,
    options: FileCallOptions,
  ): Promise<FileReply<Uint8Array>> {
    const path = `${this.#base(collection)}/chunks/${this.#chunkId(chunkId)}`;
    const r = await this.#exchange(
      "GET",
      path,
      options,
      {},
      SERVER_CHUNK_MAX_STORED_BYTES,
    );
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    if (!res.ok) return this.#refusal(res);
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, code: ErrorCode.badResponse };
    }
    const bytes = await readCappedBytes(res, SERVER_CHUNK_MAX_STORED_BYTES);
    if (bytes === null)
      return { ok: false, status: res.status, code: ErrorCode.badResponse };
    return { ok: true, value: bytes };
  }
}
