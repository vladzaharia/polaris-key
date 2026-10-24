"use client";
// `<PolarisKeyGate>`, the drop-in root. It is its own module so a web page's entry stays lean: the
// Settings and update-check drivers that a desktop host's menu items open (drive.tsx) load only when
// such an item is chosen (openedViews.tsx), not with the gate.

import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { PolarisAdapter } from "../core/index.js";
import type { KitView } from "../desktop/bridge.js";
import { PolarisContext } from "../react/context.js";
import {
  PolarisKeyGate as Gate_,
  type PolarisKeyGateProps,
} from "./component.js";

const OpenedViews = lazy(() => import("./openedViews.js"));

/**
 * What the host asked the window to open (`PolarisAdapter.onOpen`, a native menu item): the drop-in
 * Settings, or an update check that ends in the prompt or "You're up to date", each as a modal
 * dialog over the app. Closing returns focus to what held it. Draws nothing when nothing is open.
 * The request is taken at once; the drivers behind it load when it arrives.
 */
function OpenedHost(props: { adapter: PolarisAdapter; version?: string }) {
  const { adapter, version } = props;
  const [view, setView] = useState<KitView | null>(null);
  useEffect(() => adapter.onOpen?.((v) => setView(v)), [adapter]);
  const onClose = useCallback(() => setView(null), []);
  if (view === null) return null;
  return (
    <Suspense fallback={null}>
      <OpenedViews
        view={view}
        adapter={adapter}
        onClose={onClose}
        {...(version !== undefined ? { version } : {})}
      />
    </Suspense>
  );
}

/**
 * `<PolarisKeyGate>`, with the host's menu requests wired in: on a desktop host that can ask
 * (`adapter.onOpen`), a native "Manage license" or "Check for updates" item opens Settings or the
 * update prompt over the app, in this window. The app's children are where it lives, so it shows
 * only while the license lets the app run (a gate screen is never covered by it).
 */
export function PolarisKeyGate(props: PolarisKeyGateProps): ReactNode {
  const sdk = useContext(PolarisContext);
  if (props.input !== undefined || !sdk?.adapter.onOpen)
    return <Gate_ {...props} />;
  return (
    <Gate_ {...props}>
      {props.children}
      <OpenedHost
        adapter={sdk.adapter}
        {...(sdk.version !== undefined ? { version: sdk.version } : {})}
      />
    </Gate_>
  );
}
