// Surface primitives: the full-window backdrop every blocking screen sits in, and the card
// shells the panels are built from. Extracted from the three inline copies that used to live
// in LicenseGate/PolarisLogin/PolarisLogout so a token change lands everywhere at once.
//
// Every value is a `--pk-*` custom property, never a literal, so a host that themes by
// stylesheet gets the same result as one that themes by token bag.

import type { CSSProperties, ReactNode } from "react";

/** The fixed, scrolling backdrop a blocking gate screen occupies. */
export const fullWindow: CSSProperties = {
  position: "fixed",
  inset: 0,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  overflow: "auto",
  background: "var(--pk-background)",
  color: "var(--pk-text)",
  fontFamily: "var(--pk-font-family)",
};

/** The narrow, centred card a message screen renders inside. */
export const messageCard: CSSProperties = {
  boxSizing: "border-box",
  width: "min(420px, 100%)",
  maxHeight: "calc(100vh - 48px)",
  overflow: "auto",
  padding: "28px",
  textAlign: "center",
  background: "var(--pk-surface)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
};

/** The wide card the login/settings panels render inside. */
export const panelCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "min(760px, 100%)",
  padding: "28px",
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
  color: "var(--pk-text-muted)",
  fontSize: "14px",
};

export const dangerText: CSSProperties = {
  margin: 0,
  color: "var(--pk-danger)",
  fontSize: "13px",
};

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
