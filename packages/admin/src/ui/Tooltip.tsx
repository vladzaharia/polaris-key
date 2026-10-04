import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../lib/cn.js";

/**
 * Tooltips are for labels and short explanations only (components.md §4.5): never the only home
 * of data an operator needs. Anything that matters (a reason, a blocker, a hash) is visible text,
 * a `Popover` or a drawer. Each `Tooltip` carries its own provider, so it works anywhere.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof TooltipPrimitive.Content>>;
}): React.ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs rounded-md border border-border bg-surface-overlay px-2.5 py-1.5 text-xs text-fg shadow-elevation-2 animate-pk-in",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** A trigger plus its tooltip text. The child must accept a ref (a button, a link). */
export function Tooltip({
  content,
  children,
  side,
  delayDuration = 300,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}): React.ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipRoot>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </TooltipRoot>
    </TooltipPrimitive.Provider>
  );
}
