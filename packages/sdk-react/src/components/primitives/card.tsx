// Surface primitives: the full-window backdrop every blocking screen sits in, and the card
// shells the panels are built from. Extracted from the three inline copies that used to live
// in LicenseGate/PolarisLogin/PolarisLogout so a token change lands everywhere at once.
//
// Every value is a `--pk-*` custom property, never a literal, so a host that themes by
// stylesheet gets the same result as one that themes by token bag.

import type { CSSProperties, ReactNode } from "react";

/** The fixed, scrolling backdrop a blocking gate screen occupies. Its child centres itself
 *  with `margin: auto` rather than by flex alignment, so a card taller than a small screen
 *  scrolls from its top instead of being clipped above the fold. */
export const fullWindow: CSSProperties = {
  position: "fixed",
  inset: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  padding: "clamp(16px, 4vw, 32px)",
  overflow: "auto",
  background: "var(--pk-background)",
  color: "var(--pk-text)",
  fontFamily: "var(--pk-font-family)",
};

/** The narrow, centred card a message screen renders inside. */
export const messageCard: CSSProperties = {
  boxSizing: "border-box",
  width: "min(440px, 100%)",
  margin: "auto",
  padding: "clamp(24px, 6vw, 36px)",
  textAlign: "center",
  lineHeight: "22px",
  background: "var(--pk-surface)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
  // The card takes programmatic focus (tabIndex -1) only so a screen reader starts inside the
  // dialog; it is not a control, so it draws no ring (the browser's default is blue).
  outline: "none",
};

/** The wide card the login/settings panels render inside. */
export const panelCard: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  width: "min(640px, 100%)",
  margin: "auto",
  padding: "clamp(20px, 5vw, 32px)",
  lineHeight: "22px",
  background: "var(--pk-surface)",
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
  fontFamily: "var(--pk-font-family)",
};

/** A two-up responsive grid (used when two actions sit side by side). */
export const actionGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "16px",
  alignItems: "stretch",
};

/** A single vertical action column. */
export const actionPanel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  minWidth: 0,
};

export const mutedText: CSSProperties = {
  margin: 0,
  lineHeight: "22px",
  color: "var(--pk-text-muted)",
  fontSize: "14px",
};

export const dangerText: CSSProperties = {
  margin: 0,
  color: "var(--pk-danger)",
  // BRAND.md §9.7: no body text below 14 px.
  fontSize: "14px",
};

/** A panel or screen title: the brand's strong text, Rubik Bold (BRAND.md §1.6). */
export const titleText: CSSProperties = {
  margin: "0 0 4px",
  fontSize: "20px",
  lineHeight: "28px",
  fontWeight: 700,
  color: "var(--pk-text-strong, var(--pk-text))",
};

/** A small label chip (Managed / This device): the brand's `xs` size, bounded by a border so
 *  it does not rely on colour alone. */
export const chipStyle: CSSProperties = {
  fontSize: "12px",
  lineHeight: "16px",
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
  color: "var(--pk-text-muted)",
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
    gap: "12px",
    padding: "8px 16px",
    background: warning
      ? "var(--pk-warning-subtle, var(--pk-surface))"
      : "var(--pk-surface)",
    borderBottom: warning
      ? "1px solid var(--pk-warning, var(--pk-border))"
      : "1px solid var(--pk-border)",
    color: warning ? "var(--pk-text)" : "var(--pk-text-muted)",
    fontFamily: "var(--pk-font-family)",
    fontSize: "14px",
    lineHeight: "20px",
  };
}

export interface PanelProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Forwarded so a panel can carry its own `data-polaris-*` marker. */
  [dataAttr: `data-${string}`]: unknown;
}

/** The wide themed card. `<section>` rather than `<div>` so a labelled panel is a landmark. */
export function Panel({
  children,
  className,
  style,
  ...rest
}: PanelProps & {
  "aria-labelledby"?: string;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <section className={className} style={{ ...panelCard, ...style }} {...rest}>
      {children}
    </section>
  );
}
