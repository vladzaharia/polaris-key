"use client";
// The views a desktop host's menu items open over the app (gate.tsx loads this on demand).

import type { ReactNode } from "react";

import type { PolarisAdapter } from "../core/index.js";
import type { KitView } from "../desktop/bridge.js";
import { DrivenSettings, DrivenUpdate } from "./drive.js";

export default function OpenedViews(props: {
  view: KitView;
  adapter: PolarisAdapter;
  version?: string;
  onClose: () => void;
}): ReactNode {
  const { view, adapter, version, onClose } = props;
  if (view === "settings")
    return <DrivenSettings adapter={adapter} onDismiss={onClose} />;
  if (view === "update")
    return (
      <DrivenUpdate
        adapter={adapter}
        opened={{ onClose }}
        {...(version !== undefined ? { version } : {})}
      />
    );
  return null;
}
