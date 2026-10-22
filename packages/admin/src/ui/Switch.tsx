import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../lib/cn.js";
import { Spinner } from "./Spinner.js";
import { useWriteLock } from "./WriteLock.js";

type RootProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export interface SwitchProps extends Omit<
  RootProps,
  "value" | "onChange" | "checked" | "onCheckedChange"
> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  value?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  readOnly?: boolean;
  /** 44×24 on a phone (the touch size); the default 36×20 from `sm` up and everywhere else. */
  touch?: boolean;
  /** A save is in flight: a ring in the knob, and the control is inert (`aria-busy`). */
  saving?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * An immediate or form-local boolean (components.md §3.3). Never the only control for a
 * confirmed destructive action (LDT-7): that is a button and a `ConfirmDialog`.
 */
export function Switch({
  className,
  checked,
  onCheckedChange,
  value,
  onChange,
  label,
  description,
  readOnly,
  touch,
  saving,
  id,
  ref,
  ...props
}: SwitchProps): React.ReactElement {
  const reactId = React.useId();
  const { locked } = useWriteLock();
  readOnly = readOnly || locked;
  const switchId = id ?? `sw-${reactId.replace(/:/g, "")}`;
  const descId = description ? `${switchId}-desc` : undefined;
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={switchId}
      checked={checked ?? value ?? false}
      aria-readonly={readOnly || saving || undefined}
      aria-disabled={locked || props["aria-disabled"] || undefined}
      aria-busy={saving || undefined}
      onCheckedChange={(c) => {
        if (readOnly || saving) return;
        onCheckedChange?.(c);
        onChange?.(c);
      }}
      className={cn(
        // Pressable (src/motion.css): the track presses and its colours ease at `micro`.
        "pk-pressable peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong",
        "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-sunken",
        // Forced colours drop every background to Canvas: the checked track fills with Highlight
        // and the knob is CanvasText, so on, off and blocked read apart without colour.
        "forced-colors:data-[state=checked]:border-[Highlight] forced-colors:data-[state=checked]:bg-[Highlight] forced-colors:data-[state=unchecked]:bg-[Canvas] forced-colors:disabled:border-[GrayText] forced-colors:aria-disabled:border-[GrayText]",
        "after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-['']",
        touch && "max-sm:h-6 max-sm:w-11",
        !label && className,
      )}
      {...props}
      aria-describedby={
        [props["aria-describedby"], descId].filter(Boolean).join(" ") ||
        undefined
      }
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none relative block size-3.5 rounded-full bg-fg-muted shadow-elevation-1 [transition:translate_var(--pk-duration-slow)_var(--pk-ease-spring),background-color_var(--pk-duration-micro)_var(--pk-ease-standard)] data-[state=checked]:translate-x-[1.125rem] data-[state=checked]:bg-accent-on light:data-[state=checked]:bg-white data-[state=unchecked]:translate-x-0.5 rtl:data-[state=checked]:-translate-x-[1.125rem] rtl:data-[state=unchecked]:-translate-x-0.5 forced-colors:bg-[CanvasText] forced-colors:data-[state=checked]:bg-[HighlightText]",
          touch &&
            "max-sm:size-[1.125rem] max-sm:data-[state=checked]:translate-x-[1.375rem] max-sm:data-[state=unchecked]:translate-x-[0.1875rem] max-sm:rtl:data-[state=checked]:-translate-x-[1.375rem] max-sm:rtl:data-[state=unchecked]:-translate-x-[0.1875rem]",
        )}
      >
        {saving ? (
          <Spinner
            label=""
            className="absolute inset-0 m-auto size-2.5 border-[1.5px] text-fg-strong"
          />
        ) : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    // Label first, the switch flush right: a switch reads as a row's trailing control.
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          className="inline-flex min-h-6 min-w-6 items-center text-sm text-fg"
        >
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-xs text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <span className="mt-0.5 flex">{control}</span>
    </div>
  );
}
