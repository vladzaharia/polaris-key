// A fake U-10 and U-37 server behind the FileTransport port, shared by the transfer and saves tests.
import type {
  FileBody,
  FileCallOptions,
  FileQuery,
  FileTarget,
  FileTransport,
} from "../src/sync/index.js";
import type {
  BeginFileRequest,
  BeginFileResponse,
  ChunkPlanRequest,
  ChunkPlanResponse,
  FileRevisionsResponse,
  FinalizeRequest,
  FinalizeResponse,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import { webCryptoSyncPort as port } from "../src/sync/index.js";
import { fail, hex, ok } from "./syncTransferFixtures.js";
import type { FileReply } from "../src/sync/index.js";

export interface StoredFile {
  version: number;
  format: "whole" | "chunks";
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

/** A fake U-10 and U-37 server behind the port: chunks per collection, files by version. */
export class FakeServer implements FileTransport {
  chunks = new Map<string, Uint8Array>();
  files: StoredFile[] = [];
  uploads = new Map<
    string,
    {
      format: "whole" | "chunks";
      size: number;
      sha256: string;
      planned: Set<string>;
      manifest?: Uint8Array;
      expiresAt: number;
    }
  >();
  calls: string[] = [];
  chunkPuts: string[] = [];
  chunkGets: string[] = [];
  fileGets: FileQuery[] = [];
  aborted: string[] = [];
  seq = 0;
  /** Breaks one kind of call; return a reply to override. */
  hook: (kind: string, arg?: string) => FileReply<never> | undefined = () =>
    undefined;
  /** Rewrites an answer to a file GET. */
  tamperFile: (q: FileQuery, b: FileBody) => FileBody = (_q, b) => b;
  tamperChunk: (id: string, o: Uint8Array) => Uint8Array = (_i, o) => o;
  /** What the plan call answers instead of the truth. */
  planOverride: ((r: ChunkPlanRequest) => ChunkPlanResponse) | null = null;
  etag = '"e1"';
  /** The version `finalize` answers; a records layer bumps its own. */
  nextVersion = (): number => this.files.length + 1;
  expiresAt = Math.floor(Date.now() / 1000) + 86_400;

  begin = async (
    _t: FileTarget,
    r: BeginFileRequest,
  ): Promise<FileReply<BeginFileResponse>> => {
    this.calls.push("begin");
    const h = this.hook("begin");
    if (h) return h;
    const uploadId = `up${++this.seq}`;
    this.uploads.set(uploadId, {
      format: r.format,
      size: r.size,
      sha256: r.sha256,
      planned: new Set(),
      expiresAt: this.expiresAt,
    });
    return ok({
      uploadId,
      mode: r.format === "chunks" ? "chunks" : "single",
      expiresAt: this.expiresAt,
    });
  };
  status = async (): Promise<FileReply<UploadStatus>> => {
    throw new Error("unused");
  };
  planChunks = async (
    _t: FileTarget,
    id: string,
    r: ChunkPlanRequest,
    _o?: FileCallOptions,
  ): Promise<FileReply<ChunkPlanResponse>> => {
    this.calls.push("plan");
    const h = this.hook("plan");
    if (h) return h;
    const u = this.uploads.get(id);
    if (!u) return fail(410, "upload_expired");
    if (this.planOverride) return ok(this.planOverride(r));
    const missing: string[] = [];
    const present: [string, number][] = [];
    for (const [cid, n] of r.chunks) {
      u.planned.add(cid);
      if (this.chunks.has(cid)) present.push([cid, n]);
      else missing.push(cid);
    }
    return ok({ missing, present });
  };
  putChunk = async (
    _t: FileTarget,
    id: string,
    cid: string,
    body: Uint8Array,
    digest: string,
  ): Promise<FileReply<null>> => {
    this.calls.push("putChunk");
    const h = this.hook("putChunk", cid);
    if (h) return h;
    if (!this.uploads.has(id)) return fail(410, "upload_expired");
    if (hex(await port.sha256(body)) !== digest)
      return fail(400, "upload_mismatch");
    this.chunkPuts.push(cid);
    this.chunks.set(cid, Uint8Array.from(body));
    return ok(null);
  };
  putSingle = async (
    _t: FileTarget,
    id: string,
    body: Uint8Array,
    digest: string,
  ): Promise<FileReply<null>> => {
    this.calls.push("putSingle");
    const h = this.hook("putSingle");
    if (h) return h;
    const u = this.uploads.get(id);
    if (!u) return fail(410, "upload_expired");
    if (hex(await port.sha256(body)) !== digest)
      return fail(400, "upload_mismatch");
    u.manifest = Uint8Array.from(body);
    return ok(null);
  };
  putPart = async (): Promise<FileReply<null>> => {
    throw new Error("unused");
  };
  abort = async (_t: FileTarget, id: string): Promise<FileReply<null>> => {
    this.calls.push("abort");
    this.aborted.push(id);
    this.uploads.delete(id);
    return ok(null);
  };
  finalize = async (
    _t: FileTarget,
    r: FinalizeRequest,
  ): Promise<FileReply<FinalizeResponse>> => {
    this.calls.push("finalize");
    const h = this.hook("finalize");
    if (h) return h;
    const u = this.uploads.get(r.uploadId);
    if (!u) return fail(410, "upload_expired");
    const missing = [...u.planned].filter((c) => !this.chunks.has(c));
    if (missing.length || !u.manifest)
      return fail(409, "upload_incomplete", { body: { missing } });
    const file: StoredFile = {
      version: this.nextVersion(),
      format: u.format,
      size: u.size,
      sha256: u.sha256,
      bytes: u.manifest,
    };
    this.files.push(file);
    return ok({
      version: file.version,
      size: file.size,
      sha256: file.sha256,
      format: file.format,
    });
  };
  getFile = async (
    _t: FileTarget,
    q: FileQuery,
  ): Promise<FileReply<FileBody>> => {
    this.calls.push("getFile");
    this.fileGets.push(q);
    const h = this.hook("getFile");
    if (h) return h;
    const f =
      q.version === undefined
        ? this.files.at(-1)
        : this.files.find((x) => x.version === q.version);
    if (!f) return fail(404, "not_found");
    if (f.format === "chunks" || !q.range)
      return ok(
        this.tamperFile(q, {
          status: 200,
          bytes: f.bytes,
          etag: this.etag,
        }),
      );
    return ok(
      this.tamperFile(q, {
        status: 206,
        bytes: f.bytes.subarray(q.range.start, q.range.end),
        etag: this.etag,
        contentRange: {
          start: q.range.start,
          end: q.range.end,
          total: f.bytes.length,
        },
      }),
    );
  };
  revisions = async (
    _t: FileTarget,
  ): Promise<FileReply<FileRevisionsResponse>> => {
    this.calls.push("revisions");
    const h = this.hook("revisions");
    if (h) return h;
    return ok({
      revisions: [...this.files].reverse().map((f) => ({
        version: f.version,
        size: f.size,
        sha256: f.sha256,
        format: f.format,
        createdAt: 0,
      })),
    });
  };
  getChunk = async (
    _c: string,
    cid: string,
  ): Promise<FileReply<Uint8Array>> => {
    this.calls.push("getChunk");
    this.chunkGets.push(cid);
    const h = this.hook("getChunk", cid);
    if (h) return h;
    const o = this.chunks.get(cid);
    return o ? ok(this.tamperChunk(cid, o)) : fail(404, "not_found");
  };
}
