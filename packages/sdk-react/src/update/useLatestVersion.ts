// `useLatestVersion` — the headless half of the Update service's UI.
//
// It polls `GET /<product>/update/version` and reports the newest build on a channel plus
// whether the HOST APPLICATION is behind it. Two sources, in order:
//
//   1. a host-supplied `fetcher`, for an app whose updates do not come through the Polaris Key
//      transport at all (a Sparkle host reading its own appcast, an internal feed);
//   2. otherwise the active adapter's `checkUpdate()` — the browser transport's real HTTP
//      call, or the desktop bridge's `invoke("update", "check")`.
//
// It is a HOOK, not a component, because "is there an update?" is a question a menu bar, a
// settings row, and a modal all want to answer differently. `<UpdatePrompt>` is one answer.
//
// Fail-closed (D-21): a product that does not run the Update service never polls at all. The
// hook reports `enabled: false` and stays silent rather than hammering a 404.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { PolarisError, VersionCheck } from "../core/index.js";
import { useAdapterState, useCtx } from "../react/hooks.js";
import { sharedCheckFor } from "./sharedCheck.js";

export interface UseLatestVersionOptions {
  /** Release channel to ask about. Defaults to the product's default channel. */
  channel?: string;
  /**
   * Poll on this interval (seconds). OFF by default: a background network call every N
   * seconds is a decision the host makes, not one a hook makes on its behalf. A single check
   * still runs on mount unless `immediate` is false.
   */
  intervalSeconds?: number;
  /** Run one check on mount (default true). */
  immediate?: boolean;
  /** Bypass the adapter entirely and ask this instead. */
  fetcher?: (opts: { channel?: string }) => Promise<VersionCheck>;
}

export interface UseLatestVersion {
  /** The newest build, once a check has succeeded. */
  latest: VersionCheck | null;
  /** True when the newest build is ahead of the host application's version. */
  updateAvailable: boolean;
  /** True while a check is in flight. */
  busy: boolean;
  /** The last check's error, if any (cleared by the next success). */
  error: PolarisError | Error | null;
  /** False when the product does not run the Update service — nothing is polled. */
  enabled: boolean;
  /** Run a check now. Resolves to the result, or null when the service is disabled. */
  check: () => Promise<VersionCheck | null>;
}

export function useLatestVersion(
  opts: UseLatestVersionOptions = {},
): UseLatestVersion {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const { channel, intervalSeconds, immediate = true, fetcher } = opts;

  // A host `fetcher` is the host's own update source, so it is honoured even for a product
  // whose Polaris Key Update service is off.
  const enabled = Boolean(fetcher) || state.capabilities.update.enabled;

  // One check per source and channel, however many components ask (the gate's "Update required"
  // screen and an `<UpdatePrompt>` share it).
  const shared = sharedCheckFor(fetcher ?? adapter, channel);
  const { latest, error, busy } = useSyncExternalStore(
    shared.subscribe,
    shared.get,
    shared.get,
  );

  const ask = useCallback(
    (force: boolean, freshMs?: number): Promise<VersionCheck | null> =>
      enabled
        ? shared.run(
            () =>
              fetcher ? fetcher({ channel }) : adapter.checkUpdate({ channel }),
            { force, ...(freshMs !== undefined ? { freshMs } : {}) },
          )
        : Promise.resolve(null),
    [adapter, channel, enabled, fetcher, shared],
  );
  // An explicit check is a person asking again: it goes to the network.
  const check = useCallback(() => ask(true), [ask]);

  useEffect(() => {
    if (!enabled) return;
    if (immediate) void ask(false);
    if (!intervalSeconds || intervalSeconds <= 0) return;
    // A poll reuses an answer younger than half its period, so two components polling the same
    // source make one request per period between them.
    const id = setInterval(
      () => void ask(false, intervalSeconds * 500),
      intervalSeconds * 1000,
    );
    return () => clearInterval(id);
  }, [ask, enabled, immediate, intervalSeconds]);

  return {
    latest,
    updateAvailable: latest?.updateAvailable ?? false,
    busy,
    error: error as PolarisError | Error | null,
    enabled,
    check,
  };
}
