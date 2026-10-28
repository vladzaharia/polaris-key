"use client";
// CloudSyncStatus as the drop-in (U-42.2). The strip is the plain part; its Unlock sync and Review
// controls open the screen they name when the host does not answer them: given no `onAction`,
// inside `<PolarisKeyProvider>`, UnlockSync or RingChange opens in the kit's modal dialog over the
// strip, and focus returns to the control that opened it. A host that passes `onAction` answers them itself.

import { useContext, useState, type ReactNode } from "react";

import { PolarisContext } from "../react/context.js";
import { kitComponent } from "./kitComponent.js";
import type { KitProps } from "./component.js";
import { syncScreen } from "./syncLazy.js";
import type { RingChangeProps, UnlockSyncProps } from "./syncScreens.js";

const Status = kitComponent("CloudSyncStatus");
const UnlockSync = syncScreen<UnlockSyncProps>("UnlockSync");
const RingChange = syncScreen<RingChangeProps>("RingChange");

export function CloudSyncStatus(props: KitProps): ReactNode {
  const [open, setOpen] = useState<"unlock" | "review" | null>(null);
  const sdk = useContext(PolarisContext);
  const answers = props.onAction !== undefined || !sdk;
  const close = () => setOpen(null);
  const { theme, className } = props;
  // The screen opens in the kit's modal dialog over the strip; closing it hands focus back to
  // the control that opened it.
  return (
    <>
      <Status
        {...props}
        onAction={(a) => {
          props.onAction?.(a);
          if (answers) return;
          if (a.key === "cloudSync.unlock") setOpen("unlock");
          else if (a.key === "common.review") setOpen("review");
        }}
      />
      {open === "unlock" ? (
        <UnlockSync
          theme={theme}
          className={className}
          onDismiss={close}
          onCancel={close}
          onUnlocked={close}
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
