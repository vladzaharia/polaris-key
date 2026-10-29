// The holders family (ui-matrix.json `holders`, UK-42): activation without an account. After a key
// activates the license is floating, held by the key alone; ActivateDone says so and recommends an
// account once, quietly; AddToAccount collects a name and an email, and the browser confirms the
// email. The rules the rows pin:
//   - the reasons are written once (`recommendReasons`): Cloud Sync only when the product has it;
//     getting the license back and moving it to a new device only when Identity is on; with
//     Identity off the one line sends the person to the portal;
//   - the holder is `profile.email` of the license: empty is floating, set is waiting for that
//     email, which a screen shows masked (`maskEmail`) and never in full;
//   - skipping is never a refusal: Start using is always the one primary, and "Continue without an
//     account" is a line under the card, never a second filled control.

import { maskEmail } from "../format.js";
import { coarsePointer, type Context } from "../input.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";
import type { HolderScreenName } from "../vocabulary.js";

// ── The reasons ─────────────────────────────────────────────────────────────────────────────────

/** The services that decide which reasons a product has. */
export interface ReasonServices {
  identity: boolean;
  /** Cloud Sync. It requires Identity, so it counts only with it. */
  sync: boolean;
}

/**
 * The copy keys of the recommendation's reason lines, in the order they show. Written once, for the
 * Done step and the portal's on-ramp alike: Cloud Sync only when the product has it, getting the
 * license back and moving it to a new device when Identity is on, and with Identity off the single
 * `activate.recommend.portal` line. The first words of each line are a lead-in a renderer may style.
 */
export function recommendReasons(services: ReasonServices): string[] {
  if (!services.identity) return ["activate.recommend.portal"];
  return [
    ...(services.sync ? ["activate.recommend.sync"] : []),
    "activate.recommend.recover",
    "activate.recommend.devices",
  ];
}

/** The reasons for what the input's services turn on. */
export function reasonsOf(ctx: Context): string[] {
  return recommendReasons({
    identity: ctx.on("identity"),
    sync: ctx.on("sync"),
  });
}

// ── ActivateDone ────────────────────────────────────────────────────────────────────────────────

export type ActivateDoneState = "ready" | "waiting" | "hidden";

/**
 * The step after a license key activates: "<Product> is ready", the license line, and the
 * recommendation when no email holds the license. A license sent to an email that has no account
 * yet shows the waiting line instead, with Sign in as <masked email>.
 */
export function activateDoneView(
  ctx: Context,
): View<"ActivateDone", ActivateDoneState> {
  const done = ctx.input.activateDone;
  if (!ctx.on("license") || !done) return hiddenView(ctx, "ActivateDone");
  const id = identityText(ctx);
  const a = ctx.input.activation;
  const args = {
    product: id.name,
    developer: id.developer ?? id.name,
    tier: done.tier ?? a?.tier,
    term: done.term ?? a?.term,
    deviceKind: done.deviceKind,
    n: done.position,
    limit: done.limit,
  };
  // A holder email too malformed to mask counts as none: no sentence renders with an empty email.
  const masked = maskEmail(ctx.input.licenseHolder?.email);
  if (masked) {
    return makeView(ctx, "ActivateDone", {
      state: "waiting",
      copy: [
        "activate.done.title",
        "activate.done.device",
        "activate.waiting",
        "activate.waitingSignIn",
        "signin.done.start",
      ],
      args: { ...args, maskedEmail: masked },
      primary: "signin.done.start",
    });
  }
  return makeView(ctx, "ActivateDone", {
    state: "ready",
    copy: [
      "activate.done.title",
      "activate.done.device",
      "activate.recommend.title",
      "activate.recommend.badge",
      ...reasonsOf(ctx),
      // With Identity off the action opens polaris.locker, so it says that (an external link).
      ctx.on("identity") ? "activate.recommend.action" : "signin.key.addInLocker",
      !ctx.on("identity") && "a11y.externalLink",
      "activate.recommend.skip",
      "signin.done.start",
    ],
    args,
    primary: "signin.done.start",
  });
}

// ── AddToAccount ────────────────────────────────────────────────────────────────────────────────

export type AddToAccountState =
  | "form"
  | "invalid"
  | "busy"
  | "added"
  | "owned"
  | "email-bound"
  | "other-account"
  | "failed"
  | "hidden";

const NAME = "activate.attach.name";
const EMAIL = "signin.email.label";

/** Add your name and email: the person types them here, the browser confirms the email. */
export function addToAccountView(
  ctx: Context,
  stepOverride?: "added",
): View<"AddToAccount", AddToAccountState> {
  const a = ctx.input.addToAccount;
  if (!ctx.on("identity") || !ctx.on("license") || !a)
    return hiddenView(ctx, "AddToAccount");
  const id = identityText(ctx);
  const args = {
    product: id.name,
    deviceKind: a.deviceKind,
    maskedEmail:
      a.typedEmail || maskEmail(ctx.input.licenseHolder?.email) || undefined,
    email: a.signedEmail || undefined,
  };
  const step = stepOverride ?? a.step;
  // DL9: Name takes focus; a field never does under a coarse pointer, where the heading does.
  const nameFocus = coarsePointer(ctx.platform) ? "heading" : NAME;
  const fields = [
    "activate.recommend.action",
    "activate.attach.lede",
    NAME,
    EMAIL,
    "activate.attach.fine",
    "common.continue",
    "common.cancel",
  ];
  switch (step) {
    case "form":
      return makeView(ctx, "AddToAccount", {
        state: "form",
        copy: fields,
        args,
        primary: "common.continue",
        focus: nameFocus,
      });
    case "invalid": {
      const field = a.field ?? "both";
      const bad =
        field === "both" ? [NAME, EMAIL] : [field === "name" ? NAME : EMAIL];
      return makeView(ctx, "AddToAccount", {
        state: "invalid",
        copy: [
          ...fields,
          bad.includes(NAME) && "activate.attach.nameRequired",
          bad.includes(EMAIL) && "signin.email.invalid",
        ],
        args,
        primary: "common.continue",
        tone: "danger",
        // The message sits under the first field that is wrong (DL7).
        errorSlot: bad[0]!,
        focus: bad[0] === NAME ? nameFocus : bad[0],
      });
    }
    case "busy":
      return makeView(ctx, "AddToAccount", {
        state: "busy",
        // The person is in the browser, which can take minutes: Continue stays (busy), Open the
        // browser again brings the tab back, and Cancel is the way out (DL9).
        copy: [
          ...fields.filter((k) => k !== "common.cancel"),
          "common.working",
          "signin.handoff.again",
          "common.cancel",
        ],
        args,
        primary: "common.continue",
        focus: null,
      });
    case "added": {
      // From Settings the app is already running: the screen closes with Done.
      const closing = a.fromSettings ? "common.done" : "signin.done.start";
      return makeView(ctx, "AddToAccount", {
        state: "added",
        copy: [
          "activate.attach.done",
          // Cloud Sync is named only when the product has it.
          ctx.on("sync") && "activate.attach.syncOn",
          closing,
        ],
        args,
        primary: closing,
      });
    }
    case "owned":
      // Someone attached the license while this screen was open (frame 45).
      return makeView(ctx, "AddToAccount", {
        state: "owned",
        copy: [
          "activate.owned.title",
          "activate.owned.lede",
          "signin.key.ownedSignIn",
          "common.cancel",
        ],
        args,
        primary: "signin.key.ownedSignIn",
        tone: "neutral",
      });
    case "email-bound":
      // The license's email is not the account's (frame 46); the license keeps working.
      return makeView(ctx, "AddToAccount", {
        state: "email-bound",
        copy: [
          "activate.otherEmail.title",
          // The sentence names the email; with none known it is left out, never half-written.
          args.maskedEmail && "activate.otherEmail.body",
          "activate.otherEmail.verify",
          "signin.auto.confirm.other",
          "signin.done.start",
        ],
        args,
        primary: "activate.otherEmail.verify",
        tone: "neutral",
      });
    case "other-account":
      // A different account signed in than the email typed: the license was added nowhere.
      return makeView(ctx, "AddToAccount", {
        state: "other-account",
        copy: [
          "activate.otherAccount.title",
          args.maskedEmail && args.email && "activate.otherAccount.body",
          "common.tryAgain",
          "signin.done.start",
        ],
        args,
        primary: "common.tryAgain",
        tone: "neutral",
      });
    case "failed":
      return makeView(ctx, "AddToAccount", {
        state: "failed",
        copy: [
          "activate.recommend.action",
          "activate.attach.failed",
          "common.tryAgain",
          "common.cancel",
        ],
        args,
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "common.tryAgain",
      });
  }
}

export const HOLDER_MODELS: Readonly<
  Record<HolderScreenName, (ctx: Context) => View<HolderScreenName>>
> = {
  ActivateDone: activateDoneView,
  AddToAccount: (ctx) => addToAccountView(ctx),
};
