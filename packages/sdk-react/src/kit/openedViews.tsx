"use client";
// The views a desktop host's menu items open over the app (gate.tsx loads this on demand).

import type { ReactNode } from "react";

import type { PolarisAdapter } from "../core/index.js";
import type { KitView } from "../desktop/bridge.js";
import type { KitProps } from "./component.js";
import { DrivenSettings, DrivenUpdate } from "./drive.js";

export default function OpenedViews(props: {
  view: KitView;
  adapter: PolarisAdapter;
  version?: string;
  theme?: KitProps["theme"];
  onClose: () => void;
  onCheckUpdates: () => void;
}): ReactNode {
  const { view, adapter, version, onClose } = props;
  const theme = props.theme ? { theme: props.theme } : {};
  if (view === "settings")
    return (
      <DrivenSettings
        adapter={adapter}
        onDismiss={onClose}
        onCheckUpdates={props.onCheckUpdates}
        {...(version !== undefined ? { version } : {})}
        {...theme}
      />
    );
  if (view === "update")
    return (
      <DrivenUpdate
        adapter={adapter}
        opened={{ onClose }}
        {...theme}
        {...(version !== undefined ? { version } : {})}
      />
    );
  return null;
}
