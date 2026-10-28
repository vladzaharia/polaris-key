// Cloud Sync for settings as hooks (sync.settings, U-20.3): `useSetting(key)` is `useConfigSetting`
// plus how the setting relates to Cloud Sync, and `useCloudSync()` is the machine's status, a flush
// and the sign-in offer.
//
// Nothing here loads Cloud Sync: the adapter's lazy client does, on the first call that needs it,
// so a page that never syncs pays only for this file. Where Cloud Sync cannot run (a cookie page,
// the desktop bridge until v4, a product without Sync) `unsupported` says why and every setting
// stays `local`. No value ever passes through the status or the offer.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Unsupported } from "@polaris-key/client-core";
import type { JSONValue } from "@polaris-key/protocol/core";
import { UnsupportedError } from "../core/caps.js";
import { safeSignInUrl } from "../core/signInUrl.js";
import type { SyncStatus } from "../core/cloudSync.js";
import type { SettingSync } from "../core/localConfig.js";
import { useConfigSetting, useCtx, type UseConfigSetting } from "./hooks.js";

/** A setting with its Cloud Sync state. */
export interface UseSetting<T> extends UseConfigSetting<T> {
  /** `local` with Cloud Sync off, no person signed in or a `local` key; `pending` while an edit
   *  waits to be sent; `synced` otherwise. */
  sync: SettingSync;
}

/** One setting as a reactive value: `useConfigSetting` plus `sync`. Re-renders when the value or
 *  its sync state moves. */
export function useSetting<T = JSONValue>(
  key: string,
): UseSetting<T | undefined>;
export function useSetting<T = JSONValue>(
  key: string,
  fallback: T,
): UseSetting<T>;
export function useSetting<T = JSONValue>(
  key: string,
  fallback?: T,
): UseSetting<T | undefined> {
  const { adapter } = useCtx();
  const base = useConfigSetting<T | undefined>(key, fallback);
  const setting = useMemo(() => adapter.config.setting(key), [adapter, key]);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => adapter.cloudSync.onStatus(bump), [adapter]);
  return { ...base, sync: setting.sync() };
}

const LOCAL: SyncStatus = { state: "local", pending: 0 };

/** The sign-in offer: Cloud Sync lost the person (`account_required`, a sign-out, another
 *  person's sign-in). `signInUrl` is where the Worker says to go, or null for the app's own. */
export interface SignInOffer {
  signInUrl: string | null;
}

export interface UseCloudSync {
  /** The machine's status; `local` before Cloud Sync has started. */
  status: SyncStatus;
  /** Why Cloud Sync is unavailable here, or null when it runs. */
  unsupported: Unsupported | null;
  /** Set when Cloud Sync needs the person to sign in; cleared by `dismissOffer()` or a sign-in. */
  offer: SignInOffer | null;
  /** Send what is waiting now (bounded) and save the journal. Resolves to the status after. */
  flush: () => Promise<SyncStatus>;
  dismissOffer: () => void;
}

/** The status and a flush for Cloud Sync, following the machine. */
export function useCloudSync(): UseCloudSync {
  const { adapter } = useCtx();
  const client = adapter.cloudSync;
  const read = useCallback((): {
    status: SyncStatus;
    unsupported: Unsupported | null;
  } => {
    if (client.unsupported)
      return { status: LOCAL, unsupported: client.unsupported };
    try {
      return { status: client.status(), unsupported: null };
    } catch (e) {
      if (e instanceof UnsupportedError)
        return {
          status: LOCAL,
          unsupported: {
            supported: false,
            feature: e.feature,
            reason: e.reason,
            detail: e.detail,
          },
        };
      throw e;
    }
  }, [client]);
  const [view, setView] = useState(read);
  const [offer, setOffer] = useState<SignInOffer | null>(null);

  useEffect(() => {
    const next = () => setView(read());
    next();
    const offStatus = client.onStatus(next);
    const offEvents = client.onEvents((events) => {
      for (const e of events)
        if (e.type === "signInOffered")
          setOffer({
            signInUrl: safeSignInUrl(e.signInUrl, client.signInOrigin),
          });
      next();
    });
    return () => (offStatus(), offEvents());
  }, [client, read]);

  // A person who is back (anything but `local`) has accepted the offer.
  useEffect(() => {
    if (view.status.state !== "local" && view.status.state !== "blocked")
      setOffer(null);
  }, [view.status.state]);

  const flush = useCallback(async () => {
    const status = await client.flush();
    setView(read());
    return status;
  }, [client, read]);
  const dismissOffer = useCallback(() => setOffer(null), []);
  return { ...view, offer, flush, dismissOffer };
}
