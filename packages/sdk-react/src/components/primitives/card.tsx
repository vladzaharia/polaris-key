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

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { SPACE, TYPE_SCALE } from "@polaris-key/brand";
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

/** The backdrop for a layout: no inset when the card bleeds, a tighter one when the window is
 *  short. */
export function fullWindowStyle(layout: WindowLayout): CSSProperties {
  return {
    ...fullWindow,
    padding: layout.bleed ? 0 : layout.short ? SPACE["4"] : SPACE["8"],
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

/** The wide card the login/settings panels render inside. */
export const panelCard: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: SPACE["5"],
  width: "min(40rem, 100%)",
  margin: "auto",
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
 * border, no radius, 20 px padding); otherwise it stays centred and never grows past the window,
 * scrolling inside instead, with tighter vertical padding when the window is short. `null` (a
 * card in the host's own page) changes nothing.
 */
export function cardInWindow(layout: WindowLayout | null): CSSProperties {
  if (!layout) return {};
  if (layout.bleed)
    return {
      width: "100%",
      minHeight: "100%",
      margin: 0,
      border: "none",
      borderRadius: 0,
      ...bleedPadding,
    };
  return {
    maxHeight: "100%",
    overflowY: "auto",
    ...(layout.short ? { paddingBlock: SPACE["5"] } : null),
  };
}

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

/** A panel or screen title: the brand's strong text, Rubik Bold (BRAND.md §1.6). */
export const titleText: CSSProperties = {
  margin: `0 0 ${SPACE["1"]}`,
  ...typeStep("xl"),
  fontWeight: 700,
  color: "var(--pk-text-strong, var(--pk-text))",
};

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
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

/**
 * The full-window backdrop. It measures itself and tells the card inside how to lay out
 * (`useWindowLayout`): full-bleed below 35rem of width, capped at the window's height below
 * 30rem of height.
 */
export function FullWindow({
  children,
  style,
  ...rest
}: FullWindowProps): JSX.Element {
  const [ref, size] = useRemSize<HTMLDivElement>();
  const layout = windowLayoutOf(size);
  return (
    <div ref={ref} style={{ ...fullWindowStyle(layout), ...style }} {...rest}>
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
  /** Forwarded so a panel can carry its own `data-polaris-*` marker. */
  [dataAttr: `data-${string}`]: unknown;
}

/** The wide themed card. `<section>` rather than `<div>` so a labelled panel is a landmark.
 *  Directly inside a full-window screen it takes that screen's placement (`cardInWindow`). */
export function Panel({
  children,
  className,
  style,
  ...rest
}: PanelProps & {
  "aria-labelledby"?: string;
  "aria-label"?: string;
}): JSX.Element {
  const layout = useWindowLayout();
  return (
    <section
      className={className}
      style={{ ...panelCard, ...style, ...cardInWindow(layout) }}
      {...rest}
    >
      {/* A card nested in this one is not the window's card. */}
      <WindowLayoutContext.Provider value={null}>
        {children}
      </WindowLayoutContext.Provider>
    </section>
  );
}
