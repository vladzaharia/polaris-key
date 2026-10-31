// The purge of a tab whose host never ran (U-20.2): delete the record without starting anything,
// then tell the other tabs, so a writer holding the signed-out person's snapshot in memory drops it
// now rather than at its next save (SEC-HOST2 S6).

import { filesDbName, purgeFilesStore } from "./filesPurge.js";
import { removeSyncState, syncStateStore } from "./store.js";
import { broadcastChannel } from "./writer.js";

export async function purgeUnloaded(dbName: string): Promise<void> {
  try {
    await removeSyncState(syncStateStore(dbName));
  } finally {
    // The journal and chunk cache of saves go with the person too (D-9).
    await purgeFilesStore(filesDbName(dbName)).catch(() => undefined);
    const c = broadcastChannel(dbName);
    c.post({ t: "purge" });
    c.close();
  }
}
