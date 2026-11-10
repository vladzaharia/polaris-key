// Cloud Sync saves as hooks (sync.saves, U-22.7): `useSaves()` is the saves of the signed-in person
// (list, read, write, resolve, delete, revisions) and `useTransfers()` the writes in flight, with
// pause, resume and cancel. Where Cloud Sync cannot run (a page without pinned keys, the desktop bridge until
// v4, a product without Sync) `unsupported` says why and every verb throws the typed unsupported.
//
// Nothing here loads the saves layer: the adapter's lazy client does, on the first verb, so a page
// that keeps no save pays only for this file. A save's bytes never pass through a hook's state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type {
  SaveSummary,
  SaveTransfer,
  TransferState,
} from "@polaris-key/client-core/sync";
import { UnsupportedError } from "../core/caps.js";
import type { BrowserSaves, SaveTransferEvent } from "../core/cloudSync.js";
import { useCtx } from "./hooks.js";

export type { SaveTransferEvent };

const unsupportedOf = (e: unknown): Unsupported | null =>
  e instanceof UnsupportedError
    ? {
        supported: false,
        feature: e.feature,
        reason: e.reason,
        detail: e.detail,
      }
    : null;

export interface UseSaves {
  /** The saves as `list()` last read them; null before the first read. */
  saves: SaveSummary[] | null;
  /** Why saves are unavailable here, or null when they run. Known after the first verb. */
  unsupported: Unsupported | null;
  /** The saves of this person (at most 16). Updates `saves`. */
  list: BrowserSaves["list"];
  read: BrowserSaves["read"];
  /** Resolves with the handle at once; follow it in `useTransfers()`. */
  write: BrowserSaves["write"];
  resolve: BrowserSaves["resolve"];
  delete: BrowserSaves["delete"];
  revisions: BrowserSaves["revisions"];
}

/** The saves of the signed-in person. */
export function useSaves(): UseSaves {
  const { adapter } = useCtx();
  const client = adapter.cloudSync;
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [unsupported, setUnsupported] = useState<Unsupported | null>(
    client.unsupported,
  );
  const live = useRef(true);
  // The person left (sign-out, another person): their list is not shown to the next one.
  useEffect(
    () =>
      client.onEvents((events) => {
        if (events.some((e) => e.type === "signedOut")) setSaves(null);
      }),
    [client],
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  return useMemo<UseSaves>(() => {
    const note = (e: unknown): never => {
      const u = unsupportedOf(e);
      if (u !== null && live.current) setUnsupported(u);
      throw e;
    };
    const via =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        try {
          return await fn(...a);
        } catch (e) {
          return note(e);
        }
      };
    const s = client.saves;
    const refresh = async (): Promise<SaveSummary[]> => {
      const rows = await s.list();
      if (live.current) setSaves(rows);
      return rows;
    };
    return {
      saves,
      unsupported,
      list: via(refresh),
      read: via((id, o) => s.read(id, o)),
      write: via(async (id, b, m, o) => {
        const t = await s.write(id, b, m, o);
        // A finished write changes the list: read it again when it settles.
        void t.done.then(() => refresh().catch(() => undefined));
        return t;
      }),
      resolve: via(async (c, k, b, o) => {
        const t = await s.resolve(c, k, b, o);
        void t.done.then(() => refresh().catch(() => undefined));
        return t;
      }),
      delete: via(async (id, v) => {
        const r = await s.delete(id, v);
        if (r.ok) await refresh().catch(() => undefined);
        return r;
      }),
      revisions: via((id) => s.revisions(id)),
    };
  }, [client, saves, unsupported]);
}

/** One write in flight, as a render value. */
export interface TransferView {
  id: string;
  state: TransferState;
  progress: { done: number; total: number };
}

export interface UseTransfers {
  /** The writes in flight (running, paused or waiting), oldest first. */
  transfers: TransferView[];
  pause: (id: string) => void;
  resume: (id: string) => void;
  /** Resolves when the transfer has settled as cancelled. */
  cancel: (id: string) => Promise<void>;
}

const viewOf = (t: SaveTransfer): TransferView => ({
  id: t.id,
  state: t.state,
  progress: { ...t.progress },
});

/** The save writes in flight, following their events. */
export function useTransfers(): UseTransfers {
  const { adapter } = useCtx();
  const saves = adapter.cloudSync.saves;
  const read = useCallback(
    (): TransferView[] => saves.transfers().map(viewOf),
    [saves],
  );
  const [transfers, setTransfers] = useState<TransferView[]>(read);
  useEffect(() => {
    setTransfers(read());
    return saves.onTransfers(() => setTransfers(read()));
  }, [saves, read]);
  return useMemo<UseTransfers>(() => {
    const find = (id: string): SaveTransfer | undefined =>
      saves.transfers().find((t) => t.id === id);
    return {
      transfers,
      pause: (id) => find(id)?.pause(),
      resume: (id) => find(id)?.resume(),
      cancel: async (id) => {
        await find(id)?.cancel();
      },
    };
  }, [saves, transfers]);
}
