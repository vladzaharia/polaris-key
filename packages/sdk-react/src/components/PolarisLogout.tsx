// `<PolarisLogout>` — a branded sign-out button wired to `usePolarisAuth().signOut`. Themed
// via the same `--pk-*` custom properties as the login card so it inherits the brand. The
// busy state is announced (aria-busy + aria-live) and the button keeps an accessible name
// even while the spinner glyph is showing, so screen-reader users always know its purpose.

import { type CSSProperties } from "react";
import { usePolarisAuth, usePolarisTheme } from "../react/hooks.js";

export interface PolarisLogoutProps {
  /** Extra className on the button. */
  className?: string;
  /** Render a low-emphasis (text/ghost) button instead of the bordered default. */
  variant?: "outline" | "ghost";
  /** Override the themed label (defaults to `theme.copy.signOutLabel`). */
  label?: string;
}

const base: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  padding: "10px 16px",
  borderRadius: "var(--pk-radius)",
  color: "var(--pk-text)",
  background: "transparent",
  border: "1px solid var(--pk-border)",
  fontSize: "14px",
  fontWeight: 600,
  fontFamily: "var(--pk-font-family)",
  outlineColor: "var(--pk-ring)",
  outlineOffset: "2px",
};

export function PolarisLogout(props: PolarisLogoutProps): JSX.Element {
  const auth = usePolarisAuth();
  const theme = usePolarisTheme();
  const label = props.label ?? theme.copy.signOutLabel;

  const style: CSSProperties = {
    ...base,
    ...(props.variant === "ghost" ? { border: "none" } : null),
    opacity: auth.busy ? 0.7 : 1,
  };

  return (
    <button
      type="button"
      className={props.className}
      style={style}
      disabled={auth.busy}
      aria-busy={auth.busy}
      aria-label={label}
      onClick={() => {
        void auth.signOut();
      }}
      data-polaris-logout=""
    >
      {label}
    </button>
  );
}
