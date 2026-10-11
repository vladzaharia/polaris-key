// @pkey-feature ui.update
package im.plrs.key.ui

internal fun updatePromptScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val update = inputs.obj("update")
    if (!inputs.closedServices.contains("update") || update == null) return hidden(KitComponent.updatePrompt)
    val version = CopyArgument.Text(update.string("version") ?: "")
    val named = mapOf("product" to context.product, "version" to version)
    return when (update.string("action")) {
        "none" -> screen(
            KitComponent.updatePrompt,
            "up-to-date",
            listOf(context.line("update.upToDate"), context.line("update.checkNow")),
        )
        "blocked" -> if (update.string("reason") == "revoked-content") {
            screen(
                KitComponent.updatePrompt,
                "revoked-required-content",
                listOf(
                    context.line("core.codes.pack-revoked.title"),
                    context.line("update.revokedContent", context.productArgs),
                    context.line("update.install"),
                ),
            )
        } else {
            screen(
                KitComponent.updatePrompt,
                "blocked",
                listOf(context.line("update.blockedTitle"), context.line("update.blockedBody", context.productArgs)),
            )
        }
        "store" -> screen(KitComponent.updatePrompt, "store", listOf(storeLine(update.string("outlet"), context)))
        "platform" -> screen(
            KitComponent.updatePrompt,
            "platform",
            listOf(context.line("update.availableTitle"), platformLine(update.string("outlet"), context)),
        )
        "code-ready" -> screen(
            KitComponent.updatePrompt,
            "ready",
            listOf(
                context.line("update.readyTitle", named),
                context.line("update.readyBody", context.productArgs),
                context.line("update.restartNow"),
                context.line("update.later"),
            ),
        )
        "binary" -> {
            if (update.boolean("mandatory") == true) {
                return screen(
                    KitComponent.updatePrompt,
                    "mandatory",
                    listOf(
                        context.line("update.mandatoryTitle", context.productArgs),
                        context.line("update.mandatoryBody", context.productArgs),
                        context.line("update.install"),
                    ),
                )
            }
            if (update.obj("progress").string("phase")?.let { it != "queued" } == true) {
                return screen(
                    KitComponent.updatePrompt,
                    "downloading",
                    listOf(
                        context.line("update.downloading", context.progressArgs()),
                        context.line("update.timeLeft", context.progressArgs()),
                        context.line("a11y.progress", context.progressArgs()),
                        context.line("update.later"),
                        context.line("update.restartWhenReady"),
                    ),
                )
            }
            val lines = if (update.string("version") != null) {
                mutableListOf(
                    context.line("update.title", named),
                    context.line(
                        "update.current",
                        mapOf("version" to CopyArgument.Text(""), "size" to CopyArgument.Text("")),
                    ),
                ).apply {
                    if (update.boolean("critical") == true) add(context.line("update.critical"))
                    add(context.line("update.whatsNew"))
                    add(context.line("update.allChanges", mapOf("version" to version)))
                }
            } else {
                mutableListOf(context.line("update.availableTitle"))
            }
            lines += context.line("update.install")
            lines += context.line("update.restartWhenReady")
            lines += context.line("update.later")
            lines += context.line("update.skipVersion")
            screen(KitComponent.updatePrompt, "available", lines)
        }
        else -> hidden(KitComponent.updatePrompt)
    }
}

private fun storeLine(outlet: String?, context: KitContext): CopyLine = when (outlet) {
    "app-store" -> context.line("update.appStore")
    "play", "play-testing" -> context.line("update.googlePlay")
    "testflight" -> context.line("update.testflight")
    "altstore", "altstore-pal" -> context.line("update.altstore")
    "steam" -> context.line("update.steam")
    "ms-store" -> context.line("update.openStore", mapOf("store" to CopyArgument.Text("Microsoft Store")))
    else -> context.line("update.openStore", mapOf("store" to CopyArgument.Text("")))
}

private fun platformLine(outlet: String?, context: KitContext): CopyLine = when (outlet) {
    "steam" -> context.line("update.platform.steam")
    "itch" -> context.line("update.platform.itch")
    "flathub", "snap" -> context.line("update.platform.store")
    "app-installer" -> context.line("update.platform.appInstaller", context.productArgs)
    "winget" -> context.line("update.platform.command", mapOf("command" to CopyArgument.Text("winget upgrade")))
    "fdroid-repo" -> context.line("update.platform.package")
    "web" -> context.line("update.platform.web")
    else -> context.line("update.platform.generic", context.productArgs)
}

internal fun updateProgressScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val update = inputs.obj("update")
    val progress = update.obj("progress")
    if (!inputs.closedServices.contains("update") || update == null || progress == null) return hidden(KitComponent.updateProgress)
    return when (progress.string("phase")) {
        "queued" -> {
            val lines = mutableListOf(context.line("updateProgress.queued"))
            if (update.string("action") == "packs") lines.add(0, context.line("updateProgress.contentTitle"))
            screen(KitComponent.updateProgress, "queued", lines)
        }
        "download", "verify" -> screen(
            KitComponent.updateProgress,
            "downloading",
            listOf(context.line("updateProgress.downloading", context.progressArgs()), context.line("a11y.progress", context.progressArgs())),
        )
        "install" -> screen(
            KitComponent.updateProgress,
            "installing",
            listOf(context.line("updateProgress.installing"), context.line("update.verifying")),
        )
        "paused" -> screen(
            KitComponent.updateProgress,
            "paused",
            listOf(context.line("updateProgress.paused"), context.line("updateProgress.resume")),
        )
        "failed" -> screen(
            KitComponent.updateProgress,
            "failed",
            listOf(context.line("updateProgress.failed"), context.line("common.tryAgain")),
        )
        "done" -> screen(KitComponent.updateProgress, "done", listOf(context.line("updateProgress.done")))
        else -> hidden(KitComponent.updateProgress)
    }
}

internal fun releaseNotesScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.closedServices.contains("release")) return hidden(KitComponent.releaseNotes)
    if (inputs.boolean("loading") == true) {
        return screen(
            KitComponent.releaseNotes,
            "loading",
            context.delayed(listOf(context.line("releaseNotes.title", context.productArgs), context.line("common.loading"))),
        )
    }
    if (inputs.obj("error") != null) {
        return screen(
            KitComponent.releaseNotes,
            "error",
            listOf(context.line("releaseNotes.error"), context.line("common.tryAgain")),
        )
    }
    val notes = inputs.array("releaseNotes")
        ?: return screen(
            KitComponent.releaseNotes,
            "loading",
            listOf(context.line("releaseNotes.title", context.productArgs), context.line("common.loading")),
        )
    if (notes.isEmpty()) return screen(KitComponent.releaseNotes, "empty", listOf(context.line("releaseNotes.empty")))
    return screen(
        KitComponent.releaseNotes,
        "list",
        listOf(
            context.line("releaseNotes.title", context.productArgs),
            context.line("releaseNotes.version", mapOf("version" to CopyArgument.Text(""))),
            context.line("releaseNotes.released", mapOf("date" to CopyArgument.Text(""))),
        ),
    )
}
