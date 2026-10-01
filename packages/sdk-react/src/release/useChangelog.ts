// `useChangelog` — the headless half of the Release service's UI (P1b-07).
//
// It reads `GET /<product>/release/changelog` through the active adapter (the browser
// transport's request, or the desktop bridge's `invoke("release", "changelog")`) and hands back
// the entries newest first. A hook, not a component, for the same reason `useLatestVersion` is
// one: a "What's new" modal, a settings page and an About box all render release notes
// differently.
//
// Fail-closed (D-21): a product that does not run the Release service is never asked. The hook
// reports `enabled: false` and an empty list rather than provoking a 404.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangelogEntry, PolarisError } from "../core/index.js";
import { useAdapterState, useCtx } from "../react/hooks.js";

export interface UseChangelogOptions {
  /** Load once on mount (default true). */
  immediate?: boolean;
}

export interface UseChangelog {
  /** The published releases, newest first. Empty until a load succeeds. */
  entries: ChangelogEntry[];
  /** True while a load is in flight. */
  busy: boolean;
  /** The last load's error (`release-refused` with the refusal's `wireCode`, `network`, …). */
  error: PolarisError | Error | null;
  /** False when the product does not run the Release service — nothing is requested. */
  enabled: boolean;
  /** Load now. Resolves to the entries, or null when disabled or refused. */
  reload: () => Promise<ChangelogEntry[] | null>;
}

export function useChangelog(opts: UseChangelogOptions = {}): UseChangelog {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const { immediate = true } = opts;
  const enabled = state.capabilities.release.enabled;

  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PolarisError | Error | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<ChangelogEntry[] | null> => {
    if (!enabled) return null;
    setBusy(true);
    try {
      const result = await adapter.changelog();
      if (!alive.current) return result;
      setEntries(result);
      setError(null);
      return result;
    } catch (e) {
      if (alive.current) setError(e as Error);
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [adapter, enabled]);

  useEffect(() => {
    if (enabled && immediate) void reload();
  }, [enabled, immediate, reload]);

  return { entries, busy, error, enabled, reload };
}
