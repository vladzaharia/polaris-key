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
const DIFFERENT_KEY = "signin.key.differentKey";
/** Read by the manage link as its description: where it goes. */
export const OPENS_BROWSER_KEY = "signin.replace.opensBrowser";

const COPY: Record<Refusal, string[]> = {
  "key-entry-limit": [
    "core.activation.key-entry-limit.title",
    "core.activation.key-entry-limit.message",
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
  const signIn = input.capabilities?.signIn !== false;
  const manage =
    which === "key-entry-limit" && safeLink(input.activation?.manageUrl);
  const copy = [
    ...COPY[which],
    ...(signIn ? [SIGN_IN_KEY] : []),
    ...(manage ? [MANAGE_KEY] : []),
    DIFFERENT_KEY,
  ];
  return {
    ...view,
    copy,
    actions: manage ? ["open-manage-url"] : [],
    args: { ...view.args, refusal: which },
    decisions: {
      ...view.decisions,
      primary: signIn ? SIGN_IN_KEY : manage ? MANAGE_KEY : DIFFERENT_KEY,
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
export function refusalLayout(layout: Layout): Layout {
  return {
    ...layout,
    controls: [SIGN_IN_KEY, MANAGE_KEY],
    links: [DIFFERENT_KEY],
    content: [],
  };
}
