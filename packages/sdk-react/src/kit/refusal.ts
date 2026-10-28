// The two key refusals no other key can fix (UI-KITS DL6, ui-matrix Activate): the key has no
// entries left, or its license already sits in another account. Both are one focused step, in
// the order of the Compose kit (the UX ruling): product header, title, one sentence, then the
// actions: Sign in (the primary), the manage link where there is one, and Use a different key.
// No key field, no lede. ui-core's views keep the corpus's stacked form; the drop-in draws this.

import type { UiInput, View } from "@polaris-key/ui-core";

import type { Layout } from "./contract.js";
import { safeLink } from "./links.js";

export type Refusal = "key-entry-limit" | "license-owned";

/** The refusal a snapshot holds, if it is one of the two. */
export function refusalOf(input: UiInput): Refusal | null {
  const a = input.activation;
  if (!a) return null;
  if (a.result === "key-entry-limit" || a.code === "key_entry_limit")
    return "key-entry-limit";
  if (a.result === "license-owned" || a.code === "license_owned")
    return "license-owned";
  return null;
}

/** The manage link's label (ui-core's `keyRefusalSpec`): "Add it in Polaris Locker" plus the
 *  new-window glyph. */
export const MANAGE_KEY = "signin.key.addInLocker";
export const SIGN_IN_KEY = "signin.key.signIn";
/** license-owned's primary: the account that holds the license (M4). */
export const OWNED_SIGN_IN_KEY = "signin.key.ownedSignIn";
/** A sign-in that failed to start: the one callout on the step. */
export const REFUSAL_ERROR_KEY = "core.codes.sign-in-failed.message";
const DIFFERENT_KEY = "signin.key.differentKey";
/** Read by the manage link as its description: where it goes. */
export const OPENS_BROWSER_KEY = "signin.replace.opensBrowser";

/** True for a view the refusal step replaces: Activate's two refusal states, the form's
 *  `key-refused` step (I-46.1 renamed all three). */
function replaced(view: View): boolean {
  return (
    (view.component === "Activate" &&
      (view.state === "key-entry-limit" || view.state === "license-owned")) ||
    (view.component === "SignIn" && view.state === "key-refused")
  );
}

/** The focused step for a refusal, or `null` when `view` is not the key step of one. The copy and
 *  the primary are ui-core's `keyRefusalSpec` (the corpus pins them, TV's QR included); the drop-in
 *  adds the form's Cancel and the callout for a sign-in that failed to start. */
export function refusalView(view: View, input: UiInput): View | null {
  const which = refusalOf(input);
  if (!which || !replaced(view)) return null;
  const canSignIn = input.capabilities?.signIn !== false;
  // license-owned on a build that cannot sign in itself: the product's sign-in page is the link
  // (and says so with the new-window glyph).
  const ownedLink =
    which === "license-owned" &&
    !canSignIn &&
    safeLink(input.activation?.signInUrl);
  const failed = input.error?.code;
  const copy = [
    ...view.copy,
    ...(view.component === "SignIn" && !view.copy.includes("common.cancel")
      ? ["common.cancel"]
      : []),
    ...(failed ? [REFUSAL_ERROR_KEY] : []),
  ];
  return {
    ...view,
    copy,
    args: {
      ...view.args,
      refusal: which,
      ...(ownedLink ? { signInLink: 1 } : {}),
    },
    decisions: { ...view.decisions, errorSlot: null, focus: "heading" },
  };
}

/** Whether `view` is a refusal step drawn by `refusalView`. */
export const isRefusalStep = (view: View): boolean =>
  view.args.refusal === "key-entry-limit" ||
  view.args.refusal === "license-owned";

/** The layout of a refusal step: the three actions, the quiet one a link, nothing else. */
export function refusalLayout(layout: Layout, component: string): Layout {
  return {
    ...layout,
    controls: [SIGN_IN_KEY, OWNED_SIGN_IN_KEY, MANAGE_KEY],
    // The form's step also offers Cancel (its Escape).
    links:
      component === "SignIn"
        ? [DIFFERENT_KEY, "common.cancel"]
        : [DIFFERENT_KEY],
  };
}
