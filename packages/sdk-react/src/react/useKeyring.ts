// The Cloud Sync lock hooks the kit builds its screens on (sync.keyring, U-38.2; the screens are
// U-42's). `useSyncLock()` reads the ring once on mount and follows it; `useRecoveryCode()` is the
// one action that unlocks a new browser (plan-cloud-sync Q8).
//
// Nothing here keeps a recovery code in state: `unlock(code)` takes the text the person typed and
// hands it to the engine, and `create`/`reset` return the code once, to show.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type { PolarisError } from "../core/index.js";
import { PolarisError as PolarisErrorClass } from "../core/types.js";
import type { RingCode, RingStatus } from "../core/keyring.js";
import { useCtx } from "./hooks.js";

export type SyncLockState =
  /** Reading the ring. */
  | "loading"
  /** This transport has no key ring (a cookie page, the desktop bridge): see `unsupported`. */
  | "unsupported"
  /** The product has no ring yet. */
  | "none"
  /** A ring exists and this device holds no root: it needs the recovery code. */
  | "locked"
  | "unlocked"
  /** The served ring is not the one this browser pinned: unlock with the recovery code, or
   *  `accept()` once the person confirmed. See `status.changed`. */
  | "ring-changed"
  /** The ring could not be read; see `error`. */
  | "failed";

export interface UseSyncLock {
  state: SyncLockState;
  status: RingStatus | null;
  unsupported: Unsupported | null;
  error: PolarisError | null;
  /** Reads the ring again. */
  refresh: () => Promise<void>;
}

const asError = (e: unknown): PolarisError =>
  e instanceof PolarisErrorClass
    ? e
    : new PolarisErrorClass("network", (e as Error)?.message ?? "failed");

/** The ring's lock state, following the engine's changes. */
export function useSyncLock(): UseSyncLock {
  const { adapter } = useCtx();
  const ring = adapter.keyring;
  const [status, setStatus] = useState<RingStatus | null>(null);
  const [error, setError] = useState<PolarisError | null>(null);
  const [loading, setLoading] = useState(ring.unsupported === null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (ring.unsupported) return;
    try {
      const s = await ring.status();
      if (!alive.current) return;
      setStatus(s);
      setError(null);
    } catch (e) {
      if (alive.current) setError(asError(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [ring]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = ring.subscribe(() => void refresh());
    return () => {
      alive.current = false;
      off();
    };
  }, [ring, refresh]);

  const state: SyncLockState = ring.unsupported
    ? "unsupported"
    : loading
      ? "loading"
      : error
        ? "failed"
        : (status?.state ?? "failed");
  return { state, status, unsupported: ring.unsupported, error, refresh };
}

export interface UseRecoveryCode {
  /** An action is in flight. */
  busy: boolean;
  /** The last failure, or null. `recovery-code-invalid` is a wrong or mistyped code. */
  error: PolarisError | null;
  /** Unlocks with the code the person typed. True when the root is now held. */
  unlock: (code: string) => Promise<boolean>;
  /** Makes the first ring; resolves to its recovery code, to show once. */
  create: () => Promise<RingCode | null>;
  /** Replaces the code; resolves to the new one, to show once. */
  replace: () => Promise<RingCode | null>;
  /** "Start over": a new ring and a new code. */
  reset: () => Promise<RingCode | null>;
  /** After `ring-changed`, once the person confirmed in UI: pin the served ring. True when the
   *  root is now held. */
  accept: () => Promise<boolean>;
}

/** The recovery-code actions over the adapter's key ring. */
export function useRecoveryCode(): UseRecoveryCode {
  const { adapter } = useCtx();
  const ring = adapter.keyring;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PolarisError | null>(null);

  const run = useCallback(async <T>(f: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(asError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    busy,
    error,
    unlock: async (code) => {
      const s = await run(() => ring.recover(code));
      return s?.state === "unlocked";
    },
    create: () => run(() => ring.create()),
    replace: () => run(() => ring.setRecoveryCode()),
    reset: () => run(() => ring.reset()),
    accept: async () => {
      const s = await run(() => ring.acceptRingChange());
      return s?.state === "unlocked";
    },
  };
}
