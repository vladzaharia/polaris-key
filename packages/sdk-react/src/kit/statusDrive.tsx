"use client";
// CloudSyncStatus as the drop-in (U-42.2). The strip is the plain part; its Unlock sync and Review
// controls open the screen they name when the host does not answer them: given no `onAction`,
// inside `<PolarisKeyProvider>`, UnlockSync or RingChange opens in the kit's modal dialog over the
// strip, and focus returns to the control that opened it. A host that passes `onAction` answers them itself.
// Review on a pending save conflict opens SaveConflict (its `bytes` and `describe` are passed on);
// RingChange is for a changed ring. Try again on a failed transfer calls `onRetry`, then `onAction`:
// the saves hold no bytes to resend, so the app writes again. With neither, Try again is not
// offered: the strip says the save did not sync until the next write succeeds.

import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { PolarisContext } from "../react/context.js";
import { kitComponent } from "./kitComponent.js";
import type { KitProps } from "./component.js";
import { syncScreen } from "./syncLazy.js";
import { useBoundSaves, useTransferInput } from "./saveScreens.js";
import type {
  RingChangeProps,
  SaveConflictProps,
  UnlockSyncProps,
} from "./syncScreens.js";

const Status = kitComponent("CloudSyncStatus");
const UnlockSync = syncScreen<UnlockSyncProps>("UnlockSync");
const RingChange = syncScreen<RingChangeProps>("RingChange");
const SaveConflict = syncScreen<SaveConflictProps>("SaveConflict");

export interface CloudSyncStatusProps extends KitProps {
  /** Try again on a failed transfer: write the save again. */
  onRetry?: () => void;
  /** For the SaveConflict that Review opens: the local copy's bytes. */
  bytes?: SaveConflictProps["bytes"];
  /** For the SaveConflict that Review opens: the cards' times, device and Newer. */
  describe?: SaveConflictProps["describe"];
}

export function CloudSyncStatus(allProps: CloudSyncStatusProps): ReactNode {
  const { onRetry, bytes, describe, ...props } = allProps;
  const [open, setOpen] = useState<"unlock" | "review" | "save" | null>(null);
  const sdk = useContext(PolarisContext);
  const saves = useBoundSaves();
  const answers = props.onAction !== undefined || !sdk;
  const close = () => setOpen(null);
  const { theme, className } = props;
  // While a save moves, its transfer states draw over the host's input (K.2T).
  const { input, clearFailure, muted } = useTransferInput(
    props.input,
    onRetry !== undefined || props.onAction !== undefined,
  );
  // The screen opens in the kit's modal dialog over the strip. The control that opened it leaves
  // the strip while it is open (Review is not offered then), so on close focus goes back to the
  // strip: its Review control when it is asked again, else the strip itself, never the page.
  const strip = useRef<HTMLSpanElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open !== null) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // After the strip has redrawn without the screen.
    const t = setTimeout(() => {
      const root = strip.current;
      if (!root || root.contains(document.activeElement)) return;
      const to =
        root.querySelector<HTMLElement>(
          '[data-key="common.review"], [data-key="cloudSync.unlock"]',
        ) ??
        root.querySelector<HTMLElement>(
          '[data-part="banner"], [data-part="status"], [role]',
        );
      if (!to) return;
      if (!to.matches("button, a, [tabindex]")) to.tabIndex = -1;
      to.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <>
      <span
        ref={strip}
        data-pk-strip=""
        style={{ display: "contents" }}
        {...(muted ? { "aria-hidden": true } : {})}
      >
        <Status
          {...props}
          {...(input ? { input } : {})}
          onAction={(a) => {
            props.onAction?.(a);
            if (a.key === "common.tryAgain") {
              onRetry?.();
              clearFailure();
              return;
            }
            if (answers) return;
            if (a.key === "cloudSync.unlock") setOpen("unlock");
            else if (a.key === "common.review")
              setOpen(
                saves && saves.conflicts().length > 0 ? "save" : "review",
              );
          }}
        />
      </span>
      {open === "unlock" ? (
        <UnlockSync
          theme={theme}
          className={className}
          onDismiss={close}
          onCancel={close}
          onUnlocked={close}
        />
      ) : null}
      {open === "save" ? (
        <SaveConflict
          theme={theme}
          className={className}
          onDismiss={close}
          {...(bytes ? { bytes } : {})}
          {...(describe ? { describe } : {})}
        />
      ) : null}
      {open === "review" ? (
        <RingChange
          theme={theme}
          className={className}
          onDismiss={close}
          onCancel={close}
          onAccepted={close}
          onUseCode={() => setOpen("unlock")}
        />
      ) : null}
    </>
  );
}
