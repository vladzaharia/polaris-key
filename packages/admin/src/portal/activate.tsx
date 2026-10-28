import * as React from "react";
import { ActivateDialog } from "./components/ActivateDialog.js";
import type { ActivateNext } from "./router.js";

/**
 * The Activate license modal is mounted once, in the shell (PORTAL.md §5.2 `ActivateDialog`),
 * and opened from anywhere: the header action, the phone bar's pill, ⌘K, the empty library,
 * the not-found page and `/activate#key=…`.
 */
export interface ActivateRequest {
  /** A key to fill in (the deep link). */
  key?: string;
  /** The product slug an app sent along (`/activate?product=…#key=…`). */
  product?: string;
  /** Where to go after the add (`next=free-device`, PX-W8 Q3). */
  next?: ActivateNext;
  /** The device the free-device flow is for (`for=`). */
  forDevice?: string;
  /** Where to return after the add (`return=`), not yet validated. */
  returnTo?: string;
}

interface ActivateContextValue {
  open: (request?: ActivateRequest) => void;
}

const ActivateCtx = React.createContext<ActivateContextValue>({
  open: () => undefined,
});

export function useActivate(): ActivateContextValue {
  return React.useContext(ActivateCtx);
}

export function ActivateProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [state, setState] = React.useState<{
    open: boolean;
    request: ActivateRequest;
    /** Bumps on every open, so a re-open starts from a fresh first step. */
    session: number;
  }>({ open: false, request: {}, session: 0 });
  // Back with the modal open closes the modal and leaves the page under it where it is: the open
  // modal holds one history entry of its own (same address), and Back pops that entry.
  React.useEffect(() => {
    if (!state.open) return;
    const id = `activate-${state.session}`;
    let popped = false;
    const at = window.location.href;
    try {
      window.history.pushState(
        { ...(window.history.state as object | null), pkDialog: id },
        "",
        at,
      );
    } catch {
      return;
    }
    const onPop = (): void => {
      if (
        (window.history.state as { pkDialog?: string } | null)?.pkDialog === id
      )
        return;
      popped = true;
      setState((s) => ({ ...s, open: false }));
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (popped) return;
      // Closed from inside: drop the modal's entry, unless a navigation has already left it.
      setTimeout(() => {
        const h = window.history.state as { pkDialog?: string } | null;
        if (h?.pkDialog === id && window.location.href === at)
          window.history.back();
      }, 0);
    };
  }, [state.open, state.session]);
  /** What was typed and not added: a dismissed modal (Back, Escape) opens on it again. */
  const draft = React.useRef("");
  const value = React.useMemo<ActivateContextValue>(
    () => ({
      open: (request = {}) =>
        setState((s) => ({
          open: true,
          request: {
            ...request,
            key: request.key || draft.current || undefined,
          },
          session: s.session + 1,
        })),
    }),
    [],
  );
  return (
    <ActivateCtx.Provider value={value}>
      {children}
      <ActivateDialog
        key={state.session}
        open={state.open}
        prefill={state.request.key}
        fromProduct={state.request.product}
        next={state.request.next}
        forDevice={state.request.forDevice}
        returnTo={state.request.returnTo}
        onDraft={(k) => {
          draft.current = k;
        }}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
      />
    </ActivateCtx.Provider>
  );
}
