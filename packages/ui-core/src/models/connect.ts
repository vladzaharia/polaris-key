// The inter-account screens (ui-matrix.json `connect`, CC-19.9): LinkPairing, the window where two
// people pair their devices once, and TransferOffer, the prompt for something a contact offers
// (D-8: consent per transfer; without a handler the SDK declines). Rules the rows pin:
//   - the code is the thing both people compare; the screen asks for the comparison before any
//     button, and the confirm button comes after the categories that would be shared;
//   - the other device's label is unauthenticated: it is worded as reported by the device, never
//     as proof of who it is, and an absent label says so instead of inventing one;
//   - no state confirms by default: focus stays on the heading, so a stray Enter never links;
//   - a failed session says why in its own line (declined, timeout, full, closed) and stored
//     nothing; links turned off by the product are their own neutral state;
//   - an offer shows the contact's label and the name it chose, both isolated text.

import type { Context } from "../input.js";
import type { ConnectScreenName } from "../vocabulary.js";
import { hiddenView, makeView, type View } from "../view.js";

// ── LinkPairing ────────────────────────────────────────────────────────────────────────────────

export type LinkPairingState =
  | "open"
  | "code"
  | "confirm"
  | "linked"
  | "failed"
  | "unavailable"
  | "hidden";

const FAILED_BODY = {
  declined: "linkPairing.failedDeclined",
  timeout: "linkPairing.failedTimeout",
  full: "linkPairing.failedFull",
  closed: "linkPairing.failedClosed",
} as const;

/** The pairing window and its outcomes. */
export function linkPairingView(
  ctx: Context,
): View<"LinkPairing", LinkPairingState> {
  const p = ctx.input.linkPairing;
  if (!ctx.on("connect") || !p) return hiddenView(ctx, "LinkPairing");
  const device = p.device?.trim() ? p.device : undefined;
  const none = (p.categories ?? []).length === 0;
  switch (p.step) {
    case "code":
      // Categories first, then the choice: the person sees what would be shared before Codes match.
      return makeView(ctx, "LinkPairing", {
        state: "code",
        copy: [
          "linkPairing.codeTitle",
          "linkPairing.codeBody",
          p.code && "a11y.linkCode",
          device ? "linkPairing.reported" : "linkPairing.reportedUnnamed",
          none ? "linkPairing.sharesNone" : "linkPairing.shares",
          "linkPairing.confirm",
          "linkPairing.decline",
        ],
        args: { device, code: p.code },
        // Filled, but not focused: Enter on arrival never confirms a code nobody compared.
        primary: "linkPairing.confirm",
        focus: "heading",
      });
    case "confirm":
      return makeView(ctx, "LinkPairing", {
        state: "confirm",
        copy: ["linkPairing.waiting", "common.cancel"],
        focus: "heading",
      });
    case "linked":
      return makeView(ctx, "LinkPairing", {
        state: "linked",
        copy: [
          "linkPairing.linkedTitle",
          "linkPairing.linkedBody",
          none ? "linkPairing.sharesNone" : "linkPairing.shares",
          "common.done",
        ],
        primary: "common.done",
        focus: "heading",
      });
    case "failed": {
      const reason = p.reason ?? "closed";
      return makeView(ctx, "LinkPairing", {
        state: "failed",
        copy: [
          "linkPairing.failedTitle",
          FAILED_BODY[reason],
          "common.tryAgain",
          "common.done",
        ],
        primary: "common.tryAgain",
        tone: reason === "closed" ? "danger" : "neutral",
        errorSlot: reason === "closed" ? "screen" : null,
        focus: "heading",
      });
    }
    case "unavailable":
      return makeView(ctx, "LinkPairing", {
        state: "unavailable",
        copy: [
          "core.codes.connect_links_disabled.title",
          "core.codes.connect_links_disabled.message",
          "common.done",
        ],
        primary: "common.done",
        tone: "neutral",
        focus: "heading",
      });
    default:
      return makeView(ctx, "LinkPairing", {
        state: "open",
        copy: [
          "linkPairing.title",
          "linkPairing.openBody",
          "linkPairing.searching",
          "common.cancel",
        ],
        focus: "heading",
      });
  }
}

// ── TransferOffer ──────────────────────────────────────────────────────────────────────────────

export type TransferOfferState =
  | "ask"
  | "receiving"
  | "done"
  | "failed"
  | "hidden";

/** The prompt for something a contact offers, and what follows Accept. */
export function transferOfferView(
  ctx: Context,
): View<"TransferOffer", TransferOfferState> {
  const t = ctx.input.transferOffer;
  if (!ctx.on("connect") || !t) return hiddenView(ctx, "TransferOffer");
  const device = t.device?.trim() ? t.device : undefined;
  const args = { device, name: t.name };
  switch (t.step) {
    case "receiving":
      return makeView(ctx, "TransferOffer", {
        state: "receiving",
        copy: ["transferOffer.receiving", "common.cancel"],
        args,
        focus: "heading",
      });
    case "done":
      return makeView(ctx, "TransferOffer", {
        state: "done",
        copy: ["transferOffer.done", "common.done"],
        args,
        primary: "common.done",
        focus: "heading",
      });
    case "failed":
      return makeView(ctx, "TransferOffer", {
        state: "failed",
        copy: [
          "transferOffer.failed",
          "transferOffer.failedBody",
          "common.done",
        ],
        args,
        primary: "common.done",
        tone: "danger",
        errorSlot: "screen",
        focus: "heading",
      });
    default:
      // No default focus on Accept: consent is a deliberate press, never a stray Enter.
      return makeView(ctx, "TransferOffer", {
        state: "ask",
        copy: [
          device ? "transferOffer.ask" : "transferOffer.askUnnamed",
          "transferOffer.askBody",
          "transferOffer.accept",
          "transferOffer.decline",
        ],
        args,
        primary: "transferOffer.accept",
        focus: "heading",
      });
  }
}

/** The inter-account screens' models, by name (`viewOf` answers them). */
export const CONNECT_MODELS: Readonly<
  Record<ConnectScreenName, (ctx: Context) => View<ConnectScreenName>>
> = {
  LinkPairing: linkPairingView,
  TransferOffer: transferOfferView,
};
