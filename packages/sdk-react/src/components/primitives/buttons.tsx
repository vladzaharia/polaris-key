// Button primitives. Five weights over one behavioural contract:
//
//   * `disabled` is `aria-disabled`, never the native attribute: the button keeps focus (a
//     submit that disables itself must not drop focus to <body>) and ignores clicks and the
//     form submit it would start;
//   * `busy` is `aria-busy`, keeps the label and adds a 1rem ring beside it (still, under
//     reduced motion), and ignores clicks while it lasts;
//   * `aria-label` carries the button's text, or the caller's `label`;
//   * the focus ring is 2px solid `--pk-ring` with a 2px offset on keyboard focus (`./focus.ts`,
//     BRAND.md §7.4, WCAG 2.4.7);
//   * labels are weight 500 (UI-KITS §1.5 rule 6);
//   * every variant carries a 1px border (transparent where it draws none), so every full-size
//     control is the same height as a bordered one and as a field: 46 px at a 16 px root;
//   * a control's visible boundary is `--pk-border-strong` (>= 3:1, WCAG 1.4.11).

import {
  forwardRef,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { SPACE } from "@polaris-key/brand";
import { typeStep } from "./card.js";
import { useFocusRing } from "./focus.js";
import {
  COARSE_POINTER,
  FORCED_COLORS,
  REDUCED_MOTION,
  matches,
  useMediaQuery,
} from "./media.js";

// rem throughout, so a button grows with the person's default font.
const base: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: SPACE["2"],
  padding: `${SPACE["3"]} ${SPACE["4"]}`,
  border: "1px solid transparent",
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  fontWeight: 500,
  fontSize: "1rem",
  lineHeight: "1.25rem",
  fontFamily: "var(--pk-font-family)",
  textAlign: "center",
  // A long label wraps inside the button rather than pushing it past its container.
  overflowWrap: "anywhere",
};

export const primaryStyle: CSSProperties = {
  ...base,
  background: "var(--pk-accent)",
  color: "var(--pk-accent-text)",
};

export const secondaryStyle: CSSProperties = {
  ...base,
  background: "transparent",
  color: "var(--pk-text-strong, var(--pk-text))",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
};

/** A tertiary action: quieter type, no fill. */
export const quietStyle: CSSProperties = {
  ...secondaryStyle,
  padding: `${SPACE["2"]} ${SPACE["4"]}`,
  ...typeStep("sm"),
  fontWeight: 400,
};

/** A destructive confirm: the danger colour as the fill. */
export const dangerStyle: CSSProperties = {
  ...base,
  background: "var(--pk-danger)",
  color: "var(--pk-background)",
};

/** The smaller button a banner and a list row carry: 38 px tall at a 16 px root, and 44 px
 *  where the pointer is coarse (touch). */
export const compactStyle: CSSProperties = {
  padding: `${SPACE["2"]} ${SPACE["3"]}`,
  ...typeStep("sm"),
};

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "ghost"
  | "danger";

const styles: Record<ButtonVariant, CSSProperties> = {
  primary: primaryStyle,
  secondary: secondaryStyle,
  quiet: quietStyle,
  ghost: { ...secondaryStyle, border: "1px solid transparent" },
  danger: dangerStyle,
};

/** The busy ring: 1rem, drawn in the label's colour, turning unless motion is reduced. Web
 *  Animations rather than a keyframes rule, which an inline style cannot carry. */
function BusyRing(): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || matches(REDUCED_MOTION))
      return;
    const spin = el.animate(
      [{ transform: "rotate(0turn)" }, { transform: "rotate(1turn)" }],
      { duration: 800, iterations: Infinity, easing: "linear" },
    );
    return () => spin.cancel();
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-polaris-busy=""
      style={{
        boxSizing: "border-box",
        flex: "none",
        width: "1rem",
        height: "1rem",
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderInlineEndColor: "transparent",
      }}
    />
  );
}

export interface ButtonProps {
  children?: ReactNode;
  /** The accessible name. Defaults to `children` when that is a plain string. */
  label?: string;
  variant?: ButtonVariant;
  /** `compact` for a banner or a list row. */
  size?: "regular" | "compact";
  type?: "button" | "submit";
  busy?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** The id of a node that describes the action (`aria-describedby`). */
  describedBy?: string;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      children,
      label,
      variant = "primary",
      size = "regular",
      type = "button",
      busy,
      disabled,
      autoFocus,
      className,
      style,
      onClick,
      describedBy,
      ...rest
    } = props;
    const name = label ?? (typeof children === "string" ? children : undefined);
    const ring = useFocusRing();
    const coarse = useMediaQuery(COARSE_POINTER);
    const forced = useMediaQuery(FORCED_COLORS);
    const inert = Boolean(disabled || busy);
    const click = (e: MouseEvent<HTMLButtonElement>): void => {
      // Ignored rather than natively disabled, so focus stays here; preventing the default also
      // stops the form submit a submit button would start (Enter in a field included).
      if (inert) {
        e.preventDefault();
        return;
      }
      onClick?.();
    };
    return (
      <button
        ref={ref}
        type={type}
        className={className}
        style={{
          ...styles[variant],
          ...(size === "compact" ? compactStyle : null),
          // A touch target is 44 px: the compact, quiet and ghost buttons grow to it.
          ...((size === "compact" ||
            variant === "quiet" ||
            variant === "ghost") &&
          coarse
            ? { minHeight: "2.75rem" }
            : null),
          // Forced colours drop an author fill, so the one primary is drawn in the system's
          // selection pair: a solid block no other button has.
          ...(forced && variant === "primary"
            ? { background: "Highlight", color: "HighlightText" }
            : null),
          ...(disabled ? { opacity: 0.42, cursor: "not-allowed" } : null),
          ...(busy && !disabled ? { cursor: "progress" } : null),
          ...style,
          ...ring.style,
        }}
        onFocus={ring.onFocus}
        onBlur={ring.onBlur}
        aria-disabled={disabled ? true : undefined}
        aria-busy={busy ? true : undefined}
        aria-label={name}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        onClick={click}
        {...rest}
      >
        {busy ? <BusyRing /> : null}
        {children}
      </button>
    );
  },
);
