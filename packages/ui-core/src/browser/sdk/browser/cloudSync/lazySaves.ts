// The stub that stands for `adapter.cloudSync.saves` until the first call (U-22.7): it forwards to
// the saves module, imported then, so a page that keeps no save carries none of the saves client,
// the file layer or client-core's transfer engine.

import type { BrowserSaves, SaveTransferEvent } from "../../core/cloudSync.js";
import type { BrowserSavesDeps, SavesApi } from "./saves.js";

export function lazySaves(
  deps: () => BrowserSavesDeps,
): BrowserSaves & { built(): boolean } {
  let loading: Promise<SavesApi> | null = null;
  let real: SavesApi | null = null;
  const listeners = new Set<(e: SaveTransferEvent | null) => void>();
  const ready = (): Promise<SavesApi> =>
    (loading ??= import("./saves.js").then(
      (m) => {
        const api = new m.SavesApi(deps());
        api.onTransfers((e) => {
          for (const l of [...listeners]) {
            try {
              l(e);
            } catch {
              // A listener's failure is its own.
            }
          }
        });
        return (real = api);
      },
      (err) => ((loading = null), Promise.reject(err)),
    ));
  return {
    built: () => real?.built ?? false,
    list: async () => (await ready()).list(),
    read: async (id, o) => (await ready()).read(id, o),
    write: async (id, b, m, o) => (await ready()).write(id, b, m, o),
    resolve: async (c, k, b, o) => (await ready()).resolve(c, k, b, o),
    delete: async (id, v) => (await ready()).delete(id, v),
    revisions: async (id) => (await ready()).revisions(id),
    transfers: () => real?.transfers() ?? [],
    conflicts: () => real?.conflicts() ?? [],
    dismissConflict: (id) => real?.dismissConflict(id),
    onTransfers: (l) => (listeners.add(l), () => listeners.delete(l)),
    async purge() {
      // A load in flight is waited for, so its layer is not built after the purge.
      const s = real ?? (await loading?.catch(() => null)) ?? null;
      await s?.purge();
    },
  };
}
