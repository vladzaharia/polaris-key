import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/cn.js";

/**
 * Select (components.md §3.3), on Radix.
 *
 * - `<Select options value onChange />` is the everyday form: `id` lands on the trigger, so a
 *   `FormField` label and `aria-*` wiring reach it (fixes UI-6).
 * - `allowEmpty` adds an explicit "None" option that reads and writes `null`: no sentinel strings
 *   in callers (UI-7). Radix forbids `""` as an item value, so the mapping is internal.
 * - An option's `description` is a second line in the list (replaces legend `dl`s, UPS-7).
 *
 * The compositional primitives (`SelectRoot`, `SelectTrigger`, …) are exported too, for the
 * legacy views until chunk 11.
 */

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
  ref?: React.Ref<React.ComponentRef<typeof SelectPrimitive.Trigger>>;
}): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface-sunken px-3 text-left text-sm text-fg",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
        "data-[placeholder]:text-fg-subtle [&>span]:line-clamp-1 pointer-coarse:h-10",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof SelectPrimitive.Content>>;
}): React.ReactElement {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border bg-surface-overlay text-fg shadow-elevation-3 animate-pk-in",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
          <ChevronUp aria-hidden className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
          <ChevronDown aria-hidden className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label> & {
  ref?: React.Ref<React.ComponentRef<typeof SelectPrimitive.Label>>;
}): React.ReactElement {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-xs font-medium text-fg-muted", className)}
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  description,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
  description?: React.ReactNode;
  ref?: React.Ref<React.ComponentRef<typeof SelectPrimitive.Item>>;
}): React.ReactElement {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex w-full cursor-pointer select-none flex-col items-start rounded-sm py-1.5 pl-8 pr-2 text-sm outline-hidden",
        "focus:bg-hover focus:text-fg-strong data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 top-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {description ? (
        <span className="text-xs text-fg-muted">{description}</span>
      ) : null}
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> & {
  ref?: React.Ref<React.ComponentRef<typeof SelectPrimitive.Separator>>;
}): React.ReactElement {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

// ── The everyday Select ────────────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

const NONE = "__pk-select-none__";

export interface SelectProps {
  options: readonly SelectOption[];
  value: string | null | undefined;
  onChange?: (value: string | null) => void;
  /** Adds a "None" option that means `null`. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onBlur?: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function Select({
  options,
  value,
  onChange,
  allowEmpty,
  emptyLabel = "None",
  placeholder = "Choose…",
  id,
  name,
  disabled,
  readOnly,
  className,
  onBlur,
  ref,
  ...aria
}: SelectProps): React.ReactElement {
  const current =
    value === null || value === undefined || value === ""
      ? allowEmpty && value === null
        ? NONE
        : undefined
      : value;
  return (
    <SelectRoot
      value={current}
      name={name}
      disabled={disabled || readOnly}
      onValueChange={(v) => onChange?.(v === NONE ? null : v)}
      onOpenChange={(open) => {
        if (!open) onBlur?.();
      }}
    >
      <SelectTrigger id={id} ref={ref} className={className} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowEmpty ? <SelectItem value={NONE}>{emptyLabel}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            description={o.description}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
