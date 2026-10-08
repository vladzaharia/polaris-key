// Button primitives. Three visual weights over one behavioural contract:
//
//   * `aria-busy` is always the caller's `busy`, so an in-flight action is announced;
//   * `aria-label` always carries the button's TEXT, so a button whose label is swapped for a
//     busy glyph ("…") keeps its accessible name — this is the a11y contract the suite pins;
//   * the focus ring is 2px solid `--pk-ring` with a 2px offset on `:focus-visible`
//     (`./focus.ts`, BRAND.md §7.4), so keyboard focus stays visible on every surface
//     (WCAG 2.4.7);
//   * the brand ships two weights (BRAND.md §1.6), so labels are 700 or 400, never 600;
//   * a control's boundary is `--pk-border-strong` (>= 3:1, WCAG 1.4.11).
//
// Extracted from the copies in PolarisLogin / LicenseGate / PolarisLogout.

import { forwardRef, type CSSProperties, type ReactNode } from "react";
import { SPACE } from "@polaris-key/brand";
import { typeStep } from "./card.js";
import { useFocusRing } from "./focus.js";

// rem throughout, so a button grows with the person's default font: 44 px tall at a 16 px root.
const base: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  boxSizing: "border-box",
  padding: `${SPACE["3"]} ${SPACE["4"]}`,
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  fontWeight: 700,
  fontSize: "1rem",
  lineHeight: "1.25rem",
  fontFamily: "var(--pk-font-family)",
  // A long label wraps inside the button rather than pushing it past its container.
  overflowWrap: "anywhere",
};

export const primaryStyle: CSSProperties = {
  ...base,
  border: "none",
  background: "var(--pk-accent)",
  color: "var(--pk-accent-text)",
};

export const secondaryStyle: CSSProperties = {
  ...base,
  background: "transparent",
  color: "var(--pk-text-strong, var(--pk-text))",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
};

/** The smaller, quieter button a message screen's retry uses. */
export const quietStyle: CSSProperties = {
  ...secondaryStyle,
  padding: `${SPACE["2"]} ${SPACE["4"]}`,
  ...typeStep("sm"),
  fontWeight: 400,
};

/** The smaller button a banner and a list row carry: 36 px tall at a 16 px root. */
export const compactStyle: CSSProperties = {
  padding: `${SPACE["2"]} ${SPACE["3"]}`,
  ...typeStep("sm"),
};

export type ButtonVariant = "primary" | "secondary" | "quiet" | "ghost";

const styles: Record<ButtonVariant, CSSProperties> = {
  primary: primaryStyle,
  secondary: secondaryStyle,
  quiet: quietStyle,
  ghost: { ...secondaryStyle, border: "none" },
};

export interface ButtonProps {
  children?: ReactNode;
  /** The accessible name. Defaults to `children` when that is a plain string. */
  label?: string;
  variant?: ButtonVariant;
  type?: "button" | "submit";
  busy?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      children,
      label,
      variant = "primary",
      type = "button",
      busy,
      disabled,
      autoFocus,
      className,
      style,
      onClick,
      ...rest
    } = props;
    const name = label ?? (typeof children === "string" ? children : undefined);
    const ring = useFocusRing();
    return (
      <button
        ref={ref}
        type={type}
        className={className}
        style={{
          ...styles[variant],
          ...(busy ? { opacity: 0.7 } : null),
          ...(disabled ? { cursor: "not-allowed" } : null),
          ...style,
          ...ring.style,
        }}
        onFocus={ring.onFocus}
        onBlur={ring.onBlur}
        disabled={disabled}
        aria-busy={busy}
        // Keep an accessible name even while a busy glyph replaces the label.
        aria-label={name}
        autoFocus={autoFocus}
        onClick={onClick}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
