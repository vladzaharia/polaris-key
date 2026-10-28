"use client";
// The in-app sign-in form for automatic sign-in's steps: what the ladder found (a confirm, the
// license list, the device limit) or the methods with the provider's account chooser. Loaded on
// demand by the gate (component.tsx), so a page that signs in silently never fetches it. The SDK's
// calls are mapped to ui-core's `SignInPrimitives` here; the model decides every step.

import { useMemo, type ReactNode } from "react";
import type { AutoOutcome } from "@polaris-key/ui-core";
import { primitivesOf } from "@polaris-key/ui-core/browser/sdk/autoPrimitives.js";

import type { PolarisAdapter } from "../core/index.js";
import { SignIn } from "./signin.js";
import type { KitProps } from "./component.js";

const GOOGLE = { provider: "Google" } as const;

export interface AutoFormProps {
  adapter: PolarisAdapter;
  /** What automatic sign-in found, or null for the methods. */
  seed: AutoOutcome | null;
  theme?: KitProps["theme"];
  className?: string;
  /** Leave the form for the gate's welcome. */
  onBack: () => void;
  /** Leave the form for the gate's own sign-in (the browser hand-off). */
  onFallback?: () => void;
  /** The link offer: a sheet over the app, not the gate's own screen. */
  sheet?: boolean;
}

export default function AutoForm(props: AutoFormProps): ReactNode {
  const { adapter, seed, onBack } = props;
  const newLicense = () =>
    seed?.kind === "confirm" && seed.input.license === "new";
  const primitives = useMemo(
    () => primitivesOf(adapter, () => props.onFallback?.(), newLicense),
    // The seed is read when Continue is pressed, so a new seed needs no new primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter],
  );
  return (
    <SignIn
      primitives={primitives}
      // The platform provider on the web is Google: the button names it.
      input={GOOGLE}
      presentation={props.sheet ? "sheet" : "inline"}
      replace="inline"
      {...(props.sheet ? { open: true } : { fill: true })}
      {...(seed ? { seed } : {})}
      {...(props.theme ? { theme: props.theme } : {})}
      {...(props.className ? { className: props.className } : {})}
      onClose={onBack}
      onDone={onBack}
    />
  );
}
