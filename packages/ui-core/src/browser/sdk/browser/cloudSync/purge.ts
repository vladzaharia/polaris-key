// The purge of a tab whose host never ran (U-20.2): delete the record without starting anything,
// then tell the other tabs, so a writer holding the signed-out person's snapshot in memory drops it
// now rather than at its next save (SEC-HOST2 S6).

import { removeSyncState, syncStateStore } from "./store.js";
import { broadcastChannel } from "./writer.js";

export async function purgeUnloaded(dbName: string): Promise<void> {
  try {
    await removeSyncState(syncStateStore(dbName));
  } finally {
    const c = broadcastChannel(dbName);
    c.post({ t: "purge" });
    c.close();
  }
}
