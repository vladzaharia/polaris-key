// `<PolarisKeyProvider>` — constructs (and owns the lifecycle of) the right adapter for the
// requested mode and publishes it (plus the resolved theme) through context. `mode:"auto"`
// picks desktop when a bridge is present (explicit prop or `window.polarisKey`), else
// browser. The adapter is built once per {mode, productSlug, baseUrl, bridge} identity and
// disposed on unmount, so credential/session state is stable across renders.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
  SYSTEM_FONT_STACK,
  isBrowserDefaultFont,
  mergeTheme,
  themeVars,
  type PartialTheme,
  type PolarisBranding,
  type PolarisColorScheme,
  type PolarisResolvedScheme,
} from "../components/theme.js";
import { useIsomorphicLayoutEffect } from "../components/primitives/layout.js";
import { PolarisContext } from "./context.js";
import { usePresentationOf } from "./usePresentation.js";
import { iconAccent, withPresentation } from "./presentationTheme.js";
import { DARK_QUERY, resolveSystemScheme } from "./hostScheme.js";

/** Disposals waiting out a possible immediate re-run of the Provider's effect. */
const pendingDisposals = new WeakMap<
  PolarisAdapter,
  ReturnType<typeof setTimeout>
>();

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
   * "system" (the default) matches the page the provider sits on: the first ancestor with a
   * background decides, by its luminance; on a page that paints none, the kit is dark only when
   * the page opts in to dark (`color-scheme` or `<meta name="color-scheme">` includes "dark") and
   * the OS prefers dark, and light otherwise. It re-resolves when the OS preference changes or
   * the host switches theme on `<html>` or `<body>`. "dark" and "light" pin it. Persisting a
   * user's choice is the host's job: pass it back in here.
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

/**
 * Whether the host page set no font where the provider sits, so a theme whose font token is
 * `inherit` (the neutral theme, high contrast) would inherit the browser's default serif. Read
 * once mounted and again once the page has loaded, in case the host's stylesheet arrives late.
 */
function useNoHostFont(
  root: { current: HTMLElement | null },
  enabled: boolean,
): boolean {
  const [none, setNone] = useState(false);
  useIsomorphicLayoutEffect(() => {
    const el = root.current;
    if (!enabled || !el || typeof getComputedStyle !== "function") {
      setNone(false);
      return;
    }
    const check = (): void =>
      setNone(isBrowserDefaultFont(getComputedStyle(el).fontFamily));
    check();
    if (document.readyState === "complete") return;
    window.addEventListener("load", check, { once: true });
    return () => window.removeEventListener("load", check);
  }, [root, enabled]);
  return none;
}

function subscribeScheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const mql = window.matchMedia(DARK_QUERY);
  // Safari < 14 has only the deprecated listener API.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/** The attributes a host flips to switch its own theme. */
const THEME_ATTRIBUTES = [
  "class",
  "data-theme",
  "data-color-scheme",
  "data-mode",
];

/**
 * The scheme `colorScheme` resolves to now. "system" matches the host page (`hostScheme.ts`),
 * resolved before the first paint and again when the OS preference or the host's theme changes.
 * Light until it is measured (a server render).
 */
function useResolvedScheme(
  requested: PolarisColorScheme,
  root: { current: HTMLElement | null },
): PolarisResolvedScheme {
  const [system, setSystem] = useState<PolarisResolvedScheme>("light");
  useIsomorphicLayoutEffect(() => {
    if (requested !== "system") return;
    const update = (): void => setSystem(resolveSystemScheme(root.current));
    update();
    const unsubscribe = subscribeScheme(update);
    let observer: MutationObserver | undefined;
    if (
      typeof MutationObserver === "function" &&
      typeof document !== "undefined"
    ) {
      observer = new MutationObserver(update);
      for (const el of [document.documentElement, document.body])
        if (el)
          observer.observe(el, {
            attributes: true,
            attributeFilter: THEME_ATTRIBUTES,
          });
    }
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, [requested, root]);
  return requested === "dark" || requested === "light" ? requested : system;
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

  const rootRef = useRef<HTMLDivElement>(null);
  const scheme = useResolvedScheme(colorScheme, rootRef);

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
        expectServices: expected,
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

  // Discovery's presentation (HA-13): the product's name, accent and verified icon fill what the
  // integrator's theme leaves unset; the integrator's value always wins.
  const presentationSource = useMemo(() => {
    try {
      return typeof adapter.presentationSource === "function"
        ? adapter.presentationSource()
        : null;
    } catch {
      return null;
    }
  }, [adapter]);
  const { presentation, iconUrl } = usePresentationOf(presentationSource);
  const [derivedAccent, setDerivedAccent] = useState<string | null>(null);
  const productAccent = presentation?.accent ?? presentation?.accentDark;
  useEffect(() => {
    setDerivedAccent(null);
    if (!iconUrl || productAccent) return;
    let live = true;
    void iconAccent(iconUrl).then((a) => {
      if (live) setDerivedAccent(a);
    });
    return () => {
      live = false;
    };
  }, [iconUrl, productAccent]);
  const theme = useMemo(() => {
    const partial = branding ? { ...themeProp, branding } : themeProp;
    const merged = mergeTheme(
      withPresentation(partial, presentation, derivedAccent),
      scheme,
    );
    return iconUrl && merged.logo === undefined
      ? { ...merged, productIcon: iconUrl }
      : merged;
  }, [themeProp, scheme, branding, presentation, iconUrl, derivedAccent]);

  const value = useMemo(() => ({ adapter, theme }), [adapter, theme]);
  // `inherit` takes the host's font; on a page that sets none, that would be Times, so the kit
  // uses the platform's UI font there instead.
  const inheritsFont = theme.tokens.fontFamily.trim() === "inherit";
  const noHostFont = useNoHostFont(rootRef, inheritsFont);
  const vars = useMemo(() => {
    const v = themeVars(theme);
    if (inheritsFont && noHostFont) v["--pk-font-family"] = SYSTEM_FONT_STACK;
    return v;
  }, [theme, inheritsFont, noHostFont]);
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
        ref={rootRef}
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
