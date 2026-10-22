import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowLeft, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
  DialogOverlay,
  DiscardStrip,
  type DiscardWords,
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
  /** The words of the "discard" question, when the default does not fit. */
  discard?: DiscardWords;
  /** A line above the title ("DJDL · Licenses"): where the drawer belongs. */
  eyebrow?: React.ReactNode;
  /** The ONE leading glyph of the head (B4): the subject's mark for a record, never a service tile. */
  glyph?: React.ReactNode;
  /**
   * What the phone header's control is. `back` (default) is a "Back" that closes; `close` is an X
   * at every width, for a drawer whose body has its own Back (a wizard); `close-narrow` is that X
   * below sm only, for one whose footer carries a Cancel from sm up.
   */
  closeStyle?: "back" | "close" | "close-narrow";
  /** Replaces the default return of focus to the opener (the handler says where focus goes). */
  onCloseAutoFocus?: (e: Event) => void;
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
  discard,
  eyebrow,
  glyph,
  closeStyle = "back",
  onCloseAutoFocus,
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
          onCloseAutoFocus={onCloseAutoFocus ?? focus.onCloseAutoFocus}
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
          // The 3 px top rule in the origin's accent is the spec'd one (B4, B17).
          data-edge="canvas"
          className={cn(
            // The 3 px rule in the origin's accent (B4, B17) along the panel's top edge.
            "pk-drawer fixed inset-0 z-50 flex flex-col bg-surface-overlay text-fg outline-hidden console:border-t-[3px] console:border-t-accent",
            "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
            "lg:inset-y-0 lg:w-full lg:shadow-elevation-3",
            side === "end"
              ? "lg:start-auto lg:end-0 lg:border-s lg:border-border"
              : "lg:start-0 lg:end-auto lg:border-e lg:border-border",
            size === "lg" ? "lg:max-w-[40rem]" : "lg:max-w-[28rem]",
            className,
          )}
        >
          <div
            data-pk-overlay-header=""
            // At large text on a phone the header is compact: Back on its own line, a smaller title, a
            // two-line description, so the form keeps the room (P4).
            className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 lg:px-6 lg:py-4 console:bg-(--pk-admin-band-overlay) bigtext:max-lg:flex-wrap conbig:max-lg:flex-wrap bigtext:max-lg:gap-x-2 conbig:max-lg:gap-x-2 bigtext:max-lg:gap-y-0 conbig:max-lg:gap-y-0 bigtext:max-lg:py-2 conbig:max-lg:py-2"
          >
            {closeStyle === "back" ? (
              <button
                type="button"
                onClick={close}
                disabled={!dismissible}
                className="-ms-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-fg hover:bg-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus lg:hidden"
              >
                <ArrowLeft aria-hidden className="size-4" />
                Back
              </button>
            ) : null}
            {glyph ? (
              <span aria-hidden data-overlay-glyph="" className="mt-0.5 flex">
                {glyph}
              </span>
            ) : null}
            <div className="min-w-0 flex-1 space-y-1 bigtext:max-lg:basis-full conbig:max-lg:basis-full bigtext:max-lg:space-y-0.5 conbig:max-lg:space-y-0.5">
              {eyebrow ? (
                <p className="truncate text-xs text-fg-muted">{eyebrow}</p>
              ) : null}
              <DialogPrimitive.Title
                ref={titleRef}
                tabIndex={-1}
                className="text-lg font-semibold leading-tight text-fg-strong outline-hidden forced-colors:outline-none console:text-xl console:leading-7 bigtext:max-lg:text-base conbig:max-lg:text-base"
              >
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-fg-muted bigtext:max-lg:line-clamp-2 conbig:max-lg:line-clamp-2 bigtext:max-lg:text-xs conbig:max-lg:text-xs">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {dismissible || closeStyle !== "back" ? (
              <DialogPrimitive.Close
                aria-label="Close"
                disabled={!dismissible}
                className={cn(
                  "-me-2 size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50",
                  closeStyle === "close"
                    ? "inline-flex"
                    : closeStyle === "close-narrow"
                      ? // Below sm only: from sm up the body's own Cancel is the way out.
                        "inline-flex sm:hidden"
                      : "hidden lg:inline-flex",
                )}
              >
                <X aria-hidden className="size-4" />
              </DialogPrimitive.Close>
            ) : null}
          </div>
          {dismissal.asking ? (
            <DiscardStrip
              className="px-4 lg:px-6"
              words={discard}
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
        // At large text on a phone the actions share rows instead of stacking one per line (P4).
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end lg:px-6 bigtext:max-lg:flex-row-reverse conbig:max-lg:flex-row-reverse bigtext:max-lg:flex-wrap conbig:max-lg:flex-wrap bigtext:max-lg:justify-start conbig:max-lg:justify-start bigtext:max-lg:gap-x-2 conbig:max-lg:gap-x-2 bigtext:max-lg:gap-y-1 conbig:max-lg:gap-y-1 bigtext:max-lg:py-2 conbig:max-lg:py-2",
        className,
      )}
      {...props}
    />
  );
}
