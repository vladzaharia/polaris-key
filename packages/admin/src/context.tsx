import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Me } from "./api.js";

/**
 * App-wide context: the admin identity (`me`) and the currently-selected product slug.
 * Views read the catalog per-product via `useResource` rather than threading props.
 */
export interface AdminContextValue {
  me: Me;
  product: string;
  setProduct: (slug: string) => void;
}

const AdminCtx = createContext<AdminContextValue | null>(null);

export function AdminProvider({ value, children }: { value: AdminContextValue; children: React.ReactNode }): React.ReactElement {
  return <AdminCtx.Provider value={value}>{children}</AdminCtx.Provider>;
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminCtx);
  if (!ctx) throw new Error("useAdmin used outside AdminProvider");
  return ctx;
}

// ── status region (mutation feedback) ────────────────────────────────────────
interface StatusContextValue {
  message: string;
  tone: "message" | "ok" | "error";
  announce: (message: string, tone?: StatusContextValue["tone"]) => void;
}
const StatusCtx = createContext<StatusContextValue | null>(null);

export function StatusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<{ message: string; tone: StatusContextValue["tone"] }>({ message: "", tone: "message" });
  const announce = useCallback((message: string, tone: StatusContextValue["tone"] = "message") => setState({ message, tone }), []);
  const value = useMemo(() => ({ ...state, announce }), [state, announce]);
  return (
    <StatusCtx.Provider value={value}>
      {children}
      <div className={`app-status app-status-${state.tone}`} role="status" aria-live="polite">
        {state.message}
      </div>
    </StatusCtx.Provider>
  );
}

export function useStatus(): StatusContextValue {
  const ctx = useContext(StatusCtx);
  if (!ctx) return { message: "", tone: "message", announce: () => undefined };
  return ctx;
}

// ── a tiny per-key resource cache (load once, reload on demand) ───────────────
interface CacheEntry<T = unknown> {
  data: T | null;
  error: string | null;
  loading: boolean;
  loadedAt: number;
  subscribers: Set<() => void>;
  promise?: Promise<void>;
}
const CACHE = new Map<string, CacheEntry>();

function entryFor<T>(key: string): CacheEntry<T> {
  let e = CACHE.get(key) as CacheEntry<T> | undefined;
  if (!e) {
    e = { data: null, error: null, loading: false, loadedAt: 0, subscribers: new Set() };
    CACHE.set(key, e);
  }
  return e;
}

function notify(e: CacheEntry): void {
  for (const s of e.subscribers) s();
}

function load<T>(e: CacheEntry<T>, fetcher: () => Promise<T>, force: boolean): void {
  if (e.promise && !force) return;
  e.loading = true;
  e.error = null;
  notify(e);
  e.promise = fetcher()
    .then((data) => {
      e.data = data;
      e.loadedAt = Date.now();
      e.error = null;
    })
    .catch((err: unknown) => {
      e.error = err instanceof Error ? err.message : "Request failed.";
    })
    .finally(() => {
      e.loading = false;
      e.promise = undefined;
      // Stamp the settle time on BOTH success and error so the auto-load effect
      // (guarded on `loadedAt === 0`) doesn't re-fire forever on an errored entry —
      // an infinite render loop. `reload()`/`invalidate()` still force a refetch
      // (reload bypasses the guard; invalidate resets `loadedAt` to 0).
      if (e.loadedAt === 0) e.loadedAt = Date.now();
      notify(e);
    });
}

/** Invalidate (and refetch on next render) every cache key that starts with `prefix`. */
export function invalidate(prefix: string): void {
  for (const [key, e] of CACHE.entries()) {
    if (key.startsWith(prefix)) {
      e.loadedAt = 0;
      notify(e);
    }
  }
}

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useResource<T>(key: string, fetcher: () => Promise<T>): ResourceState<T> {
  const [, force] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const e = entryFor<T>(key);

  const reload = useCallback(() => load(e, () => fetcherRef.current(), true), [e]);

  useEffect(() => {
    const refresh = () => force((n) => n + 1);
    e.subscribers.add(refresh);
    return () => {
      e.subscribers.delete(refresh);
    };
  }, [e]);

  useEffect(() => {
    // `loadedAt === 0` is the single "no settled attempt yet" signal (stamped on both
    // success and error in `load`). Guarding on `!e.data` instead would re-fire forever
    // on an errored entry (data stays null) — an infinite render loop.
    if (e.loadedAt === 0) load(e, () => fetcherRef.current(), false);
  });

  return { data: e.data, loading: e.loading, error: e.error, reload };
}

/** Reset the module cache — used by tests to isolate renders. */
export function resetCache(): void {
  CACHE.clear();
}
