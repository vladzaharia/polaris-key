// What a host needs around `exportToSink` (WIRE-CONTRACT-V5 §13.12 "What is read"), written once
// for Node and the browser: the pulls that collect the changes, the file source over a
// `FileTransport`, and the bounded waits. A host adds the destination (a file, a Blob, a stream)
// and the sink over it.
//
//   - Every wait (a 429's Retry-After, a retry's backoff) is taken from one budget,
//     `SYNC_EXPORT_MAX_WAIT_MS`; one wait is cut to `SYNC_EXPORT_RETRY_AFTER_MAX_MS`; a cancel ends
//     a wait at once. Past the budget the export fails with `sync-export-failed`, reason `network`.
//   - At most `SYNC_EXPORT_MAX_PULLS` pulls, and each must advance the cursor.
//   - Files are read as `saves.read` reads them: ranged `GET`s of the stored bytes with the ETag held
//     fixed, `?version=` pinned (a pruned version retried once at the current one). The source reads
//     a range only when the export asks for more, so bytes past the plan are never fetched.
//
// Nothing here logs, and nothing is retained after the returned promise settles.

import {
  SYNC_EXPORT_MAX_PULLS,
  SYNC_EXPORT_MAX_WAIT_MS,
  SYNC_EXPORT_RETRY_AFTER_MAX_MS,
} from "@polaris-key/protocol/sync";
import { PolarisError } from "../errors.js";
import type { SyncResponse, SyncStatus } from "../cloud-sync.js";
import type { ExportFilePointer, ExportFileSource } from "./export.js";
import {
  DOWNLOAD_RANGE_BYTES,
  TransferError,
  type FileReply,
  type FileTransport,
} from "./transfer.js";

export type ExportFailReason = "destination" | "network" | "busy";

/** `sync-export-failed`; `reason` says whether it is the destination, the network or a second export. */
export class SyncExportError extends PolarisError {
  readonly reason: ExportFailReason;
  constructor(reason: ExportFailReason, message: string, cause?: unknown) {
    super("sync-export-failed", message, cause === undefined ? {} : { cause });
    this.name = "SyncExportError";
    this.reason = reason;
  }
}

/** What `cloudSync.export()` answers. `path` is set where the SDK wrote a file. */
export interface CloudSyncExport {
  path?: string;
  /** Bytes of the archive. */
  bytes: number;
  entries: number;
  settings: number;
  records: number;
  files: number;
  skipped: Array<{
    kind: string;
    collection?: string;
    entry?: string;
    code: string;
    partial?: boolean;
  }>;
  unsynced: number;
}

const cancelled = (): PolarisError =>
  new PolarisError("cancelled", "The export was cancelled");
const network = (what: string, cause?: unknown): SyncExportError =>
  new SyncExportError(
    "network",
    `The export could not read the data: ${what}`,
    cause,
  );

/** Whether `e` is the cancel of an export. */
export const isExportCancel = (e: unknown): boolean =>
  e instanceof PolarisError && e.code === "cancelled";

export const checkExportCancel = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelled();
};

/** The refusals the machine's own state gives, before anything is read. */
export function refuseExportByStatus(s: SyncStatus): void {
  if (s.state === "unsupported" && s.code !== undefined)
    throw new PolarisError(
      s.code,
      "Cloud Sync is pinned to end-to-end encryption",
    );
  if (s.state === "locked")
    throw new PolarisError(
      "sync-locked",
      "This device holds no root for the key ring; unlock it first.",
    );
  if (
    s.state === "local" ||
    (s.state === "blocked" && s.reason === "account_required")
  )
    throw new PolarisError("account_required", "Sign in to export");
}

const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

/** The one wait budget of an export. `sleep` rejects or resolves when the signal fires. */
export class ExportWaits {
  #used = 0;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #signal: AbortSignal | undefined;
  readonly #max: number;
  readonly #cut: number;
  readonly onWait: ((waiting: boolean) => void) | undefined;

  constructor(opts: {
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    maxWaitMs?: number;
    retryAfterMaxMs?: number;
    onWait?: (waiting: boolean) => void;
  }) {
    this.#sleep = opts.sleep;
    this.#signal = opts.signal;
    this.#max = opts.maxWaitMs ?? SYNC_EXPORT_MAX_WAIT_MS;
    this.#cut = opts.retryAfterMaxMs ?? SYNC_EXPORT_RETRY_AFTER_MAX_MS;
    this.onWait = opts.onWait;
  }

  /** Wait `ms` (cut to one wait's maximum). Past the budget: `sync-export-failed`, reason network. */
  async wait(ms: number): Promise<void> {
    checkExportCancel(this.#signal);
    const m = Math.min(Math.max(0, Math.floor(ms)), this.#cut);
    if (this.#used + m > this.#max) throw network("the waits ran out");
    this.#used += m;
    this.onWait?.(true);
    try {
      await this.#sleep(m, this.#signal);
    } catch (e) {
      if (this.#signal?.aborted) throw cancelled();
      throw e;
    } finally {
      this.onWait?.(false);
    }
    checkExportCancel(this.#signal);
  }
}

const backoff = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));

/**
 * Runs `call` until it answers or the budget ends: a 429 waits out its `Retry-After` (no attempt
 * is spent), a 5xx or a failed exchange backs off (at most `MAX_ATTEMPTS`). Any other answer is
 * returned for the caller to read.
 */
async function answered<T>(
  waits: ExportWaits,
  signal: AbortSignal | undefined,
  call: () => Promise<FileReply<T>>,
): Promise<FileReply<T>> {
  let attempt = 0;
  for (;;) {
    checkExportCancel(signal);
    let r: FileReply<T>;
    try {
      r = await call();
    } catch (e) {
      if (signal?.aborted) throw cancelled();
      // A route the transport refuses outright is not retried.
      if (e instanceof TransferError)
        throw network("the request was refused", e);
      r = { ok: false, status: 0, code: "network" };
    }
    if (r.ok) return r;
    if (r.status === 429) {
      await waits.wait(
        r.retryAfterSeconds !== undefined
          ? r.retryAfterSeconds * 1000
          : backoff(attempt + 1),
      );
      continue;
    }
    if (r.status === 0 || r.status >= 500) {
      if (++attempt >= MAX_ATTEMPTS) throw network("retries spent");
      await waits.wait(backoff(attempt));
      continue;
    }
    return r;
  }
}

const refused = (
  r: Extract<FileReply<unknown>, { ok: false }>,
): PolarisError =>
  r.code === "account_required"
    ? new PolarisError("account_required", "Sign in to export", {
        status: r.status,
      })
    : network(`the Worker answered ${r.status}`);

/**
 * The stored bytes of a file by ranged `GET`s, and its chunks, over a host's `FileTransport`.
 * The answers' status and `Content-Range` are checked as a download checks them; a file that
 * changes under the read (`If-Match`) or answers badly fails the export (`network`), and the
 * export has already written what it had as a partial entry only for a short or differing file.
 */
export function transportFileSource(
  transport: FileTransport,
  waits: ExportWaits,
  signal?: AbortSignal,
): ExportFileSource {
  const opts = signal === undefined ? {} : { signal };
  return {
    async pointers(collection, record) {
      const r = await answered(waits, signal, () =>
        transport.revisions({ collection, record }, opts),
      );
      if (!r.ok) {
        if (r.status === 404) return [];
        throw refused(r);
      }
      const list: unknown = r.value.revisions;
      if (!Array.isArray(list)) return [];
      return list.filter(
        (v): v is ExportFilePointer =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as { version?: unknown }).version === "number",
      );
    },

    async *stored(ref) {
      const target = { collection: ref.collection, record: ref.record };
      let version: number | undefined = ref.version;
      let etag: string | undefined;
      let at = 0;
      let total: number | undefined;
      while (total === undefined || at < total) {
        const end = at + DOWNLOAD_RANGE_BYTES;
        const ask = (v: number | undefined) =>
          answered(waits, signal, () =>
            transport.getFile(
              target,
              {
                ...(v !== undefined ? { version: v } : {}),
                range: { start: at, end },
                ...(etag !== undefined ? { ifMatch: etag } : {}),
              },
              opts,
            ),
          );
        let r = await ask(version);
        // A version the Worker pruned since the pointer was read: once, at the current one.
        if (!r.ok && r.status === 404 && at === 0 && version !== undefined) {
          version = undefined;
          r = await ask(undefined);
        }
        // An empty file has no byte to ask for.
        if (!r.ok && r.status === 416 && at === 0) return;
        if (!r.ok) throw refused(r);
        const body = r.value;
        if (etag !== undefined && body.etag !== undefined && body.etag !== etag)
          throw network("the file changed while it was read");
        etag ??= body.etag;
        let piece: Uint8Array;
        if (body.status === 206) {
          const cr = body.contentRange;
          if (
            cr === undefined ||
            cr.start !== at ||
            cr.end <= cr.start ||
            cr.end > end ||
            body.bytes.length !== cr.end - cr.start ||
            (total !== undefined && cr.total !== total)
          )
            throw network("the Worker's range answer was not usable");
          total = cr.total;
          piece = body.bytes;
        } else {
          // A Worker that ignores `Range` sends the whole file, which only fits from the start.
          if (at !== 0) throw network("the Worker's answer was not usable");
          total = body.bytes.length;
          piece = body.bytes;
        }
        if (piece.length === 0) return;
        at += piece.length;
        yield piece;
      }
    },

    async chunk(collection, idHex) {
      const r = await answered(waits, signal, () =>
        transport.getChunk(collection, idHex, opts),
      );
      if (r.ok) return r.value;
      if (r.status === 404) return null;
      throw refused(r);
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const pair = (v: unknown): string | null =>
  Array.isArray(v) &&
  v.length >= 2 &&
  typeof v[0] === "string" &&
  typeof v[1] === "string"
    ? `${v[0].length}:${v[0]}${v[1]}`
    : null;

/**
 * Pull from the start until the Worker says `more: false`, and return the changes as served (a
 * later change to a row replaces the earlier one; a tombstone removes it). `pull` is the host's
 * authenticated `GET /<p>/sync?cursor=n`.
 */
export async function pullChanges(
  pull: (cursor: number) => Promise<SyncResponse>,
  waits: ExportWaits,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const rows = new Map<string, Record<string, unknown>>();
  let cursor = 0;
  for (let n = 0; n < SYNC_EXPORT_MAX_PULLS; n++) {
    let answer: { status: number; body?: unknown } | null = null;
    for (let attempt = 0; answer === null; ) {
      checkExportCancel(signal);
      let r: SyncResponse;
      try {
        r = await pull(cursor);
      } catch {
        r = { error: "transport" };
      }
      if ("error" in r) {
        if (++attempt >= MAX_ATTEMPTS) throw network("retries spent");
        await waits.wait(backoff(attempt));
      } else if (r.status === 429) {
        await waits.wait(backoff(++attempt));
      } else if (r.status >= 500) {
        if (++attempt >= MAX_ATTEMPTS) throw network("retries spent");
        await waits.wait(backoff(attempt));
      } else answer = r;
    }
    const body = answer.body;
    if (answer.status === 403 || answer.status === 401) {
      const e = isObj(body) && isObj(body["error"]) ? body["error"] : body;
      if (isObj(e) && e["code"] === "account_required")
        throw new PolarisError("account_required", "Sign in to export", {
          status: answer.status,
        });
    }
    if (answer.status !== 200 || !isObj(body))
      throw network(`the Worker answered ${answer.status}`);
    for (const c of Array.isArray(body["changes"]) ? body["changes"] : []) {
      if (!isObj(c)) continue;
      if (typeof c["setting"] === "string") rows.set(`s${c["setting"]}`, c);
      else {
        const k = pair(c["record"]);
        if (k !== null) rows.set(`r${k}`, c);
      }
    }
    for (const t of Array.isArray(body["tombstones"])
      ? body["tombstones"]
      : []) {
      if (!isObj(t)) continue;
      if (typeof t["setting"] === "string") rows.delete(`s${t["setting"]}`);
      else {
        const k = pair(t["record"]);
        if (k !== null) rows.delete(`r${k}`);
      }
    }
    if (body["more"] !== true) return [...rows.values()];
    const next = body["cursor"];
    if (
      typeof next !== "number" ||
      !Number.isSafeInteger(next) ||
      next <= cursor
    )
      throw network("a pull did not advance");
    cursor = next;
  }
  throw network("too many pulls");
}
