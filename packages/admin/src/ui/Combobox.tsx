import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "./Popover.js";

export interface ComboboxOption {
  value: string;
  label: React.ReactNode;
  /** Secondary text on the row (a release's channel and date, a tier's policy summary). */
  secondary?: React.ReactNode;
  /** Text to match when `label` is not a string. */
  searchText?: string;
  disabled?: boolean;
}

interface Common {
  options: readonly ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** Shown when the search matches nothing. */
  emptyText?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onBlur?: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
}

export type ComboboxProps = Common &
  (
    | {
        multiple?: false;
        value: string | null | undefined;
        onChange?: (value: string | null) => void;
        /** Show a clear button (single mode). */
        clearable?: boolean;
      }
    | {
        multiple: true;
        value: readonly string[] | null | undefined;
        onChange?: (value: string[]) => void;
        clearable?: never;
      }
  );

function text(o: ComboboxOption): string {
  if (o.searchText) return o.searchText;
  const parts = [o.label, o.secondary].filter(
    (p): p is string | number => typeof p === "string" || typeof p === "number",
  );
  return parts.join(" ") || o.value;
}

/**
 * A searchable single or multi select (components.md §3.3): releases (version, channel and date
 * per row; PAD-2), tiers, profiles, outlets. The trigger is a button that opens a non-modal
 * popover holding a `cmdk` combobox: type to filter, arrows move, Enter selects, Escape closes and
 * returns focus to the trigger.
 */
export function Combobox(props: ComboboxProps): React.ReactElement {
  const {
    options,
    placeholder = "Choose…",
    searchPlaceholder = "Search…",
    emptyText = "Nothing matches.",
    id,
    name,
    disabled,
    readOnly,
    className,
    onBlur,
    ref,
    ...rest
  } = props;
  const aria = {
    "aria-label": rest["aria-label"],
    "aria-labelledby": rest["aria-labelledby"],
    "aria-describedby": rest["aria-describedby"],
    "aria-invalid": rest["aria-invalid"],
    "aria-required": rest["aria-required"],
  };
  const [open, setOpen] = React.useState(false);
  const reactId = React.useId();
  const valueId = `cbx-${reactId.replace(/:/g, "")}-value`;
  const selected: string[] = props.multiple
    ? [...(props.value ?? [])]
    : props.value
      ? [props.value]
      : [];
  const byValue = new Map(options.map((o) => [o.value, o]));
  const labels = selected.map((v) => byValue.get(v)?.label ?? v);

  const choose = (value: string): void => {
    if (props.multiple) {
      const next = selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value];
      props.onChange?.(
        options.map((o) => o.value).filter((v) => next.includes(v)),
      );
    } else {
      props.onChange?.(value);
      setOpen(false);
    }
  };

  let summary: React.ReactNode = (
    <span className="text-fg-subtle">{placeholder}</span>
  );
  if (labels.length === 1) summary = labels[0];
  else if (labels.length > 1)
    summary =
      props.multiple && labels.length > 2 ? (
        `${labels.length} selected`
      ) : (
        <span className="flex gap-1">
          {labels.map((l, i) => (
            <span key={i} className="rounded-xs bg-hover px-1.5 text-xs">
              {l}
            </span>
          ))}
        </span>
      );

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onBlur?.();
      }}
    >
      <div className={cn("relative flex w-full", className)}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            id={id}
            name={name}
            type="button"
            disabled={disabled || readOnly}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface-sunken px-3 text-left text-sm text-fg",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
              "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger pointer-coarse:h-10",
              !props.multiple &&
                props.clearable &&
                selected.length > 0 &&
                "pr-16",
            )}
            {...aria}
            aria-describedby={
              [aria["aria-describedby"], valueId].filter(Boolean).join(" ") ||
              undefined
            }
          >
            <span id={valueId} className="min-w-0 truncate">
              {summary}
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-4 shrink-0 text-fg-muted"
            />
          </button>
        </PopoverTrigger>
        {!props.multiple &&
        props.clearable &&
        selected.length > 0 &&
        !disabled &&
        !readOnly ? (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => props.onChange?.(null)}
            className="absolute right-8 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[min(32rem,92vw)] p-0"
        onOpenAutoFocus={(e) => {
          // cmdk's input takes focus itself.
          e.preventDefault();
        }}
      >
        <Command loop className="flex flex-col">
          <Command.Input
            autoFocus
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-9 border-b border-border bg-transparent px-3 text-sm text-fg outline-hidden"
          />
          <Command.List
            aria-multiselectable={props.multiple || undefined}
            className="pk-scroll max-h-72 overflow-y-auto p-1"
          >
            <Command.Empty className="px-2 py-3 text-sm text-fg-muted">
              {emptyText}
            </Command.Empty>
            {options.map((o) => {
              const isOn = selected.includes(o.value);
              return (
                <Command.Item
                  key={o.value}
                  value={`${text(o)} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => choose(o.value)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm text-fg",
                    "data-[selected=true]:bg-hover data-[selected=true]:text-fg-strong",
                    "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
                  )}
                >
                  <Check
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      isOn ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.secondary ? (
                      <span className="block truncate text-xs text-fg-muted">
                        {o.secondary}
                      </span>
                    ) : null}
                  </span>
                  {isOn ? <span className="sr-only">selected</span> : null}
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </PopoverRoot>
  );
}
