// @pkey-feature ui.kit
// The SaveConflict states of the ui-matrix `saveConflict` family (U-22.K0/.K1): a port of ui-core's
// `models/saveConflict.ts`. The same save changed on two devices and the person picks one:
//  - a save is never discarded without a choice: `choose` offers every way on and takes no default;
//  - Keep both is a copy of the other save under a new name and needs a free slot of the 16: without
//    one (or when the input does not say) it stays on the screen, disabled, with its reason, and is
//    not among the screen's actions;
//  - when the other copy was deleted (`remote: null`) there is nothing to keep or copy: Keep the other
//    becomes Delete it here too (its own button, danger), Keep both goes, and the screen has its own
//    title and lede;
//  - a choice is applied once: while it runs no control is offered, and `kept` names the choice that
//    was made as its title, never another, and never after a failure;
//  - a failed choice offers Try again, Choose again and Cancel, none filled; Newer (U-22.UX2) is
//    information the app gives, shown on `choose` only and never with one copy.
package im.plrs.key.ui

import kotlinx.serialization.json.JsonNull

/** The result titles of `kept`, by the choice made (`deleted` when the other copy was gone). */
private val KEPT_KEYS: Map<String, String> = mapOf(
    "local" to "saveConflict.keptLocalTitle",
    "remote" to "saveConflict.keptRemoteTitle",
    "both" to "saveConflict.keptBothTitle",
    "deleted" to "saveConflict.keptDeletedTitle",
)

internal fun saveConflictScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val conflict = inputs.obj("saveConflict")
    if ("sync" !in inputs.closedServices || conflict == null) return hidden(KitComponent.saveConflict)
    val gone = conflict["remote"] is JsonNull
    val local = conflict.obj("local")
    val remote = conflict.obj("remote")
    // The situation's own title: one copy and a deletion is never "two versions".
    val situation = if (gone) "saveConflict.deletedTitle" else "saveConflict.title"
    return when (conflict.string("step")) {
        // Nothing to press while it runs: the choice cannot be made twice.
        "keeping" -> screen(
            KitComponent.saveConflict,
            "keeping",
            listOf(context.line(situation), context.line("saveConflict.keeping"), context.line("a11y.busy")),
        )

        "kept" -> {
            // With one copy there is no "both": it reads as the local choice.
            val asked = conflict.string("keep") ?: "local"
            val keep = if (gone && asked == "both") "local" else asked
            val key = KEPT_KEYS.getValue(
                if (keep == "remote" && gone) {
                    "deleted"
                } else if (keep in KEPT_KEYS) {
                    keep
                } else {
                    "local"
                },
            )
            screen(
                KitComponent.saveConflict,
                "kept",
                listOfNotNull(
                    context.line(key),
                    if (keep == "both") context.line("saveConflict.keptCopy") else null,
                    context.line("common.done"),
                ),
            )
        }

        // Both copies are as they were: Try again repeats the choice, Choose again returns to the
        // choices (the host sets the step), Cancel leaves the conflict. No control is filled.
        "failed" -> screen(
            KitComponent.saveConflict,
            "failed",
            listOf(
                context.line(situation),
                context.line(if (gone) "saveConflict.failedDeleted" else "saveConflict.failed"),
                context.line("common.tryAgain"),
                context.line("saveConflict.chooseAgain"),
                context.line("common.cancel"),
            ),
        )

        else -> {
            // Keep both needs a free slot and a copy to keep. Without the host saying so it is drawn
            // disabled with its reason (the fail-safe), never silently available.
            val both = !gone && conflict.boolean("bothAvailable") == true
            val device = remote.string("device")?.takeIf(String::isNotEmpty)
            val localWhen = local.string("when")
            val remoteWhen = remote.string("when")
            val newer = conflict.string("newer")
            screen(
                KitComponent.saveConflict,
                "choose",
                listOfNotNull(
                    // The deleted variant states its own situation: one copy and a deletion, not two versions.
                    context.line(if (gone) "saveConflict.deletedTitle" else "saveConflict.title"),
                    context.line(if (gone) "saveConflict.deletedLede" else "saveConflict.lede"),
                    context.line("saveConflict.thisDevice"),
                    if (localWhen != null) context.line("saveConflict.savedThis", mapOf("when" to CopyArgument.Text(localWhen))) else null,
                    when {
                        gone -> context.line("saveConflict.deletedElsewhere")
                        device != null -> context.line("saveConflict.otherDevice", mapOf("device" to CopyArgument.Text(device)))
                        else -> context.line("saveConflict.otherUnknown")
                    },
                    if (!gone &&
                        remoteWhen != null
                    ) {
                        context.line("saveConflict.savedOther", mapOf("when" to CopyArgument.Text(remoteWhen)))
                    } else {
                        null
                    },
                    // Newer only tags a card; it never chooses, fills or focuses anything.
                    if (!gone && newer == "local") context.line("saveConflict.newerThis") else null,
                    if (!gone && newer == "remote") context.line("saveConflict.newerOther") else null,
                    context.line("saveConflict.keepThis"),
                    context.line(if (gone) "saveConflict.acceptDelete" else "saveConflict.keepOther"),
                    if (!gone) context.line("saveConflict.keepBoth") else null,
                    if (!gone && !both) context.line("saveConflict.bothFull") else null,
                    context.line("common.cancel"),
                ),
                disabled = if (both) emptyList() else listOf(KitAction.keepBoth),
            )
        }
    }
}
