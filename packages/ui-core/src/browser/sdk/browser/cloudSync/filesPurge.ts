// Deleting the Cloud Sync files database (U-22.6), apart from the store so the purge path of a
// page that never moved a file loads none of the engine: the journal, the chunk cache and the
// saves writer's identity go with the person (sign-out, deactivation, `account_required`).

/** The database name that goes with a settings record's. */
export const filesDbName = (syncDbName: string): string =>
  `${syncDbName}-files`;

const factoryOf = (idb?: IDBFactory): IDBFactory | undefined =>
  idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;

export function deleteDb(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const r = factory.deleteDatabase(name);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error ?? new Error("indexeddb"));
    // Open connections in other tabs close on `versionchange`; the delete then goes through.
    r.onblocked = () => undefined;
  });
}

/**
 * What a purge does to the file layer: the saves layer is closed first (a transfer still running
 * cannot recreate the database), and a page that never built it knows no person's cache, so it
 * deletes the whole database (the journal and the chunk cache).
 */
export async function purgeFilesLayer(
  saves: { purge(): Promise<void>; built(): boolean } | null,
  dbName: string,
  idb?: IDBFactory | undefined,
): Promise<void> {
  await saves?.purge().catch(() => undefined);
  if (!saves?.built()) await purgeFilesStore(filesDbName(dbName), idb);
}

/**
 * Delete the files database without opening it (a tab whose saves never ran). Where the database
 * is known to be absent there is nothing to do.
 */
export async function purgeFilesStore(
  name: string,
  idb?: IDBFactory | undefined,
): Promise<void> {
  const factory = factoryOf(idb);
  if (factory === undefined) return;
  if (typeof factory.databases === "function") {
    try {
      if (!(await factory.databases()).some((d) => d.name === name)) return;
    } catch {
      // Cannot tell: delete.
    }
  }
  await deleteDb(factory, name);
}
