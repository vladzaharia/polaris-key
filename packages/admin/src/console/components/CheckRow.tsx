/**
 * One row of a checklist: a state icon, a title, one line of detail and an optional action on
 * the right. The Releases first-release panel and Link repository both list their checks with
 * it (EXPERIENCE.md §0.4 S1–S2), so a check reads the same wherever it appears.
 */

import * as React from "react";
import { Check, CircleDot, X } from "lucide-react";
import { Spinner } from "../../ui/Spinner.js";

export type RowState = "done" | "todo" | "failed" | "checking" | "waiting";

const ROW_ICON: Record<RowState, React.ReactNode> = {
  done: <Check aria-hidden className="size-4 text-success" />,
  todo: <CircleDot aria-hidden className="size-4 text-fg-muted" />,
  failed: <X aria-hidden className="size-4 text-danger" />,
  checking: <Spinner className="size-4" label="" />,
  waiting: (
    <span
      aria-hidden
      className="relative flex size-4 items-center justify-center"
    >
      <span className="absolute size-3 rounded-full bg-accent opacity-40 motion-safe:animate-ping" />
      <span className="relative size-2 rounded-full bg-accent" />
    </span>
  ),
};

/** What the icon means, for assistive tech (the icon itself is decorative). */
const ROW_STATE_TEXT: Record<RowState, string> = {
  done: "Done",
  todo: "To do",
  failed: "Needs a fix",
  checking: "Checking",
  waiting: "Waiting",
};

export function CheckRow({
  state,
  title,
  detail,
  action,
}: {
  state: RowState;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <li
      data-step-state={state}
      className="flex min-h-16 items-center gap-3 px-4 py-3"
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        {ROW_ICON[state]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">
          <span className="sr-only">{ROW_STATE_TEXT[state]}: </span>
          {title}
        </p>
        <p className="text-xs text-fg-muted">{detail}</p>
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </li>
  );
}
