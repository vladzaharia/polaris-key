import * as React from "react";
import { Toaster as Sonner, toast as sonner, type ExternalToast } from "sonner";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useTheme } from "../components/theme.js";
import { errorCopy, type ErrorContext } from "../lib/errorCopy.js";

/**
 * The console's toasts (components.md §5.1), on sonner.
 *
 * - A toast confirms something that happened. Validation and form errors are inline, never
 *   toast-only.
 * - Durations: success and info 4 s, warning 8 s, error persistent until dismissed (UI-11).
 * - At most 3 visible; identical toasts dedupe by id (default: variant + title).
 * - `action` is for a safe inverse only (Undo a disable, a yank, a pause).
 * - `toast.error(apiError)` words it through `errorCopy`: never "api 422".
 *
 * sonner's CSS is bundled by styles.css (vite.config.ts stops its inline `<style>`); the toasts
 * are `unstyled` and dressed with brand utilities here.
 */

export const TOAST_DURATIONS = {
  success: 4_000,
  info: 4_000,
  warning: 8_000,
  error: Infinity,
} as const;

export type ToastVariant = keyof typeof TOAST_DURATIONS;

export interface ToastOptions {
  description?: React.ReactNode;
  /** Dedupe key; defaults to `variant:title`. */
  id?: string;
  /** Overrides the variant's duration (ms; `Infinity` keeps it up). */
  duration?: number;
  /** A safe inverse ("Undo"). */
  action?: { label: string; onClick: () => void };
  /** For `error`: what the request was about. */
  context?: ErrorContext;
}

function show(
  variant: ToastVariant,
  title: string,
  opts: ToastOptions = {},
): string | number {
  const data: ExternalToast = {
    id: opts.id ?? `${variant}:${title}`,
    description: opts.description,
    duration: opts.duration ?? TOAST_DURATIONS[variant],
    action: opts.action
      ? { label: opts.action.label, onClick: () => opts.action!.onClick() }
      : undefined,
  };
  return sonner[variant](title, data);
}

export const toast = {
  success: (title: string, opts?: ToastOptions) => show("success", title, opts),
  info: (title: string, opts?: ToastOptions) => show("info", title, opts),
  warning: (title: string, opts?: ToastOptions) => show("warning", title, opts),
  /** An `ApiError` (or any thrown value) is worded by `errorCopy`; a string is the title. */
  error: (errorOrTitle: unknown, opts?: ToastOptions) => {
    if (typeof errorOrTitle === "string")
      return show("error", errorOrTitle, opts);
    const copy = errorCopy(errorOrTitle, opts?.context);
    return show("error", copy.title, {
      ...opts,
      description: opts?.description ?? copy.description,
    });
  },
  dismiss: (id?: string | number) => sonner.dismiss(id),
};

/** Is the viewport phone-sized? (Toasts move to the top there.) */
function usePhone(): boolean {
  const query = "(max-width: 639px)";
  const [phone, setPhone] = React.useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setPhone(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return phone;
}

let mounted = 0;

const ICON_CLASS = "size-4 shrink-0";

/**
 * Mount once near the root. Bottom-end on desktop, top on phones. When the last toaster unmounts
 * (a test tree, a full reload), the toasts still showing are dismissed, so none is replayed into
 * the next toaster.
 */
export function AppToaster(): React.ReactElement {
  const { theme } = useTheme();
  const phone = usePhone();
  React.useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      // After sonner's own unsubscribe, so the dismissal schedules no frame.
      queueMicrotask(() => {
        if (mounted === 0) sonner.dismiss();
      });
    };
  }, []);
  return (
    <Sonner
      theme={theme}
      position={phone ? "top-center" : "bottom-right"}
      visibleToasts={3}
      closeButton
      containerAriaLabel="Notifications"
      icons={{
        success: (
          <CheckCircle2 aria-hidden className={`${ICON_CLASS} text-success`} />
        ),
        info: <Info aria-hidden className={`${ICON_CLASS} text-info`} />,
        warning: (
          <AlertTriangle aria-hidden className={`${ICON_CLASS} text-warning`} />
        ),
        error: <XCircle aria-hidden className={`${ICON_CLASS} text-danger`} />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group flex w-full items-start gap-3 rounded-lg border border-border bg-surface-overlay p-4 pr-10 text-sm text-fg shadow-elevation-3 sm:w-[22rem]",
          success: "border-success-border",
          info: "border-info-border",
          warning: "border-warning-border",
          error: "border-danger-border",
          icon: "mt-0.5",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "font-bold text-fg-strong",
          description: "text-fg-muted",
          actionButton:
            "ml-auto inline-flex h-7 shrink-0 items-center rounded-md border border-border-strong px-2 text-xs text-fg-strong hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
          closeButton:
            "absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
        },
      }}
    />
  );
}
