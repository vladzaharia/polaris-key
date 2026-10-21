import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * One setting: label and help on the left, the control (or read-only value) on the right.
 *
 * - `align="end"` (the default) is for compact controls and values: a switch, a pill, a short
 *   input, a select, a link or a button. The control sits flush right, beside the label on every
 *   width while it fits, and wraps under the label (still right-aligned) when it does not.
 * - `align="stretch"` is for wide editors (code editors, paired inputs): label and help left,
 *   the editor filling the right 3/5 at ≥ 1024 px, stacked full width below.
 * - `align="block"` is for editors that need the card's full width (radio cards): the label
 *   line on top, the editor full width under it.
 *
 * `aside` is a read-only status for the row ("Enforced now: …"), drawn flush right on the label
 * line in `stretch` and `block` rows and before the control in `end` rows.
 *
 * `htmlFor` ties the label to a control; for a read-only fact, omit it.
 */
export function SettingsRow({
  id,
  label,
  help,
  htmlFor,
  source,
  chip,
  compact = false,
  align = "end",
  aside,
  children,
  footer,
  state,
  control,
}: {
  /** The row's own element id: a `?setting=<key>` deep link lands on `setting-<key>`. */
  id?: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  htmlFor?: string;
  /** A `SourceBadge` for this one value (Platform → Settings). */
  source?: React.ReactNode;
  /** A quiet mono chip after the title: the registry key. */
  chip?: React.ReactNode;
  /** A read-only fact: tighter padding and quieter help. */
  compact?: boolean;
  align?: "end" | "stretch" | "block";
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** A per-row `SaveBar` when the row saves on its own. */
  footer?: React.ReactNode;
  /**
   * What the end-aligned control is, for phones (below `sm`): `switch` stays on the label row
   * and never wraps under the text; `field` (an input, a choice) takes the full width under the
   * help instead of floating mid-row.
   */
  control?: "switch" | "field";
  /** The engine row's state, for the stylesheet and the tests (`data-state`). */
  state?: "default" | "changed" | "locked" | "error" | "conflict";
}): React.ReactElement {
  const labelBlock = (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-sm font-medium text-fg-strong"
          >
            {label}
          </label>
        ) : (
          <span className="text-sm font-medium text-fg-strong">{label}</span>
        )}
        {chip ? (
          <code className="rounded border border-border px-1.5 py-px font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">
            {chip}
          </code>
        ) : null}
        {source}
      </div>
      {help ? (
        <p
          className={cn(
            "max-w-[68ch] text-fg-muted",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {help}
        </p>
      ) : null}
    </div>
  );
  return (
    <div
      id={id}
      className={cn(
        "relative px-5",
        compact ? "py-2.5" : "py-4",
        // A row with an unsaved change: an ink bar at its leading edge and a wash.
        "data-[state=changed]:bg-surface-sunken data-[state=changed]:before:absolute data-[state=changed]:before:inset-y-0 data-[state=changed]:before:left-0 data-[state=changed]:before:w-[3px] data-[state=changed]:before:bg-fg-strong data-[state=changed]:before:content-['']",
      )}
      data-align={align}
      data-state={state}
    >
      {align === "block" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0 flex-[1_1_16rem]">{labelBlock}</div>
            {aside ? (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-sm text-fg">
                {aside}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 text-sm text-fg">{children}</div>
        </div>
      ) : align === "stretch" ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-6">
          <div className="min-w-0 space-y-2">
            {labelBlock}
            {aside ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
                {aside}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 text-sm text-fg">{children}</div>
        </div>
      ) : (
        <div
          className={cn(
            "flex items-start justify-between gap-x-6 gap-y-2",
            control === "switch"
              ? "max-sm:flex-nowrap sm:flex-wrap"
              : "flex-wrap",
            control === "field" && "max-sm:flex-col max-sm:items-stretch",
          )}
        >
          <div className="min-w-0 flex-[1_1_16rem]">{labelBlock}</div>
          {/* Flush right, and so is every line of a value that wraps (a chain of pills). */}
          <div
            className={cn(
              "ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-right text-sm text-fg [&>:not(button)]:justify-end",
              control === "switch" && "max-sm:shrink-0",
              control === "field" &&
                "max-sm:ml-0 max-sm:w-full max-sm:justify-start max-sm:text-left [&>*]:max-sm:max-w-full",
            )}
          >
            {aside}
            {children}
          </div>
        </div>
      )}
      {footer}
    </div>
  );
}
