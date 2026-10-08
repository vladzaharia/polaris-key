// The labelled text field. Its whole reason to exist is that the three inline copies each had
// to re-establish the same a11y wiring by hand:
//
//   * a real `<label for>` (not a placeholder standing in for one), so the field has a name;
//   * `aria-invalid` + `aria-describedby` pointing at the error node when there is one, so a
//     screen reader announces WHY the field is rejected rather than just that it is;
//   * the error node itself rendered `role="alert"` by the caller that owns the message.
//
// The field renders the label and input; the error node is the caller's, because a login card
// shows one error for the whole form, not one per input.

import { forwardRef, type CSSProperties } from "react";
import { SPACE } from "@polaris-key/brand";
import { typeStep } from "./card.js";
import { useFocusRing } from "./focus.js";
import { COARSE_POINTER, useMediaQuery } from "./media.js";

export const inputStyle: CSSProperties = {
  padding: SPACE["3"],
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  // A control's boundary needs 3:1 (WCAG 1.4.11; BRAND.md §4.3 `border-strong`); an input on a
  // card sits in the sunken surface.
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
  background: "var(--pk-surface-sunken, transparent)",
  color: "var(--pk-text)",
  // 1rem, never less: iOS zooms the page into a field whose text is under 16 px.
  fontSize: "1rem",
  lineHeight: "1.25rem",
  fontFamily: "var(--pk-font-family)",
};

export const labelStyle: CSSProperties = {
  ...typeStep("sm"),
  color: "var(--pk-text-muted)",
};

export interface TextFieldProps {
  /** The input's id — the `<label for>` target. Callers pass a `useId()` value. */
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Focus the field on mount; never where the pointer is coarse (touch), where it would pop
   *  the keyboard over the screen. */
  autoFocus?: boolean;
  disabled?: boolean;
  /** Read-only and `aria-disabled` while a save runs: the field keeps focus and what was typed. */
  busy?: boolean;
  /** The id of the node carrying the current error message, when there is one. */
  errorId?: string;
  /** Other nodes that describe the field (`aria-describedby`, after the error). */
  describedBy?: string;
  /** The value itself is wrong: `aria-invalid` and the danger border. */
  invalid?: boolean;
  /** Visually hide the label (it still names the field). */
  hideLabel?: boolean;
  /** `auto` for a value the person names in any script (a device name). */
  dir?: "auto" | "ltr" | "rtl";
  style?: CSSProperties;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

/** Present to assistive tech, absent from the layout. */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(props, ref) {
    const {
      id,
      label,
      value,
      onChange,
      placeholder,
      autoFocus,
      disabled,
      busy,
      errorId,
      describedBy,
      invalid,
      hideLabel,
      style,
      ...rest
    } = props;
    const ring = useFocusRing();
    const coarse = useMediaQuery(COARSE_POINTER);
    const described =
      [errorId, describedBy].filter(Boolean).join(" ") || undefined;
    return (
      <>
        <label htmlFor={id} style={hideLabel ? visuallyHidden : labelStyle}>
          {label}
        </label>
        <input
          ref={ref}
          id={id}
          style={{
            ...inputStyle,
            ...(invalid ? { borderColor: "var(--pk-danger)" } : null),
            ...style,
            ...ring.style,
          }}
          onFocus={ring.onFocus}
          onBlur={ring.onBlur}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={busy}
          aria-disabled={busy ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus && !coarse}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={described}
          {...rest}
        />
      </>
    );
  },
);
