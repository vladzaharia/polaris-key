import * as React from "react";
import { Check, CircleDashed, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Spinner } from "../Spinner.js";

export type AutoState = "will" | "doing" | "done" | "needs" | "failed";

export interface AutoItem {
  id: string;
  label: string;
  state: AutoState;
  /** The result, or what is needed: a link or a sentence. */
  result?: React.ReactNode;
  /** Where the row comes from ("GitHub App"). */
  source?: string;
  /** Retry, or the permission to grant: shown on a `needs` or `failed` row. */
  action?: React.ReactNode;
}

const WORDS: Record<AutoState, string> = {
  will: "Will do",
  doing: "Doing",
  done: "Done",
  needs: "Needs a permission",
  failed: "Failed",
};

/**
 * "Polaris Key does this" (SETUP.md §1.2): one row per automated action, in the plan's order.
 * Never a step and never counted. Before the work it is the plan in the future tense; afterwards it
 * is live. A failed row names the fix beside it, and nothing keeps spinning after a failure.
 */
export function AutoList({
  items,
  title = "Polaris Key does this",
}: {
  items: readonly AutoItem[];
  title?: string;
}): React.ReactElement {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold text-fg-strong">
        {title}
      </h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((a) => (
          <li
            key={a.id}
            data-state={a.state}
            className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          >
            <span aria-hidden className="shrink-0">
              {a.state === "done" ? (
                <Check className="size-4 text-success" />
              ) : a.state === "doing" ? (
                <Spinner label="" className="text-fg-muted" />
              ) : a.state === "failed" || a.state === "needs" ? (
                <X className="size-4 text-danger" />
              ) : (
                <CircleDashed className="size-4 text-fg-muted" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg-strong">{a.label}</p>
              {a.result || a.source ? (
                <p className="text-xs text-fg-muted">
                  {a.result}
                  {a.result && a.source ? " · " : null}
                  {a.source}
                </p>
              ) : null}
            </div>
            <span
              className={cn(
                "text-xs",
                a.state === "failed" || a.state === "needs"
                  ? "text-danger"
                  : "text-fg-muted",
              )}
            >
              {WORDS[a.state]}
            </span>
            {(a.state === "failed" || a.state === "needs") && a.action ? (
              <span className="shrink-0">{a.action}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
