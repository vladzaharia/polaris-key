import * as React from "react";
import { AppToaster, toast as appToast } from "../../ui/toast.js";

/**
 * LEGACY adapter (ADMIN.md §7.2 chunk 3; deleted in chunk 11). The views written against the old
 * Radix toaster call `useToast()`; it now forwards to `src/ui/toast.tsx` (sonner), so every view
 * gets the new durations (errors stay until dismissed), stacking and dedupe with no edits.
 */
export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  variant?: "default" | "success" | "destructive";
  /** Auto-dismiss after this many ms; `Infinity` keeps the toast up until it is closed. */
  duration?: number;
}

interface ToastContextValue {
  toast: (t: Omit<ToastMessage, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const VALUE: ToastContextValue = {
  toast: ({ title, description, variant, duration }) => {
    const opts = { description, duration };
    if (variant === "destructive") appToast.error(title, opts);
    else if (variant === "success") appToast.success(title, opts);
    else appToast.info(title, opts);
  },
  success: (title, description) => appToast.success(title, { description }),
  error: (title, description) => appToast.error(title, { description }),
};

/** Mounts the app toaster beside `children`. */
export function Toaster({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      {children}
      <AppToaster />
    </>
  );
}

/** Enqueue toasts from anywhere. */
export function useToast(): ToastContextValue {
  return VALUE;
}
