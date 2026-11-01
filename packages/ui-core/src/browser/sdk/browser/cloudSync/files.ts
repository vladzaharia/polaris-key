// The browser Cloud Sync file transport (U-22.6): the `FileTransport` port of client-core's transfer
// engine over `fetch`, as sdk-node's `NodeFileTransport` (U-22.4). It carries bytes to and from the
// product's own `/<p>/sync/files/…` routes (WIRE-CONTRACT-V5 §13.2, §13.8) and nothing else.
//
//   Paths       every URL is built from validated parts and then tested against a closed list of
//               route shapes (`isFilesPath`). The collection, the record id and the upload id use
//               the key charset and may not be `.` or `..`; a chunk id is 64 lowercase hex
//               characters; a part number is 1…9999. A value that fails is a `TransferError`,
//               never a request.
//   Redirects   none are followed (`redirect: "manual"`): a 3xx, or the opaque redirect a browser
//               shows for one, is a refusal, so the bearer token and the file never leave the
//               product's origin.
//   CORS        a `PUT` or a `Range`/`If-Match`/`Content-Digest` request is not a simple one: the
//               Worker's preflight answers for the routes (the `cloudsync-cors` recording). Nothing
//               here sends a cookie (`credentials: "omit"`).
//   Bodies      a request carries `Content-Digest: sha-256=:…:` of its body. An answer is read under
//               a cap equal to what the call expects, as Node's. A longer body is cancelled and
//               answered as `bad_response`.
//   Retries     none here: the engine owns them. A request that gets no answer throws (the engine
//               retries it); an answer is a `FileReply`, with `Retry-After` parsed.
//
// The device bearer is added by the session (`BearerSession.fileFetch`), never held here.

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
import { readCappedBytes, readCappedText } from "../boundedBody.js";

/** The most a JSON answer of a file route may be. */
export const FILES_JSON_MAX_BYTES = 1_048_576;
/** The most an error body is read to. */
export const FILES_ERROR_MAX_BYTES = 65_536;
/** The most an unranged file `GET` returns: a `chunks` file's manifest (786,496 bytes plain, sealed). */
export const FILES_MANIFEST_MAX_BYTES = 2 * 1_048_576;
/** A request with no answer after this long counts as none; the deadline grows by body size over the rate below. */
export const FILES_REQUEST_MS = 15_000;
/** A transfer slower than this is cut off. */
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

/** One authenticated request under `/<product>/` for the file routes: the session adds the bearer and the `X-PKey-*` headers; a body is bytes. */
export type FileFetch = (
  path: string,
  init: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    headers: Record<string, string>;
    body?: Uint8Array | string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface BrowserFileTransportDeps {
  product: string;
  request: FileFetch;
  /** Test seam: the per-request base deadline. */
  requestMs?: number;
}

type Refusal = Extract<FileReply<unknown>, { ok: false }>;
/** An answer with its deadline still running (`end` stops it), or a refusal made here. */
type Exchanged = { res: Response; end: () => void } | { refusal: Refusal };

const bad = (detail: string): TransferError =>
  new TransferError("rejected", { code: "bad_path", detail });

/** The base64 of a lowercase-hex digest, for `Content-Digest`. */
export function digestHeader(hex: string): string {
  let s = "";
  for (let i = 0; i < hex.length; i += 2)
    s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return `sha-256=:${btoa(s)}:`;
}

/** `Retry-After` as whole seconds (an HTTP date is ignored). */
function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header.trim());
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** A signal that fires when any of `signals` does (`AbortSignal.any` where there is one). */
function anySignal(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  const any = (
    AbortSignal as unknown as {
      any?: (s: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof any === "function") return any.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** A refusal's code from an error body: `{error: {code}}`, `{error: "code"}` or a bare status. */
function codeOf(body: Record<string, unknown>, status: number): string {
  const e = body.error;
  if (typeof e === "string" && e !== "") return e;
  if (typeof e === "object" && e !== null) {
    const c = (e as Record<string, unknown>).code;
    if (typeof c === "string" && c !== "") return c;
  }
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  return "request_failed";
}

/** The routes of §13.2 as an engine `FileTransport`. */
export class BrowserFileTransport implements FileTransport {
  readonly #d: BrowserFileTransportDeps;

  constructor(deps: BrowserFileTransportDeps) {
    this.#d = deps;
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────

  #seg(value: string, what: string): string {
    if (!KEY.test(value) || value === "." || value === "..") throw bad(what);
    return value;
  }

  #base(collection: string): string {
    return `/${this.#d.product}/sync/files/${this.#seg(collection, "collection")}`;
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
  ): Promise<Exchanged> {
    const { product } = this.#d;
    // The builders already checked; this is the closed list.
    if (!isFilesPath(product, path)) throw bad("route");
    const headers: Record<string, string> = {
      accept: "application/octet-stream, application/json",
    };
    let body: Uint8Array | string | undefined;
    if (sent.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(sent.json);
    } else if (sent.body !== undefined) {
      headers["content-type"] = "application/octet-stream";
      if (sent.sha256 === undefined || !/^[0-9a-f]{64}$/.test(sent.sha256))
        throw bad("digest");
      headers["content-digest"] = digestHeader(sent.sha256);
      body = sent.body;
    }
    if (sent.range)
      headers["range"] = `bytes=${sent.range.start}-${sent.range.end - 1}`;
    if (sent.ifMatch !== undefined) headers["if-match"] = sent.ifMatch;
    const bytes = Math.max(expectBytes, sent.body ? sent.body.byteLength : 0);
    const ms =
      (this.#d.requestMs ?? FILES_REQUEST_MS) +
      Math.ceil(bytes / FILES_MIN_BYTES_PER_SECOND) * 1000;
    const timer = new AbortController();
    const cut = setTimeout(
      () => timer.abort(new Error("The request timed out.")),
      ms,
    );
    const end = (): void => clearTimeout(cut);
    try {
      const signal = anySignal([
        timer.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      const res = await this.#d.request(path.slice(product.length + 2), {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(signal ? { signal } : {}),
      });
      if (
        res.type === "opaqueredirect" ||
        (res.status >= 300 && res.status < 400)
      ) {
        await res.body?.cancel().catch(() => undefined);
        end();
        return {
          refusal: {
            ok: false,
            status: res.status === 0 ? 302 : res.status,
            code: "redirect_refused",
          },
        };
      }
      // The deadline also covers reading the body: the caller ends it once the body is read.
      return { res, end };
    } catch (e) {
      end();
      throw e;
    }
  }

  /** The refusal an error answer is: the server's code, `Retry-After`, and the body's extra members. */
  async #refusal(res: Response): Promise<Refusal> {
    const text = await readCappedText(res, FILES_ERROR_MAX_BYTES);
    let parsed: Record<string, unknown> = {};
    try {
      const v = text ? JSON.parse(text) : null;
      if (typeof v === "object" && v !== null && !Array.isArray(v))
        parsed = v as Record<string, unknown>;
    } catch {
      // Not JSON: the status alone says what happened.
    }
    const seconds = retryAfter(res.headers.get("retry-after"));
    // Extra members (`missing`, `server`) sit beside `error` or inside it; both are read.
    const nested =
      typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : {};
    const { error: _error, ...top } = parsed;
    const { code: _code, message: _message, ...inner } = nested;
    return {
      ok: false,
      status: res.status,
      code: codeOf(parsed, res.status),
      ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
      body: { ...top, ...inner },
    };
  }

  /** A route whose success carries no body. */
  async #empty(r: Exchanged): Promise<FileReply<null>> {
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    try {
      if (!res.ok) return await this.#refusal(res);
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, value: null };
    } finally {
      r.end();
    }
  }

  /** A route whose success is a JSON object under the cap. */
  async #json<T>(
    r: Exchanged,
    accept: (v: Record<string, unknown>) => boolean = () => true,
  ): Promise<FileReply<T>> {
    if ("refusal" in r) return r.refusal;
    const { res } = r;
    try {
      if (!res.ok) return await this.#refusal(res);
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
        return { ok: false, status: res.status, code: "bad_response" };
      return { ok: true, value: value as T };
    } finally {
      r.end();
    }
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
    let bytes: Uint8Array | null;
    try {
      if (!res.ok) return await this.#refusal(res);
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, code: "bad_response" };
      }
      bytes = await readCappedBytes(res, cap);
    } finally {
      r.end();
    }
    if (bytes === null)
      return { ok: false, status: res.status, code: "bad_response" };
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
    let bytes: Uint8Array | null;
    try {
      if (!res.ok) return await this.#refusal(res);
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, code: "bad_response" };
      }
      bytes = await readCappedBytes(res, SERVER_CHUNK_MAX_STORED_BYTES);
    } finally {
      r.end();
    }
    if (bytes === null)
      return { ok: false, status: res.status, code: "bad_response" };
    return { ok: true, value: bytes };
  }
}
