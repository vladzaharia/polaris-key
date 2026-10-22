import * as React from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../../../lib/cn.js";

/**
 * One Appearance row (the MK-L2 anatomy): a label at the left and a compact segmented radio group
 * at the right, under the label when the card is narrow. A WAI-ARIA radio group (one tab stop,
 * arrows move and select); the chosen segment is raised, with a heavier label, never colour alone.
 * `note` is one muted line under the label (what the chosen option does).
 */
export function SegmentedRow<V extends string>({
  label,
  note,
  value,
  onChange,
  options,
}: {
  label: string;
  note?: string;
  value: V;
  onChange: (value: V) => void;
  options: readonly { value: V; label: string }[];
}): React.ReactElement {
  const id = React.useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4 first:pt-1 last:pb-1">
      <div className="min-w-0">
        <p id={id} className="font-medium text-fg-strong">
          {label}
        </p>
        {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
      </div>
      <RadioGroup.Root
        aria-labelledby={id}
        value={value}
        onValueChange={(v) => onChange(v as V)}
        className="flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5 max-sm:w-full"
      >
        {options.map((o) => (
          <RadioGroup.Item
            key={o.value}
            value={o.value}
            className={cn(
              "inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-3 text-sm max-sm:px-2 text-fg-muted outline-none",
              "max-desk:min-h-11 max-sm:flex-1",
              "hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus",
              "data-[state=checked]:border-border-strong data-[state=checked]:bg-surface-raised data-[state=checked]:font-semibold data-[state=checked]:text-fg-strong",
              "forced-colors:data-[state=checked]:border-[Highlight]",
            )}
          >
            {o.label}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
