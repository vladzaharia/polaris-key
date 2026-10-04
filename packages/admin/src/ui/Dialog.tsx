import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";

/**
 * Dialogs (components.md §4.1).
 *
 * - **Sizes:** sm 24rem, md 32rem, lg 44rem, xl 60rem.
 * - **Below 640 px** every dialog is a bottom sheet: full width, at most 92dvh, a drag-handle
 *   visual and safe-area padding (responsive classes only; SH-17).
 * - `dismissible={false}` blocks Escape and outside click and removes the close button, for a
 *   dialog that is busy (fixes UI-10).
 * - One footer component, `DialogFooter`.
 * - **Focus** goes to the first focusable element (Radix), or to `initialFocusRef` (the least
 *   destructive button in a confirm); on close it returns to the invoker.
 *
 * The Radix building blocks are exported under `Dialog*Primitive`/`DialogRoot` names for the
 * legacy views (`components/ui/Dialog.tsx` re-exports them under their old names).
 */

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<DialogSize, string> = {
  sm: "sm:max-w-[24rem]",
  md: "sm:max-w-[32rem]",
  lg: "sm:max-w-[44rem]",
  xl: "sm:max-w-[60rem]",
};

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Overlay>>;
}): React.ReactElement {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 bg-black/60 animate-pk-overlay-in",
        className,
      )}
      {...props}
    />
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: DialogSize;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** False while busy: Escape, outside click and the close button do nothing. Default true. */
  dismissible?: boolean;
  children?: React.ReactNode;
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
  /** Where focus lands on open (a confirm's Cancel). Default: the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** `alertdialog` for confirmations. */
  role?: "dialog" | "alertdialog";
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  size = "md",
  title,
  description,
  dismissible = true,
  children,
  onEscapeKeyDown,
  initialFocusRef,
  role,
  className,
}: DialogProps): React.ReactElement {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissible) return;
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          {...(role ? { role } : {})}
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            if (initialFocusRef?.current) {
              e.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (!dismissible) e.preventDefault();
            onEscapeKeyDown?.(e);
          }}
          onPointerDownOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border border-border bg-surface-overlay text-fg shadow-elevation-3 outline-hidden animate-pk-in",
            // Phones: a bottom sheet.
            "inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-xl pb-[env(safe-area-inset-bottom)]",
            // ≥ 640 px: a centred dialog.
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:pb-0",
            SIZE[size],
            className,
          )}
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"
          />
          <div className="flex shrink-0 items-start gap-4 px-6 pb-2 pt-4 sm:pt-6">
            <div className="min-w-0 flex-1 space-y-1">
              <DialogPrimitive.Title className="text-lg font-bold leading-tight text-fg-strong">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-fg-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {dismissible ? (
              <DialogPrimitive.Close
                aria-label="Close"
                className="-mr-2 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X aria-hidden className="size-4" />
              </DialogPrimitive.Close>
            ) : null}
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The scrolling middle of a dialog. */
export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "pk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-2 text-base",
        className,
      )}
      {...props}
    />
  );
}

/** The one footer: actions end-aligned on desktop, stacked full-width on phones. */
export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "mt-2 flex shrink-0 flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto",
        className,
      )}
      {...props}
    />
  );
}

// ── Legacy building blocks (re-exported by components/ui/Dialog.tsx until chunk 11) ──────────

export function DialogContentPrimitive({
  className,
  children,
  hideClose,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  hideClose?: boolean;
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Content>>;
}): React.ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden",
          "rounded-lg border border-border bg-surface-overlay p-6 text-fg shadow-elevation-3 animate-pk-in",
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-sm text-fg-muted opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page"
            aria-label="Close"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeaderPrimitive({
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

export function DialogFooterPrimitive({
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

export function DialogBodyPrimitive({
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

export function DialogActionBarPrimitive({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "-mx-6 -mb-6 mt-1 flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-surface-overlay px-6 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitlePrimitive({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Title>>;
}): React.ReactElement {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        "text-lg font-bold leading-none tracking-tight text-fg-strong",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescriptionPrimitive({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Description>>;
}): React.ReactElement {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-fg-muted", className)}
      {...props}
    />
  );
}
