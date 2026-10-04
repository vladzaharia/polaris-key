import * as React from "react";
import { Input, type InputProps } from "./Input.js";

export interface NumberInputProps extends Omit<
  InputProps,
  "value" | "onChange" | "type" | "defaultValue" | "min" | "max" | "step"
> {
  /** The number, or `null` when empty (only with `nullable`). */
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  /** Empty means `null`, never 0 (fixes UHL-4, TIR-1). Without it, empty reads as `null` too but the field is meant to be filled. */
  nullable?: boolean;
  /** A unit suffix ("days", "ms"). */
  unit?: string;
  /** Store a fraction (0.125), show a percent (12.5) with a "%" suffix (fixes UHL-5). */
  percent?: boolean;
  /** Bounds, in displayed units (a percent field's `max` is 100). */
  min?: number;
  max?: number;
  step?: number | "any";
  /** Whole numbers only. */
  integer?: boolean;
}

const round = (n: number): number => Math.round(n * 1e9) / 1e9;

function display(value: number | null | undefined, percent: boolean): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return String(percent ? round(value * 100) : value);
}

/**
 * A number field that keeps "empty" distinct from 0. It holds the text being typed, so "1." or
 * "-" mid-entry is not thrown away, and reports a number (or `null`) on every valid change.
 */
export function NumberInput({
  value,
  onChange,
  nullable,
  unit,
  percent = false,
  min,
  max,
  step,
  integer,
  ...props
}: NumberInputProps): React.ReactElement {
  const [text, setText] = React.useState(() => display(value, percent));
  const lastReported = React.useRef<number | null | undefined>(value);

  // Follow outside changes (a reset), but not the echo of our own report.
  React.useEffect(() => {
    if (value !== lastReported.current) {
      lastReported.current = value;
      setText(display(value, percent));
    }
  }, [value, percent]);

  return (
    <Input
      {...props}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      suffix={percent ? "%" : unit}
      clearable={nullable ? (props.clearable ?? false) : false}
      onValueChange={(raw) => {
        setText(raw);
        const t = raw.trim();
        if (t === "") {
          lastReported.current = null;
          onChange?.(null);
          return;
        }
        if (!/^-?\d*(?:\.\d*)?$/.test(t) || t === "-" || t === ".") return;
        let n = Number(t);
        if (Number.isNaN(n)) return;
        if (integer && !Number.isInteger(n)) return;
        if (percent) n = round(n / 100);
        lastReported.current = n;
        onChange?.(n);
      }}
      data-min={min}
      data-max={max}
      data-step={step}
    />
  );
}

/** The range message for a number field, or `null` (`min`/`max` in displayed units). */
export function numberRangeError(
  value: number | null,
  opts: { min?: number; max?: number; percent?: boolean; required?: boolean },
): string | null {
  if (value === null) return opts.required ? "Enter a value." : null;
  const shown = opts.percent ? round(value * 100) : value;
  const unit = opts.percent ? " %" : "";
  if (opts.min !== undefined && shown < opts.min)
    return `Use ${opts.min}${unit} or more.`;
  if (opts.max !== undefined && shown > opts.max)
    return `Use ${opts.max}${unit} or less.`;
  return null;
}
