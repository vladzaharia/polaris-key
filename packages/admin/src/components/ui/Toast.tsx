import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../../lib/cn.js";

export const ToastProvider = ToastPrimitive.Provider;

export function ToastViewport({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport> & {
  ref?: React.Ref<React.ComponentRef<typeof ToastPrimitive.Viewport>>;
}) {
  return (
    <ToastPrimitive.Viewport
      ref={ref}
      className={cn(
        "fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-sm",
        className,
      )}
      {...props}
    />
  );
}

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-lg border p-4 pr-8 shadow-pk-md animate-pk-in",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-card-foreground",
        success: "border-success/40 bg-card text-card-foreground",
        destructive: "border-destructive/50 bg-card text-card-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Toast({
  className,
  variant,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> &
  VariantProps<typeof toastVariants> & {
    ref?: React.Ref<React.ComponentRef<typeof ToastPrimitive.Root>>;
  }) {
  return (
    <ToastPrimitive.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
}

export function ToastTitle({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title> & {
  ref?: React.Ref<React.ComponentRef<typeof ToastPrimitive.Title>>;
}) {
  return (
    <ToastPrimitive.Title
      ref={ref}
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  );
}

export function ToastDescription({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description> & {
  ref?: React.Ref<React.ComponentRef<typeof ToastPrimitive.Description>>;
}) {
  return (
    <ToastPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ToastClose({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close> & {
  ref?: React.Ref<React.ComponentRef<typeof ToastPrimitive.Close>>;
}) {
  return (
    <ToastPrimitive.Close
      ref={ref}
      className={cn(
        "absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label="Dismiss"
      {...props}
    >
      <X className="size-4" />
    </ToastPrimitive.Close>
  );
}
