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
  /**
   * Auto-dismiss after this many ms (default {@link TOAST_DURATION_MS}). `Infinity` (or 0)
   * keeps the toast up until the user closes it.
   */
  duration?: number;
}

interface ToastContextValue {
  toast: (t: Omit<ToastMessage, "id">) => void;
  /** Shorthands the app status region used to wire mutation feedback. */
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

/** How long a toast stays up when its message sets no `duration`. */
export const TOAST_DURATION_MS = 5_000;

const ToastCtx = React.createContext<ToastContextValue | null>(null);

/**
 * App-wide toast surface. Mount once near the root (inside `Shell`/`App`); call `useToast()`
 * from anywhere to enqueue a toast. Backed by Radix's `Toast.Provider` so toasts are
 * announced to assistive tech and auto-dismiss.
 */
export function Toaster({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const seq = React.useRef(0);

  const remove = React.useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );
  const toast = React.useCallback((t: Omit<ToastMessage, "id">) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { ...t, id }]);
  }, []);
  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) =>
        toast({ title, description, variant: "success" }),
      error: (title, description) =>
        toast({ title, description, variant: "destructive" }),
    }),
    [toast],
  );

  return (
    <ToastCtx.Provider value={value}>
      <ToastProvider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <TimedToast key={t.id} message={t} onDismiss={remove} />
        ))}
        <ToastViewport />
      </ToastProvider>
    </ToastCtx.Provider>
  );
}

/**
 * One toast whose auto-dismiss timer is owned here rather than by Radix.
 *
 * Radix's `Toast` starts its close timer on open but never clears it on unmount (checked in
 * @radix-ui/react-toast 1.2.17), so a toast that is still open when its tree goes away leaves
 * the timer behind; when it fires it reads `document` for focus handling. In the browser that is
 * harmless, but under test it fired after the file's jsdom environment was torn down and
 * failed the run ("document is not defined"). Radix is therefore given `duration={Infinity}`
 * (which it treats as "never auto-close"), and this component runs the timer itself, clears it
 * on unmount, and keeps Radix's pause-on-hover/focus/window-blur through `onPause`/`onResume`.
 */
function TimedToast({
  message,
  onDismiss,
}: {
  message: ToastMessage;
  onDismiss: (id: number) => void;
}): React.ReactElement {
  const { id, duration = TOAST_DURATION_MS } = message;
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const remaining = React.useRef(duration);
  const startedAt = React.useRef(0);
  const dismiss = React.useRef(() => onDismiss(id));
  dismiss.current = () => onDismiss(id);

  const stop = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const start = React.useCallback(() => {
    stop();
    if (!Number.isFinite(remaining.current) || remaining.current <= 0) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismiss.current(), remaining.current);
  }, [stop]);
  const pause = React.useCallback(() => {
    if (timer.current === undefined) return;
    stop();
    remaining.current -= Date.now() - startedAt.current;
  }, [stop]);

  React.useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  return (
    <Toast
      variant={message.variant}
      duration={Infinity}
      onPause={pause}
      onResume={start}
      onOpenChange={(open) => {
        if (!open) onDismiss(id);
      }}
    >
      <div className="grid gap-1">
        <ToastTitle>{message.title}</ToastTitle>
        {message.description ? (
          <ToastDescription>{message.description}</ToastDescription>
        ) : null}
      </div>
      <ToastClose />
    </Toast>
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
