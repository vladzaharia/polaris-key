import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { TriangleAlert, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";

/**
 * Dialogs (components.md §4.1).
 *
 * - **Sizes:** sm 24rem, md 32rem, lg 44rem, xl 60rem.
 * - **Below 640 px** every dialog is a bottom sheet: full width, at most 92dvh, a drag-handle
 *   visual and safe-area padding (responsive classes only; SH-17). It slides up from the bottom
 *   edge (`slow`·`emphasized`) and back down (`base`·`exit`); a centred dialog rises and falls.
 *   Under reduced motion both are an instant swap (src/motion.css).
 * - `dismissible={false}` blocks Escape and outside click and removes the close button, for a
 *   dialog that is busy (fixes UI-10).
 * - One footer component, `DialogFooter`.
 * - **Focus** (FLOWS.md §2 C13, C18) goes to `initialFocusRef` (the least destructive button in a
 *   confirm), else to the first field, else to the title; never to the close button. It stays in
 *   the dialog when the focused control is disabled under it (a submit while it loads) and goes
 *   back to that control once it is enabled again. On close it returns to the opener; when the
 *   opener was a menu item, to the menu's trigger.
 * - **Unsaved input** (`unsaved`, or `useDismissGuard` from inside): Escape, an outside click and
 *   the close button ask "Discard your changes?" in the dialog instead of closing.
 */

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<DialogSize, string> = {
  sm: "sm:max-w-[24rem]",
  md: "sm:max-w-[32rem]",
  lg: "sm:max-w-[44rem]",
  xl: "sm:max-w-[60rem]",
};

// ── Focus and dismissal, shared with `Drawer` ─────────────────────────────────────────────────

/** Fields first focus may land on; buttons and links never get first focus by default. */
const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  "select:not([disabled])",
  "textarea:not([disabled]):not([readonly])",
  '[role="combobox"]:not([disabled])',
  '[role="radio"]:not([disabled])',
  '[role="checkbox"]:not([disabled])',
  '[role="switch"]:not([disabled])',
  '[contenteditable="true"]',
].join(",");

/** The first field in `root` outside its header, or `null`. */
export function firstField(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>(FIELD_SELECTOR)) {
    if (el.closest("[data-pk-overlay-header]")) continue;
    if (el.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    return el;
  }
  return null;
}

/** Where focus goes back to: the opener, or, for a menu item, the menu's trigger. */
function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  if (!opener) return null;
  const menu = opener.closest<HTMLElement>('[role="menu"]');
  if (menu) {
    const trigger = menu.getAttribute("aria-labelledby");
    const el = trigger ? document.getElementById(trigger) : null;
    if (el) return el;
  }
  return opener.isConnected ? opener : null;
}

function focusable(el: HTMLElement | null): el is HTMLElement {
  return (
    !!el &&
    el.isConnected &&
    !(el as HTMLButtonElement).disabled &&
    !el.closest("[inert]")
  );
}

/**
 * The open/close focus contract for an overlay: records the opener, picks first focus, keeps
 * focus inside when the focused control is disabled under it, and returns focus on close.
 */
export function useOverlayFocus(
  open: boolean,
  contentRef: React.RefObject<HTMLElement | null>,
  titleRef: React.RefObject<HTMLElement | null>,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
): {
  onOpenAutoFocus: (e: Event) => void;
  onCloseAutoFocus: (e: Event) => void;
} {
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  // Read during render, before Radix moves focus in.
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;

  // A control disabled under focus (a loading submit) drops focus to <body>: hold it on the
  // title, then give it back to the control when it is enabled again.
  React.useEffect(() => {
    const root = contentRef.current;
    if (!open || !root) return;
    let lost: HTMLElement | null = null;
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget !== null) return;
      const from = e.target as HTMLElement | null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (!root.isConnected) return;
        lost = from && root.contains(from) ? from : null;
        titleRef.current?.focus({ preventScroll: true });
      });
    };
    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            const el: HTMLElement | null = lost;
            if (!el) return;
            if (
              document.activeElement !== titleRef.current ||
              !el.isConnected
            ) {
              lost = null;
              return;
            }
            if (focusable(el)) {
              lost = null;
              el.focus({ preventScroll: true });
            }
          });
    root.addEventListener("focusout", onFocusOut);
    observer?.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-busy"],
    });
    return () => {
      root.removeEventListener("focusout", onFocusOut);
      observer?.disconnect();
    };
  }, [open, contentRef, titleRef]);

  return {
    onOpenAutoFocus: (e) => {
      e.preventDefault();
      const target =
        initialFocusRef?.current ??
        firstField(contentRef.current) ??
        titleRef.current;
      target?.focus({ preventScroll: true });
    },
    onCloseAutoFocus: (e) => {
      const target = returnTarget(opener.current);
      opener.current = null;
      if (!target) return;
      e.preventDefault();
      // The opener may still be disabled for a frame (a switch while its confirm was pending).
      let tries = 0;
      const attempt = (): void => {
        // Yield to whatever took focus since the close (a result panel that focuses itself, a
        // route change): the dialog's content is gone by now, so lost focus sits on <body>, and
        // focus returns only when it was lost, never as a steal.
        const active = document.activeElement;
        if (active && active !== document.body && active !== target) return;
        if (focusable(target)) {
          target.focus({ preventScroll: true });
          if (document.activeElement === target) return;
        }
        if (++tries < 10) requestAnimationFrame(attempt);
      };
      attempt();
    },
  };
}

type RegisterDirty = (id: string, dirty: boolean) => void;
/** Provided by `Dialog` and `Drawer`; read through `useDismissGuard`. */
export const DismissGuardContext = React.createContext<RegisterDirty | null>(
  null,
);

/**
 * Mark the surrounding `Dialog` or `Drawer` as holding unsaved input while `dirty`: dismissing it
 * then asks first. A no-op outside one.
 */
export function useDismissGuard(dirty: boolean): void {
  const register = React.useContext(DismissGuardContext);
  const id = React.useId();
  React.useEffect(() => {
    register?.(id, dirty);
    return () => register?.(id, false);
  }, [register, id, dirty]);
}

/** The dismissal state machine shared by `Dialog` and `Drawer`. */
export function useGuardedDismissal({
  open,
  onOpenChange,
  dismissible,
  unsaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible: boolean;
  unsaved: boolean;
}): {
  /** Escape, outside click, Close and Back go through this. */
  requestClose: () => void;
  asking: boolean;
  keepEditing: () => void;
  discard: () => void;
  /** The `DismissGuardContext` value for the overlay's children. */
  register: RegisterDirty;
} {
  const [dirtyIds, setDirtyIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [asking, setAsking] = React.useState(false);
  React.useEffect(() => {
    if (!open) setAsking(false);
  }, [open]);
  const register = React.useCallback<RegisterDirty>((id, dirty) => {
    setDirtyIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const guarded = unsaved || dirtyIds.size > 0;
  // Where focus was when the question opened; "Keep editing" puts it back.
  const before = React.useRef<HTMLElement | null>(null);
  const keepEditing = (): void => {
    const el = before.current;
    before.current = null;
    // Focus first, while the question's buttons still hold it, so it never drops to <body>.
    if (el?.isConnected) el.focus({ preventScroll: true });
    setAsking(false);
  };

  React.useEffect(() => {
    if (!guarded) setAsking(false);
  }, [guarded]);
  return {
    requestClose: () => {
      if (!dismissible) return;
      if (asking) return keepEditing();
      if (guarded) {
        const active = document.activeElement;
        before.current = active instanceof HTMLElement ? active : null;
        return setAsking(true);
      }
      onOpenChange(false);
    },
    asking,
    keepEditing,
    discard: () => {
      setAsking(false);
      onOpenChange(false);
    },
    register,
  };
}

/** "Discard your changes?", asked in place when an overlay with unsaved input is dismissed. */
export function DiscardStrip({
  onKeep,
  onDiscard,
  className,
}: {
  onKeep: () => void;
  onDiscard: () => void;
  className?: string;
}): React.ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning-border bg-warning-subtle px-6 py-3 text-sm",
        className,
      )}
    >
      <p className="flex min-w-0 flex-1 items-center gap-2 font-medium text-fg-strong">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
        Discard your changes? Nothing has been saved.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" autoFocus onClick={onKeep}>
          Keep editing
        </Button>
        <Button size="sm" variant="danger" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}

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
  /** The draft holds unsaved input: dismissing asks first. See also `useDismissGuard`. */
  unsaved?: boolean;
  /** The title element, for a flow that moves focus to it (a result step). */
  titleRef?: React.Ref<HTMLHeadingElement>;
  /**
   * The id of an element in the body that also describes the dialog (a notice the person must
   * hear on open); read after `description`.
   */
  describedBy?: string;
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
  unsaved = false,
  titleRef: titleRefProp,
  describedBy,
  className,
}: DialogProps): React.ReactElement {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const descriptionId = React.useId();
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const focus = useOverlayFocus(open, contentRef, titleRef, initialFocusRef);
  const dismissal = useGuardedDismissal({
    open,
    onOpenChange,
    dismissible,
    unsaved,
  });
  const setTitle = React.useCallback(
    (el: HTMLHeadingElement | null) => {
      titleRef.current = el;
      if (typeof titleRefProp === "function") titleRefProp(el);
      else if (titleRefProp)
        (titleRefProp as React.RefObject<HTMLHeadingElement | null>).current =
          el;
    },
    [titleRefProp],
  );
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return onOpenChange(true);
        dismissal.requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={contentRef}
          {...(role ? { role } : {})}
          {...(describedBy
            ? {
                "aria-describedby": description
                  ? `${descriptionId} ${describedBy}`
                  : describedBy,
              }
            : description
              ? {}
              : { "aria-describedby": undefined })}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
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
            // Phones: a bottom sheet that slides up from the bottom edge and back down
            // (pk-sheet, src/motion.css; S-23 §4.2). At ≥ 640 px it rises like any dialog.
            "pk-sheet inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-xl pb-[env(safe-area-inset-bottom)]",
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
          <div
            data-pk-overlay-header=""
            className="flex shrink-0 items-start gap-4 px-6 pb-2 pt-4 sm:pt-6"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <DialogPrimitive.Title
                ref={setTitle}
                tabIndex={-1}
                className="text-lg font-semibold leading-tight text-fg-strong outline-hidden"
              >
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description
                  // With `describedBy` the content names both ids itself.
                  {...(describedBy ? { id: descriptionId } : {})}
                  className="text-sm text-fg-muted"
                >
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
          {dismissal.asking ? (
            <DiscardStrip
              className="mt-2 border-t"
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

/**
 * The scrolling middle of a dialog. Whenever its content overflows (a phone on its side, 200 %
 * zoom) it joins the tab order, so a keyboard can scroll it even when it holds nothing focusable
 * (WCAG 2.1.1; axe `scrollable-region-focusable`). While it is a tab stop it is a `region` named
 * by the dialog's title ("Dialog content" when no title is reachable), and its focus ring is drawn
 * 4 px inside its edges with rounded corners.
 */
export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const overflows = useOverflowsY(ref);
  // The title's id from the dialog's own `aria-labelledby` (Radix names the content by its title).
  const [titleId, setTitleId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!overflows) return;
    const id = ref.current
      ?.closest("[role=dialog], [role=alertdialog]")
      ?.getAttribute("aria-labelledby");
    setTitleId(id && document.getElementById(id) ? id : null);
  }, [overflows]);
  const region = overflows
    ? {
        tabIndex: 0,
        role: "region",
        ...(titleId
          ? { "aria-labelledby": titleId }
          : { "aria-label": "Dialog content" }),
      }
    : {};
  return (
    <div
      ref={ref}
      {...region}
      className={cn(
        "pk-scroll min-h-0 flex-1 overflow-y-auto rounded-md px-6 py-2 text-base",
        // outline-solid: the base `:focus-visible` rule's outline-hidden leaves the outline style
        // at none, which outline-2 alone would keep.
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-4 focus-visible:outline-focus focus-visible:ring-0 focus-visible:ring-offset-0",
        className,
      )}
      {...props}
    />
  );
}

/** Whether the element's content is taller than its box, kept current as either resizes. */
function useOverflowsY(ref: React.RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (): void =>
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      measure();
    });
    mo.observe(el, { childList: true });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return overflows;
}

/** The one footer: actions end-aligned on desktop, stacked full-width on phones. */
export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "mt-2 flex shrink-0 flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-end [&>:not(.sr-only)]:w-full sm:[&>:not(.sr-only)]:w-auto",
        className,
      )}
      {...props}
    />
  );
}
