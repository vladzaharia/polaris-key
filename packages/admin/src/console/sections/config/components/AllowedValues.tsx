import * as React from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { useWriteLock } from "../../../../ui/WriteLock.js";
import { same } from "../model/mergeDraft.js";
import { valueText, type ValueHolder } from "../model/valueUse.js";
import type { KeyHolders } from "./RemovedValues.js";

/** "Studio profile and 5 more", "10 set it": who uses a value, from the holders read. */
export function usageTag(
  value: unknown,
  use: KeyHolders | undefined,
): string | null {
  if (!use) return null;
  const mine = use.holders.filter((h) => same(h.value, value));
  if (mine.length === 0) return null;
  const more = use.unread > 0 ? "+" : "";
  const first: ValueHolder = mine[0]!;
  if (first.kind === "profile")
    return mine.length > 1
      ? `${first.label} and ${mine.length - 1}${more} more`
      : first.label;
  return `${mine.length}${more} set it`;
}

/**
 * The allowed values as chips, each with who uses it, a remove button and an Add (docs/design/
 * mockups config.entry-setting). A value the draft removed stays in the row, dashed and struck, with
 * Undo, until the draft is published (config.entry-setting-remove-value).
 */
export function AllowedValues({
  values,
  removed,
  baseValues,
  defaultValue,
  numeric,
  use,
  onChange,
  onUndo,
  describedBy,
}: {
  values: unknown[];
  removed: unknown[];
  /** The published list, to tell a new value. */
  baseValues: unknown[] | null;
  defaultValue: unknown;
  numeric: boolean;
  use: KeyHolders | undefined;
  onChange: (next: unknown[]) => void;
  onUndo: (value: unknown) => void;
  describedBy?: string;
}): React.ReactElement {
  const locked = useWriteLock().locked;
  const [adding, setAdding] = React.useState(false);
  const [text, setText] = React.useState("");
  const commit = (): void => {
    const raw = text.trim();
    setAdding(false);
    setText("");
    if (raw === "") return;
    const v = numeric ? Number(raw) : raw;
    if (numeric && !Number.isFinite(v)) return;
    if (!values.some((x) => same(x, v))) onChange([...values, v]);
  };
  return (
    <ul
      aria-label="Allowed values"
      aria-describedby={describedBy}
      className="flex flex-wrap items-center gap-2"
    >
      {values.map((v) => {
        const tag = usageTag(v, use);
        const isNew =
          baseValues !== null && !baseValues.some((b) => same(b, v));
        const isDefault = same(v, defaultValue);
        return (
          <li
            key={valueText(v)}
            className={cn(
              "inline-flex min-h-7 items-center gap-2 rounded-full border bg-surface-raised ps-3 pe-1 text-xs",
              isNew ? "border-fg-strong" : "border-border-strong",
            )}
          >
            <code className="font-mono text-fg-strong">{valueText(v)}</code>
            {isNew || isDefault || tag ? (
              <span className="border-s border-border ps-2 text-fg-muted">
                {isNew ? "New" : isDefault ? "Default" : tag}
              </span>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove ${valueText(v)}`}
              disabled={locked}
              onClick={() => onChange(values.filter((x) => !same(x, v)))}
            >
              <X aria-hidden />
            </Button>
          </li>
        );
      })}
      {removed.map((v) => (
        <li
          key={`removed:${valueText(v)}`}
          className="inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-border-strong ps-3 pe-1 text-xs text-fg-muted"
        >
          <s className="font-mono">{valueText(v)}</s>
          <span className="sr-only"> (removed)</span>
          <Button
            size="xs"
            variant="ghost"
            iconStart={<RotateCcw aria-hidden />}
            onClick={() => onUndo(v)}
          >
            Undo<span className="sr-only"> removing {valueText(v)}</span>
          </Button>
        </li>
      ))}
      <li>
        {adding ? (
          <input
            autoFocus
            aria-label="New allowed value"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                setAdding(false);
                setText("");
              }
            }}
            className="h-7 w-32 rounded-full border border-border-strong bg-surface-raised px-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus"
          />
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="rounded-full border-dashed"
            iconStart={<Plus aria-hidden />}
            disabled={locked}
            onClick={() => setAdding(true)}
          >
            Add
          </Button>
        )}
      </li>
    </ul>
  );
}
