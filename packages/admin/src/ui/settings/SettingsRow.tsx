import * as React from "react";

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
  label,
  help,
  htmlFor,
  source,
  align = "end",
  aside,
  children,
  footer,
  state,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  htmlFor?: string;
  /** A `SourceBadge` for this one value (Platform → Settings). */
  source?: React.ReactNode;
  align?: "end" | "stretch" | "block";
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** A per-row `SaveBar` when the row saves on its own. */
  footer?: React.ReactNode;
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
        {source}
      </div>
      {help ? <p className="text-sm text-fg-muted">{help}</p> : null}
    </div>
  );
  return (
    <div className="px-5 py-4" data-align={align} data-state={state}>
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
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-[1_1_16rem]">{labelBlock}</div>
          {/* Flush right, and so is every line of a value that wraps (a chain of pills). */}
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-right text-sm text-fg [&>:not(button)]:justify-end">
            {aside}
            {children}
          </div>
        </div>
      )}
      {footer}
    </div>
  );
}
