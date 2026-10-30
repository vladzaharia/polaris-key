// The Cloud Sync transfer journal on disk (U-22.4): the `JournalStore` port of client-core's
// transfer engine, one JSON file per transfer in `<stateDir>/cloud-sync-transfers/`.
//
//   Names    a file is named by the SHA-256 of the transfer id, never by the id: a save id may
//            hold dots and the id is the caller's text, so no id can climb out of the directory or
//            collide with another file. `list()` reads the records and returns the ids they hold,
//            keeping only a record whose file name is the hash of its own id.
//   Mode     the directory is 0700 and a file 0600, written atomically (a temporary file made
//            exclusively, flushed, then renamed), like the state file beside it.
//   Content  a record holds ids, counts, hashes and times (see `transferJournal.ts`): no key, no
//            plaintext and no bearer token. The directory is purged with the person (`clear`).
//   Reads    a missing file is `null`. A file that is not JSON is not any build's record (writes
//            are atomic), so it also reads as `null` and is overwritten by the next write. A
//            record of another version or shape is returned as found: the engine refuses it and
//            leaves it alone.

import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  JournalStore,
  TransferJournalRecord,
} from "@polaris-key/client-core/sync";
import { readJson, removeJson, writeJson } from "../core/jsonFile.js";
import { serialQueue } from "../core/serialQueue.js";

export const CLOUD_SYNC_TRANSFERS_DIR = "cloud-sync-transfers";

const NAME = /^[0-9a-f]{64}\.json$/;

/** The file a transfer id lives in: the lowercase hex SHA-256 of the id, `.json`. */
export const journalFileName = (id: string): string =>
  `${createHash("sha256").update(id, "utf8").digest("hex")}.json`;

export class FileJournal implements JournalStore {
  readonly dir: string;
  readonly #serial = serialQueue();

  /** `stateDir` is the host's state directory; the journal sits in its own folder beside the state file. */
  constructor(stateDir: string) {
    this.dir = join(stateDir, CLOUD_SYNC_TRANSFERS_DIR);
  }

  async get(id: string): Promise<unknown | null> {
    return readJson<unknown | null>(join(this.dir, journalFileName(id)), null);
  }

  put(id: string, record: TransferJournalRecord): Promise<void> {
    return this.#serial(() =>
      writeJson(join(this.dir, journalFileName(id)), record),
    );
  }

  delete(id: string): Promise<void> {
    return this.#serial(() => removeJson(join(this.dir, journalFileName(id))));
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const name of names) {
      if (!NAME.test(name)) continue;
      const raw = await readJson<unknown>(join(this.dir, name), null);
      const id =
        typeof raw === "object" && raw !== null
          ? (raw as { id?: unknown }).id
          : undefined;
      if (typeof id === "string" && journalFileName(id) === name) ids.push(id);
    }
    return ids;
  }

  /** Remove every record: the purge that goes with the person (sign-out, `forget`). */
  clear(): Promise<void> {
    return this.#serial(() => rm(this.dir, { recursive: true, force: true }));
  }
}
