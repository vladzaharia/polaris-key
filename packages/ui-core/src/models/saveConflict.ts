// The saveConflict family (ui-matrix.json `saveConflict`, U-22.K0): SaveConflict, shown when the
// same save changed on two devices. The person picks one; the kit never settles it for them.
//   - a save is never discarded without a choice: `choose` offers every way on and takes no
//     default, so nothing is focused but the heading and there is no filled control;
//   - Keep both is a copy of the other save under a new name and needs a free slot of the 16: with
//     none (or when the input does not say) it is drawn disabled, with its reason, and not offered;
//   - when the other copy was deleted there is nothing to keep or copy: Keep the other becomes
//     Delete it here too, its own button (danger), Keep both goes, and the screen has its own
//     title and lede;
//   - a choice is applied once: while it runs no control is offered, and `kept` names the choice
//     that was made, never another, and never after a failure.

import type { Context } from "../input.js";
import { hiddenView, makeView, type View } from "../view.js";

export type SaveConflictState =
  | "choose"
  | "keeping"
  | "kept"
  | "failed"
  | "hidden";

/** The strings of `kept`, by the choice made (`deleted` when the other copy was gone). */
const KEPT = {
  local: "saveConflict.keptLocal",
  remote: "saveConflict.keptRemote",
  both: "saveConflict.keptBoth",
  deleted: "saveConflict.keptDeleted",
} as const;

/** A save conflict: choose, being applied, applied, or failed. */
export function saveConflictView(
  ctx: Context,
): View<"SaveConflict", SaveConflictState> {
  const c = ctx.input.saveConflict;
  if (!ctx.on("sync") || !c) return hiddenView(ctx, "SaveConflict");
  const gone = c.remote === null;
  switch (c.step) {
    case "keeping":
      return makeView(ctx, "SaveConflict", {
        state: "keeping",
        copy: ["saveConflict.title", "saveConflict.keeping"],
        // Nothing to press while it runs: the choice cannot be made twice.
        focus: "heading",
      });
    case "kept":
      return makeView(ctx, "SaveConflict", {
        state: "kept",
        copy: [
          "saveConflict.title",
          KEPT[c.keep === "remote" && gone ? "deleted" : (c.keep ?? "local")],
          "common.done",
        ],
        primary: "common.done",
      });
    case "failed":
      // Both copies are as they were: Try again repeats the choice, Cancel leaves the conflict.
      return makeView(ctx, "SaveConflict", {
        state: "failed",
        copy: [
          "saveConflict.title",
          "saveConflict.failed",
          "common.tryAgain",
          "common.cancel",
        ],
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "screen",
        // Try again repeats the choice (an overwrite, a deletion): a stray Enter must not run it.
        focus: "heading",
      });
    default: {
      // Keep both needs a free slot and a copy to keep. Without the host saying so it is drawn
      // disabled with its reason (the fail-safe), never silently available.
      const both = !gone && c.bothAvailable === true;
      return makeView(ctx, "SaveConflict", {
        state: "choose",
        copy: [
          // The deleted variant states its own situation: one copy and a deletion, not two versions.
          gone ? "saveConflict.deletedTitle" : "saveConflict.title",
          gone ? "saveConflict.deletedLede" : "saveConflict.lede",
          "saveConflict.thisDevice",
          c.local?.when !== undefined && "saveConflict.savedThis",
          gone
            ? "saveConflict.deletedElsewhere"
            : c.remote?.device
              ? "saveConflict.otherDevice"
              : "saveConflict.otherUnknown",
          !gone && c.remote?.when !== undefined && "saveConflict.savedOther",
          "saveConflict.keepThis",
          gone ? "saveConflict.acceptDelete" : "saveConflict.keepOther",
          !gone && "saveConflict.keepBoth",
          !gone && !both && "saveConflict.bothFull",
          "common.cancel",
        ],
        // Each card's time is its own key, so each takes its own `when`.
        args: { device: c.remote?.device },
        keyArgs: {
          "saveConflict.savedThis": { when: c.local?.when },
          "saveConflict.savedOther": { when: c.remote?.when },
        },
        disabledActions: both ? [] : ["keep-both"],
        // No filled control and no default focus: every way on is the person's pick.
        primary: null,
        tone: null,
        focus: "heading",
      });
    }
  }
}
