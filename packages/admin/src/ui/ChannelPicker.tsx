import * as React from "react";
import { channelOptions, HINT_DEV, HINT_PR } from "../lib/channels.js";
import { cn } from "../lib/cn.js";
import { Checkbox } from "./Checkbox.js";

/** What each built-in channel grant means (components.md §3.3). */
const SEMANTICS: Record<string, string> = {
  stable: "General releases",
  beta: "Pre-releases, plus everything on stable",
  pr: HINT_PR,
  dev: HINT_DEV,
};

export interface ChannelPickerProps {
  value: readonly string[] | null | undefined;
  onChange?: (value: string[]) => void;
  /** The product's manual channel names (`.pkey/product`). */
  manual?: readonly string[];
  /** The value when the form opened, so an unticked held grant stays listed. */
  held?: readonly string[];
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/**
 * A checkbox group over `channelOptions()` (the protocol's channels plus the product's manual
 * names), each with what the grant means. `pr` and `dev` are never offered by accident: `dev`
 * appears only when already held.
 */
export function ChannelPicker({
  value,
  onChange,
  manual = [],
  held,
  id,
  disabled,
  readOnly,
  className,
  ref,
  ...aria
}: ChannelPickerProps): React.ReactElement {
  const selected = value ?? [];
  const options = channelOptions(manual, held ?? selected);
  const reactId = React.useId();
  const base = id ?? `ch-${reactId.replace(/:/g, "")}`;
  return (
    <div
      ref={ref}
      id={id}
      role="group"
      className={cn("flex flex-col gap-2", className)}
      {...aria}
    >
      {options.map((o) => (
        <Checkbox
          key={o.name}
          id={`${base}-${o.name}`}
          label={<span className="font-mono text-xs">{o.name}</span>}
          description={SEMANTICS[o.name] ?? o.hint}
          checked={selected.includes(o.name)}
          disabled={disabled}
          readOnly={readOnly}
          onCheckedChange={(on) => {
            const next = on
              ? [...selected, o.name]
              : selected.filter((c) => c !== o.name);
            // Keep the picker's order, not the click order.
            onChange?.(
              options.map((x) => x.name).filter((n) => next.includes(n)),
            );
          }}
        />
      ))}
    </div>
  );
}
