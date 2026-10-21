import * as React from "react";
import { Check, Circle, X } from "lucide-react";
import { cn } from "../../lib/cn.js";

export type PrereqState = "met" | "unmet" | "unknown";

export interface Prereq {
  id: string;
  /** A sentence: "App Store team connection". */
  label: string;
  /** The fact, or the reason it cannot be checked. */
  detail?: React.ReactNode;
  state: PrereqState;
  /** An unmet blocking row holds Continue; a non-blocking one only warns. Default true. */
  blocking?: boolean;
  /** The fix, inline: a control, a link or a button. Shown on an unmet row. */
  fix?: React.ReactNode;
}

const WORDS: Record<PrereqState, string> = {
  met: "Met",
  unmet: "Not met",
  unknown: "Cannot be checked yet",
};

/** Every blocking row is met (a row that cannot be checked does not block). */
export function prereqsMet(rows: readonly Prereq[]): boolean {
  return rows.every((r) => r.state !== "unmet" || r.blocking === false);
}

/**
 * Requirement rows (SETUP.md §1.4): a state, a sentence and, on an unmet row, the fix. The state is
 * an icon and a word, never colour alone.
 */
export function PrereqList({
  rows,
  label = "Requirements",
  words,
}: {
  rows: readonly Prereq[];
  label?: string;
  /** Replace the word of a state ("Shown by the first write" for `unknown`). */
  words?: Partial<Record<PrereqState, string>>;
}): React.ReactElement {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {rows.map((p) => (
        <li
          key={p.id}
          data-state={p.state}
          className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg-strong">{p.label}</p>
            {p.detail ? (
              <p className="text-sm text-fg-muted">{p.detail}</p>
            ) : null}
          </div>
          <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 text-sm",
                p.state === "met" && "text-success",
                p.state === "unmet" && "text-danger",
                p.state === "unknown" && "text-fg-muted",
              )}
            >
              {p.state === "met" ? (
                <Check aria-hidden className="size-4" />
              ) : p.state === "unmet" ? (
                <X aria-hidden className="size-4" />
              ) : (
                <Circle aria-hidden className="size-4" />
              )}
              {words?.[p.state] ?? WORDS[p.state]}
            </span>
            {p.state === "unmet" ? p.fix : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
