// NearbyApproval (plans/auto-sign-in.md §3, D-A9): the approving device's side of nearby
// sign-in. A new device asks to sign in; the person sees three 6-digit codes, one of them the code
// the new device shows, and taps it (number matching). Any other code denies and says so. Deny is
// the one other choice. The codes and the tap are the kit's; this model answers what the screen
// says. Every outcome has a title that takes focus and one way on (Done).

import type { Context } from "../input.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

export type NearbyApprovalState =
  | "entry"
  | "ask"
  | "approved"
  | "not-nearby"
  | "mismatch"
  | "denied"
  | "expired"
  | "device-limit"
  | "choose"
  | "account-required"
  | "rate-limited"
  | "hidden";

/** The approver's prompt and its outcomes, and the account menu's entry that opens it. */
export function nearbyApprovalView(
  ctx: Context,
): View<"NearbyApproval", NearbyApprovalState> {
  if (!ctx.on("identity")) return hiddenView(ctx, "NearbyApproval");
  const n = ctx.input.nearbyApproval;
  const args = { device: n?.device, product: identityText(ctx).name };
  const outcome = (
    state: NearbyApprovalState,
    copy: string[],
    primary: string | null,
    tone: "neutral" | null = null,
  ) =>
    makeView(ctx, "NearbyApproval", {
      state,
      copy,
      args,
      primary,
      tone,
      focus: "heading",
    });
  switch (n?.step) {
    case "ask":
      // No primary: choosing the matching code is the action, and Deny the only other. The
      // warning is the device-code approver's (SIGN-IN §3.11): nearby is the same attack.
      return makeView(ctx, "NearbyApproval", {
        state: "ask",
        copy: [
          "signin.nearby.ask",
          "signin.nearby.askBody",
          "signin.approve.warning",
          "signin.approve.deny",
        ],
        args,
        focus: "heading",
      });
    case "approved":
      return outcome(
        "approved",
        ["signin.nearby.approved", "common.done"],
        "common.done",
      );
    case "not-nearby":
      return outcome(
        "not-nearby",
        [
          "signin.nearby.notNearby",
          "signin.nearby.notNearbyBody",
          "common.done",
        ],
        "common.done",
        "neutral",
      );
    case "mismatch":
      return outcome(
        "mismatch",
        ["signin.nearby.mismatch", "common.done"],
        "common.done",
      );
    case "denied":
      return outcome(
        "denied",
        ["signin.approve.deniedDone", "common.done"],
        "common.done",
      );
    case "expired":
      return outcome(
        "expired",
        [
          "core.codes.sign-in-expired.title",
          "core.codes.sign-in-expired.message",
          "common.done",
        ],
        "common.done",
        "neutral",
      );
    case "device-limit":
      // The license is full on the approving device: it opens the device list (Manage devices).
      return outcome(
        "device-limit",
        [
          "core.codes.device_limit.title",
          "core.codes.device_limit.message",
          "devices.manage",
        ],
        "devices.manage",
        "neutral",
      );
    case "choose":
      // The license is chosen on the approving device (D-A10), never on the new one.
      return outcome(
        "choose",
        ["signin.choice.title", "signin.choice.lede", "signin.choice.continue"],
        "signin.choice.continue",
      );
    case "account-required":
      return outcome(
        "account-required",
        [
          "core.codes.account_required.title",
          "core.codes.account_required.message",
          "signin.key.signIn",
        ],
        "signin.key.signIn",
        "neutral",
      );
    case "rate-limited":
      return outcome(
        "rate-limited",
        [
          "core.codes.rate_limited.title",
          "core.codes.rate_limited.message",
          "common.tryAgain",
        ],
        "common.tryAgain",
        "neutral",
      );
    default:
      return makeView(ctx, "NearbyApproval", {
        state: "entry",
        copy: ["signin.nearby.menu"],
        args,
        focus: null,
      });
  }
}
