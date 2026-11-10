// Cloud Sync conflicts as a hook (sync.conflict, U-08.4): `useConflicts()` is the MergeRequests open
// now, re-rendered as they open, change and close, and `keep(request, choice)` settles one. Only
// the `revision` policy asks: the device keeps its copy unsent until the person or the app answers.
//
// Mounting the hook is a listener, so the developer notice for an unheard request stays quiet. Where
// Cloud Sync cannot run `unsupported` says why and the list stays empty. No value passes through a
// hook's state beyond what the request itself holds.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type { MergeKeepArg, MergeOutcome } from "@polaris-key/client-core/sync";
import type { MergeRequest } from "../core/cloudSync.js";
import { useCtx } from "./hooks.js";
import { unsupportedOf } from "./unsupportedOf.js";

export interface UseConflicts {
  /** The requests open now, in id order. A request is live: `state`, `error` and `remote` follow. */
  conflicts: MergeRequest[];
  /** Settle a request: `"local"`, `"remote"`, `"both"` (a save, while a slot is free) or
   *  `{ value }` (a record). Never throws; a refusal is `{ ok: false, code, reopened }`. */
  keep: (request: MergeRequest, choice: MergeKeepArg) => Promise<MergeOutcome>;
  /** Why Cloud Sync is unavailable here, or null when it runs. */
  unsupported: Unsupported | null;
}

/** The MergeRequests open now, following the adapter's events. */
export function useConflicts(): UseConflicts {
  const { adapter } = useCtx();
  const client = adapter.cloudSync;
  const read = useCallback((): {
    conflicts: MergeRequest[];
    unsupported: Unsupported | null;
  } => {
    if (client.unsupported)
      return { conflicts: [], unsupported: client.unsupported };
    try {
      return { conflicts: client.conflicts(), unsupported: null };
    } catch (e) {
      return { conflicts: [], unsupported: unsupportedOf(e) };
    }
  }, [client]);
  const [view, setView] = useState(read);

  useEffect(() => {
    const next = () => setView(read());
    next();
    // A listener of its own: the request is announced to the app, so no notice is due.
    const offListen = client.unsupported
      ? () => undefined
      : client.onConflict(() => undefined);
    const offEvents = client.onEvents(next);
    const offStatus = client.onStatus(next);
    const offSaves = client.saves.onTransfers(next);
    return () => (offListen(), offEvents(), offStatus(), offSaves());
  }, [client, read]);

  const keep = useCallback(
    async (request: MergeRequest, choice: MergeKeepArg) => {
      try {
        return await request.keep(choice);
      } finally {
        setView(read());
      }
    },
    [read],
  );
  return useMemo(() => ({ ...view, keep }), [view, keep]);
}
