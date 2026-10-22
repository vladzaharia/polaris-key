// Renew is drawn only when the host can renew (UI-KITS.md StatusScreen, expired). The view model
// always lists `status.renew` (the corpus pins that); the kits draw it through this one gate, so
// a host with nothing to open or handle gets Use another license alone, as SwiftUI and Compose do.

import type { UiInput } from "./input.js";
import { validLink } from "./link.js";
import type { View } from "./view.js";

/**
 * The https page Renew opens, `null` when the host handles the press itself (`renew: {}`), and
 * `undefined` when the host cannot renew: no `renew` input, or a URL that fails DL14.
 */
export function renewTarget(
  input: Pick<UiInput, "renew">,
): string | null | undefined {
  const renew = input.renew;
  if (!renew) return undefined;
  if (renew.url === undefined) return null;
  return validLink(renew.url) ?? undefined;
}

/** True when the host can renew: a handler (`renew: {}`) or a valid renew URL. */
export function canRenew(input: Pick<UiInput, "renew">): boolean {
  return renewTarget(input) !== undefined;
}

/** The view as drawn: Renew is gone without a host that can renew, and Use another license is the
 *  one primary. Any other view is returned as is. */
export function withRenew(view: View, input: Pick<UiInput, "renew">): View {
  if (
    view.component !== "StatusScreen" ||
    !view.copy.includes("status.renew") ||
    canRenew(input)
  )
    return view;
  return {
    ...view,
    copy: view.copy.filter((k) => k !== "status.renew"),
    decisions: {
      ...view.decisions,
      primary:
        view.decisions.primary === "status.renew"
          ? "status.useAnotherLicense"
          : view.decisions.primary,
    },
  };
}
