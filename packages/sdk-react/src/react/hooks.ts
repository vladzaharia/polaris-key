// The hook surface. Every hook reads the adapter's observable store via
// `useSyncExternalStore`, so a desktop and a browser session render IDENTICALLY shaped
// values — mode-parity is enforced here, not branched on. The headless `useLicenseGate`
// hook returns everything a custom gate UI needs without rendering anything.
//
// The service hooks (`useLicense`, `useManagedConfig`, `usePolarisAuth`, `useLatestVersion`)
// are re-homed under the matching subpath entries (`@polaris-key/react/license`, `/config`,
// `/identity`, `/update`) and re-exported from here + the root barrel while callers migrate.

import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  LicenseStatus,
} from "@polaris-key/protocol/license";
import {
  anyBusy,
  firstError,
  isUsable,
  type ConfigSource,
  type DeviceInfo,
  type LicenseState,
  type PolarisAdapter,
  type PolarisError,
  type PolarisState,
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
  type UserConfigEntry,
  type VersionCheck,
  type ImportBundleResult,
} from "../core/index.js";
import { readEntitled, readEntitledChannels } from "../core/adapter.js";
import { Feature } from "../constants.generated.js";
import { PolarisContext, type PolarisContextValue } from "./context.js";
import type { PolarisTheme } from "../components/theme.js";

export function useCtx(): PolarisContextValue {
  const ctx = useContext(PolarisContext);
  if (!ctx) {
    throw new Error("usePolarisKey must be used within <PolarisKeyProvider>.");
  }
  return ctx;
}

/** Subscribe to the adapter's full snapshot (re-renders on any state change). */
export function useAdapterState(adapter: PolarisAdapter): PolarisState {
  return useSyncExternalStore(
    useCallback((cb) => adapter.subscribe(cb), [adapter]),
    () => adapter.snapshot(),
    () => adapter.snapshot(),
  );
}

/** The product's service capability map (D-21) plus the two convenience predicates a UI
 *  reaches for most. Discovery when it answered; the provider's `expectServices` when it did
 *  not; never all-true. */
export function useCapabilities(): ServicesMap & {
  has: (slug: keyof ServicesMap) => boolean;
} {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return useMemo(
    () => ({
      ...state.capabilities,
      has: (slug: keyof ServicesMap) => state.capabilities[slug].enabled,
    }),
    [state.capabilities],
  );
}

/** The primary hook: the adapter, the live state, and bound action callbacks.
 *
 *  @deprecated Prefer the per-service hooks — `useLicense` (`@polaris-key/react/license`),
 *  `useManagedConfig` (`/config`), `usePolarisAuth` (`/identity`), `useLatestVersion`
 *  (`/update`) — which re-render only on the slice they read and carry that service's own
 *  busy/error rather than an aggregate. This hook stays for the whole-client case. */
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
  /** True when the gate permits running (ok, grace, or not-applicable). */
  usable: boolean;
  /** How this install became activated, or `null`. */
  activation: ActivationSource | null;
  /** The product's service capability map. */
  capabilities: ServicesMap;
  /** True when ANY service has an op in flight (the aggregate of the per-service map). */
  busy: boolean;
  /** Per-service in-flight flags. */
  busyByService: ServiceBusyMap;
  /** The first error in canonical service order (the aggregate of the per-service map). */
  error: PolarisError | null;
  /** Per-service last error. */
  errorByService: ServiceErrorMap;
  refresh: () => Promise<void>;
  signInWithOidc: PolarisAdapter["signInWithOidc"];
  submitKey: (key: string) => Promise<void>;
  signOut: () => Promise<void>;
  currentDevice: () => DeviceInfo | null;
  listDevices: () => Promise<DeviceInfo[]>;
  renameDevice: (deviceId: string, label: string | null) => Promise<void>;
  deauthorizeDevice: (deviceId: string) => Promise<void>;
  checkUpdate: (opts?: { channel?: string }) => Promise<VersionCheck>;
  getConfig: PolarisAdapter["getConfig"];
  /** Config for a settings UI: every key EXCEPT `hidden`, each `{ key, value, enforced }`. */
  listUserConfig: () => UserConfigEntry[];
  /** The provenance of a key's effective value. */
  getConfigSource: (key: string) => ConfigSource;
  getSecret: PolarisAdapter["getSecret"];
  isEntitled: (name: string) => boolean;
  /** Whether a parity feature works through this adapter (PARITY §2.2). Pure; it reads the
   *  capability map in `state`, so a component re-renders when discovery changes the answer. */
  supports: PolarisAdapter["supports"];
  /** The feature ids `supports()` answers Supported for, in registry order. */
  caps: PolarisAdapter["caps"];
}

/** @deprecated See {@link UsePolarisKey} — prefer the per-service hooks. */
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
      activation: state.activation,
      capabilities: state.capabilities,
      busy: anyBusy(state.busy),
      busyByService: state.busy,
      error: firstError(state.error),
      errorByService: state.error,
      refresh: () => adapter.refresh(),
      signInWithOidc: () => adapter.signInWithOidc(),
      submitKey: (key: string) => adapter.submitKey(key),
      signOut: () => adapter.signOut(),
      currentDevice: () => adapter.currentDevice(),
      listDevices: () => adapter.listDevices(),
      renameDevice: (deviceId, label) => adapter.renameDevice(deviceId, label),
      deauthorizeDevice: (deviceId) => adapter.deauthorizeDevice(deviceId),
      checkUpdate: (opts) => adapter.checkUpdate(opts),
      getConfig: (key, fallback) => adapter.getConfig(key, fallback),
      listUserConfig: () => adapter.listUserConfig(),
      getConfigSource: (key) => adapter.getConfigSource(key),
      getSecret: (key) => adapter.getSecret(key),
      isEntitled: (name) => adapter.isEntitled(name),
      supports: (feature) => adapter.supports(feature),
      caps: () => adapter.caps(),
    }),
    [adapter, state],
  );
}

export interface UseLicense {
  gate: LicenseState;
  status: LicenseStatus;
  /** True when the gate permits running: `ok`, `grace`, or `not-applicable`. */
  usable: boolean;
  loading: boolean;
  /** False for a product that does not run the license service — its gate is
   *  `not-applicable` and a `<LicenseGate>` renders children straight through (D-08). */
  enabled: boolean;
  /** How this install became activated (`"token"`, `"bundle"`), or `null`. */
  activation: ActivationSource | null;
  /** §4.2's monotonic clock floor, epoch seconds. `0` before anything signed is seen. */
  highWaterMark: number;
  /** The channels the licence grants (the `channels` entitlement's strings, in order), or
   *  `["stable"]` when it grants none explicitly — the Worker's answer and every SDK's. */
  entitledChannels: string[];
  busy: boolean;
  error: PolarisError | null;
  refresh: () => Promise<void>;
}

/** Just the license gate (status + grace/version metadata) and `usable`. */
export function useLicense(): UseLicense {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return {
    gate: state.gate,
    status: state.status,
    usable: isUsable(state.status),
    loading: state.phase === "loading",
    enabled: state.capabilities.license.enabled,
    activation: state.activation,
    highWaterMark: state.highWaterMark,
    entitledChannels: readEntitledChannels(state),
    busy: state.busy.license,
    error: state.error.license,
    refresh: () => adapter.refresh(),
  };
}

export interface UseImportBundle {
  /** Verify and install an offline activation bundle (§7). Resolves to what landed, or
   *  `null` when it was refused — the refusal is in `error` (`bundle-rejected`, with the §7
   *  step as `wireCode`, or `bundle-import-unsupported`). Nothing is written on a refusal. */
  importBundle: (jws: string) => Promise<ImportBundleResult | null>;
  /** True while an import is in flight. */
  busy: boolean;
  /** The last import's refusal, cleared by the next success. */
  error: PolarisError | null;
  /** How this install is activated now — `"bundle"` after an import that carried a licence. */
  activation: ActivationSource | null;
}

/** Offline bundle import (§7): desktop through the host bridge (protocol v3), browser verified
 *  in-page and kept in IndexedDB. */
export function useImportBundle(): UseImportBundle {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const importBundle = useCallback(
    async (jws: string): Promise<ImportBundleResult | null> => {
      try {
        return await adapter.importBundle(jws);
      } catch {
        // The adapter recorded the refusal on the license slice; the hook reads it from there.
        return null;
      }
    },
    [adapter],
  );
  return {
    importBundle,
    busy: state.busy.license,
    error: state.error.license,
    activation: state.activation,
  };
}

export interface UseManagedConfig {
  /** The effective config map (key → resolved value). */
  config: Record<string, JSONValue>;
  /** Read one key's effective value with a typed fallback. */
  get: <T = JSONValue>(key: string, fallback: T) => T;
  /** Config rows for a settings UI: every key EXCEPT `hidden`, each `{ key, value, enforced }`. */
  listUserConfig: () => UserConfigEntry[];
  /** Where a key's effective value came from (its provenance). */
  getConfigSource: (key: string) => ConfigSource;
  /** False when the product does not run the config service. */
  enabled: boolean;
  loading: boolean;
  busy: boolean;
  error: PolarisError | null;
  /** `config.set`: persist a device-local override (`config.local`). Throws
   *  `managed_by_admin` for a locked key, `bad_request` for a value the catalog refuses. */
  set: (key: string, value: JSONValue) => Promise<void>;
  /** `config.clear`: drop one device-local override. */
  clear: (key: string) => Promise<void>;
  /** `config.clearAll`: drop every device-local override. */
  clearAll: () => Promise<void>;
  /** False when overrides live in memory only (no usable browser storage). */
  persistent: boolean;
  /** True when `set` can work here (`supports("config.local")`): false on a desktop host that
   *  predates bridge v4, or with the config service off. */
  canSet: boolean;
}

/** The delivered managed config — the EFFECTIVE map (per-key precedence: `enforced|hidden` >
 *  local override > remote-default > fallback) plus a typed getter, a user-facing enumeration
 *  (excludes `hidden`), and a per-key provenance source. */
export function useManagedConfig(): UseManagedConfig {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return {
    config: state.config,
    get: (key, fallback) => adapter.getConfig(key, fallback),
    listUserConfig: () => adapter.listUserConfig(),
    getConfigSource: (key) => adapter.getConfigSource(key),
    enabled: state.capabilities.config.enabled,
    loading: state.phase === "loading",
    busy: state.busy.config,
    error: state.error.config,
    set: (key, value) => adapter.config.set(key, value),
    clear: (key) => adapter.config.clear(key),
    clearAll: () => adapter.config.clearAll(),
    persistent: adapter.config.persistent(),
    canSet: adapter.supports(Feature.configLocal).supported,
  };
}

/** One config key as a reactive setting (`config.local`): the effective value, where it came
 *  from, whether the operator locked it, and `set`/`clear` for the device-local override. */
export interface UseConfigSetting<T> {
  key: string;
  value: T;
  source: ConfigSource;
  /** True when the operator locked the key (`enforced`/`hidden`): `set` refuses. */
  locked: boolean;
  /** True when a device-local override supplies the value. */
  overridden: boolean;
  set: (value: T) => Promise<void>;
  clear: () => Promise<void>;
}

/** Subscribe to one config key; re-renders whenever its resolved value, source or lock moves
 *  (a local `set`/`clear`, or a sync). */
export function useConfigSetting<T = JSONValue>(
  key: string,
): UseConfigSetting<T | undefined>;
export function useConfigSetting<T = JSONValue>(
  key: string,
  fallback: T,
): UseConfigSetting<T>;
export function useConfigSetting<T = JSONValue>(
  key: string,
  fallback?: T,
): UseConfigSetting<T | undefined> {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const setting = useMemo(
    () => adapter.config.setting<T | undefined>(key),
    [adapter, key],
  );
  const own = Object.prototype.hasOwnProperty.call(state.config, key);
  const source = adapter.getConfigSource(key);
  return {
    key,
    value: own ? (state.config[key] as unknown as T) : fallback,
    source,
    locked: setting.locked(),
    overridden: source === "local",
    set: setting.set,
    clear: setting.clear,
  };
}

/** A single boolean entitlement (capability) by name. Entitlements ride the LICENSE
 *  document (D-20), so a product without the license service grants none. */
export function useEntitlement(name: string): boolean {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  // Read off the snapshot so the value is reactive (not just the imperative accessor), and
  // false whenever the gate is not usable (S-19 G11).
  return readEntitled(state, name);
}

/** The auth surface: profile + the sign-in/out/key actions + busy/error. */
export interface UsePolarisAuth {
  profile: PolarisState["profile"];
  status: LicenseStatus;
  /** Identity-service busy (sign-in / sign-out), NOT a whole-client aggregate. */
  busy: boolean;
  /** The identity error, falling back to the license error so a rejected key still surfaces
   *  on the login card that submitted it. */
  error: PolarisError | null;
  /** True when the user must activate/sign in. */
  needsAuth: boolean;
  signInWithOidc: PolarisAdapter["signInWithOidc"];
  /** Activate with a license key using the active transport. */
  submitKey: (key: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** True when this product exposes generic OIDC sign-in. DERIVED from the identity service's
   *  discovery fragment — a product with no identity service has no login to offer. */
  supportsOidcLogin: boolean;
  /** True when typed-key entry is offered. DERIVED from the license service's fragment —
   *  a key activates a LICENSE, so a config-only product has nothing to type in. */
  supportsKeyEntry: boolean;
  /** License-service busy, for the key-entry half of a login card. */
  keyEntryBusy: boolean;
}

export function usePolarisAuth(): UsePolarisAuth {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  return useMemo(
    () => ({
      profile: state.profile,
      status: state.status,
      busy: state.busy.identity,
      error: state.error.identity ?? state.error.license,
      needsAuth:
        state.status === "needs-activation" || state.status === "revoked",
      signInWithOidc: () => adapter.signInWithOidc(),
      submitKey: (key: string) => adapter.submitKey(key),
      signOut: () => adapter.signOut(),
      supportsOidcLogin: state.capabilities.identity.enabled,
      supportsKeyEntry: state.capabilities.license.enabled,
      keyEntryBusy: state.busy.license,
    }),
    [adapter, state],
  );
}

/** Headless gate logic for a fully custom UI: which screen to render + the theme + actions.
 *  `screen` is the renderable bucket; `usable` short-circuits to children. */
export type GateScreen =
  | "loading"
  | "ok"
  | "not-applicable"
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
  /** The error the gate would describe: license first, then identity. */
  error: PolarisError | null;
  retry: () => Promise<void>;
}

export function screenFor(state: PolarisState): GateScreen {
  if (state.phase === "loading") return "loading";
  // A product that does not run the license service has no gate to show and must not be held
  // hostage by one (D-08): children render, no chrome. This precedes the error branch —
  // an unreachable licensing service is not an error for a product that has none.
  if (state.status === "not-applicable") return "not-applicable";
  if (
    (state.error.license ?? state.error.identity) &&
    state.status === "needs-activation"
  )
    return "error";
  switch (state.status) {
    case "ok":
      return "ok";
    case "grace":
      return "grace";
    case "needs-activation":
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
    error: state.error.license ?? state.error.identity,
    retry: () => adapter.refresh(),
  };
}

/** Access the resolved brand theme (tokens + copy + logo). */
export function usePolarisTheme(): PolarisTheme {
  return useCtx().theme;
}
