// The hook surface. Every hook reads the adapter's observable store via
// `useSyncExternalStore`, so a desktop and a browser session render IDENTICALLY shaped
// values — mode-parity is enforced here, not branched on. The headless `useLicenseGate`
// hook returns everything a custom gate UI needs without rendering anything.

import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { JSONValue, LicenseStatus } from "@polaris-key/protocol";
import {
  isUsable,
  type ConfigSource,
  type LicenseState,
  type PolarisAdapter,
  type PolarisState,
  type UserConfigEntry,
} from "../core/index.js";
import { PolarisContext, type PolarisContextValue } from "./context.js";
import type { PolarisTheme } from "../components/theme.js";

function useCtx(): PolarisContextValue {
  const ctx = useContext(PolarisContext);
  if (!ctx) {
    throw new Error("usePolarisKey must be used within <PolarisKeyProvider>.");
  }
  return ctx;
}

/** Subscribe to the adapter's full snapshot (re-renders on any state change). */
function useAdapterState(adapter: PolarisAdapter): PolarisState {
  return useSyncExternalStore(
    useCallback((cb) => adapter.subscribe(cb), [adapter]),
    () => adapter.snapshot(),
    () => adapter.snapshot(),
  );
}

/** The primary hook: the adapter, the live state, and bound action callbacks. */
export interface UsePolarisKey {
  /** The active transport. */
  mode: PolarisState["mode"];
  /** True until the first snapshot resolves. */
  loading: boolean;
  /** The full immutable snapshot. */
  state: PolarisState;
  /** The license gate. */
  gate: LicenseState;
  /** Convenience mirror of `gate.status`. */
  status: LicenseStatus;
  /** True when the gate permits running (ok or grace). */
  usable: boolean;
  /** An in-flight op is running. */
  busy: boolean;
  /** The last op error. */
  error: PolarisState["error"];
  refresh: () => Promise<void>;
  signInWithOidc: PolarisAdapter["signInWithOidc"];
  submitKey: (key: string) => Promise<void>;
  signOut: () => Promise<void>;
  getConfig: PolarisAdapter["getConfig"];
  /** Config for a settings UI: every key EXCEPT `hidden`, each `{ key, value, enforced }`. */
  listUserConfig: () => UserConfigEntry[];
  /** The provenance of a key's effective value. */
  getConfigSource: (key: string) => ConfigSource;
  getSecret: PolarisAdapter["getSecret"];
  isEntitled: (name: string) => boolean;
}

export function usePolarisKey(): UsePolarisKey {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return useMemo(
    () => ({
      mode: state.mode,
      loading: state.phase === "loading",
      state,
      gate: state.gate,
      status: state.status,
      usable: isUsable(state.status),
      busy: state.busy,
      error: state.error,
      refresh: () => adapter.refresh(),
      signInWithOidc: () => adapter.signInWithOidc(),
      submitKey: (key: string) => adapter.submitKey(key),
      signOut: () => adapter.signOut(),
      getConfig: (key, fallback) => adapter.getConfig(key, fallback),
      listUserConfig: () => adapter.listUserConfig(),
      getConfigSource: (key) => adapter.getConfigSource(key),
      getSecret: (key) => adapter.getSecret(key),
      isEntitled: (name) => adapter.isEntitled(name),
    }),
    [adapter, state],
  );
}

/** Just the license gate (status + grace/version metadata) and `usable`. */
export function useLicense(): {
  gate: LicenseState;
  status: LicenseStatus;
  usable: boolean;
  loading: boolean;
} {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return {
    gate: state.gate,
    status: state.status,
    usable: isUsable(state.status),
    loading: state.phase === "loading",
  };
}

/** The delivered managed config — the v2 EFFECTIVE map (per-key precedence:
 *  `enforced|hidden` > local override > remote-default > fallback) plus a typed getter, a
 *  user-facing enumeration (excludes `hidden`), and a per-key provenance source. */
export function useManagedConfig(): {
  /** The effective config map (key → resolved value). */
  config: Record<string, JSONValue>;
  /** Read one key's effective value with a typed fallback. */
  get: <T = JSONValue>(key: string, fallback: T) => T;
  /** Config rows for a settings UI: every key EXCEPT `hidden`, each `{ key, value, enforced }`. */
  listUserConfig: () => UserConfigEntry[];
  /** Where a key's effective value came from (its provenance). */
  getConfigSource: (key: string) => ConfigSource;
} {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return {
    config: state.config,
    get: (key, fallback) => adapter.getConfig(key, fallback),
    listUserConfig: () => adapter.listUserConfig(),
    getConfigSource: (key) => adapter.getConfigSource(key),
  };
}

/** A single boolean entitlement (capability) by name. */
export function useEntitlement(name: string): boolean {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  // Read off the snapshot so the value is reactive (not just the imperative accessor).
  return state.entitlements[name] === true;
}

/** The auth surface: profile + the sign-in/out/key actions + busy/error. */
export interface UsePolarisAuth {
  profile: PolarisState["profile"];
  status: LicenseStatus;
  busy: boolean;
  error: PolarisState["error"];
  /** True when the user must enroll/sign in. */
  needsAuth: boolean;
  signInWithOidc: PolarisAdapter["signInWithOidc"];
  /** Desktop only — throws `key-entry-unsupported` in browser mode. */
  submitKey: (key: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** True when typed-key entry is offered (desktop). */
  supportsKeyEntry: boolean;
}

export function usePolarisAuth(): UsePolarisAuth {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return useMemo(
    () => ({
      profile: state.profile,
      status: state.status,
      busy: state.busy,
      error: state.error,
      needsAuth: state.status === "needs-enroll" || state.status === "revoked",
      signInWithOidc: () => adapter.signInWithOidc(),
      submitKey: (key: string) => adapter.submitKey(key),
      signOut: () => adapter.signOut(),
      supportsKeyEntry: state.mode === "desktop",
    }),
    [adapter, state],
  );
}

/** Headless gate logic for a fully custom UI: which screen to render + the theme + actions.
 *  `screen` is the renderable bucket; `usable` short-circuits to children. */
export type GateScreen =
  | "loading"
  | "ok"
  | "grace"
  | "login"
  | "revoked"
  | "expired"
  | "version-block"
  | "error";

export interface UseLicenseGate {
  screen: GateScreen;
  state: PolarisState;
  gate: LicenseState;
  status: LicenseStatus;
  theme: PolarisTheme;
  usable: boolean;
  retry: () => Promise<void>;
}

function screenFor(state: PolarisState): GateScreen {
  if (state.phase === "loading") return "loading";
  if (state.error && state.status === "needs-enroll") return "error";
  switch (state.status) {
    case "ok":
      return "ok";
    case "grace":
      return "grace";
    case "needs-enroll":
      return "login";
    case "revoked":
      return "revoked";
    case "expired":
      return "expired";
    case "version-too-old":
    case "version-too-new":
    case "channel-not-entitled":
      return "version-block";
    default:
      return "error";
  }
}

export function useLicenseGate(): UseLicenseGate {
  const { adapter, theme } = useCtx();
  const state = useAdapterState(adapter);
  const screen = screenFor(state);
  return {
    screen,
    state,
    gate: state.gate,
    status: state.status,
    theme,
    usable: isUsable(state.status),
    retry: () => adapter.refresh(),
  };
}

/** Access the resolved brand theme (tokens + copy + logo). */
export function usePolarisTheme(): PolarisTheme {
  return useCtx().theme;
}
