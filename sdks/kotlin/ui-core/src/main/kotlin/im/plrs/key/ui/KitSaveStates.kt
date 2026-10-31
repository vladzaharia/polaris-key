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
//    was made, never another, and never after a failure.
package im.plrs.key.ui

import kotlinx.serialization.json.JsonNull

/** The strings of `kept`, by the choice made (`deleted` when the other copy was gone). */
private val KEPT_KEYS: Map<String, String> = mapOf(
    "local" to "saveConflict.keptLocal",
    "remote" to "saveConflict.keptRemote",
    "both" to "saveConflict.keptBoth",
    "deleted" to "saveConflict.keptDeleted",
)

internal fun saveConflictScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val conflict = inputs.obj("saveConflict")
    if ("sync" !in inputs.closedServices || conflict == null) return hidden(KitComponent.saveConflict)
    val gone = conflict["remote"] is JsonNull
    val local = conflict.obj("local")
    val remote = conflict.obj("remote")
    return when (conflict.string("step")) {
        // Nothing to press while it runs: the choice cannot be made twice.
        "keeping" -> screen(
            KitComponent.saveConflict,
            "keeping",
            listOf(context.line("saveConflict.title"), context.line("saveConflict.keeping")),
        )

        "kept" -> {
            val keep = conflict.string("keep") ?: "local"
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
                listOf(context.line("saveConflict.title"), context.line(key), context.line("common.done")),
            )
        }

        // Both copies are as they were: Try again repeats the choice, Cancel leaves the conflict.
        "failed" -> screen(
            KitComponent.saveConflict,
            "failed",
            listOf(
                context.line("saveConflict.title"),
                context.line("saveConflict.failed"),
                context.line("common.tryAgain"),
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
