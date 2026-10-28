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

/** The manage link's label: the key step's title plus the new-window glyph (interim, until
 *  I-46.1's `signin.key.addInLocker`). */
export const MANAGE_KEY = "signin.key.addTitle";
export const SIGN_IN_KEY = "welcome.signIn";
/** license-owned's primary: the account that holds the license (M4). */
export const OWNED_SIGN_IN_KEY = "signin.key.ownedSignIn";
/** A sign-in that failed to start: the one callout on the step. */
export const REFUSAL_ERROR_KEY = "core.codes.sign-in-failed.message";
const DIFFERENT_KEY = "signin.key.differentKey";
/** Read by the manage link as its description: where it goes. */
export const OPENS_BROWSER_KEY = "signin.replace.opensBrowser";

const COPY: Record<Refusal, string[]> = {
  // The title says it; the sentence is the product-named one, not a restatement.
  "key-entry-limit": [
    "core.activation.key-entry-limit.title",
    "signin.key.noEntries",
  ],
  // The product-named words: the license is this product's.
  "license-owned": [
    "core.codes.license_owned.title",
    "core.codes.license_owned.message",
  ],
};

/** True for a view the refusal step replaces: Activate's rejected state, the form's key step. */
function replaced(view: View): boolean {
  return (
    (view.component === "Activate" && view.state === "rejected") ||
    (view.component === "SignIn" && view.state === "key")
  );
}

/** The focused step for a refusal, or `null` when `view` is not the key step of one. */
export function refusalView(view: View, input: UiInput): View | null {
  const which = refusalOf(input);
  if (!which || !replaced(view)) return null;
  const canSignIn = input.capabilities?.signIn !== false;
  const manage =
    which === "key-entry-limit" && safeLink(input.activation?.manageUrl);
  // license-owned: Sign in to that account. Where the build cannot sign in itself, the product's
  // sign-in page is the link (and says so with the new-window glyph).
  const ownedLink =
    which === "license-owned" &&
    !canSignIn &&
    safeLink(input.activation?.signInUrl);
  const signIn =
    which === "license-owned"
      ? canSignIn || ownedLink
        ? OWNED_SIGN_IN_KEY
        : null
      : canSignIn
        ? SIGN_IN_KEY
        : null;
  const failed = input.error?.code;
  const copy = [
    ...COPY[which],
    ...(signIn ? [signIn] : []),
    ...(manage ? [MANAGE_KEY] : []),
    DIFFERENT_KEY,
    ...(view.component === "SignIn" ? ["common.cancel"] : []),
    ...(failed ? [REFUSAL_ERROR_KEY] : []),
  ];
  return {
    ...view,
    copy,
    actions: manage ? ["open-manage-url"] : [],
    args: {
      ...view.args,
      refusal: which,
      ...(ownedLink ? { signInLink: 1 } : {}),
    },
    decisions: {
      ...view.decisions,
      primary: signIn ?? (manage ? MANAGE_KEY : DIFFERENT_KEY),
      tone: "neutral",
      errorSlot: null,
      focus: "heading",
    },
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
    content: [],
  };
}
