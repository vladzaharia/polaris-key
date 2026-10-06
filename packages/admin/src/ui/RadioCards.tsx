import * as React from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../lib/cn.js";

export interface RadioCardOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface RadioCardsProps<V extends string = string> {
  options: readonly RadioCardOption<V>[];
  value: V | null | undefined;
  onChange?: (value: V) => void;
  /** Columns at ≥ 640 px (one column below). */
  columns?: 1 | 2 | 3 | 4;
  name?: string;
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onBlur?: () => void;
  ref?: React.Ref<HTMLDivElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
}

/**
 * Mutually exclusive choices with their consequences spelled out (components.md §3.3): access
 * modes, registration policy, fingerprint mode. A WAI-ARIA radio group: one tab stop, arrows move
 * and select. The selected card carries the section accent and a filled dot, never colour alone.
 */
export function RadioCards<V extends string = string>({
  options,
  value,
  onChange,
  columns = 2,
  name,
  id,
  disabled,
  readOnly,
  className,
  onBlur,
  ref,
  ...aria
}: RadioCardsProps<V>): React.ReactElement {
  const cols = {
    1: "",
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-4",
  }[columns];
  return (
    <RadioGroup.Root
      ref={ref}
      id={id}
      name={name}
      value={value ?? ""}
      disabled={disabled}
      onValueChange={(v) => {
        if (!readOnly) onChange?.(v as V);
      }}
      onBlur={onBlur}
      className={cn("grid gap-2", cols, className)}
      {...aria}
    >
      {options.map((o) => {
        const itemId = `${id ?? name ?? "rc"}-${o.value}`;
        return (
          <RadioGroup.Item
            key={o.value}
            value={o.value}
            id={itemId}
            disabled={o.disabled}
            aria-describedby={o.description ? `${itemId}-desc` : undefined}
            className={cn(
              "group flex items-start gap-3 rounded-lg border border-border bg-surface-raised p-3 text-left",
              // Pressable (src/motion.css): the card presses; its border and fill ease at `micro`.
              "pk-pressable hover:border-border-strong",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
              "data-[state=checked]:border-accent data-[state=checked]:bg-accent-subtle",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span
              aria-hidden
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong transition-colors duration-(--pk-duration-micro) ease-standard group-data-[state=checked]:border-accent"
            >
              <span className="size-2 scale-50 rounded-full bg-accent opacity-0 transition-[opacity,scale] duration-(--pk-duration-micro) ease-standard group-data-[state=checked]:scale-100 group-data-[state=checked]:opacity-100" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-bold text-fg-strong">
                {o.icon ? (
                  <span aria-hidden className="[&_svg]:size-4">
                    {o.icon}
                  </span>
                ) : null}
                {o.label}
              </span>
              {o.description ? (
                <span
                  id={`${itemId}-desc`}
                  className="mt-0.5 block text-xs text-fg-muted"
                >
                  {o.description}
                </span>
              ) : null}
            </span>
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}
