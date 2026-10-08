// Surface primitives: the full-window backdrop every blocking screen sits in, and the card
// shells the panels are built from. Extracted from the three inline copies that used to live
// in LicenseGate/PolarisLogin/PolarisLogout so a token change lands everywhere at once.
//
// Every colour is a `--pk-*` custom property, never a literal, so a host that themes by
// stylesheet gets the same result as one that themes by token bag.
//
// Every size is rem, so the kit follows the person's default font size (a 24 px root scales
// every font, gap and width with it), and every gap and padding is a step of the brand's 4 px
// grid (`SPACE`). A card's padding is a percentage of its containing block's width, which is the
// space the host gave it, so a panel in a narrow sidebar pads like one on a phone.

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { KIT_TOKENS, SPACE, TYPE_SCALE } from "@polaris-key/brand";
import {
  WindowLayoutContext,
  useRemSize,
  useWindowLayout,
  windowLayoutOf,
  type WindowLayout,
} from "./layout.js";

/** Font size and line height for a step of the brand's type scale. */
export function typeStep(step: keyof typeof TYPE_SCALE): CSSProperties {
  const [fontSize, lineHeight] = TYPE_SCALE[step];
  return { fontSize, lineHeight };
}

/** A card's padding: 20 px in a container under 400 px, 32 px from 640 px, fluid between. */
export const cardPadding = `clamp(${SPACE["5"]}, 5%, ${SPACE["8"]})`;

/** The fixed, scrolling backdrop a blocking gate screen occupies. Its child centres itself
 *  with `margin: auto` rather than by flex alignment, so a card taller than a small screen
 *  scrolls from its top instead of being clipped above the fold. */
export const fullWindow: CSSProperties = {
  position: "fixed",
  inset: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  padding: SPACE["8"],
  overflow: "auto",
  background: "var(--pk-background)",
  color: "var(--pk-text)",
  fontFamily: "var(--pk-font-family)",
};

/** The backdrop for a layout: no inset when the card bleeds or is a sheet, a tighter one when
 *  the window is short. It is the container the title's type role sizes against (`cqi`). */
export function fullWindowStyle(layout: WindowLayout): CSSProperties {
  return {
    ...fullWindow,
    containerType: "inline-size",
    padding:
      layout.bleed || layout.sheet ? 0 : layout.short ? SPACE["4"] : SPACE["8"],
  };
}

/** The scrim a dismissible dialog sits on, the host app visible behind it (UI-KITS §2.1 web
 *  scrim): the page ground at 14 % with a 12 px blur in light, 50 % and 16 px in dark. */
export function scrimStyle(scheme: "dark" | "light"): CSSProperties {
  const { opacity, blur } = KIT_TOKENS.components.web.scrim[scheme];
  return {
    background: `color-mix(in srgb, var(--pk-background) ${Math.round(opacity * 100)}%, transparent)`,
    backdropFilter: `blur(${blur}px)`,
    WebkitBackdropFilter: `blur(${blur}px)`,
  };
}

/** The narrow, centred card a message screen renders inside. */
export const messageCard: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  width: "min(27.5rem, 100%)",
  margin: "auto",
  padding: cardPadding,
  textAlign: "center",
  ...typeStep("sm"),
  background: "var(--pk-surface)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
  overflowWrap: "anywhere",
  // The card takes programmatic focus (tabIndex -1) only so a screen reader starts inside the
  // dialog; it is not a control, so it draws no ring (the browser's default is blue).
  outline: "none",
};

/** The card the login/settings panels render inside. In the host's page it starts at the host's
 *  start edge and fills its container up to 40rem; only a full-window screen centres it. */
export const panelCard: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: SPACE["5"],
  width: "100%",
  maxWidth: "40rem",
  margin: 0,
  padding: cardPadding,
  ...typeStep("sm"),
  background: "var(--pk-surface)",
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
  fontFamily: "var(--pk-font-family)",
  // A long word (a device id, a URL) wraps inside the card instead of pushing it sideways.
  overflowWrap: "anywhere",
};

/** The inset a full-bleed card keeps: 20 px, or the device's safe area where that is larger. */
const bleedPadding: CSSProperties = {
  paddingBlock: `max(${SPACE["5"]}, env(safe-area-inset-top)) max(${SPACE["5"]}, env(safe-area-inset-bottom))`,
  paddingInline: `max(${SPACE["5"]}, env(safe-area-inset-left), env(safe-area-inset-right))`,
};

/**
 * Where a card sits in a full-window screen. On a narrow window it fills it (full-bleed: no
 * border, no radius, 20 px padding, the safe areas kept); under a dismissible dialog it is a
 * bottom sheet; otherwise it is centred. A short, wide window lays it out in two columns
 * (`twoColumnCard`). The card never scrolls inside: when it is taller than the window, the
 * window scrolls. `null` (a card in the host's own page) changes nothing.
 */
export function cardInWindow(layout: WindowLayout | null): CSSProperties {
  if (!layout) return {};
  if (layout.bleed)
    return {
      width: "100%",
      maxWidth: "none",
      minHeight: "100%",
      margin: 0,
      border: "none",
      borderRadius: 0,
      flexShrink: 0,
      ...bleedPadding,
    };
  if (layout.sheet)
    return {
      width: "100%",
      maxWidth: "none",
      margin: "auto 0 0",
      borderInline: "none",
      borderBottom: "none",
      borderRadius: "var(--pk-radius) var(--pk-radius) 0 0",
      flexShrink: 0,
      paddingBottom: `max(${SPACE["5"]}, env(safe-area-inset-bottom))`,
    };
  return {
    margin: "auto",
    flexShrink: 0,
    ...(layout.twoColumn
      ? {
          width: "min(52rem, 100%)",
          maxWidth: "none",
          paddingBlock: SPACE["5"],
        }
      : null),
  };
}

/** A card's two columns on a short, wide window: start (identity and title) and end (the
 *  controls), top-aligned. */
export const twoColumnCard: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  columnGap: SPACE["8"],
  rowGap: SPACE["4"],
  alignItems: "start",
};

/** The start column on a short, wide window: it stays in view while the window scrolls. */
export const stickyColumn: CSSProperties = {
  position: "sticky",
  top: 0,
  alignSelf: "start",
};

/** A full-window screen's title: the kit's Title role (UI-KITS §2.1), sized against the window. */
export const screenTitle: CSSProperties = {
  margin: 0,
  fontSize: KIT_TOKENS.typeScale.web.title.size,
  lineHeight: KIT_TOKENS.typeScale.web.title.lineHeight,
  fontWeight: KIT_TOKENS.typeScale.web.title.weight,
  color: "var(--pk-text-strong, var(--pk-text))",
  textWrap: "balance",
} as CSSProperties;

/** Body copy under a title: wrapped to avoid a stranded last word. */
export const prettyText = { textWrap: "pretty" } as CSSProperties;

/** A two-up responsive grid (used when two actions sit side by side). */
export const actionGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13.75rem), 1fr))",
  gap: SPACE["4"],
  alignItems: "stretch",
};

/** A single vertical action column. */
export const actionPanel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE["2"],
  minWidth: 0,
};

export const mutedText: CSSProperties = {
  margin: 0,
  // BRAND.md §9.7: no body text below 14 px.
  ...typeStep("sm"),
  color: "var(--pk-text-muted)",
};

export const dangerText: CSSProperties = {
  margin: 0,
  ...typeStep("sm"),
  color: "var(--pk-danger)",
};

/** A panel title in the host's page: the brand's strong text at the `xl` step. */
export const titleText = {
  margin: `0 0 ${SPACE["1"]}`,
  ...typeStep("xl"),
  fontWeight: 600,
  color: "var(--pk-text-strong, var(--pk-text))",
  textWrap: "balance",
} as CSSProperties;

/** A small label chip (Managed / This device): the brand's `xs` size, bounded by a border so
 *  it does not rely on colour alone. */
export const chipStyle: CSSProperties = {
  ...typeStep("xs"),
  padding: `${SPACE["0.5"]} ${SPACE["2"]}`,
  borderRadius: "999px",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
  color: "var(--pk-text-muted)",
  whiteSpace: "nowrap",
};

/**
 * The strip a non-blocking notice renders as (the grace banner, the update banner). `warning`
 * is the tone of a notice the user cannot dismiss: the brand's warning callout (BRAND.md §4.4,
 * subtle ground and border), with the words still saying what it is; colour never carries the
 * state alone.
 */
export function bannerStyle(
  tone: "neutral" | "warning" = "neutral",
): CSSProperties {
  const warning = tone === "warning";
  return {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    gap: `${SPACE["2"]} ${SPACE["3"]}`,
    padding: `${SPACE["2"]} ${SPACE["4"]}`,
    background: warning
      ? "var(--pk-warning-subtle, var(--pk-surface))"
      : "var(--pk-surface)",
    borderBottom: warning
      ? "1px solid var(--pk-warning, var(--pk-border))"
      : "1px solid var(--pk-border)",
    color: warning ? "var(--pk-text)" : "var(--pk-text-muted)",
    fontFamily: "var(--pk-font-family)",
    ...typeStep("sm"),
    overflowWrap: "anywhere",
  };
}

export interface FullWindowProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** A modal screen (`aria-modal`): while it is up the rest of the page is inert and Tab stays
   *  inside it; when it closes, focus goes back to where it was. */
  modal?: boolean;
  /** A dismissible dialog over the host app: a translucent scrim in this scheme instead of the
   *  opaque page, and a bottom sheet on a narrow window. */
  scrim?: "dark" | "light";
  /** Escape pressed inside the screen. */
  onEscape?: () => void;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Make every sibling of every ancestor of `el` inert, up to <body>; returns the undo. */
function inertOutside(el: HTMLElement): () => void {
  const changed: Element[] = [];
  let node: HTMLElement | null = el;
  while (node && node.parentElement && node !== document.body) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (
        sibling === node ||
        sibling.hasAttribute("inert") ||
        /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(sibling.tagName)
      )
        continue;
      sibling.setAttribute("inert", "");
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const sibling of changed) sibling.removeAttribute("inert");
  };
}

/**
 * The full-window backdrop. It measures itself and tells the card inside how to lay out
 * (`useWindowLayout`): full-bleed below 35rem of width (a bottom sheet under a scrim), two
 * columns below 30rem of height.
 */
export function FullWindow({
  children,
  style,
  modal,
  scrim,
  onEscape,
  onKeyDown,
  ...rest
}: FullWindowProps): JSX.Element {
  const [ref, size] = useRemSize<HTMLDivElement>();
  const el = useRef<HTMLDivElement | null>(null);
  const layout = windowLayoutOf(size, { scrim: scrim !== undefined });
  // What had focus before this screen opened, read on the first render: by the time an effect
  // runs, the screen has already moved focus inside itself.
  const [before] = useState(() =>
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );

  // While a modal screen is up, nothing behind it takes focus or a pointer; when it goes, focus
  // returns to what had it.
  useEffect(() => {
    if (!modal || !el.current || typeof document === "undefined") return;
    const undo = inertOutside(el.current);
    return () => {
      undo();
      if (before && before !== document.body && before.isConnected)
        before.focus();
    };
  }, [modal, before]);

  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }
    if (!modal || e.key !== "Tab" || !el.current) return;
    // Tab cycles inside the screen.
    const items = Array.from(
      el.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((x) => !x.closest("[inert]"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={(node) => {
        el.current = node;
        ref(node);
      }}
      style={{
        ...fullWindowStyle(layout),
        ...(scrim ? scrimStyle(scrim) : null),
        ...style,
      }}
      onKeyDown={keyDown}
      {...rest}
    >
      <WindowLayoutContext.Provider value={layout}>
        {children}
      </WindowLayoutContext.Provider>
    </div>
  );
}

export interface PanelProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** No border, background, radius or inline padding, for a host that frames the panel itself
   *  (the title and the row dividers stay). A bare panel never takes a window's placement. */
  bare?: boolean;
  /** Forwarded so a panel can carry its own `data-polaris-*` marker. */
  [dataAttr: `data-${string}`]: unknown;
}

/** What `bare` drops. */
export const bareCard: CSSProperties = {
  border: "none",
  background: "transparent",
  borderRadius: 0,
  paddingInline: 0,
};

/** The themed card. `<section>` rather than `<div>` so a labelled panel is a landmark. Directly
 *  inside a full-window screen it takes that screen's placement (`cardInWindow`). */
export const Panel = forwardRef<
  HTMLElement,
  PanelProps & {
    "aria-labelledby"?: string;
    "aria-label"?: string;
    tabIndex?: number;
  }
>(function Panel({ children, className, style, bare, ...rest }, ref) {
  const layout = useWindowLayout();
  return (
    <section
      ref={ref}
      className={className}
      style={{
        ...panelCard,
        ...style,
        ...(bare ? bareCard : cardInWindow(layout)),
        // The card takes programmatic focus only (a touch screen's key-only sign-in): no ring.
        outline: "none",
      }}
      {...rest}
    >
      {children}
    </section>
  );
});
