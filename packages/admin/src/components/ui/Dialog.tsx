import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../../lib/cn.js";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Overlay>>;
}) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-pk-overlay-in",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  hideClose,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  hideClose?: boolean;
} & { ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Content>> }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden",
          "rounded-lg border border-border bg-card p-6 text-card-foreground shadow-pk-lg animate-pk-in",
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "pk-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1",
        className,
      )}
      {...props}
    />
  );
}

export function DialogActionBar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "-mx-6 -mb-6 mt-1 flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-card/95 px-6 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Title>>;
}) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Description>>;
}) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
