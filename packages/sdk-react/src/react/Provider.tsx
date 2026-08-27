// `<PolarisKeyProvider>` — constructs (and owns the lifecycle of) the right adapter for the
// requested mode and publishes it (plus the resolved theme) through context. `mode:"auto"`
// picks desktop when a bridge is present (explicit prop or `window.polarisKey`), else
// browser. The adapter is built once per {mode, productSlug, baseUrl, bridge} identity and
// disposed on unmount, so credential/session state is stable across renders.

import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import { browserAdapter } from "../browser/browserAdapter.js";
import { desktopAdapter } from "../desktop/desktopAdapter.js";
import { resolveBridge, type PolarisBridge } from "../desktop/bridge.js";
import type { PolarisAdapter, PolarisMode } from "../core/index.js";
import {
  defaultServices,
  servicesFromList,
  type ServiceSlug,
  type ServicesMap,
} from "../core/services.js";
import {
  mergeTheme,
  themeVars,
  type PartialTheme,
} from "../components/theme.js";
import { PolarisContext } from "./context.js";

export interface PolarisKeyProviderProps {
  /** The product slug — path-scopes every request. */
  productSlug: string;
  /** The control-plane origin (browser mode). Defaults to `https://key.plrs.im`. */
  baseUrl?: string;
  /** Which transport to use. `auto` (default) = desktop if a bridge exists, else browser. */
  mode?: "browser" | "desktop" | "auto";
  /** An explicit desktop bridge (otherwise `window.polarisKey`). */
  bridge?: PolarisBridge;
  /** Brand theme tokens/copy/logo. */
  theme?: PartialTheme;
  /**
   * The services this app EXPECTS the product to run, used only until discovery (browser) or
   * the bridge (desktop) reports the real map. D-21's fail-closed fallback: on a discovery
   * failure the client believes THIS, not "everything is on". Defaults to `["license",
   * "config"]` — what every product ran before the suite existed.
   */
  expectServices?: readonly ServiceSlug[];
  /** Client-supplied local/user overrides for `default`-state config keys. `enforced`/`hidden`
   *  keys are never overridable (server wins). Ignored when an `adapter` is injected. */
  localOverrides?: Record<string, JSONValue>;
  /** Inject a pre-built adapter (tests) — bypasses mode resolution entirely. */
  adapter?: PolarisAdapter;
  /** The host app's version, reported so a browser device row carries app-version metadata,
   *  and used as the basis for `updateAvailable`. Ignored when an `adapter` is injected. */
  version?: string;
  /** Poll for managed-config changes on this interval (seconds). OFF by default — enabling it
   *  would silently add network traffic to every already-shipped integration. Set it to make a
   *  remote tier change land without a reload. */
  refreshIntervalSeconds?: number;
  /** Test seams forwarded to the constructed adapter. */
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  now?: () => number;
  children?: ReactNode;
}

/** Resolve the concrete mode from the requested mode + bridge availability. */
function resolveMode(
  requested: "browser" | "desktop" | "auto",
  bridge?: PolarisBridge,
): PolarisMode {
  if (requested === "browser" || requested === "desktop") return requested;
  return resolveBridge(bridge) ? "desktop" : "browser";
}

export function PolarisKeyProvider(
  props: PolarisKeyProviderProps,
): JSX.Element {
  const {
    productSlug,
    baseUrl,
    mode = "auto",
    bridge,
    theme: themeProp,
    expectServices,
    localOverrides,
    adapter: injected,
    version,
    refreshIntervalSeconds,
    fetchImpl,
    navigate,
    now,
    children,
  } = props;

  const theme = useMemo(() => mergeTheme(themeProp), [themeProp]);

  // Serialize the expectation list so a caller passing an inline array literal does not
  // rebuild (and re-authenticate) the adapter on every render.
  const expectKey = expectServices ? expectServices.join(",") : "";
  const expected = useMemo<ServicesMap>(
    () =>
      expectKey === ""
        ? defaultServices()
        : servicesFromList(expectKey.split(",") as ServiceSlug[]),
    [expectKey],
  );

  const adapter = useMemo<PolarisAdapter>(() => {
    if (injected) return injected;
    const resolved = resolveMode(mode, bridge);
    if (resolved === "desktop") {
      return desktopAdapter({
        bridge,
        now,
        localOverrides,
        expectServices: expected,
      });
    }
    return browserAdapter({
      productSlug,
      baseUrl,
      fetchImpl,
      navigate,
      now,
      localOverrides,
      version,
      expectServices: expected,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    injected,
    mode,
    bridge,
    productSlug,
    baseUrl,
    fetchImpl,
    navigate,
    now,
    localOverrides,
    version,
    expected,
  ]);

  // Dispose the adapter when it (or the provider) goes away.
  useEffect(() => () => adapter.dispose(), [adapter]);

  // Optional refresh loop. The adapter's own store already notifies subscribers when state
  // changes, so there's no separate onChange here — a tier change simply re-renders whatever
  // reads `useEntitlement`/`useManagedConfig`.
  useEffect(() => {
    if (!refreshIntervalSeconds || refreshIntervalSeconds <= 0) return;
    const id = setInterval(() => {
      void adapter.refresh().catch(() => undefined);
    }, refreshIntervalSeconds * 1000);
    return () => clearInterval(id);
  }, [adapter, refreshIntervalSeconds]);

  const value = useMemo(() => ({ adapter, theme }), [adapter, theme]);
  const vars = useMemo(() => themeVars(theme), [theme]);

  /**
   * The tokens are published TWICE, on purpose.
   *
   * The wrapper `<div>` is the scoping copy: it keeps the variables local so two providers (a
   * host app and an embedded panel) can carry different brands without one leaking into the
   * other. But anything React PORTALS — a dialog, a toast, the update prompt — mounts outside
   * that div, inherits from `<html>` instead, and renders unthemed. So the same tokens also go
   * on `:root`, where a portal can reach them. Only the keys this provider set are removed on
   * unmount, so an app that also sets `--pk-*` in its own stylesheet is left alone.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [vars]);

  return (
    <PolarisContext.Provider value={value}>
      <div data-polaris-key-root="" style={vars as CSSProperties}>
        {children}
      </div>
    </PolarisContext.Provider>
  );
}
