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
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AutoOutcome } from "@polaris-key/ui-core";
import type { PolarisAdapter } from "../core/index.js";
import type { KitView } from "../desktop/bridge.js";
import { PolarisContext } from "../react/context.js";
import {
  PolarisKeyGate as Gate_,
  type KitProps,
  type PolarisKeyGateProps,
  type SignInStepArgs,
} from "./component.js";

const OpenedViews = lazy(() => import("./openedViews.js"));
const AutoForm = lazy(() => import("./autoForm.js"));

/**
 * What the host asked the window to open (`PolarisAdapter.onOpen`, a native menu item): the drop-in
 * Settings, or an update check that ends in the prompt or "You’re up to date", each as a modal
 * dialog over the app. Closing returns focus to what held it. Draws nothing when nothing is open.
 * The request is taken at once; the drivers behind it load when it arrives.
 */
function OpenedHost(props: {
  adapter: PolarisAdapter;
  version?: string;
  theme?: KitProps["theme"];
}) {
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
        onCheckUpdates={() => setView("update")}
        {...(props.theme ? { theme: props.theme } : {})}
        {...(version !== undefined ? { version } : {})}
      />
    </Suspense>
  );
}

/**
 * The link offer after a redirect sign-in (identity.link): a sheet over the app, asked once when
 * the app runs. Nothing loads unless the adapter says a redirect sign-in landed; the offer, its
 * form and the link engine load then.
 */
function LinkHost(props: {
  adapter: PolarisAdapter;
  theme?: KitProps["theme"];
}) {
  const { adapter } = props;
  const [seed, setSeed] = useState<AutoOutcome | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    const check = (): void => {
      if (asked.current || !adapter.link?.pending()) return;
      asked.current = true;
      void import("./autoMap.js")
        .then((m) => m.linkOfferOutcome(adapter))
        .then(setSeed)
        .catch(() => undefined);
    };
    check();
    return adapter.subscribe(check);
  }, [adapter]);
  // Escape, Close and the answers all end here; only No thanks remembers anything. A tab that
  // dismisses is not asked again until the next sign-in.
  const onClose = useCallback(() => {
    void adapter.link?.dismiss();
    setSeed(null);
  }, [adapter]);
  // Too old a sign-in: the regular sign-in, then the offer links in one tap.
  const signInAgain = useCallback(() => {
    void adapter.signInWithOidc().catch(() => undefined);
  }, [adapter]);
  if (seed === null) return null;
  return (
    <Suspense fallback={null}>
      <AutoForm
        adapter={adapter}
        seed={seed}
        sheet
        onBack={onClose}
        onFallback={signInAgain}
        {...(props.theme ? { theme: props.theme } : {})}
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
  const signInStep = (a: SignInStepArgs) => (
    <Suspense fallback={null}>
      <AutoForm {...a} />
    </Suspense>
  );
  const link = props.input === undefined && sdk?.adapter.link !== undefined;
  if (props.input !== undefined || (!sdk?.adapter.onOpen && !link))
    return <Gate_ signInStep={signInStep} {...props} />;
  return (
    <Gate_ signInStep={signInStep} {...props}>
      {props.children}
      {link && sdk ? (
        <LinkHost
          adapter={sdk.adapter}
          {...(props.theme ? { theme: props.theme } : {})}
        />
      ) : null}
      {sdk?.adapter.onOpen ? (
        <OpenedHost
          adapter={sdk.adapter}
          {...(props.theme ? { theme: props.theme } : {})}
          {...(sdk.version !== undefined ? { version: sdk.version } : {})}
        />
      ) : null}
    </Gate_>
  );
}
