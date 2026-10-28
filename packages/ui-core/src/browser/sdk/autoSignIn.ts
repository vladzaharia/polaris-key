// The ladder's mapping over the SDK: shared by both web kits (React's gate and `<pk-gate config>`).
// Small and eager (the gate reads it at boot); the form that draws the steps, and its primitives
// (autoPrimitives.ts), load on demand. No framework here.

import type { AutoOutcome } from "../../signInModel.js";
import { isLicenseChoiceView } from "./core/choice.js";
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
