// The destination of `cloudSync.export()` on a path (WIRE-CONTRACT-V5 §13.12 "Destination").
//
//   prepare   a destination that exists must be a regular file (never a link, directory, device or
//             pipe); a stale `<destination>.partial` an earlier crash left is removed first, and a
//             partial path that is not a regular file is refused.
//   create    `<destination>.partial` is created exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`) with
//             mode 0600 AT creation, so no other process can pre-create it, link it or read it.
//   write     the archive is written in order, flushed to disk, closed, and renamed over the
//             destination (atomic: the old destination is replaced whole or not at all).
//   discard   any failure or cancel closes and removes the partial; the old destination is untouched.
//
// Every failure here is `sync-export-failed`, reason `destination`. No path, name or byte is logged,
// and no other copy of the data exists: the partial is the only file this module makes.

import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SyncExportError } from "@polaris-key/client-core/sync";
import type { ZipSink } from "@polaris-key/client-core/sync";

/** The OS error is not chained: its message and `path` name the destination. */
const destination = (what: string): SyncExportError =>
  new SyncExportError("destination", `The export cannot write there: ${what}`);

/** `O_NOFOLLOW` where the platform has it (Windows has no such flag; `wx` still refuses a link). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw destination("it cannot be read");
  }
}

export interface ExportFile {
  /** The sink the archive is written through. */
  readonly sink: ZipSink;
  /** Flush, close and rename the partial over the destination. */
  commit(): Promise<void>;
  /** Close and remove the partial; never throws. */
  discard(): Promise<void>;
}

/** Checks the destination and removes a stale partial. Returns the partial's path. */
export async function prepareDestination(path: string): Promise<{
  destination: string;
  partial: string;
}> {
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    throw destination("the path is not usable");
  const dest = resolve(path);
  const partial = `${dest}.partial`;
  const d = await stat(dest);
  if (d !== null && !d.isFile())
    throw destination("the destination is not a regular file");
  const p = await stat(partial);
  if (p !== null) {
    if (!p.isFile())
      throw destination("the partial path is not a regular file");
    try {
      await unlink(partial);
    } catch {
      throw destination("a stale partial could not be removed");
    }
  }
  return { destination: dest, partial };
}

/** Creates the partial exclusively with 0600. Call `prepareDestination` first. */
export async function createExportFile(paths: {
  destination: string;
  partial: string;
}): Promise<ExportFile> {
  let fh: FileHandle;
  try {
    fh = await open(
      paths.partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch {
    throw destination("the partial file cannot be created");
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fh.close();
  };
  const discard = async (): Promise<void> => {
    try {
      await close();
    } catch {
      // the descriptor is gone either way
    }
    try {
      await unlink(paths.partial);
    } catch {
      // nothing left to remove, or nothing this process may remove
    }
  };
  return {
    sink: {
      async write(chunk) {
        try {
          let at = 0;
          while (at < chunk.length) {
            const { bytesWritten } = await fh.write(
              chunk,
              at,
              chunk.length - at,
            );
            if (bytesWritten === 0)
              throw new Error("the file accepted no bytes");
            at += bytesWritten;
          }
        } catch {
          throw destination("a write failed");
        }
      },
    },
    async commit() {
      try {
        await fh.sync();
        await close();
        await rename(paths.partial, paths.destination);
      } catch {
        await discard();
        throw destination("the file could not be completed");
      }
      // The rename itself reaches the disk when the directory does; best effort, and not on
      // platforms that cannot open a directory.
      try {
        const dir = await open(dirname(paths.destination), constants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch {
        // the rename is done
      }
    },
    discard,
  };
}
