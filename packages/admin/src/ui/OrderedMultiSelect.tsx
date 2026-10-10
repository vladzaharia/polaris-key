import * as React from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Combobox, type ComboboxOption } from "./Combobox.js";
import { IconButton } from "./IconButton.js";
import { announce } from "./LiveRegion.js";

export interface OrderedMultiSelectProps {
  options: readonly ComboboxOption[];
  /** The chosen values, in order: the first is position 1 (highest precedence, or as the page says). */
  value: readonly string[] | null | undefined;
  onChange?: (value: string[]) => void;
  /** The add picker's placeholder ("Add profile"). */
  addLabel?: string;
  /** Shown when nothing is chosen. */
  emptyText?: string;
  /** What the order means, read after the list ("Later profiles override earlier ones."). */
  orderHint?: React.ReactNode;
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  ref?: React.Ref<HTMLButtonElement>;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/**
 * Chosen items as a numbered, reorderable list where order is meaning (components.md §3.3;
 * license profiles, where order is precedence: fixes LIC-3, LDT-3). Reordering is keyboard-first:
 * each row has "Move up" / "Move down" buttons, focus follows the moved row, and the new position
 * is announced. Items are added from a combobox of the ones not chosen yet.
 */
export function OrderedMultiSelect({
  options,
  value,
  onChange,
  addLabel = "Add",
  emptyText = "None chosen.",
  orderHint,
  id,
  disabled,
  readOnly,
  className,
  ref,
  ...aria
}: OrderedMultiSelectProps): React.ReactElement {
  const chosen = [...(value ?? [])];
  const byValue = new Map(options.map((o) => [o.value, o]));
  const name = (v: string): string => {
    const o = byValue.get(v);
    return typeof o?.label === "string" ? o.label : (o?.searchText ?? v);
  };
  const listRef = React.useRef<HTMLOListElement>(null);
  const pendingFocus = React.useRef<string | null>(null);
  const locked = disabled || readOnly;

  React.useLayoutEffect(() => {
    const sel = pendingFocus.current;
    if (!sel) return;
    pendingFocus.current = null;
    const el = listRef.current?.querySelector<HTMLElement>(sel);
    (el &&
    !el.hasAttribute("disabled") &&
    el.getAttribute("aria-disabled") !== "true"
      ? el
      : listRef.current?.querySelector<HTMLElement>(
          "[data-move]:not([disabled])",
        )
    )?.focus();
  });

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= chosen.length) return;
    const next = [...chosen];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    pendingFocus.current = `[data-row="${item!.replace(/["\\]/g, "\\$&")}"] [data-move="${to < from ? "up" : "down"}"]`;
    onChange?.(next);
    announce(`${name(item!)} moved to position ${to + 1} of ${next.length}.`);
  };

  const remove = (i: number): void => {
    const next = chosen.filter((_, j) => j !== i);
    onChange?.(next);
    announce(`${name(chosen[i]!)} removed.`);
  };

  const available = options.filter((o) => !chosen.includes(o.value));

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      id={id}
      role="group"
      {...aria}
    >
      {chosen.length === 0 ? (
        <p className="text-sm text-fg-muted">{emptyText}</p>
      ) : (
        <ol ref={listRef} className="flex flex-col gap-1">
          {chosen.map((v, i) => (
            <li
              key={v}
              data-row={v}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-raised py-1 pl-2 pr-1"
            >
              <span
                aria-hidden
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-medium text-fg-strong tabular-nums"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="sr-only">{`Position ${i + 1}: `}</span>
                <span
                  className="block truncate text-sm text-fg"
                  title={textOf(byValue.get(v)?.label ?? v)}
                >
                  {byValue.get(v)?.label ?? v}
                </span>
                {byValue.get(v)?.secondary ? (
                  <span
                    className="block truncate text-xs text-fg-muted"
                    title={textOf(byValue.get(v)?.secondary)}
                  >
                    {byValue.get(v)?.secondary}
                  </span>
                ) : null}
              </span>
              {locked ? null : (
                <span className="flex shrink-0 items-center">
                  <IconButton
                    size="sm"
                    label={`Move ${name(v)} up`}
                    icon={<ArrowUp />}
                    data-move="up"
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  />
                  <IconButton
                    size="sm"
                    label={`Move ${name(v)} down`}
                    icon={<ArrowDown />}
                    data-move="down"
                    disabled={i === chosen.length - 1}
                    onClick={() => move(i, i + 1)}
                  />
                  <IconButton
                    size="sm"
                    label={`Remove ${name(v)}`}
                    icon={<X />}
                    onClick={() => remove(i)}
                  />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {/* Order only matters with two or more picked. */}
      {orderHint && chosen.length >= 2 ? (
        <p className="text-xs text-fg-muted">{orderHint}</p>
      ) : null}
      {locked ? null : (
        <Combobox
          ref={ref}
          options={available}
          value={null}
          placeholder={addLabel}
          aria-label={addLabel}
          disabled={available.length === 0}
          emptyText="Nothing left to add."
          onChange={(v) => {
            if (!v) return;
            onChange?.([...chosen, v]);
            announce(`${name(v)} added at position ${chosen.length + 1}.`);
          }}
        />
      )}
    </div>
  );
}

/** A label's plain text for a `title` (a node label has none to offer). */
function textOf(node: React.ReactNode): string | undefined {
  return typeof node === "string" || typeof node === "number"
    ? String(node)
    : undefined;
}
