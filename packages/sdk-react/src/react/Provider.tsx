// `<PolarisKeyProvider>` — constructs (and owns the lifecycle of) the right adapter for the
// requested mode and publishes it (plus the resolved theme) through context. `mode:"auto"`
// picks desktop when a bridge is present (explicit prop or `window.polarisKey`), else
// browser. The adapter is built once per {mode, productSlug, baseUrl, bridge} identity and
// disposed on unmount, so credential/session state is stable across renders.

import { useEffect, useMemo, type ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol";
import { browserAdapter } from "../browser/browserAdapter.js";
import { desktopAdapter } from "../desktop/desktopAdapter.js";
import { resolveBridge, type PolarisBridge } from "../desktop/bridge.js";
import type { PolarisAdapter, PolarisMode } from "../core/index.js";
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
  /** Client-supplied local/user overrides for `default`-state config keys. `enforced`/`hidden`
   *  keys are never overridable (server wins). Ignored when an `adapter` is injected. */
  localOverrides?: Record<string, JSONValue>;
  /** Inject a pre-built adapter (tests) — bypasses mode resolution entirely. */
  adapter?: PolarisAdapter;
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
    localOverrides,
    adapter: injected,
    fetchImpl,
    navigate,
    now,
    children,
  } = props;

  const theme = useMemo(() => mergeTheme(themeProp), [themeProp]);

  const adapter = useMemo<PolarisAdapter>(() => {
    if (injected) return injected;
    const resolved = resolveMode(mode, bridge);
    if (resolved === "desktop") {
      return desktopAdapter({ bridge, now, localOverrides });
    }
    return browserAdapter({
      productSlug,
      baseUrl,
      fetchImpl,
      navigate,
      now,
      localOverrides,
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
  ]);

  // Dispose the adapter when it (or the provider) goes away.
  useEffect(() => () => adapter.dispose(), [adapter]);

  const value = useMemo(() => ({ adapter, theme }), [adapter, theme]);
  const style = useMemo(
    () => themeVars(theme) as Record<string, string>,
    [theme],
  );

  return (
    <PolarisContext.Provider value={value}>
      <div data-polaris-key-root="" style={style}>
        {children}
      </div>
    </PolarisContext.Provider>
  );
}
