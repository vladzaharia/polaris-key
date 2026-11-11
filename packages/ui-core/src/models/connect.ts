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
import type { ConnectScreenName, ScreenName } from "../vocabulary.js";
import { hiddenView, makeView, type View } from "../view.js";
import { LOCAL_MODELS } from "./local.js";

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
      // This person confirmed; the other may still be comparing against this screen, so the code, the
      // reported line and the categories stay until the pairing completes or fails.
      return makeView(ctx, "LinkPairing", {
        state: "confirm",
        copy: [
          "linkPairing.waiting",
          p.code && "a11y.linkCode",
          device ? "linkPairing.reported" : "linkPairing.reportedUnnamed",
          none ? "linkPairing.sharesNone" : "linkPairing.shares",
          "common.cancel",
        ],
        args: { device, code: p.code },
        focus: "heading",
      });
    case "linked":
      return makeView(ctx, "LinkPairing", {
        state: "linked",
        copy: [
          "linkPairing.linkedTitle",
          device ? "linkPairing.linkedWith" : "linkPairing.linkedBody",
          none ? "linkPairing.sharesNone" : "linkPairing.shares",
          "common.done",
        ],
        args: { device },
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
        // "full" cannot succeed until a pairing is removed: Done leads, Try again stays available.
        primary: reason === "full" ? "common.done" : "common.tryAgain",
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

/** A name for a heading: at most [limit] characters, the middle elided so the extension stays. */
export function shortName(name: string, limit = 40): string {
  const chars = [...name];
  if (chars.length <= limit) return name;
  const keep = limit - 1;
  const tail = Math.ceil(keep / 2);
  return `${chars.slice(0, keep - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** A category id as words when the app gave it no label: "photos" → "Photos", "tax-forms" or "voice_memos" → "Tax forms", "Voice memos". */
export function categoryFallback(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words === "" ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The prompt for something a contact offers, and what follows Accept. */
export function transferOfferView(
  ctx: Context,
): View<"TransferOffer", TransferOfferState> {
  const t = ctx.input.transferOffer;
  if (!ctx.on("connect") || !t) return hiddenView(ctx, "TransferOffer");
  const device = t.device?.trim() ? t.device : undefined;
  // The title carries a shortened name; the kit shows the whole one on its own row.
  const args = { device, name: shortName(t.name) };
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
  ...LOCAL_MODELS,
};

/**
 * The control Escape answers on the inter-account screens: decline a code or an offer, cancel a
 * window, close a finished screen. `null` where Escape does nothing: a transfer in flight is
 * stopped by its own Cancel, never by a stray key.
 */
export function connectEscape(view: View<ScreenName>): string | null {
  if (view.component === "TransferOffer" && view.state === "receiving")
    return null;
  if (view.component === "LocalPairing" || view.component === "PairedDevices")
    return (
      // Not now on a prompt, Cancel on a window or a busy Pair (R8), Back on the field; while a
      // row is edited Cancel is the editor's, and Escape closes nothing else.
      [
        "common.notNow",
        "common.cancel",
        "common.back",
        "common.close",
        "common.done",
      ].find((k) => view.copy.includes(k)) ?? null
    );
  return (
    [
      "linkPairing.decline",
      "transferOffer.decline",
      "common.cancel",
      "common.done",
    ].find((k) => view.copy.includes(k)) ?? null
  );
}
