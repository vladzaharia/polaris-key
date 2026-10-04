import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../lib/cn.js";

/**
 * A click-opened, focusable, Escape-dismissable panel (components.md §4.5): the home for "why"
 * explanations, full hashes and matrix cell detail on hover-less devices. Never modal, so it does
 * not lock scroll.
 */
export const PopoverRoot = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = "start",
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof PopoverPrimitive.Content>>;
}): React.ReactElement {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 max-w-sm rounded-lg border border-border bg-surface-overlay p-3 text-sm text-fg shadow-elevation-3 outline-hidden animate-pk-in",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/** A trigger plus its panel. `label` names the panel for assistive tech. */
export function Popover({
  trigger,
  children,
  label,
  side,
  align,
  className,
  open,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        aria-label={label}
        className={className}
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
  );
}
