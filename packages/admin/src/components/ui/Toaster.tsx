import * as React from "react";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./Toast.js";

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  variant?: "default" | "success" | "destructive";
  /** Auto-dismiss after this many ms (Radix default 5000). */
  duration?: number;
}

interface ToastContextValue {
  toast: (t: Omit<ToastMessage, "id">) => void;
  /** Shorthands the app status region used to wire mutation feedback. */
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastCtx = React.createContext<ToastContextValue | null>(null);

/**
 * App-wide toast surface. Mount once near the root (inside `Shell`/`App`); call `useToast()`
 * from anywhere to enqueue a toast. Backed by Radix's `Toast.Provider` so toasts are
 * announced to assistive tech and auto-dismiss.
 */
export function Toaster({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const seq = React.useRef(0);

  const remove = React.useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  const toast = React.useCallback((t: Omit<ToastMessage, "id">) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { ...t, id }]);
  }, []);
  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ title, description, variant: "success" }),
      error: (title, description) => toast({ title, description, variant: "destructive" }),
    }),
    [toast],
  );

  return (
    <ToastCtx.Provider value={value}>
      <ToastProvider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            duration={t.duration}
            onOpenChange={(open) => {
              if (!open) remove(t.id);
            }}
          >
            <div className="grid gap-1">
              <ToastTitle>{t.title}</ToastTitle>
              {t.description ? <ToastDescription>{t.description}</ToastDescription> : null}
            </div>
            <ToastClose />
          </Toast>
        ))}
        <ToastViewport />
      </ToastProvider>
    </ToastCtx.Provider>
  );
}

/** Enqueue toasts from anywhere under a `<Toaster>`. No-ops (dev-warns) if unmounted. */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) {
    return {
      toast: () => undefined,
      success: () => undefined,
      error: () => undefined,
    };
  }
  return ctx;
}
