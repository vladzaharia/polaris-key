// `client.cloudSync.export(destination, options)` on Node (U-51.3; WIRE-CONTRACT-V5 §13.12): a
// readable, unencrypted zip of what the app synced, written to a path the app chose.
//
//   1. the destination is checked and a stale `<destination>.partial` removed (`exportFile.ts`),
//   2. the machine's pending edits are flushed (bounded), then the Worker is pulled from the start
//      until `more: false`, so the archive holds what the Worker holds,
//   3. client-core's `exportToSink` plans the archive, refuses before the first byte when it is over a
//      bound, and streams it into the partial file through the file source over this client's file
//      transport (the hourly file allowance applies: a `429` is waited out, bounded),
//   4. the partial is flushed and renamed over the destination. Any failure or cancel removes it.
//
// The end-to-end root never leaves the key ring: `keyring.withRoot` lends the live array for the
// call, and a lock (sign-out, quit) aborts the export. No value, id or path is logged or put in an
// error, and nothing is kept after the promise settles.

import type { SyncStatus } from "@polaris-key/client-core/cloud-sync";
import { PolarisError } from "@polaris-key/client-core";
import {
  ExportWaits,
  SyncExportError,
  checkExportCancel,
  exportSleep,
  exportToSink,
  pullChanges,
  refuseExportByStatus,
  transportFileSource,
  webCryptoSyncPort,
  type CloudSyncExport,
  type ZipSink,
} from "@polaris-key/client-core/sync";
import { ErrorCode } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { KeyringClient } from "../keyring/client.js";
import {
  createExportFile,
  prepareDestination,
  type ExportFile,
} from "./exportFile.js";
import { NodeFileTransport } from "./files.js";
import type { CloudSyncHost } from "./host.js";
import { sendSync } from "./transport.js";

export interface CloudSyncExportOptions {
  /** Also write each file's kept revisions (default false). */
  includeRevisions?: boolean;
  /** Abort the export: the partial file is removed and the call rejects with `cancelled`. */
  signal?: AbortSignal;
}

export interface NodeExportDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  host: CloudSyncHost;
  keyring: KeyringClient;
  /** Start the host, send what is waiting (bounded), then the status. */
  flush: () => Promise<SyncStatus>;
  /** Test seams: the device clock (ms) and a wait that ends when the signal fires. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function runNodeExport(
  d: NodeExportDeps,
  destination: string,
  options: CloudSyncExportOptions = {},
): Promise<CloudSyncExport> {
  const { signal } = options;
  checkExportCancel(signal);
  const paths = await prepareDestination(destination);
  const status = await d.flush();
  refuseExportByStatus(status);
  checkExportCancel(signal);
  const e2e = d.host.machine.encryptionMode() === "e2e";
  const transport = new NodeFileTransport({
    ctx: d.ctx,
    token: () => d.tokens.current,
  });

  const run = async (
    root: Uint8Array | null,
    locked?: AbortSignal,
  ): Promise<CloudSyncExport> => {
    const sig =
      locked === undefined
        ? signal
        : signal === undefined
          ? locked
          : AbortSignal.any([signal, locked]);
    const waits = new ExportWaits({
      sleep: d.sleep ?? exportSleep,
      ...(sig === undefined ? {} : { signal: sig }),
    });
    const changes = await pullChanges(
      (cursor) =>
        sendSync(d.ctx, d.tokens, {
          method: "GET",
          path: `/${d.ctx.product}/sync?cursor=${cursor}`,
        }),
      waits,
      sig,
    );
    // The partial is created at the first byte, which the export writes only once its plan is
    // accepted: a refusal leaves nothing behind.
    let file: ExportFile | undefined;
    const sink: ZipSink = {
      async write(chunk) {
        file ??= await createExportFile(paths);
        await file.sink.write(chunk);
      },
    };
    try {
      const summary = await exportToSink(
        {
          product: d.ctx.product,
          exportedAt: (d.now ?? Date.now)(),
          unsynced: status.pending,
          includeRevisions: options.includeRevisions === true,
          changes,
          port: webCryptoSyncPort,
          root,
          ...(root === null ? {} : { codec: d.keyring.codec }),
          files: transportFileSource(transport, waits, sig),
          ...(sig === undefined ? {} : { signal: sig }),
        },
        sink,
      );
      if (file === undefined) throw new Error("the export wrote nothing");
      await file.commit();
      return {
        path: paths.destination,
        bytes: summary.bytes,
        entries: summary.entries,
        settings: summary.counts.settings,
        records: summary.counts.records,
        files: summary.counts.files,
        skipped: summary.skipped,
        unsynced: summary.unsynced,
      };
    } catch (e) {
      await file?.discard();
      throw e;
    }
  };

  if (e2e && !d.keyring.unlocked)
    throw new PolarisError(
      ErrorCode.syncLocked,
      "This device holds no root for the key ring; unlock it first.",
    );
  return e2e
    ? d.keyring.withRoot((root, locked) => run(root, locked))
    : run(null);
}

/** The error a second concurrent export gets. */
export const exportBusy = (): SyncExportError =>
  new SyncExportError("busy", "Another export of this client is running");
