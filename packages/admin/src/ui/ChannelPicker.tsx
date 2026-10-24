import * as React from "react";
import { withIncludedChannels } from "@polaris-key/manifest";
import { channelOptions, HINT_DEV, HINT_PR } from "../lib/channels.js";
import { cn } from "../lib/cn.js";
import { t } from "../lib/copy.js";
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
  /**
   * Channels held whatever the value says (a tier's `stable`): drawn first, checked and disabled
   * with "Always included" (a dashed chip whose tooltip says so on hover or focus), and never part
   * of the value or of what `onChange` returns.
   */
  fixed?: readonly string[];
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
  fixed = [],
  id,
  disabled,
  readOnly,
  className,
  ref,
  ...aria
}: ChannelPickerProps): React.ReactElement {
  const selected = value ?? [];
  // `dev` includes `beta`: with dev chosen, beta shows ticked and locked, whatever is stored.
  const devChosen = selected.includes("dev");
  const options = channelOptions(manual, held ?? selected).filter(
    (o) => !fixed.includes(o.name),
  );
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
      {fixed.map((name) => (
        <Checkbox
          key={name}
          id={`${base}-${name}`}
          label={
            // Focusable, so the keyboard reaches the locked choice; the description says why, once.
            <span
              tabIndex={0}
              data-locked
              data-ui-static
              className="inline-flex min-h-6 min-w-6 cursor-default items-center justify-center rounded-sm border border-dashed border-border-strong px-1.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus"
            >
              {name}
            </span>
          }
          description="Always included"
          checked
          disabled
        />
      ))}
      {options.map((o) => (
        <Checkbox
          key={o.name}
          id={`${base}-${o.name}`}
          label={<span className="font-mono text-xs">{o.name}</span>}
          description={
            o.name === "beta" && devChosen
              ? t("license.channelIncludedByDev")
              : (SEMANTICS[o.name] ?? o.hint)
          }
          checked={
            selected.includes(o.name) || (o.name === "beta" && devChosen)
          }
          disabled={disabled || (o.name === "beta" && devChosen)}
          readOnly={readOnly}
          onCheckedChange={(on) => {
            const next = on
              ? [...selected, o.name]
              : selected.filter((c) => c !== o.name);
            // Keep the picker's order, not the click order.
            onChange?.(
              withIncludedChannels(
                options.map((x) => x.name).filter((n) => next.includes(n)),
              ),
            );
          }}
        />
      ))}
    </div>
  );
}
