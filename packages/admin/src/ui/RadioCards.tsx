import * as React from "react";
import { Check } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "../lib/cn.js";
import { useWriteLock } from "./WriteLock.js";

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
  /**
   * `dot` (default): the radio dot at the start. `check`: a filled check at the end and a 3 px
   * accent marker on the selected card's start edge (the Locker's free-a-device list).
   */
  indicator?: "dot" | "check";
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
  indicator = "dot",
  name,
  id,
  disabled,
  readOnly,
  className,
  onBlur,
  ref,
  ...aria
}: RadioCardsProps<V>): React.ReactElement {
  const check = indicator === "check";
  const frozen = readOnly || useWriteLock().locked;
  // One column below 640 px is an explicit minmax(0,1fr) track: an implicit auto track grows with
  // its content and runs past the card at a large text size.
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
      aria-readonly={frozen || undefined}
      onValueChange={(v) => {
        if (!frozen) onChange?.(v as V);
      }}
      onBlur={onBlur}
      className={cn("grid grid-cols-[minmax(0,1fr)] gap-2", cols, className)}
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
              "group flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface-raised p-3 text-start @max-[18rem]:gap-2 @max-[18rem]:p-2",
              // Pressable (src/motion.css): the card presses; its border and fill ease at `micro`.
              "pk-pressable hover:border-border-strong",
              "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
              "data-[state=checked]:border-accent data-[state=checked]:bg-accent-subtle",
              check &&
                "data-[state=checked]:shadow-[inset_3px_0_0_var(--pk-locker-accent,var(--pk-accent))]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong forced-colors:border-[ButtonText] transition-colors duration-(--pk-duration-micro) ease-standard group-data-[state=checked]:border-accent",
                check &&
                  "order-last ms-auto size-5 group-data-[state=checked]:border-fg-strong group-data-[state=checked]:bg-fg-strong",
              )}
            >
              {check ? (
                <Check
                  className="size-3 text-surface-raised opacity-0 group-data-[state=checked]:opacity-100"
                  strokeWidth={3}
                />
              ) : (
                <span className="size-2 scale-50 rounded-full bg-accent forced-color-adjust-none forced-colors:bg-[Highlight] opacity-0 transition-[opacity,scale] duration-(--pk-duration-micro) ease-standard group-data-[state=checked]:scale-100 group-data-[state=checked]:opacity-100" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium text-fg-strong">
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
