// `<PolarisKeyProvider>` — constructs (and owns the lifecycle of) the right adapter for the
// requested mode and publishes it (plus the resolved theme) through context. `mode:"auto"`
// picks desktop when a bridge is present (explicit prop or `window.polarisKey`), else
// browser. The adapter is built once per {mode, productSlug, baseUrl, bridge} identity and
// disposed on unmount, so credential/session state is stable across renders.

import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import {
  BrowserAdapter,
  type BrowserAdapterOptions,
} from "../browser/browserAdapter.js";
import type { TrustSet } from "../browser/offline.js";
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
  type PolarisBranding,
  type PolarisColorScheme,
  type PolarisResolvedScheme,
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
  /** Theme tokens/copy/logo, merged over the base theme of the chosen `branding`. */
  theme?: PartialTheme;
  /**
   * "neutral" (default): a host-friendly theme with no Polaris Key branding. "polaris-key":
   * the Polaris Key design system and marks. Shorthand for `theme.branding`, and wins over it.
   */
  branding?: PolarisBranding;
  /**
   * "system" (the default) follows `prefers-color-scheme`, dark when the OS states no
   * preference (BRAND.md §3: dark first); "dark" and "light" pin it. Persisting a user's
   * choice is the host's job: pass it back in here.
   */
  colorScheme?: PolarisColorScheme;
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
  /**
   * How a browser page authenticates (SDK-PARITY-PASS §3.17, owner decision Q1). "auto" (the
   * default) is bearer when the page is cross-origin to `baseUrl` or inside Tauri, cookie when
   * it is first-party. Ignored in desktop mode and when an `adapter` is injected.
   */
  auth?: "cookie" | "bearer" | "auto";
  /** The pinned trust keys (kid → raw Ed25519 public key, base64url). Bearer mode needs them:
   *  every document is verified in-page. Compared by value, so an inline literal is fine. */
  trust?: { pinnedKeys: TrustSet };
  /** Bearer mode's token/document store (defaults to IndexedDB). Pass a stable instance: a new
   *  one rebuilds the adapter. */
  store?: BrowserAdapterOptions["store"];
  /** Test seams forwarded to the constructed adapter. */
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  now?: () => number;
  children?: ReactNode;
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function lightQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(LIGHT_QUERY);
}

function subscribeScheme(onChange: () => void): () => void {
  const mql = lightQuery();
  if (!mql) return () => undefined;
  // Safari < 14 has only the deprecated listener API.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

const prefersLight = (): boolean => lightQuery()?.matches ?? false;
const serverPrefersLight = (): boolean => false;

/** The scheme `colorScheme` resolves to now, following the OS while it is "system". */
function useResolvedScheme(
  requested: PolarisColorScheme,
): PolarisResolvedScheme {
  const light = useSyncExternalStore(
    subscribeScheme,
    prefersLight,
    serverPrefersLight,
  );
  if (requested === "dark" || requested === "light") return requested;
  return light ? "light" : "dark";
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
    colorScheme = "system",
    branding,
    expectServices,
    localOverrides,
    adapter: injected,
    version,
    refreshIntervalSeconds,
    auth,
    trust,
    store,
    fetchImpl,
    navigate,
    now,
    children,
  } = props;

  const scheme = useResolvedScheme(colorScheme);
  const theme = useMemo(
    () => mergeTheme(branding ? { ...themeProp, branding } : themeProp, scheme),
    [themeProp, scheme, branding],
  );

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

  // Pinned keys by value, for the same reason: an inline `trust={{ pinnedKeys }}` literal must
  // not rebuild the adapter (and drop its session) on every render.
  const trustKey = trust ? JSON.stringify(trust.pinnedKeys) : "";
  const pinned = useMemo<{ pinnedKeys: TrustSet } | undefined>(
    () =>
      trustKey === ""
        ? undefined
        : { pinnedKeys: JSON.parse(trustKey) as TrustSet },
    [trustKey],
  );

  // Construction does no I/O: the browser adapter is built with `autoStart: false` and started
  // from the effect below, so a render (including a server render) never touches the network.
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
    return new BrowserAdapter({
      productSlug,
      baseUrl,
      fetchImpl,
      navigate,
      now,
      localOverrides,
      version,
      expectServices: expected,
      ...(auth ? { auth } : {}),
      ...(pinned ? { trust: pinned } : {}),
      ...(store ? { store } : {}),
      autoStart: false,
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
    auth,
    pinned,
    store,
  ]);

  // Begin the first load once mounted (SP-R13). `start()` is idempotent, so StrictMode's double
  // effect is harmless; an injected adapter that has no `start` is left alone.
  useEffect(() => {
    (adapter as { start?: () => void }).start?.();
  }, [adapter]);

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
  const rootStyle = useMemo<CSSProperties>(
    () => ({ ...(vars as CSSProperties), colorScheme: scheme }),
    [vars, scheme],
  );

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
      <div
        data-polaris-key-root=""
        data-theme={scheme}
        data-branding={theme.branding ?? "neutral"}
        style={rootStyle}
      >
        {children}
      </div>
    </PolarisContext.Provider>
  );
}
