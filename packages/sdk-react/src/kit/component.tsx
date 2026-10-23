"use client";
// The kit root every component draws in (layer b over layer c): a ui-core `ViewModel` for one
// component (DL7's loading delay included), the theme and the product's identity resolved through
// ui-core's one path (§1.2: integrator → the SDK's presentation source → bundle → the icon's
// accent → ink), the shared stylesheet, the shape of the box (DL1), focus moved where the view
// decides (DL9), and every control reported through `onAction`. The DOM is the elements' own
// (`.pk-root` and its `data-*`), so the shared stylesheet draws both renderers alike.

import { flushSync } from "react-dom";
import {
  createContext,
  useContext,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  focusOnMount,
  renewTarget,
  ViewModel,
  viewOf,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";
import {
  platformVariant,
  resolveProductIdentity,
  type BundleProduct,
  type ResolvedIdentity,
  type ThemeOptions,
} from "@polaris-key/ui-core/theme";
import type { PresentationSource } from "@polaris-key/client-core/presentation";
import {
  actionOf,
  canMorph,
  copyFor,
  LAYOUTS,
  decodeIcon,
  groundPrefersDark,
  inputWithIdentity,
  mergeThemes,
  morph,
  onCopyLoaded,
  preloadCopy,
  resolveFor,
  themeVars,
  watchGround,
  watchProductIdentity,
} from "./contract.js";

import { PolarisContext } from "../react/context.js";
import { text, type Chrome, type KitCtx } from "./parts.js";
import { useSdkGate, type GateStep } from "./sdk.js";
import { adoptKitStyles } from "./styles.js";
import {
  adaptHandoff,
  adaptPane,
  adaptUpdate,
  oneVerb,
  withoutLede,
  HANDOFF_WAITING,
} from "./adapt.js";
import { withChoice } from "./licenseRows.js";
import { onLazyLoaded } from "./lazy.js";
import { renderView, withBase } from "./views.js";

const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const BROWSER_DEFAULT_FONT =
  /^\s*(?:"?times new roman"?|"?times"?|serif|-webkit-standard)\s*$/i;

/** UI-KITS.md §3.1, as the React kit takes it: every field optional; an empty theme is the
 *  Polaris Key look in the product's accent. The same value `<pk-provider theme>` takes. */
export interface KitTheme extends ThemeOptions {
  /** `theme.copy`'s locale: a BCP 47 tag; absent: the document's `lang`, then the browser's. */
  locale?: string;
  /** `theme.copy`'s overrides, per locale (`{ en: { "welcome.title": "…" } }`). */
  copy?: Partial<Record<string, Readonly<Record<string, string>>>>;
  /** `sm` = 6/10, `md` = 12/22, `lg` = 16/28 (control/card), or the control radius in px. */
  radius?: "sm" | "md" | "lg" | number;
  /** The integrator's icon, as a URL the page may load. */
  iconSrc?: string;
  /** The SDK's presentation seam (HA-12's `PresentationSource`): the product's accent and icon
   *  with no integrator code. Inside `<PolarisKeyProvider>` it defaults to the adapter's
   *  `presentationSource()`; `null` shows none. */
  presentation?: PresentationSource | null;
  /** What the app bundle knows about the product. */
  bundle?: BundleProduct;
}

/** What `onAction` receives: the control's copy key and the vocabulary action it performs. */
export interface KitAction {
  key: string;
  action: string | null;
  component: ComponentName;
  state: string;
  [k: string]: unknown;
}

/** The props every kit component takes. */
export interface KitProps {
  /** The headless input (ui-core `UiInput`): what the SDK or the host knows now. */
  input?: UiInput;
  /** This component's theme, over the nearest `<PolarisKeyTheme>`. */
  theme?: KitTheme;
  /** Drop an embedded pane's own frame (DL2). */
  bare?: boolean;
  /** Take focus on mount, as a screen the person opened does (DL9). */
  autoFocus?: boolean;
  /** Own the window (DL2): a blocking screen drawn on its own, at least the window's height. The
   *  drop-in gate always does. */
  fill?: boolean;
  /** The heading level of the component's title. Default: 2 for a pane and for `embedded`, 1 for a
   *  screen (the gate and `fill` always own the page's h1). */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Draw a screen-form component (UpdatePrompt) as an embedded pane, for a page of the app's. */
  embedded?: boolean;
  /** `UpdatePrompt` only: an optional update is a modal dialog over the host (a bottom sheet on a
   *  phone); `asWindow` draws it as a screen that owns the window. A mandatory or blocked update
   *  always owns the window. */
  asWindow?: boolean;
  /** Set by the drop-in parts (and the gate): a line whose argument the input does not carry is
   *  left out rather than drawn as `{version}`. A fixture state draws every key it lists. */
  driven?: boolean;
  /** StatusScreen, expired: the https page Renew opens (the host opens it; `onAction` reports
   *  the press with `url`). Without `renewUrl`, `onRenew` or `input.renew`, Renew is not drawn. */
  renewUrl?: string;
  /** StatusScreen, expired: the host handles Renew; this runs on the press. */
  onRenew?: () => void;
  /** A control was pressed. */
  onAction?: (action: KitAction) => void;
  /** The person typed in a field (`key`, `rename`). */
  onInput?: (field: string, value: string) => void;
  /** The person picked a row (a device index, a license id, `keep`, `create`). */
  onSelect?: (id: string) => void;
  /** Extra classes on the kit root (`pk-root` stays). */
  className?: string;
}

const ThemeContext = createContext<KitTheme | null>(null);

/** The theme for every kit component inside (UI-KITS.md §3.2); an inner one layers over it. */
export function PolarisKeyTheme(props: {
  theme: KitTheme;
  children?: ReactNode;
}): ReactNode {
  const outer = useContext(ThemeContext);
  const value = useMemo(
    () => mergeThemes(outer, props.theme),
    [outer, props.theme],
  );
  return (
    <ThemeContext.Provider value={value}>
      {props.children}
    </ThemeContext.Provider>
  );
}

// ── DL9: the ring only after a key since load (no ring at rest on a cold start) ──────────────

let keyboard = false;
const keyboardListeners = new Set<() => void>();
let keyboardWired = false;

function wireKeyboard(): void {
  if (keyboardWired || typeof document === "undefined") return;
  keyboardWired = true;
  const set = (v: boolean) => {
    if (keyboard === v) return;
    keyboard = v;
    for (const l of [...keyboardListeners]) l();
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) set(true);
    },
    true,
  );
  document.addEventListener("pointerdown", () => set(false), true);
}

function subscribeKeyboard(l: () => void): () => void {
  wireKeyboard();
  keyboardListeners.add(l);
  return () => keyboardListeners.delete(l);
}

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type Shape = "landscape" | "portrait" | "short";

/** DL1: two panes from 52.5rem in a landscape box (1.4:1); under 30rem tall is short. */
function shapeOf(w: number, h: number): Shape {
  const rem =
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    16;
  return h > 0 && h / rem < 30 && w > h
    ? "short"
    : w / rem >= 52.5 && h > 0 && w / h >= 1.4
      ? "landscape"
      : "portrait";
}

/** A stable key for the theme members identity resolution reads (not the presentation source,
 *  compared by identity). */
function identityKey(o: KitTheme): string {
  return JSON.stringify([o.product, o.accent, o.preset, o.bundle, o.iconSrc]);
}

/** The locale the kit speaks for `o`, in the order the theme resolves it (`theme.locale`, the
 *  page's `lang`, the browser's language, English): the gate formats the dates it hands the
 *  models in it. */
function themeLocale(o: KitTheme): string {
  const lang =
    typeof document !== "undefined" ? document.documentElement.lang : "";
  const nav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return o.locale ?? (lang || nav || "en");
}

/** What a composed component (the gate, the sign-in form) adds to the kit's own handling. */
export interface KitHooks {
  /** Extra members of a control's `onAction` (the form's device or license id). */
  detail?: (key: string, input: UiInput) => Record<string, unknown>;
  /** A picked row: true when the component handled it (the form's Replace step). */
  pick?: (id: string, view: View) => boolean;
}

/** Everything one kit component resolves and holds: the model, the theme, the identity. */
export function useKit(
  component: ComponentName,
  props: KitProps,
  /** The view drawn for a view (the gate hands to Welcome, StatusScreen…): focus follows it. */
  drawnOf?: (view: View, input: UiInput) => View,
  hooks: KitHooks = {},
) {
  const provided = useContext(ThemeContext);
  const options = useMemo(
    () => mergeThemes(provided, props.theme),
    [provided, props.theme],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);

  // §1.2 through ui-core's one path; the SDK's presentation source is watched, never fetched here.
  // Inside <PolarisKeyProvider> the source is the adapter's (HA-13) unless the theme names one
  // (`null`: none), so a product's accent and icon need no integrator code.
  const adapter = useContext(PolarisContext)?.adapter ?? null;
  const sdkSource = useMemo(() => {
    try {
      return typeof adapter?.presentationSource === "function"
        ? adapter.presentationSource()
        : null;
    } catch {
      return null;
    }
  }, [adapter]);
  const [identity, setIdentity] = useState<ResolvedIdentity | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const source =
    options.presentation !== undefined ? options.presentation : sdkSource;
  const idKey = identityKey(options);
  useEffect(() => {
    const stop = watchProductIdentity(
      {
        integrator: {
          ...(options.product ?? {}),
          ...(options.iconSrc ? { icon: true } : {}),
        },
        accent: options.accent,
        preset: options.preset,
        source,
        bundle: options.bundle,
        decodeIcon,
        iconPx: 96,
        iconScale: typeof devicePixelRatio === "number" ? devicePixelRatio : 2,
      },
      setIdentity,
    );
    let url: string | null = null;
    let live = true;
    if (source)
      void source
        .icon(96, typeof devicePixelRatio === "number" ? devicePixelRatio : 2)
        .then((bytes) => {
          if (!bytes || !live) return;
          const made = URL.createObjectURL(new Blob([bytes as BlobPart]));
          url = made;
          // Bytes that do not decode as an image leave the monogram, not a broken picture.
          const probe = new Image();
          probe.src = made;
          const shown = () => live && setIconUrl(made);
          if (typeof probe.decode === "function")
            probe.decode().then(shown, () => undefined);
          else shown();
        })
        .catch(() => {
          // A failed icon leaves the monogram: never an error state.
        });
    return () => {
      live = false;
      stop();
      if (url) URL.revokeObjectURL(url);
      setIconUrl(null);
    };
    // The members identity reads, by value; the source by identity.
  }, [idKey, source]);

  // Copy packs load on demand; a component showing one redraws when it arrives.
  useEffect(() => onCopyLoaded(force), []);
  useEffect(() => onLazyLoaded(force), []);
  // Under the native preset the "system" scheme also follows the host page's own ground (a theme
  // toggle on the root or body), which the media queries below never see.
  const followsGround = options.preset === "native";
  useEffect(() => {
    if (!followsGround) return;
    let last: boolean | undefined;
    return watchGround(() => {
      const dark = groundPrefersDark(rootRef.current ?? document.body);
      if (dark === last) return;
      last = dark;
      force();
    });
  }, [followsGround]);
  // The scheme and motion follow the OS live.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const qs = [
      "(prefers-color-scheme: light)",
      "(prefers-reduced-motion: reduce)",
    ].map((q) => matchMedia(q));
    for (const m of qs) m.addEventListener?.("change", force);
    return () => {
      for (const m of qs) m.removeEventListener?.("change", force);
    };
  }, []);

  const resolved = resolveFor(
    rootRef.current,
    options,
    identity ??
      resolveProductIdentity({
        integrator: options.product,
        accent: options.accent,
        preset: options.preset,
      }),
    options.iconSrc ?? iconUrl,
    props.input?.platform,
  );

  // The input: the host's over what the person did here (a typed key, a picked row), with the
  // locale the kit speaks: the models format the numbers they are given in it.
  const [local, setLocal] = useState<Partial<UiInput>>({});
  const input: UiInput = {
    locale: resolved.locale,
    ...inputWithIdentity(
      {
        ...local,
        ...(props.renewUrl !== undefined
          ? { renew: { url: props.renewUrl } }
          : props.onRenew
            ? { renew: {} }
            : {}),
        ...(props.input ?? {}),
      },
      resolved,
    ),
  };

  // The model: created once, its view read in render; the loading timer redraws through it.
  const modelRef = useRef<ViewModel | null>(null);
  const deliver = (fn: () => void) => queueMicrotask(fn);
  if (!modelRef.current)
    modelRef.current = new ViewModel(component, input, { deliver });
  const model = modelRef.current;
  if (JSON.stringify(model.snapshot) !== JSON.stringify(input))
    model.update(() => input);
  const view = model.view;
  const drawn = useRef<View>(view);
  drawn.current = view;
  useEffect(() => {
    // StrictMode unmounts and mounts again: a disposed model is replaced, never reused.
    if (!modelRef.current) {
      modelRef.current = new ViewModel(component, input, { deliver });
      force();
    }
    const m = modelRef.current;
    const stop = m.subscribe((v) => {
      if (JSON.stringify(v) !== JSON.stringify(drawn.current)) force();
    });
    return () => {
      stop();
      m.dispose();
      modelRef.current = null;
    };
    // The model lives as long as the component.
  }, []);

  // DL1: the arrangement follows the box, measured after layout. A root that owns the window
  // (`fill`) is the window's shape: its own height grows with content that does not fit, which
  // would read a short landscape window as portrait.
  const [shape, setShape] = useState<Shape>("portrait");
  const [tight, setTight] = useState(false);
  const fill = props.fill === true;
  useIsoLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    let frame = 0;
    const measure = (w: number, h: number) => {
      const next = fill
        ? shapeOf(w, Math.min(h, window.innerHeight))
        : shapeOf(w, h);
      // Under 34 rem of window (large text on a phone) a docked bar would cover the text it
      // docks under: it scrolls with the content instead.
      const wh = window.visualViewport?.height ?? window.innerHeight;
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      const snug =
        wh > 0 && wh / rem < 34 && (next !== "short" || wh / rem < 18);
      cancelAnimationFrame(frame);
      // After this frame's layout: a shape change never re-enters the observer's loop.
      frame = requestAnimationFrame(() => {
        setShape(next);
        setTight(snug);
      });
    };
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      measure(
        box?.inlineSize ?? entry.contentRect.width,
        box?.blockSize ?? entry.contentRect.height,
      );
    });
    ro.observe(el);
    const onWindow = () => {
      const r = el.getBoundingClientRect();
      measure(r.width, r.height);
    };
    if (fill) window.addEventListener("resize", onWindow);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", onWindow);
    };
  }, [fill]);

  // `native` takes the host's face; a page that sets none would draw the kit in the browser's
  // default serif, so it gets the platform's UI face instead.
  const [fontless, setFontless] = useState(false);
  const native = resolved.theme.preset === "native";
  useIsoLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    setFontless(
      native &&
        parent !== null &&
        parent !== undefined &&
        BROWSER_DEFAULT_FONT.test(getComputedStyle(parent).fontFamily),
    );
  }, [native]);

  const kb = useSyncExternalStore(
    subscribeKeyboard,
    () => keyboard,
    () => false,
  );
  useInsertionEffect(() => {
    adoptKitStyles(typeof document === "undefined" ? undefined : document);
  }, []);

  const copy = copyFor(
    resolved.locale,
    options.copy ?? {},
    resolved.theme.platform,
  );

  const ctxFor = (v: View, chrome?: Chrome): KitCtx => ({
    view: v,
    copy,
    resolved,
    input,
    headingLevel:
      props.headingLevel ??
      (props.embedded || LAYOUTS[v.component].kind === "pane" ? 2 : 1),
    interactive: props.onInput !== undefined,
    ...(props.fill ? { fill: true } : {}),
    ...(props.driven ? { driven: true } : {}),
    ...(props.embedded ? { embedded: true } : {}),
    ...(chrome ? { chrome } : {}),
    act: (key, extra = {}) => {
      // Show advanced settings toggles in the pane itself, as in the elements.
      if (key === "settings.advanced")
        setLocal((l) => {
          const drafts = (l as { drafts?: Record<string, unknown> }).drafts;
          return {
            ...l,
            drafts: { ...drafts, advanced: drafts?.advanced !== true },
          } as Partial<UiInput>;
        });
      if (key === "activate.submit")
        setLocal((l) => ({
          ...l,
          keyField: { text: input.keyField?.text ?? "", submitted: true },
        }));
      if (key === "status.renew") props.onRenew?.();
      props.onAction?.({
        key,
        action: actionOf(key),
        component: v.component,
        state: v.state,
        ...(hooks.detail?.(key, input) ?? {}),
        ...(key === "offlineActivation.submit"
          ? { response: input.offline?.response ?? "" }
          : {}),
        ...(key === "paywall.portal" && input.offers?.url
          ? { url: input.offers.url }
          : {}),
        ...(key === "status.renew" && renewTarget(input)
          ? { url: renewTarget(input) as string }
          : {}),
        ...extra,
      });
    },
    edit: (field, value) => {
      if (field === "key")
        setLocal((l) => ({ ...l, keyField: { text: value } }));
      if (field === "response")
        setLocal((l) => ({
          ...l,
          offline: { ...l.offline, response: value, file: value !== "" },
        }));
      props.onInput?.(field, value);
    },
    pick: (id) => {
      if (hooks.pick?.(id, v)) return;
      setLocal((l) => ({ ...l, selected: id }));
      props.onSelect?.(id);
    },
  });

  // DL9: focus what the view says, when the kit already holds focus or was asked to.
  const focusView = drawnOf ? drawnOf(view, input) : view;
  const focusKey = `${focusView.component}.${focusView.state}`;
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    if (focusKey === lastFocus.current) return;
    lastFocus.current = focusKey;
    const target = focusView.decisions.focus;
    const root = rootRef.current;
    if (target === null || !root) return;
    const heading = () =>
      root.querySelector<HTMLElement>('[data-part="title"]') ??
      root.querySelector<HTMLElement>("h1");
    const field =
      target === "heading"
        ? null
        : root.querySelector<HTMLElement>(
            `[data-key="${target.replace(/["\\]/g, "")}"]`,
          );
    // The one focus-on-mount rule (ui-core): screens and dialogs only, when asked, already
    // inside, or on a cold start of a window-filling kit; the heading under a coarse pointer.
    const where = focusOnMount(target, {
      owns: LAYOUTS[focusView.component].kind === "screen",
      asked: props.autoFocus === true,
      within: root.contains(document.activeElement),
      coldStart:
        props.fill === true && document.activeElement === document.body,
      coarse:
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches,
      targetIsField: field instanceof HTMLInputElement,
    });
    if (where === "none") return;
    const el = where === "heading" ? heading() : (field ?? heading());
    el?.focus({ preventScroll: true });
  });

  return {
    view,
    resolved,
    copy,
    input,
    ctxFor,
    rootRef,
    shape,
    tight,
    kb,
    fontless,
  };
}

export type Kit = ReturnType<typeof useKit>;

/** The platform's UI face for every type role, for `native` on a page that sets no font. */
const SYSTEM_FONT_VARS: Record<string, string> = {
  fontFamily: SYSTEM_FONT_STACK,
  ...Object.fromEntries(
    ["body", "title", "display", "label", "button", "meta"].map((role) => [
      `--pk-kit-type-${role}-family`,
      SYSTEM_FONT_STACK,
    ]),
  ),
};

/** The `.pk-root` every component draws in: the elements' attributes, the theme's variables. */
export function KitRoot(props: {
  kit: Kit;
  bare?: boolean;
  className?: string;
  /** Escape backs out of the step (DL9), where there is one to back out of. */
  onEscape?: () => void;
  /** The blocking gate owns the window (DL2) with no layout code from the host (DL18). */
  fill?: boolean;
  children: ReactNode;
}): ReactNode {
  const {
    view,
    resolved: r,
    copy,
    rootRef,
    shape,
    tight,
    kb,
    fontless,
  } = props.kit;
  return (
    <div
      ref={rootRef}
      className={props.className ? `pk-root ${props.className}` : "pk-root"}
      data-pk-kit=""
      data-component={view.component}
      data-state={view.state}
      data-theme={r.theme.scheme}
      data-preset={r.theme.preset}
      data-density={r.theme.density}
      data-motion={r.theme.motion}
      data-shape={shape}
      data-tight={tight ? "" : undefined}
      data-pk-platform={platformVariant(r.theme)}
      data-keyboard={kb ? "" : undefined}
      data-bare={props.bare ? "" : undefined}
      data-fill={props.fill ? "" : undefined}
      lang={copy.locale}
      style={
        (fontless
          ? { ...themeVars(r), ...SYSTEM_FONT_VARS }
          : themeVars(r)) as CSSProperties
      }
      onKeyDown={
        props.onEscape
          ? (e) => {
              if (e.key === "Escape" && !e.defaultPrevented) {
                e.preventDefault();
                props.onEscape!();
              }
            }
          : undefined
      }
    >
      {props.children}
    </div>
  );
}

/** One §4.1 component as a React component: its view, drawn in the kit's look. */
/** States of an update that own the window; every other is a dialog over the running app (DL2). */
const UPDATE_BLOCKING: ReadonlySet<string> = new Set([
  "mandatory",
  "blocked",
  "revoked-required-content",
]);

/** An optional update prompt: a modal `<dialog>` over the host on the scrim (a bottom sheet on a
 *  phone), the host inert. Escape and the scrim answer Later; focus returns to what held it. It
 *  stays closed until the state changes. */
function UpdateDialog(props: {
  state: string;
  hasLater: boolean;
  later: () => void;
  dismissed: string | null;
  close: () => void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = props.dismissed !== props.state;
  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    opener.current ??=
      document.activeElement && document.activeElement !== document.body
        ? (document.activeElement as HTMLElement)
        : null;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  });
  useEffect(() => {
    if (open) return;
    const o = opener.current;
    opener.current = null;
    if (o?.isConnected) o.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const dismiss = () => (props.hasLater ? props.later() : props.close());
  return (
    <dialog
      ref={ref}
      className="sheet"
      data-part="sheet"
      aria-labelledby="pk-title"
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      {props.children}
    </dialog>
  );
}

export function kitComponent(component: ComponentName) {
  function KitComponent(props: KitProps): ReactNode {
    // The state the person dismissed: the update dialog stays closed until the state changes.
    const [dismissed, setDismissed] = useState<string | null>(null);
    const stateRef = useRef("");
    const kit = useKit(
      component,
      component === "UpdatePrompt"
        ? {
            ...props,
            onAction: (a) => {
              if (a.key === "update.later") setDismissed(stateRef.current);
              props.onAction?.(a);
            },
          }
        : props,
    );
    stateRef.current = kit.view.state;
    useEffect(() => {
      if (dismissed !== null && dismissed !== kit.view.state)
        setDismissed(null);
    });
    if (kit.view.state === "hidden") return null;
    // A host that handles input keeps a pane's title and rows through its transient states.
    let view =
      props.onInput !== undefined ? adaptPane(kit.view, kit.input) : kit.view;
    // The driven prompt on the web: one Download action (the page cannot install), and Later.
    const download = props.driven && component === "UpdatePrompt";
    const version = kit.input.update?.version;
    view = oneVerb(view);
    if (download) view = adaptUpdate(view);
    view = withoutLede(view);
    const labels =
      download &&
      version &&
      view.state === "available" &&
      kit.copy.has("common.updateDownload")
        ? {
            "update.install": kit.copy.format("common.updateDownload", {
              version,
            }),
          }
        : undefined;
    const asDialog =
      component === "UpdatePrompt" &&
      !props.embedded &&
      props.asWindow !== true &&
      !UPDATE_BLOCKING.has(view.state);
    const ctx = {
      ...withChoice(kit.ctxFor(view, labels ? { labels } : undefined)),
      dialog: asDialog,
    };
    const body = renderView(ctx);
    return (
      <KitRoot
        kit={kit}
        bare={props.bare}
        fill={props.fill}
        className={props.className}
      >
        {asDialog ? (
          <UpdateDialog
            state={view.state}
            hasLater={view.copy.includes("update.later")}
            later={() => ctx.act("update.later")}
            dismissed={dismissed}
            close={() => setDismissed(view.state)}
          >
            {body}
          </UpdateDialog>
        ) : (
          body
        )}
      </KitRoot>
    );
  }
  KitComponent.displayName = component;
  return KitComponent;
}

/** The props of `<PolarisKeyGate>`: a kit component's, and the app it gates. */
export interface PolarisKeyGateProps extends KitProps {
  /** The app, drawn once the license holds (and under the grace banner while offline grace runs). */
  children?: ReactNode;
  /** The app's own address, added to the device-limit link as `return=` (PX-W8). */
  returnUrl?: string;
}

/** The component the gate draws for its state and the sign-in step it is on. */
function gateScreen(view: View, step: GateStep): ComponentName | null {
  switch (view.state) {
    case "grace":
      return "GraceBanner";
    case "needs-activation":
      return step === "activate"
        ? "Activate"
        : step === "handoff"
          ? "SignInHandoff"
          : "Welcome";
    case "blocked":
      return step === "activate" ? "Activate" : "StatusScreen";
    default:
      return null;
  }
}

/**
 * `<PolarisKeyGate>`: the drop-in root (UI-KITS.md §4.2). It runs every screen the input calls for
 * and renders the app when the license holds, with the grace banner over it while offline grace
 * runs. It never flashes activation during a cached-session check (the model keeps `booting`).
 */
export function PolarisKeyGate(props: PolarisKeyGateProps): ReactNode {
  // English's wire-code texts load now, ahead of the first fetch that could fail with one.
  preloadCopy();
  // Inside <PolarisKeyProvider> with no `input`, the gate starts itself from the SDK.
  const provided = useContext(ThemeContext);
  const sdk = useSdkGate({
    ...(props.returnUrl !== undefined ? { returnUrl: props.returnUrl } : {}),
    locale: themeLocale(mergeThemes(provided, props.theme)),
  });
  const driven = props.input === undefined && sdk !== null;
  const step: GateStep = driven ? sdk.step : "home";
  // The step morph: a step change keeps drawing the old card until the View Transition has
  // captured it, then swaps inside the transition (an instant swap where there is none).
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const shown = useRef<string | null>(null);
  const now = useRef<string | null>(null);
  const card = useRef<ReactNode>(null);
  const holding = useRef(false);
  const lastFocus = useRef<View | null>(null);
  const kit = useKit(
    "PolarisKeyGate",
    {
      ...props,
      input: driven ? sdk.input : props.input,
      fill: true,
      driven,
      onAction: (a) => {
        if (driven) sdk.act(a.key);
        props.onAction?.(a);
      },
      onInput: (field, value) => {
        if (driven) sdk.edit(field, value);
        props.onInput?.(field, value);
      },
    },
    (v, input) => {
      const screen = gateScreen(v, step);
      const key = screen && v.state !== "grace" ? `${v.state}.${screen}` : null;
      now.current = key;
      holding.current =
        key !== null &&
        shown.current !== null &&
        shown.current !== key &&
        card.current !== null &&
        canMorph();
      if (holding.current && lastFocus.current) return lastFocus.current;
      shown.current = key;
      if (!screen) return (lastFocus.current = v);
      // Focus follows the view as drawn: a revoked screen focuses its Sign in.
      return (lastFocus.current = viewOf(screen, input));
    },
  );
  const stepKey = now.current;
  useEffect(() => {
    if (!holding.current || kit.rootRef.current === null) return;
    // In a microtask: an instant swap (reduced motion) must not flush inside this effect.
    queueMicrotask(() => {
      if (kit.rootRef.current)
        morph(kit.rootRef.current, () =>
          flushSync(() => {
            shown.current = now.current;
            redraw();
          }),
        );
    });
  }, [stepKey]);
  const { view, input } = kit;
  // Back returns focus to the control that opened the step (DL9).
  const prevStep = useRef<GateStep>(step);
  useEffect(() => {
    const was = prevStep.current;
    prevStep.current = step;
    if (!driven || step !== "home" || was === "home") return;
    const opener = sdk?.opener;
    if (!opener) return;
    kit.rootRef.current
      ?.querySelector<HTMLElement>(
        `[data-key="${opener.replace(/["\\]/g, "")}"]`,
      )
      ?.focus({ preventScroll: true });
  });
  if (view.state === "hidden" || view.state === "licensed") {
    card.current = null;
    return <>{props.children}</>;
  }
  if (holding.current) return card.current;
  const c = kit.ctxFor(view);
  const sub = (component: ComponentName) => {
    const raw = viewOf(component, input);
    // The drop-in keeps each step's context and offers the way back (never in a fixture state).
    const v = driven ? adaptHandoff(raw) : raw;
    const chrome: Chrome = {};
    if (
      driven &&
      step !== "home" &&
      !withBase(kit.ctxFor(v)).copy.includes("common.back")
    )
      chrome.back = true;
    if (
      driven &&
      v.component === "SignInHandoff" &&
      v.state === "code" &&
      kit.copy.has(HANDOFF_WAITING)
    )
      chrome.meta = [HANDOFF_WAITING];
    return renderView(kit.ctxFor(v, chrome));
  };
  const screen = gateScreen(view, step);
  // The gate's own state, announced once while the screen it hands to draws the paths.
  const announce = (
    <p className="visually-hidden" role="status">
      {view.copy
        .filter((k) => !k.startsWith("a11y.") && k !== "common.reconnect")
        .map((k) => (
          <span key={k} data-key={k}>
            {text(c, k)}{" "}
          </span>
        ))}
    </p>
  );
  let body: ReactNode;
  switch (view.state) {
    case "grace":
      return (
        <>
          <KitRoot kit={kit} className={props.className}>
            {announce}
            {sub("GraceBanner")}
          </KitRoot>
          {props.children}
        </>
      );
    case "needs-activation":
    case "blocked":
      body = (
        <>
          {announce}
          {sub(screen!)}
        </>
      );
      break;
    default:
      body = renderView(c);
  }
  return (card.current = (
    <KitRoot
      kit={kit}
      className={props.className}
      fill
      onEscape={
        driven && step !== "home" ? () => sdk.act("common.back") : undefined
      }
    >
      {body}
    </KitRoot>
  ));
}
