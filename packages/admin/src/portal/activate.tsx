import * as React from "react";
import { ActivateDialog } from "./components/ActivateDialog.js";

/**
 * The Activate license modal is mounted once, in the shell (PORTAL.md §5.2 `ActivateDialog`),
 * and opened from anywhere: the header action, the phone bar's pill, ⌘K, the empty library,
 * the not-found page and `/activate?key=…`.
 */
export interface ActivateRequest {
  /** A key to fill in (the deep link). */
  key?: string;
  /** The product slug an app sent along (`/activate?key=…&product=…`). */
  product?: string;
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
  const value = React.useMemo<ActivateContextValue>(
    () => ({
      open: (request = {}) =>
        setState((s) => ({ open: true, request, session: s.session + 1 })),
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
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
      />
    </ActivateCtx.Provider>
  );
}
