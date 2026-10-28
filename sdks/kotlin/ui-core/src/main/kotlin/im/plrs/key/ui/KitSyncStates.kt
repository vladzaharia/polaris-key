// @pkey-feature ui.kit
// The Cloud Sync states of the ui-matrix `cloudSync` family (U-42): CloudSyncStatus and the three
// screens UnlockSync, RecoveryCode and RingChange. A port of ui-core's `models/cloudSync.ts`; the
// rows pin the same security points (U-sync clients plan section 9: S5, S13, T22, T23):
//  - the recovery code is entered only in the app, and both screens say no one will ask for it;
//  - the code is never an input or a copy argument: the kit draws it from the host, once;
//  - Start over warns that synced data will be lost before it runs, and Cancel takes the first focus;
//  - nearby unlock is never offered in v0.10.0 (NearbyApproval does not ship): `unlockSync.nearby`
//    is read by no branch;
//  - a changed ring is confirmed on its own screen: `ring-changed` never offers Unlock, Accept hands
//    the host the ring the person was shown (`changed.served`), and without one there is nothing to
//    accept, only the recovery code.
package im.plrs.key.ui

internal fun cloudSyncStatusScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val sync = inputs.obj("cloudSync")
    if ("sync" !in inputs.closedServices || sync == null) return hidden(KitComponent.cloudSyncStatus)
    val state = sync.string("state")
    // A locked device holds no key: it says so and offers Unlock sync, never a sync time.
    if (state == "locked") {
        return screen(KitComponent.cloudSyncStatus, "locked", listOf(context.line("cloudSync.locked"), context.line("cloudSync.unlock")))
    }
    // A changed ring is confirmed first (S5): Review always shows and Unlock never does.
    if (state == "ring-changed") {
        return screen(KitComponent.cloudSyncStatus, "ring-changed", listOf(context.line("cloudSync.ringChanged"), context.line("common.review")))
    }
    val known = state ?: return hidden(KitComponent.cloudSyncStatus)
    val signedOut = known == "error" && sync.boolean("signedIn") == false
    val review = known == "conflict" && sync.boolean("canReview") == true
    val head = when {
        signedOut -> listOf(context.line("cloudSync.signedOut"), context.line("cloudSync.signIn"))
        known == "synced" -> listOf(context.line("cloudSync.synced", mapOf("time" to CopyArgument.Text(sync.string("lastSynced").orEmpty()))))
        else -> listOf(context.line("cloudSync.$known"))
    }
    return screen(KitComponent.cloudSyncStatus, known, head + listOfNotNull(if (review) context.line("common.review") else null))
}

internal fun unlockSyncScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val unlock = inputs.obj("unlockSync")
    if ("sync" !in inputs.closedServices || unlock == null) return hidden(KitComponent.unlockSync)
    val title = context.line("unlockSync.title")
    return when (unlock.string("step")) {
        "working" -> screen(KitComponent.unlockSync, "working", listOf(title, context.line("common.working")))

        "failed" -> screen(
            KitComponent.unlockSync,
            "failed",
            listOf(title, context.line("unlockSync.failed"), context.line("common.tryAgain"), context.line("common.cancel")),
        )

        // Start over did not run: its own line, and Try again repeats it.
        "start-over-failed" -> screen(
            KitComponent.unlockSync,
            "start-over-failed",
            listOf(title, context.line("unlockSync.startOverFailed"), context.line("common.tryAgain"), context.line("common.cancel")),
        )

        "no-code" -> screen(
            KitComponent.unlockSync,
            "no-code",
            listOf(title, context.line("unlockSync.noCode"), context.line("unlockSync.startOver"), context.line("common.cancel")),
        )

        // `tone` in the matrix is the message's tone (nothing failed here, so it is neutral); the destructive
        // confirm still takes the danger fill (BRAND.md: danger buttons stay danger red).
        "start-over" -> screen(
            KitComponent.unlockSync,
            "start-over",
            listOf(
                context.line("unlockSync.startOverTitle"),
                context.line("unlockSync.startOverWarning"),
                context.line("unlockSync.startOverConfirm"),
                context.line("common.cancel"),
            ),
        )

        else -> {
            val invalid = unlock.string("step") == "invalid"
            screen(
                KitComponent.unlockSync,
                if (invalid) "invalid" else "code",
                listOfNotNull(
                    title,
                    context.line("unlockSync.lede"),
                    context.line("unlockSync.field"),
                    if (invalid) context.line("unlockSync.invalid") else null,
                    context.line("recoveryCode.noAsk"),
                    context.line("unlockSync.unlock"),
                    context.line("unlockSync.startOver"),
                    context.line("common.cancel"),
                ),
            )
        }
    }
}

internal fun recoveryCodeScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val code = inputs.obj("recoveryCode")
    if ("sync" !in inputs.closedServices || code == null) return hidden(KitComponent.recoveryCode)
    val saved = code.boolean("saved") == true
    val lines = listOfNotNull(
        context.line("recoveryCode.title"),
        context.line("recoveryCode.lede"),
        context.line("recoveryCode.noAsk"),
        context.line("recoveryCode.copy"),
        context.line("recoveryCode.saved"),
        if (saved) context.line("common.done") else null,
    )
    return screen(KitComponent.recoveryCode, if (saved) "saved" else "show", lines)
}

internal fun ringChangeScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val change = inputs.obj("ringChange")
    if ("sync" !in inputs.closedServices || change == null) return hidden(KitComponent.ringChange)
    val by = KitIdentity.nonEmpty(change.string("by")?.trim())
    val served = change.obj("served") != null
    val body = if (by != null) {
        context.line("ringChange.body", mapOf("device" to CopyArgument.Text(by)))
    } else {
        context.line("ringChange.bodyUnknown")
    }
    val failed = change.boolean("failed") == true
    // Nothing was served to confirm: no Accept, only the recovery code.
    val lines = listOfNotNull(
        context.line("ringChange.title"),
        body,
        context.line(if (served) "ringChange.warning" else "ringChange.warningNoServed"),
        if (failed) context.line("ringChange.failed") else null,
        if (served) context.line("ringChange.accept") else null,
        context.line("ringChange.useCode"),
        context.line("common.cancel"),
    )
    return screen(KitComponent.ringChange, if (failed) "failed" else "confirm", lines)
}
