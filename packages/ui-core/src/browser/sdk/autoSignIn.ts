// The ladder's mapping and the form's primitives over the SDK: shared by both web kits (React's
// gate and `<pk-gate config>`). Small and eager (the gate reads it at boot); the form that draws
// the steps loads on demand. No framework here.

import type {
  AutoOutcome,
  ChoiceComplete,
  LicenseChoiceInput,
  SignInPrimitives,
  SignInSessionHandle,
} from "../../signInModel.js";
import { isLicenseChoiceView, type ChoiceRefusal } from "./core/choice.js";
import type { AutoSignInResult, PolarisAdapter } from "./core/index.js";

/** The longest the gate holds its checking screen for automatic sign-in. */
export const AUTO_WAIT_MS = 10_000;

/** One run per adapter: a remounted gate shares the first's answer. */
const runs = new WeakMap<PolarisAdapter, Promise<AutoSignInResult>>();

/** `identity.autoSignIn()` once at boot. */
export function autoSignInOnce(a: PolarisAdapter): Promise<AutoSignInResult> {
  let run = runs.get(a);
  if (!run) {
    run = a
      .autoSignIn()
      .catch(
        (): AutoSignInResult => ({ kind: "unavailable", code: "refused" }),
      );
    runs.set(a, run);
  }
  return run;
}

/** The ladder's result as the form's outcome; `null` when the gate carries on as before
 *  (signed in: the license state moves by itself; unavailable: the normal sign-in). */
export function outcomeOf(r: AutoSignInResult): AutoOutcome | null {
  switch (r.kind) {
    case "confirm": {
      const c = r.consent;
      const anchor = c.items.find((i) => i.kind === "license");
      const a = anchor?.kind === "license" ? anchor.anchor : null;
      const claims = c.items.flatMap((i) =>
        i.kind === "profile" ? i.claims : [],
      );
      return {
        kind: "confirm",
        grant: r.grant,
        expiresIn: r.expiresIn,
        claims,
        input: {
          ...(c.as.email ? { email: c.as.email } : {}),
          license: a ? "existing" : "new",
          alsoGets: c.firstTime || c.changed,
          ...(a
            ? {
                anchor: {
                  name: a.name,
                  term: a.term,
                  ...(a.seat
                    ? { position: a.seat.position, limit: a.seat.limit }
                    : {}),
                },
              }
            : {}),
        },
      };
    }
    case "choose":
      return isLicenseChoiceView(r.choices)
        ? {
            kind: "choose",
            grant: r.grant,
            expiresIn: r.expiresIn,
            choices: r.choices,
          }
        : null;
    case "deviceLimit":
      return {
        kind: "deviceLimit",
        ...(r.view ? { view: r.view } : {}),
        ...(r.manageUrl ? { manageUrl: r.manageUrl } : {}),
      };
    case "needsSignIn":
      // Kept for every reason: Welcome's Sign in opens the form with the provider's button.
      // Only `noLink` and `terms` open it at boot.
      return { kind: "needsSignIn" };
    default:
      return null;
  }
}

/** Run the ladder once, giving up after `waitMs` (a late answer still moves the license state by
 *  itself). `open` is true when the answer asks for the in-app form straight away. */
export async function runAuto(
  a: PolarisAdapter,
  waitMs: number,
): Promise<{ seed: AutoOutcome | null; open: boolean }> {
  let cap: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    cap = setTimeout(() => resolve(null), waitMs);
  });
  const r = await Promise.race([autoSignInOnce(a), late]);
  clearTimeout(cap);
  if (r === null) return { seed: null, open: false };
  const seed = outcomeOf(r);
  return {
    seed,
    open:
      seed !== null &&
      (seed.kind !== "needsSignIn" ||
        (r.kind === "needsSignIn" &&
          (r.reason === "noLink" || r.reason === "terms"))),
  };
}

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
