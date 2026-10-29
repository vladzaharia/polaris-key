// The one sign-in form's steps (SIGN-IN.md §3.17), shared by both web renderers: which view the
// card's body draws for one snapshot, and the order of travel the step morph reads. No Lit, no DOM.

import { viewOf, type UiInput, type View } from "@polaris-key/ui-core";

/** The form's input: ui-core's, plus the device picked in the Replace step (kit-side). */
export type FormInput = UiInput & { replacePick?: string };

/** The step the form's body draws for one snapshot, and the order of travel. */
export interface FormStep {
  /** The form's own view (SignIn): its state names the step. */
  form: View;
  /** The view whose body the card draws: SignIn's, or the step part's (handoff, license choice). */
  body: View;
  /** Keys the form announces without drawing (a desktop notification's words). */
  announce: string[];
}

/** Steps in order of travel: a step later in the list is forward (enters from the inline end). */
export const FORM_ORDER: readonly string[] = [
  "methods",
  "error",
  "handoff",
  "code",
  "expired",
  "finishing",
  "choose",
  "key",
  "replace",
  "key-done",
  "attach",
  "added",
  "done",
];

/** Merge the form's own keys into the step part's view (one title, one set of controls). */
function merged(form: View, part: View, extra: string[] = []): View {
  const copy = [
    ...extra,
    ...form.copy.filter(
      (k) => k !== "signin.desktop.notifyChoose" && !part.copy.includes(k),
    ),
    ...part.copy,
  ].filter((k, i, all) => all.indexOf(k) === i);
  return { ...part, copy };
}

/** The step the form shows for `input`. */
export function formStep(input: UiInput): FormStep {
  const form = viewOf("SignIn", input);
  const announce = form.copy.filter((k) => k === "signin.desktop.notifyChoose");
  switch (form.state) {
    case "code":
      // Step 2 by code: the handoff part draws the code view in the form's body.
      return { form, body: viewOf("SignInHandoff", input), announce };
    case "choose":
      return {
        form,
        body: merged(form, viewOf("LicenseChoice", input)),
        announce,
      };
    case "replace":
      // Step 3b: the license list morphs into the devices, under "Replace a device" (§3.7).
      return {
        form,
        body: merged(form, viewOf("LicenseChoice", input), [
          "deviceLimit.title",
        ]),
        announce,
      };
    case "key-done":
    case "attach":
    case "added":
      // After a key with no account (UK-42): the holders' screens, drawn by the form's own view.
      return { form, body: form, announce: [] };
    case "error": {
      // A failed method keeps the others: the methods step, with the failure under the title.
      const methods = viewOf("SignIn", { ...input, error: undefined });
      if (methods.state !== "methods") return { form, body: form, announce };
      return {
        form,
        body: {
          ...methods,
          state: form.state,
          copy: [
            ...form.copy,
            ...methods.copy.filter((k) => !form.copy.includes(k)),
          ],
        },
        announce,
      };
    }
    default:
      return { form, body: form, announce };
  }
}
