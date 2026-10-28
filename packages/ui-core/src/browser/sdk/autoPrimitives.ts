// The form's primitives over the SDK (shared by both web kits' sign-in forms). Loaded with the
// form, never at the gate's boot: the ladder's own mapping stays in autoSignIn.ts.

import type {
  AutoOutcome,
  ChoiceComplete,
  LicenseChoiceInput,
  SignInPrimitives,
  SignInSessionHandle,
} from "../../signInModel.js";
import { ErrorCode } from "./constants.generated.js";
import { outcomeOf } from "./autoSignIn.js";
import { isLicenseChoiceView, type ChoiceRefusal } from "./core/choice.js";
import type { PolarisAdapter } from "./core/index.js";

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
 *  hand-off), which the form's other methods start. */
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
    ...(adapter.link
      ? {
          link: {
            accept: async () => {
              let r;
              try {
                r = await adapter.link!.accept();
              } catch (e) {
                // The connection is worth another try; a refused key or proof is not.
                return (e as { code?: string } | null)?.code ===
                  ErrorCode.networkError
                  ? ("network" as const)
                  : ("failed" as const);
              }
              if (r.kind === "linked") return "linked" as const;
              if (r.kind === "unavailable") return "none" as const;
              if (r.code === ErrorCode.linkConflict) return "conflict" as const;
              return r.code === ErrorCode.stepUpRequired
                ? ("stale" as const)
                : ("failed" as const);
            },
            decline: () => adapter.link!.decline(),
          },
        }
      : {}),
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
