// Button primitives. Three visual weights over one behavioural contract:
//
//   * `aria-busy` is always the caller's `busy`, so an in-flight action is announced;
//   * `aria-label` always carries the button's TEXT, so a button whose label is swapped for a
//     busy glyph ("…") keeps its accessible name — this is the a11y contract the suite pins;
//   * the focus ring is `--pk-ring` with a 2px offset, so keyboard focus stays visible on
//     every surface (WCAG 2.4.7).
//
// Extracted from the copies in PolarisLogin / LicenseGate / PolarisLogout.

import { forwardRef, type CSSProperties, type ReactNode } from "react";

const base: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  padding: "12px 16px",
  borderRadius: "var(--pk-radius)",
  fontWeight: 600,
  fontSize: "15px",
  fontFamily: "var(--pk-font-family)",
  outlineColor: "var(--pk-ring)",
  outlineOffset: "2px",
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
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
};

/** The smaller, quieter button a message screen's retry uses. */
export const quietStyle: CSSProperties = {
  ...secondaryStyle,
  marginTop: "16px",
  padding: "10px 16px",
  fontSize: "14px",
  fontWeight: 400,
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
    return (
      <button
        ref={ref}
        type={type}
        className={className}
        style={{
          ...styles[variant],
          ...(busy ? { opacity: 0.7 } : null),
          ...style,
        }}
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
