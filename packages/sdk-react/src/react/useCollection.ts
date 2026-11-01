// A Cloud Sync collection as a hook (sync.records, U-46): `useCollection(name)` loads the handle
// `adapter.cloudSync.collection(name)` returns and re-renders on its change events (this device's
// edits, a pull, a merge), so `ids` and `get(id)` always read what the person holds. The verbs
// (`put`, `update`, `add`, `remove`, `delete`, `on`) are the handle's; each returns its refusal
// (`collection_unknown`, `op_invalid_for_policy`, `value_invalid`, `signed_out`) and sends
// nothing then. Where Cloud Sync cannot run `unsupported` says why and `handle` stays null.

import { useEffect, useMemo, useReducer, useState } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type { SyncCollection } from "@polaris-key/client-core/sync";
import type { EffectiveValue } from "@polaris-key/client-core/cloud-sync";
import { UnsupportedError } from "../core/caps.js";
import { Feature } from "../constants.generated.js";
import { useCtx } from "./hooks.js";

export interface UseCollection {
  /** The collection's verbs; null until the host has loaded, or where Cloud Sync cannot run. */
  handle: SyncCollection | null;
  /** The ids the person holds, in byte order; empty before the handle loads. */
  ids: string[];
  /** The effective value of a record (pending edits over the cloud copy), or null. */
  get(id: string): EffectiveValue | null;
  /** Why the collection is unavailable here, or null when it runs. */
  unsupported: Unsupported | null;
}

/** The collection `name` the product's catalog declares. */
export function useCollection(name: string): UseCollection {
  const { adapter } = useCtx();
  const client = adapter.cloudSync;
  const [handle, setHandle] = useState<SyncCollection | null>(null);
  const [unsupported, setUnsupported] = useState<Unsupported | null>(
    client.unsupported
      ? { ...client.unsupported, feature: Feature.syncRecords }
      : null,
  );
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let live = true;
    setHandle(null);
    client.collection(name).then(
      (h) => {
        if (live) setHandle(h);
      },
      (e: unknown) => {
        if (live && e instanceof UnsupportedError)
          setUnsupported({
            supported: false,
            feature: e.feature,
            reason: e.reason,
            detail: e.detail,
          });
      },
    );
    return () => {
      live = false;
    };
  }, [client, name]);

  useEffect(() => (handle ? handle.on(() => bump()) : undefined), [handle]);
  // The person left: what they held is not shown to the next one.
  useEffect(
    () =>
      client.onEvents((events) => {
        if (events.some((e) => e.type === "signedOut")) bump();
      }),
    [client],
  );

  return useMemo<UseCollection>(
    () => ({
      handle,
      ids: handle ? handle.ids() : [],
      get: (id) => (handle ? handle.get(id) : null),
      unsupported,
    }),
    // `tick` is the change signal: the handle reads the machine at each call.
    [handle, unsupported, tick],
  );
}
