// `useLatestVersion` — the headless half of the Update service's UI.
//
// It polls `GET /<product>/update/version` and reports the newest build on a channel plus
// whether the HOST APPLICATION is behind it. Two sources, in order:
//
//   1. a host-supplied `fetcher`, for an app whose updates do not come through the Polaris
//      transport at all (a Sparkle host reading its own appcast, an internal feed);
//   2. otherwise the active adapter's `checkUpdate()` — the browser transport's real HTTP
//      call, or the desktop bridge's `invoke("update", "check")`.
//
// It is a HOOK, not a component, because "is there an update?" is a question a menu bar, a
// settings row, and a modal all want to answer differently. `<UpdatePrompt>` is one answer.
//
// Fail-closed (D-21): a product that does not run the Update service never polls at all. The
// hook reports `enabled: false` and stays silent rather than hammering a 404.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PolarisError, VersionCheck } from "../core/index.js";
import { useAdapterState, useCtx } from "../react/hooks.js";

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
  // whose Polaris Update service is off.
  const enabled = Boolean(fetcher) || state.capabilities.update.enabled;

  const [latest, setLatest] = useState<VersionCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PolarisError | Error | null>(null);
  // The live handles, so an unmount mid-flight cannot set state on a dead component.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async (): Promise<VersionCheck | null> => {
    if (!enabled) return null;
    setBusy(true);
    try {
      const result = fetcher
        ? await fetcher({ channel })
        : await adapter.checkUpdate({ channel });
      if (!alive.current) return result;
      setLatest(result);
      setError(null);
      return result;
    } catch (e) {
      if (alive.current) setError(e as Error);
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [adapter, channel, enabled, fetcher]);

  useEffect(() => {
    if (!enabled) return;
    if (immediate) void check();
    if (!intervalSeconds || intervalSeconds <= 0) return;
    const id = setInterval(() => void check(), intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [check, enabled, immediate, intervalSeconds]);

  return {
    latest,
    updateAvailable: latest?.updateAvailable ?? false,
    busy,
    error,
    enabled,
    check,
  };
}
