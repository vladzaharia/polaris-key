import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowLeft, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
  DialogOverlay,
  DiscardStrip,
  DismissGuardContext,
  useGuardedDismissal,
  useOverlayFocus,
} from "./Dialog.js";

/**
 * A side sheet (components.md §4.3) for peek, detail and secondary forms; it replaces the
 * restyled Dialog (DEV-2). Modal, with the same focus contract as `Dialog`: first focus on the
 * first field or the title (never Close or Back), trapped, Escape closes unless `dismissible` is
 * false, and focus returns to the opener. `unsaved` (or `useDismissGuard` inside) makes Escape,
 * Close and Back ask "Discard your changes?" first. The background is scroll-locked through the
 * CSP-safe shim.
 *
 * - **≥ 1024 px:** a panel from the end (or start) side, md 28rem or lg 40rem, with a close
 *   button.
 * - **Below 1024 px:** full-screen, with a "Back" button in place of the close button.
 *
 * **Routed drawers** keep their id in the URL (`#/p/djdl/devices/dev_123`), so the drawer is
 * linkable and Back closes it. The page owns the route; `routedDrawer` turns "the route has an id"
 * into `open`/`onOpenChange`:
 *
 * ```tsx
 * <Drawer {...routedDrawer(route.id, () => navigate(r.devices(slug)))} title="Device">…</Drawer>
 * ```
 */
export function routedDrawer(
  id: string | undefined | null,
  close: () => void,
): { open: boolean; onOpenChange: (open: boolean) => void } {
  return {
    open: id !== undefined && id !== null && id !== "",
    onOpenChange: (open) => {
      if (!open) close();
    },
  };
}

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  side?: "end" | "start";
  size?: "md" | "lg";
  /** False while busy: Escape, outside click, Back and close do nothing. Default true. */
  dismissible?: boolean;
  /** The draft holds unsaved input: dismissing asks first. See also `useDismissGuard`. */
  unsaved?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  side = "end",
  size = "md",
  dismissible = true,
  unsaved = false,
  children,
  className,
}: DrawerProps): React.ReactElement {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const focus = useOverlayFocus(open, contentRef, titleRef);
  const dismissal = useGuardedDismissal({
    open,
    onOpenChange,
    dismissible,
    unsaved,
  });
  const close = dismissal.requestClose;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return onOpenChange(true);
        dismissal.requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay className="hidden lg:block" />
        <DialogPrimitive.Content
          ref={contentRef}
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onEscapeKeyDown={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          // The panel slides in from its edge and back out (src/motion.css `.pk-drawer`; S-23 §6.1).
          data-drawer-side={side}
          className={cn(
            "pk-drawer fixed inset-0 z-50 flex flex-col bg-surface-overlay text-fg outline-hidden",
            "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
            "lg:inset-y-0 lg:w-full lg:shadow-elevation-3",
            side === "end"
              ? "lg:left-auto lg:right-0 lg:border-l lg:border-border"
              : "lg:left-0 lg:right-auto lg:border-r lg:border-border",
            size === "lg" ? "lg:max-w-[40rem]" : "lg:max-w-[28rem]",
            className,
          )}
        >
          <div
            data-pk-overlay-header=""
            className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 lg:px-6 lg:py-4"
          >
            <button
              type="button"
              onClick={close}
              disabled={!dismissible}
              className="-ml-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-fg hover:bg-hover disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus lg:hidden"
            >
              <ArrowLeft aria-hidden className="size-4" />
              Back
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <DialogPrimitive.Title
                ref={titleRef}
                tabIndex={-1}
                className="text-lg font-bold leading-tight text-fg-strong outline-hidden"
              >
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
                className="-mr-2 hidden size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus lg:inline-flex"
              >
                <X aria-hidden className="size-4" />
              </DialogPrimitive.Close>
            ) : null}
          </div>
          {dismissal.asking ? (
            <DiscardStrip
              className="px-4 lg:px-6"
              onKeep={dismissal.keepEditing}
              onDiscard={dismissal.discard}
            />
          ) : null}
          <DismissGuardContext.Provider value={dismissal.register}>
            {children}
          </DismissGuardContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The scrolling middle of a drawer. */
export function DrawerBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "pk-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm lg:px-6",
        className,
      )}
      {...props}
    />
  );
}

/** Actions pinned to the bottom of a drawer. */
export function DrawerFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end lg:px-6",
        className,
      )}
      {...props}
    />
  );
}
