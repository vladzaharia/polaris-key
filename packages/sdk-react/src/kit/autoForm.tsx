"use client";
// The in-app sign-in form for automatic sign-in's steps: what the ladder found (a confirm, the
// license list, the device limit) or the methods with the provider's account chooser. Loaded on
// demand by the gate (component.tsx), so a page that signs in silently never fetches it. The SDK's
// calls are mapped to ui-core's `SignInPrimitives` here; the model decides every step.

import { useMemo, type ReactNode } from "react";
import type {
  AutoOutcome,
  ChoiceComplete,
  LicenseChoiceInput,
  SignInPrimitives,
  SignInSessionHandle,
} from "@polaris-key/ui-core";

import type { PolarisAdapter } from "../core/index.js";
import type { ChoiceRefusal } from "../core/choice.js";
import { outcomeOf } from "./autoMap.js";
import { SignIn } from "./signin.js";
import type { KitProps } from "./component.js";

/** A sign-in that left the form for the gate's own flow: nothing to follow here. */
const LEFT: SignInSessionHandle = {
  wait: () => new Promise<never>(() => {}),
  reopen: () => false,
  cancel: () => {},
};

const refusal = (r: unknown): r is ChoiceRefusal =>
  (r as { kind?: string } | null)?.kind === "refused";

function unwrap<V>(r: { kind: "ok"; view: V } | ChoiceRefusal): V {
  if (r.kind === "ok") return r.view;
  throw new Error(r.code);
}

/** The SDK's calls as the form's primitives. `leave` runs the gate's own sign-in (the browser
 *  hand-off, the code), which the form's other methods start. */
export function primitivesOf(
  adapter: PolarisAdapter,
  leave: () => void,
  newLicense: () => boolean,
): SignInPrimitives {
  return {
    start: async () => {
      leave();
      return LEFT;
    },
    choice: {
      licenses: async (g) => unwrap(await adapter.choice.licenses(g)),
      devices: async (g, id) => unwrap(await adapter.choice.devices(g, id)),
      complete: async (grant, choice, options) => {
        const r = await adapter.choice.complete(
          grant,
          choice as LicenseChoiceInput | undefined,
          options?.consent
            ? { consent: { claims: options.consent.claims } }
            : {},
        );
        if (r.kind === "ok")
          return {
            outcome: "signedIn",
            issuedNow: choice === undefined ? newLicense() : false,
          } satisfies ChoiceComplete;
        if (!refusal(r)) throw new Error("sign-in-failed");
        if (r.code === "invalid_grant")
          return { outcome: "expired" } satisfies ChoiceComplete;
        if (r.code === "license_choice_required" && r.view)
          return {
            outcome: "choose",
            choices: r.view,
          } satisfies ChoiceComplete;
        if (r.code === "device_limit")
          return choice === undefined
            ? ({
                outcome: "deviceLimit",
                ...(r.view ? { view: r.view } : {}),
                ...(r.manageUrl ? { manageUrl: r.manageUrl } : {}),
              } satisfies ChoiceComplete)
            : ({ outcome: "raced" } satisfies ChoiceComplete);
        throw new Error(r.code);
      },
      cancel: async (g) => {
        await adapter.choice.cancel(g);
      },
    },
    activate: async (key) => {
      const r = await adapter.activateWithKey(key);
      return {
        result: "ok",
        ...(r.keyEntries ? { keyEntries: r.keyEntries } : {}),
      };
    },
    // The person pressed the provider's button: its chooser may show, and a sign-out lifts.
    autoSignIn: async (): Promise<AutoOutcome | null> => {
      const r = await adapter.autoSignIn({
        prompt: "optional",
        explicit: true,
      });
      if (r.kind === "signedIn") return { kind: "signedIn", issuedNow: false };
      return outcomeOf(r);
    },
  };
}

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
      presentation="inline"
      replace="inline"
      fill
      {...(seed ? { seed } : {})}
      {...(props.theme ? { theme: props.theme } : {})}
      {...(props.className ? { className: props.className } : {})}
      onClose={onBack}
      onDone={onBack}
    />
  );
}
