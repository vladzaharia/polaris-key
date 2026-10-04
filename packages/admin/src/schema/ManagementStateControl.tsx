import * as React from "react";
import { CircleHelp } from "lucide-react";
import type { ManagementState } from "../api.js";
import { docsUrl } from "../lib/docsLinks.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { MANAGEMENT_STATES } from "./entry.js";

/**
 * The management state of one managed key (SCF-5): the kit's `SegmentedControl`, a real radio
 * group (one tab stop, arrows move and select, Home/End, a disabled option is skipped). The chosen
 * state's meaning is its accessible description and the help icon's tooltip, not a paragraph
 * repeated under every row.
 */
export function ManagementStateControl({
  value,
  onChange,
  label,
  disabled,
}: {
  value: ManagementState;
  onChange: (next: ManagementState) => void;
  /** Accessible group name, e.g. `Management state for Theme`. */
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  const helpId = React.useId();
  const help = MANAGEMENT_STATES.find((s) => s.value === value)?.help;
  return (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5">
        <SegmentedControl<ManagementState>
          size="sm"
          aria-label={label}
          aria-describedby={help ? helpId : undefined}
          value={value}
          disabled={disabled}
          onChange={onChange}
          options={MANAGEMENT_STATES.map((s) => ({
            value: s.value,
            label: s.label,
          }))}
        />
        <a
          href={docsUrl("managementStates")}
          target="_blank"
          rel="noreferrer"
          aria-label="Management states (docs)"
          title={help}
          className="rounded-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
        >
          <CircleHelp aria-hidden className="size-3.5" />
        </a>
      </span>
      {help ? (
        <p id={helpId} className="sr-only">
          {help}
        </p>
      ) : null}
    </div>
  );
}
