// `adapter.cloudSync.export(options)` in the browser (U-51.4; WIRE-CONTRACT-V5 §13.12): a readable,
// NOT encrypted zip of what the app synced, as a Blob or streamed into a WritableStream the app
// gives (the File System Access picker's). The counterpart of sdk-node's `cloudSync/export.ts`: the
// same steps (flush, pull from the start until `more: false`, client-core's `exportToSink`), with
// a different destination.
//
//   Blob     the archive is held in memory as the pieces arrive and handed to the caller at the end.
//            A plan over `SYNC_EXPORT_BLOB_MAX_BYTES` is refused before anything is read, so a page
//            never builds more than 256 MiB; a larger export needs a `sink`. The SDK keeps no
//            reference to the Blob after it returns it, and drops every piece on an error or a cancel.
//   sink     each piece is written with the stream's backpressure; the stream is closed at the end
//            and aborted on an error or a cancel (no rename exists: an abort discards the changes
//            where the browser supports it). The writer is released and never kept.
//
// The root's bytes are never read: the ring's vault holds a non-extractable handle and lends a
// crypto port over it for the call (`exportKeys`); a lock aborts the export. No value, id or name
// is logged or put in an error.

import type { SyncStatus } from "@polaris-key/client-core/cloud-sync";
import { PolarisError } from "@polaris-key/client-core";
import {
  ExportWaits,
  SyncExportError,
  checkExportCancel,
  exportToSink,
  isExportCancel,
  pullChanges,
  refuseExportByStatus,
  transportFileSource,
  webCryptoSyncPort,
  type ZipSink,
} from "@polaris-key/client-core/sync";
import { SYNC_EXPORT_BLOB_MAX_BYTES } from "@polaris-key/protocol/sync";
import type {
  BrowserExport,
  BrowserExportOptions,
} from "../../core/cloudSync.js";
import type { KeyringClient } from "../../core/keyring.js";
import { BrowserFileTransport, type FileFetch } from "./files.js";
import type { BrowserCloudSyncHost } from "./host.js";
import { sendSync, type ProductRequest } from "./transport.js";

export interface BrowserExportDeps {
  product: string;
  host: BrowserCloudSyncHost;
  keyring: Pick<KeyringClient, "codec" | "exportKeys" | "subscribe">;
  /** One authenticated request under `/<product>/` (the pulls). */
  request: ProductRequest;
  /** The file routes' fetch (the files and chunks). */
  fileFetch: FileFetch;
  /** Start the host, send what is waiting (bounded), then the status. */
  flush: () => Promise<SyncStatus>;
  /** Test seams: the device clock (ms) and a wait that ends when the signal fires. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

const destination = (what: string, cause?: unknown): SyncExportError =>
  new SyncExportError(
    "destination",
    `The export cannot write there: ${what}`,
    cause,
  );

/** The one export a client runs at a time. */
export const exportBusy = (): SyncExportError =>
  new SyncExportError("busy", "Another export of this client is running");

const locked = (): PolarisError =>
  new PolarisError(
    "sync-locked",
    "This device holds no root for the key ring; unlock it first.",
  );

/** A sink that holds the pieces as a Blob. The pieces are copied (a piece may be a view of a
 *  larger buffer) and folded into the Blob as it grows, so the page never holds the archive twice. */
function blobSink(): { sink: ZipSink; take(): Blob; drop(): void } {
  const FOLD_BYTES = 8 * 1024 * 1024;
  let blob: Blob | null = null;
  let pending: Array<Uint8Array<ArrayBuffer>> = [];
  let pendingBytes = 0;
  const fold = (): void => {
    blob = new Blob(blob === null ? pending : [blob, ...pending]);
    pending = [];
    pendingBytes = 0;
  };
  return {
    sink: {
      write(chunk) {
        pending.push(chunk.slice());
        pendingBytes += chunk.length;
        if (pendingBytes >= FOLD_BYTES) fold();
      },
    },
    take() {
      fold();
      const out = new Blob([blob as Blob], { type: "application/zip" });
      blob = null;
      return out;
    },
    drop() {
      blob = null;
      pending = [];
      pendingBytes = 0;
    },
  };
}

export async function runBrowserExport(
  d: BrowserExportDeps,
  options: BrowserExportOptions = {},
): Promise<BrowserExport> {
  const { signal, sink } = options;
  checkExportCancel(signal);
  const status = await d.flush();
  refuseExportByStatus(status);
  checkExportCancel(signal);
  const e2e = d.host.machine.encryptionMode() === "e2e";
  const keys = e2e ? await d.keyring.exportKeys?.() : null;
  if (e2e && (keys === null || keys === undefined)) throw locked();
  const codec = e2e ? d.keyring.codec() : null;
  if (e2e && codec === null) throw locked();

  // The ring locking ends the export (the root input would answer for a key that is gone).
  const gone = new AbortController();
  const unsubscribe = e2e
    ? d.keyring.subscribe(() => {
        if (!keys?.alive()) gone.abort();
      })
    : () => undefined;
  const sig =
    signal === undefined ? gone.signal : AbortSignal.any([signal, gone.signal]);
  const waits = new ExportWaits({
    sleep: d.sleep ?? defaultSleep,
    signal: sig,
  });

  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const held = blobSink();
  try {
    const changes = await pullChanges(
      (cursor) =>
        sendSync(d.product, d.request, {
          method: "GET",
          path: `/${d.product}/sync?cursor=${cursor}`,
        }),
      waits,
      sig,
    );
    if (sink !== undefined) {
      try {
        writer = sink.getWriter();
      } catch (e) {
        throw destination("the stream is not usable", e);
      }
    }
    const w = writer;
    const to: ZipSink =
      w === null
        ? held.sink
        : {
            async write(chunk) {
              try {
                await w.ready;
                await w.write(chunk);
              } catch (e) {
                throw destination("a write failed", e);
              }
            },
          };
    const summary = await exportToSink(
      {
        product: d.product,
        exportedAt: (d.now ?? Date.now)(),
        unsynced: status.pending,
        includeRevisions: options.includeRevisions === true,
        // Without a sink the archive lives in memory: refuse a plan over the Blob's cap up front.
        ...(sink === undefined
          ? { caps: { maxBytes: SYNC_EXPORT_BLOB_MAX_BYTES } }
          : {}),
        changes,
        port: keys?.port ?? webCryptoSyncPort,
        root: keys?.root ?? null,
        ...(codec === null ? {} : { codec }),
        files: transportFileSource(
          new BrowserFileTransport({
            product: d.product,
            request: d.fileFetch,
          }),
          waits,
          sig,
        ),
        signal: sig,
      },
      to,
    );
    if (w !== null) {
      try {
        await w.close();
      } catch (e) {
        throw destination("the stream could not be closed", e);
      }
    }
    return {
      bytes: summary.bytes,
      entries: summary.entries,
      settings: summary.counts.settings,
      records: summary.counts.records,
      files: summary.counts.files,
      skipped: summary.skipped,
      unsynced: summary.unsynced,
      ...(w === null ? { blob: held.take() } : {}),
    };
  } catch (e) {
    held.drop();
    if (writer !== null)
      await writer
        .abort(isExportCancel(e) ? e : undefined)
        .catch(() => undefined);
    // A lock during the export is the ring's refusal, not a cancel.
    if (gone.signal.aborted && isExportCancel(e) && signal?.aborted !== true)
      throw locked();
    throw e;
  } finally {
    unsubscribe();
    // The sink is released and never kept; a closed or aborted stream ignores this.
    try {
      writer?.releaseLock();
    } catch {
      // the stream is already finished with
    }
  }
}
