import * as React from "react";
import { confirmFor, type ActionId } from "../../../../lib/actions.js";
import type { ConfirmIntent } from "../../../../ui/ConfirmDialog.js";

/** The `ConfirmDialog` intent §5.2 assigns an action (L1 caution, L2/L3 danger). */
export function intentOf(action: ActionId): ConfirmIntent {
  const intent = confirmFor(action).intent;
  return intent === "none" ? "neutral" : intent;
}

/** Thrown by a save the operator cancelled at its confirmation: not an error to show. */
export class SaveCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "SaveCancelled";
  }
}

/**
 * A confirmation inside a save: `await gate.ask(payload)` opens the dialog and resolves `true`
 * on confirm, `false` on cancel. The page renders one `ConfirmDialog` from `open`, `payload`,
 * `confirm` and `cancel`. Used where a `SaveBar` save needs an L1 confirm first (disabling a
 * service), so the form stays the one place that writes.
 */
export function useConfirmGate<P>(): {
  ask: (payload: P) => Promise<boolean>;
  open: boolean;
  payload: P | null;
  confirm: () => void;
  cancel: () => void;
} {
  const [payload, setPayload] = React.useState<P | null>(null);
  const resolver = React.useRef<((ok: boolean) => void) | null>(null);
  const settle = (ok: boolean): void => {
    resolver.current?.(ok);
    resolver.current = null;
    setPayload(null);
  };
  React.useEffect(() => () => resolver.current?.(false), []);
  return {
    ask: (p) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setPayload(p);
      }),
    open: payload !== null,
    payload,
    confirm: () => settle(true),
    cancel: () => settle(false),
  };
}
