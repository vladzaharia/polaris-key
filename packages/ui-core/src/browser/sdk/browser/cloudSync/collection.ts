// `cloudSync.collection(name)` in the browser (sync.records, U-46): client-core's handle over the
// host's machine. The machine is read at each call because the host rebuilds it when the catalog
// or the signed document changes. Only the writer tab writes: another tab's write verb throws
// `sync-not-writer` (as the saves do), and reads and `on` work in every tab.

import {
  SyncCollection,
  type CollectionResult,
} from "@polaris-key/client-core/sync";
import type { Json } from "@polaris-key/client-core/cloud-sync";
import type { BrowserCloudSyncHost } from "./host.js";
import { SAVES_NOT_WRITER } from "./saves.js";

/** What a write verb throws in a tab that is not the writer. */
export class NotWriterError extends Error {
  readonly code = SAVES_NOT_WRITER;
  constructor() {
    super(SAVES_NOT_WRITER);
    this.name = "NotWriterError";
  }
}

class BrowserCollection extends SyncCollection {
  readonly #host: BrowserCloudSyncHost;

  constructor(name: string, host: BrowserCloudSyncHost) {
    super(name, {
      get machine() {
        host.catchUp();
        return host.machine;
      },
      onEvents: (fn) => host.onEvents(fn),
      touch: () => void host.touch(),
    });
    this.#host = host;
  }

  #writer(): void {
    if (!this.#host.isWriter) throw new NotWriterError();
  }

  override put(
    id: string,
    value: Json,
    opts: { ifVersion?: number | "*" } = {},
  ): CollectionResult {
    this.#writer();
    return super.put(id, value, opts);
  }

  override update(
    id: string,
    change: { set?: Record<string, Json>; remove?: string[] },
  ): CollectionResult {
    this.#writer();
    return super.update(id, change);
  }

  override add(id: string, element: Json): CollectionResult {
    this.#writer();
    return super.add(id, element);
  }

  override remove(id: string, element: Json): CollectionResult {
    this.#writer();
    return super.remove(id, element);
  }

  override delete(
    id: string,
    opts: { ifVersion?: number | "*" } = {},
  ): CollectionResult {
    this.#writer();
    return super.delete(id, opts);
  }
}

/** The handle of a collection the product's catalog declares. */
export function browserCollection(
  name: string,
  host: BrowserCloudSyncHost,
): SyncCollection {
  return new BrowserCollection(name, host);
}
