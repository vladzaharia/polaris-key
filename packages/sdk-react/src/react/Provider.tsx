// `<PolarisKeyProvider>` constructs and owns the lifecycle of the adapter described by its
// canonical `config` object. `mode:"auto"` picks desktop when a bridge is present (explicit
// config or `window.polarisKey`), else browser. The adapter is built once per transport identity
// and disposed on unmount, so credential/session state is stable across renders. Presentation
// belongs to the scoped kit theme, never this transport provider.

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import {
  BrowserAdapter,
  type BrowserAdapterOptions,
} from "../browser/browserAdapter.js";
import type { TrustSet } from "../browser/offline.js";
import { desktopAdapter } from "../desktop/desktopAdapter.js";
import { resolveBridge, type PolarisBridge } from "../desktop/bridge.js";
import {
  PolarisError,
  type PolarisAdapter,
  type PolarisMode,
} from "../core/index.js";
import { SERVICE_SLUGS, type ServiceSlug } from "../core/services.js";
import { normalizeBackendOrigin } from "../core/backend.js";
import { PolarisContext } from "./context.js";

/** Disposals waiting out a possible immediate re-run of the Provider's effect. */
const pendingDisposals = new WeakMap<
  PolarisAdapter,
  ReturnType<typeof setTimeout>
>();

/**
 * The provider's transport configuration. Presentation belongs to the kit: wrap a kit screen
 * in `<PolarisKeyTheme theme={...}>`, rather than passing theme fields through the provider.
 */
export interface PolarisKeyConfig {
  /** The product slug — path-scopes every request. */
  productSlug: string;
  /** The control-plane origin (browser mode). Defaults to `https://key.plrs.im`. */
  baseUrl?: string;
  /** Which transport to use. `auto` (default) = desktop if a bridge exists, else browser. */
  mode?: "browser" | "desktop" | "auto";
  /** An explicit desktop bridge (otherwise `window.polarisKey`). */
  bridge?: PolarisBridge;
  /**
   * The services this app expects until discovery (browser) or the bridge (desktop) reports the
   * real map. Defaults to the generated default services. Unknown names are refused.
   */
  expectedServices?: readonly ServiceSlug[];
  /** Client-supplied local/user overrides for `default`-state config keys. */
  localOverrides?: Record<string, JSONValue>;
  /** Inject a pre-built adapter (tests) — bypasses mode resolution entirely. */
  adapter?: PolarisAdapter;
  /** The host app's version, reported with browser device metadata and used for updates. */
  version?: string;
  /** Poll for managed-config changes on this interval (seconds). Off by default. */
  refreshIntervalSeconds?: number;
  /** Browser-page authentication strategy; ignored in desktop mode and with an injected adapter. */
  auth?: "cookie" | "bearer" | "auto";
  /** Pinned trust keys for bearer mode. */
  trust?: { pinnedKeys: TrustSet };
  /** Bearer mode's token/document store. */
  store?: BrowserAdapterOptions["store"];
  /** `usePolarisFetch()`: the origins besides the page's own that may receive the licence
   *  document. Exact, HTTPS only except loopback; a bad one throws `invalid-options`. */
  backend?: { origins?: readonly string[] };
  /** Test seams forwarded to the constructed adapter. */
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  now?: () => number;
}

export interface PolarisKeyProviderProps {
  /** The one transport configuration object. */
  config: PolarisKeyConfig;
  /** `false` turns off automatic sign-in: the gate then shows its normal sign-in, as before. On
   *  by default; it runs once at boot, and only where the page can sign in with a platform
   *  account. */
  autoSignIn?: boolean;
  children?: ReactNode;
}

function checkedServices(
  expectedServices: readonly unknown[] | undefined,
): readonly ServiceSlug[] | undefined {
  if (!expectedServices) return undefined;
  for (const service of expectedServices) {
    if (
      typeof service !== "string" ||
      !SERVICE_SLUGS.includes(service as ServiceSlug)
    ) {
      throw new PolarisError(
        "invalid-options",
        `expectedServices contains an unknown service: ${String(service)}`,
      );
    }
  }
  return expectedServices as readonly ServiceSlug[];
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
): React.JSX.Element {
  const { config, children } = props;
  if ("expectServices" in props) {
    throw new PolarisError(
      "invalid-options",
      "expectServices was removed; use config.expectedServices",
    );
  }
  if (!config)
    throw new PolarisError(
      "invalid-options",
      "PolarisKeyProvider requires a config object",
    );
  const {
    productSlug,
    baseUrl,
    mode = "auto",
    bridge,
    expectedServices,
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
    backend,
  } = config;

  // Serialize the expectation list so an inline array literal does not rebuild the adapter.
  const expectedKey = JSON.stringify(expectedServices ?? null);
  const expected = useMemo<readonly ServiceSlug[] | undefined>(
    () =>
      checkedServices(
        JSON.parse(expectedKey) as readonly unknown[] | undefined,
      ),
    [expectedKey],
  );

  // Pinned keys by value, for the same reason: an inline `config={{ trust: { pinnedKeys } }}` literal
  // must not rebuild the adapter (and drop its session) on every render.
  const trustKey = trust ? JSON.stringify(trust.pinnedKeys) : "";
  const pinned = useMemo<{ pinnedKeys: TrustSet } | undefined>(
    () =>
      trustKey === ""
        ? undefined
        : { pinnedKeys: JSON.parse(trustKey) as TrustSet },
    [trustKey],
  );

  // Inline literals must not rebuild the adapter either: a rebuilt adapter is a new load (a new
  // discovery fetch, a dropped session). The local overrides compare by value; the test seams
  // (`fetchImpl`, `navigate`, `now`) are called through a ref, so a new closure each render is
  // the same adapter calling the latest one.
  const overridesKey = localOverrides ? JSON.stringify(localOverrides) : "";
  const overrides = useMemo<Record<string, JSONValue> | undefined>(
    () =>
      overridesKey === ""
        ? undefined
        : (JSON.parse(overridesKey) as Record<string, JSONValue>),
    [overridesKey],
  );
  const seams = useRef({ fetchImpl, navigate, now });
  seams.current = { fetchImpl, navigate, now };
  const stableFetch = useMemo<typeof fetch | undefined>(
    () =>
      fetchImpl
        ? (...args) => (seams.current.fetchImpl ?? fetch)(...args)
        : undefined,
    // Present or absent; which closure it is does not matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchImpl === undefined],
  );
  const stableNavigate = useMemo<((url: string) => void) | undefined>(
    () => (navigate ? (url) => seams.current.navigate?.(url) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate === undefined],
  );
  const stableNow = useMemo<(() => number) | undefined>(
    () => (now ? () => (seams.current.now ?? now)() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now === undefined],
  );

  // Construction does no I/O: the browser adapter is built with `autoStart: false` and started
  // from the effect below, so a render (including a server render) never touches the network.
  const adapter = useMemo<PolarisAdapter>(() => {
    if (injected) return injected;
    const resolved = resolveMode(mode, bridge);
    if (resolved === "desktop") {
      return desktopAdapter({
        bridge,
        now: stableNow,
        localOverrides: overrides,
        ...(expected ? { expectedServices: expected } : {}),
      });
    }
    return new BrowserAdapter({
      productSlug,
      baseUrl,
      fetchImpl: stableFetch,
      navigate: stableNavigate,
      now: stableNow,
      localOverrides: overrides,
      version,
      ...(expected ? { expectedServices: expected } : {}),
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
    stableFetch,
    stableNavigate,
    stableNow,
    overrides,
    version,
    expected,
    auth,
    pinned,
    store,
  ]);

  // Begin the first load once mounted (SP-R13) and own the adapter's lifetime. `start()` is
  // idempotent and an injected adapter that has no `start` is left alone.
  //
  // StrictMode (and a Suspense or Offscreen re-show) runs an effect, its cleanup and the effect
  // again on the SAME adapter. Disposing in that cleanup would leave a dead adapter (its store
  // subscription and every `onConfigChange` listener gone) for the rest of the page's life, so
  // the disposal is scheduled, and the effect running again cancels it. A real unmount, or a new
  // adapter replacing this one, finds no second run and disposes.
  useEffect(() => {
    const pending = pendingDisposals.get(adapter);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingDisposals.delete(adapter);
    }
    (adapter as { start?: () => void }).start?.();
    return () => {
      pendingDisposals.set(
        adapter,
        setTimeout(() => {
          pendingDisposals.delete(adapter);
          adapter.dispose();
        }, 0),
      );
    };
  }, [adapter]);

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

  const originsKey = JSON.stringify(backend?.origins ?? []);
  const value = useMemo(() => {
    const origins = (JSON.parse(originsKey) as string[]).map(
      normalizeBackendOrigin,
    );
    return {
      adapter,
      ...(origins.length > 0 ? { backend: { origins } } : {}),
      ...(version !== undefined ? { version } : {}),
      productSlug,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(props.autoSignIn === false ? { autoSignIn: false as const } : {}),
    };
  }, [adapter, originsKey, version, productSlug, baseUrl, props.autoSignIn]);
  return (
    <PolarisContext.Provider value={value}>{children}</PolarisContext.Provider>
  );
}
