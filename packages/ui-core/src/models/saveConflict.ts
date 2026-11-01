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
//     that was made as its title, never another, and never after a failure;
//   - a failed choice offers Try again, Choose again and Cancel, none filled; Newer (U-22.UX2) is
//     information the app gives, shown on the choose step and never with one copy.

import type { Context } from "../input.js";
import { hiddenView, makeView, type View } from "../view.js";

export type SaveConflictState =
  | "choose"
  | "keeping"
  | "kept"
  | "failed"
  | "hidden";

/** The result title of `kept`, by the choice made (`deleted` when the other copy was gone). */
const KEPT = {
  local: "saveConflict.keptLocalTitle",
  remote: "saveConflict.keptRemoteTitle",
  both: "saveConflict.keptBothTitle",
  deleted: "saveConflict.keptDeletedTitle",
} as const;

/** A save conflict: choose, being applied, applied, or failed. */
export function saveConflictView(
  ctx: Context,
): View<"SaveConflict", SaveConflictState> {
  const c = ctx.input.saveConflict;
  if (!ctx.on("sync") || !c) return hiddenView(ctx, "SaveConflict");
  const gone = c.remote === null;
  // The situation's own title: one copy and a deletion is never "two versions".
  const situation = gone ? "saveConflict.deletedTitle" : "saveConflict.title";
  switch (c.step) {
    case "keeping":
      return makeView(ctx, "SaveConflict", {
        state: "keeping",
        copy: [situation, "saveConflict.keeping", "a11y.busy"],
        // Nothing to press while it runs: the choice cannot be made twice.
        focus: "heading",
      });
    case "kept": {
      // With one copy there is no "both": it reads as the local choice.
      const keep = gone && c.keep === "both" ? "local" : (c.keep ?? "local");
      return makeView(ctx, "SaveConflict", {
        state: "kept",
        copy: [
          KEPT[keep === "remote" && gone ? "deleted" : keep],
          keep === "both" && "saveConflict.keptCopy",
          "common.done",
        ],
        primary: "common.done",
        focus: "heading",
      });
    }
    case "failed":
      // The saves are as they were: Try again repeats the choice, Choose again returns to the
      // choices (the host sets the step; nothing is applied), Cancel leaves the conflict.
      return makeView(ctx, "SaveConflict", {
        state: "failed",
        copy: [
          situation,
          gone ? "saveConflict.failedDeleted" : "saveConflict.failed",
          "common.tryAgain",
          "saveConflict.chooseAgain",
          "common.cancel",
        ],
        // No control is filled: a stray Enter must not repeat an overwrite or a deletion.
        primary: null,
        tone: "danger",
        errorSlot: "screen",
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
          // Newer only tags a card; it never chooses, fills or focuses anything.
          !gone && c.newer === "local" && "saveConflict.newerThis",
          !gone && c.newer === "remote" && "saveConflict.newerOther",
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
