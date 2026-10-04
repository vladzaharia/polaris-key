import * as React from "react";
import { blockNavigation, navigate } from "../console/router.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export interface UnsavedChangesGuardOptions {
  /** The dialog title: "Discard unsaved changes to this license?" */
  message?: string;
  /** What leaving loses, one line per effect. */
  consequences?: string[];
  /** Runs before the navigation proceeds on Discard (e.g. `form.discard`). */
  onDiscard?: () => void;
  /**
   * Navigations that keep the draft and so need no confirm: a record's own route tabs, whose
   * panels stay mounted while dirty (`TabPanel`, LDT-4).
   */
  allow?: (nextHash: string) => boolean;
}

export interface UnsavedChangesGuard {
  /** Render this once on the page: the "Keep editing / Discard" confirm. */
  dialog: React.ReactElement;
  /** A navigation is waiting on the operator's answer. */
  pending: boolean;
}

/**
 * Guard a dirty draft against leaving (components.md §3.5; fixes SH-6, LDT-4, PRF-6). While
 * `isDirty`, the router's blocker refuses route changes, product switches and route-tab changes,
 * and opens a confirm offering **Keep editing** or **Discard**; Discard runs `onDiscard` and then
 * follows the refused navigation. A reload or tab close gets the browser's own prompt
 * (`beforeunload`).
 */
export function useUnsavedChangesGuard(
  isDirty: boolean,
  opts: UnsavedChangesGuardOptions = {},
): UnsavedChangesGuard {
  const [next, setNext] = React.useState<string | null>(null);
  const bypass = React.useRef(false);
  const dirty = React.useRef(isDirty);
  dirty.current = isDirty;
  const allow = React.useRef(opts.allow);
  allow.current = opts.allow;

  React.useEffect(() => {
    if (!isDirty) return;
    const unblock = blockNavigation((hash) => {
      if (bypass.current || !dirty.current) return true;
      if (allow.current?.(hash)) return true;
      setNext(hash);
      return false;
    });
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirty.current) return;
      e.preventDefault();
      // Older engines need a returnValue to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unblock();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isDirty]);

  const {
    message = "Discard unsaved changes?",
    consequences,
    onDiscard,
  } = opts;

  const dialog = (
    <ConfirmDialog
      open={next !== null}
      onOpenChange={(open) => {
        if (!open) setNext(null);
      }}
      intent="caution"
      title={message}
      consequences={
        consequences ?? [
          "Your changes on this page are lost. Nothing has been saved.",
        ]
      }
      cancelLabel="Keep editing"
      confirmLabel="Discard"
      onConfirm={() => {
        const target = next;
        setNext(null);
        onDiscard?.();
        if (target !== null) {
          bypass.current = true;
          try {
            navigate(target);
          } finally {
            bypass.current = false;
          }
        }
      }}
    />
  );

  return { dialog, pending: next !== null };
}
