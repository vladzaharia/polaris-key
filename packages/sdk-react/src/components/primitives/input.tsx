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

import type { CSSProperties } from "react";
import { useFocusRing } from "./focus.js";

export const inputStyle: CSSProperties = {
  padding: "10px 12px",
  boxSizing: "border-box",
  // A control's boundary needs 3:1 (WCAG 1.4.11; BRAND.md §4.3 `border-strong`); an input on a
  // card sits in the sunken surface.
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
  background: "var(--pk-surface-sunken, transparent)",
  color: "var(--pk-text)",
  fontSize: "14px",
  fontFamily: "var(--pk-font-family)",
};

export const labelStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--pk-text-muted)",
};

export interface TextFieldProps {
  /** The input's id — the `<label for>` target. Callers pass a `useId()` value. */
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The id of the node carrying the current error message, when there is one. */
  errorId?: string;
  invalid?: boolean;
  style?: CSSProperties;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

export function TextField(props: TextFieldProps): JSX.Element {
  const {
    id,
    label,
    value,
    onChange,
    placeholder,
    autoFocus,
    disabled,
    errorId,
    invalid,
    style,
    ...rest
  } = props;
  const ring = useFocusRing();
  return (
    <>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input
        id={id}
        style={{ ...inputStyle, ...style, ...ring.style }}
        onFocus={ring.onFocus}
        onBlur={ring.onBlur}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={errorId}
        {...rest}
      />
    </>
  );
}
