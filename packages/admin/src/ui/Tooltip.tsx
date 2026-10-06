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

/**
 * Whether the last input was a pointer: the `:focus-visible` heuristic, kept by hand because
 * focus a script moves (a menu or a sheet handing focus back to its opener) carries no modality
 * of its own, and jsdom matches `:focus-visible` on every focused element. A key press (Tab,
 * Enter, Escape) clears it, and so does a page with no input yet.
 */
let pointerInput = false;
let listening = false;
function listenForModality(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) pointerInput = false;
    },
    true,
  );
  const pointer = (): void => {
    pointerInput = true;
  };
  for (const type of ["pointerdown", "mousedown", "touchstart"] as const)
    document.addEventListener(type, pointer, true);
}

/**
 * The trigger opens its tooltip on focus (WCAG 1.4.13) unless the last input was a pointer: a
 * sheet saved with the mouse hands focus back to its "More actions" opener, and a tooltip opened
 * then would linger over the page, portaled outside every landmark (LX-14a). Keyboard focus, and
 * focus on a page with no input yet, open it as before; so does hover.
 */
export function TooltipTrigger({
  onFocus,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
  ref?: React.Ref<React.ComponentRef<typeof TooltipPrimitive.Trigger>>;
}): React.ReactElement {
  React.useEffect(listenForModality, []);
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      {...props}
      onFocus={(e) => {
        onFocus?.(e);
        // Radix skips its focus-open for a prevented event.
        if (pointerInput) e.preventDefault();
      }}
    />
  );
}

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
