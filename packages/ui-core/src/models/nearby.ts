// NearbyApproval (plans/auto-sign-in.md §3, D-A9): the approving device's side of nearby
// sign-in. A new device asks to sign in; the person sees three 6-digit codes, one of them the code
// the new device shows, and taps it (number matching). Any other code, or Not now, denies. The
// codes and the tap are the kit's; this model answers what the screen says.

import type { Context } from "../input.js";
import { hiddenView, makeView, type View } from "../view.js";

export type NearbyApprovalState =
  | "entry"
  | "ask"
  | "approved"
  | "not-nearby"
  | "hidden";

/** The approver's prompt and its outcomes, and the account menu's entry that opens it. */
export function nearbyApprovalView(
  ctx: Context,
): View<"NearbyApproval", NearbyApprovalState> {
  if (!ctx.on("identity")) return hiddenView(ctx, "NearbyApproval");
  const n = ctx.input.nearbyApproval;
  const args = { device: n?.device };
  switch (n?.step) {
    case "ask":
      // No primary: choosing the matching code is the action, and Not now the only other.
      return makeView(ctx, "NearbyApproval", {
        state: "ask",
        copy: [
          "signin.nearby.ask",
          "signin.nearby.askBody",
          "signin.nearby.deny",
        ],
        args,
        focus: "heading",
      });
    case "approved":
      return makeView(ctx, "NearbyApproval", {
        state: "approved",
        copy: ["signin.nearby.approved"],
        args,
      });
    case "not-nearby":
      return makeView(ctx, "NearbyApproval", {
        state: "not-nearby",
        copy: ["signin.nearby.notNearby"],
        args,
        tone: "neutral",
      });
    default:
      return makeView(ctx, "NearbyApproval", {
        state: "entry",
        copy: ["signin.nearby.menu"],
        args,
        focus: null,
      });
  }
}
