import * as React from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../lib/cn.js";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** 2–4 short options. */
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange?: (value: V) => void;
  size?: "sm" | "md";
  id?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * 2–4 short, mutually exclusive options (components.md §3.3): table density, the Update health
 * window, the Matrix view mode. Radio-group semantics: one tab stop; arrow keys move and select.
 */
export function SegmentedControl<V extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  id,
  name,
  disabled,
  className,
  ref,
  ...aria
}: SegmentedControlProps<V>): React.ReactElement {
  return (
    <RadioGroup.Root
      ref={ref}
      id={id}
      name={name}
      value={value}
      disabled={disabled}
      orientation="horizontal"
      loop
      onValueChange={(v) => onChange?.(v as V)}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5",
        className,
      )}
      {...aria}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 text-fg-muted",
            size === "sm" ? "h-7 text-xs" : "h-8 text-sm",
            "transition-colors duration-(--pk-duration-fast) ease-standard hover:text-fg-strong",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
            "data-[state=checked]:bg-surface-raised data-[state=checked]:font-bold data-[state=checked]:text-fg-strong data-[state=checked]:shadow-elevation-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
