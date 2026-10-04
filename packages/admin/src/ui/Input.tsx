import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { CONTROL_INPUT } from "./inputBase.js";

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "prefix" | "onChange"
> {
  /** Leading content inside the frame (a unit, a `https://`). Decorative to assistive tech. */
  prefix?: React.ReactNode;
  /** Trailing content inside the frame. */
  suffix?: React.ReactNode;
  /** Shows a clear button while there is a value; clearing sends an empty change. */
  clearable?: boolean;
  /** Ids, keys, versions and hashes: the platform mono stack. */
  mono?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Called with the new string (also on clear). */
  onValueChange?: (value: string) => void;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * A text input (components.md §3.3). Plain props render a bare `<input>` (so legacy callers and
 * `className` overrides keep working); `prefix`, `suffix` or `clearable` wrap it in a frame.
 */
export function Input({
  className,
  prefix,
  suffix,
  clearable,
  mono,
  onChange,
  onValueChange,
  ref,
  ...props
}: InputProps): React.ReactElement {
  const inner = React.useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null): void => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref)
      (ref as React.RefObject<HTMLInputElement | null>).current = el;
  };
  const handle = (e: React.ChangeEvent<HTMLInputElement>): void => {
    onChange?.(e);
    onValueChange?.(e.target.value);
  };
  const hasValue =
    props.value !== undefined && props.value !== null && props.value !== "";
  const framed = prefix != null || suffix != null || clearable;
  const input = (
    <input
      ref={setRef}
      onChange={handle}
      className={cn(
        CONTROL_INPUT,
        mono && "font-mono text-xs",
        framed &&
          "border-0 bg-transparent px-0 focus-visible:ring-0 focus-visible:ring-offset-0",
        !framed && className,
      )}
      {...props}
    />
  );
  if (!framed) return input;
  return (
    <div
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md border border-border-strong bg-surface-sunken px-3",
        "focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 focus-within:ring-offset-surface-page",
        "has-[[aria-invalid=true]]:border-danger has-[:disabled]:opacity-50 pointer-coarse:h-10",
        className,
      )}
    >
      {prefix != null ? (
        <span aria-hidden className="shrink-0 text-sm text-fg-subtle">
          {prefix}
        </span>
      ) : null}
      {input}
      {suffix != null ? (
        <span aria-hidden className="shrink-0 text-sm text-fg-subtle">
          {suffix}
        </span>
      ) : null}
      {clearable && hasValue && !props.disabled && !props.readOnly ? (
        <button
          type="button"
          aria-label="Clear"
          className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => {
            const el = inner.current;
            if (el) {
              // Fire a real change so both onChange and react-hook-form see it.
              const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
              )?.set;
              setter?.call(el, "");
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.focus();
            } else {
              onValueChange?.("");
            }
          }}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
