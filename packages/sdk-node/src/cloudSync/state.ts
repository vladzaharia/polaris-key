// The Cloud Sync host's state file (U-06.2): `<stateDir>/cloud-sync.json`, owner-only (0600, atomic).
// It holds the machine's journal (`CloudSyncMachine.persist()`), the catalog last served by
// `/config/schema` (so a relaunch routes settings before the first fetch) and the names of the
// person's open settings (so a blinded tombstone can be mapped back).
//
// The file holds the WHOLE opened snapshot of the signed-in person's settings (every value this
// device has opened or edited), not only the pending edits. Whoever signs out, or loses the
// account, must purge it with the key ring's pin (U-06.3); until then it is as sensitive as the
// settings themselves.
//
// Nothing here is a secret of the ring: the root is never written (the keyring keeps it in memory).
// The journal does hold the person's own setting values in the clear, as the machine's locked state
// requires ("edits stay in the clear on the device"); that is why the file is 0600 and sits in the
// state directory with the pin and the token store.

import type { CloudSyncPersisted } from "@polaris-key/client-core/cloud-sync";
import type { ProductCatalog } from "@polaris-key/catalog";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "../core/jsonFile.js";

export const CLOUD_SYNC_FILE = "cloud-sync.json";
/** Holds no data: it says the legacy `local-config.json` was offered to the machine once. */
export const CLOUD_SYNC_IMPORTED_FILE = "cloud-sync-imported.json";
/** Open-setting names kept for tombstone mapping; past this the oldest are dropped. */
export const OPEN_KEYS_MAX = 4096;

export interface CloudSyncFile {
  v: 1;
  product: string;
  persisted: CloudSyncPersisted | null;
  catalog: ProductCatalog | null;
  openKeys: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The catalog's outer shape; the host derives routes from it with `syncedSettings`. */
export const isCatalogShape = (v: unknown): v is ProductCatalog =>
  isRecord(v) &&
  typeof v.schemaVersion === "number" &&
  Array.isArray(v.entries);

export class CloudSyncStateFile {
  readonly path: string;
  readonly importedPath: string;
  #write: Promise<void> = Promise.resolve();

  constructor(
    stateDir: string,
    private readonly product: string,
  ) {
    this.path = join(stateDir, CLOUD_SYNC_FILE);
    this.importedPath = join(stateDir, CLOUD_SYNC_IMPORTED_FILE);
  }

  /** Delete the file (after every pending write, so none lands after it). Throws if it stays. */
  remove(): Promise<void> {
    const next = this.#write.then(() => rm(this.path, { force: true }));
    this.#write = next.catch(() => undefined);
    return next;
  }

  async imported(): Promise<boolean> {
    return (await readJson<unknown>(this.importedPath, null)) !== null;
  }

  markImported(): Promise<void> {
    return writeJson(this.importedPath, { v: 1 });
  }

  /** The saved file, or an empty one when it is missing, corrupt or another product's. */
  async load(): Promise<CloudSyncFile> {
    const empty: CloudSyncFile = {
      v: 1,
      product: this.product,
      persisted: null,
      catalog: null,
      openKeys: [],
    };
    const raw = await readJson<unknown>(this.path, null);
    if (!isRecord(raw) || raw.v !== 1 || raw.product !== this.product)
      return empty;
    const p = raw.persisted;
    const persisted =
      isRecord(p) &&
      isRecord(p.partitions) &&
      Array.isArray(p.hlc) &&
      typeof p.contacted === "boolean"
        ? (p as unknown as CloudSyncPersisted)
        : null;
    return {
      ...empty,
      persisted,
      catalog: isCatalogShape(raw.catalog) ? raw.catalog : null,
      openKeys: Array.isArray(raw.openKeys)
        ? raw.openKeys.filter((k): k is string => typeof k === "string")
        : [],
    };
  }

  /** Writes are serialised, so a slow one never lands after a newer one. */
  save(file: CloudSyncFile): Promise<void> {
    const next = this.#write.then(() => writeJson(this.path, file));
    this.#write = next.catch(() => undefined);
    return next;
  }
}
