// @pkey-feature ui.gate
package im.plrs.key.ui

internal fun gateScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license")) return screen(KitComponent.gate, "licensed")
    val stage = inputs.obj("stage")
    if (stage.string("outcome") == "error") {
        return screen(
            KitComponent.gate,
            "error",
            listOf(context.line("gate.error.title", context.productArgs), context.line("common.tryAgain")),
        )
    }
    val gate = inputs.obj("gate")
    val status = gate.string("status")
    if (status == null || gate.boolean("checking") == true) {
        return screen(KitComponent.gate, "booting", context.delayed(listOf(context.line("gate.checking"))))
    }
    return when (status) {
        "ok", "not-applicable" -> screen(KitComponent.gate, "licensed")
        "needs-activation" -> screen(
            KitComponent.gate,
            "needs-activation",
            listOf(context.line("core.gate.needs-activation.title"), context.line("core.gate.needs-activation.message", context.productArgs)),
        )
        "grace" -> screen(
            KitComponent.gate,
            "grace",
            listOf(context.line("core.gate.grace.title"), context.line("core.gate.grace.message", context.productArgs), context.line("common.reconnect")),
        )
        "revoked", "expired", "version-too-old", "version-too-new", "channel-not-entitled" -> screen(
            KitComponent.gate,
            "blocked",
            listOf(context.line("part.status.blocked")),
        )
        else -> screen(KitComponent.gate, "booting", context.delayed(listOf(context.line("gate.checking"))))
    }
}

internal fun bootScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val stage = inputs.obj("stage")
        ?: return screen(KitComponent.boot, "progress", listOf(context.line("boot.starting"), context.line("a11y.busy")))
    val emit = stage.obj("emit")
    if (emit.string("type") == "boot_rolled_back") return screen(KitComponent.boot, "rolled-back", listOf(context.line("boot.rolledBack")))
    when (stage.string("outcome")) {
        "error" -> return screen(
            KitComponent.boot,
            "error",
            listOf(
                context.line("gate.error.title", context.productArgs),
                context.line("boot.error.body", mapOf("product" to context.product, "code" to CopyArgument.Text(emit.string("code") ?: "error"))),
                context.line("common.tryAgain"),
            ),
        )
        "offline" -> return if (emit.boolean("canPlayOffline") == true) {
            screen(
                KitComponent.boot,
                "offline",
                listOf(context.line("boot.offline.title"), context.line("boot.offline.playable"), context.line("boot.continueOffline"), context.line("common.tryAgain")),
            )
        } else {
            screen(KitComponent.boot, "offline", listOf(context.line("boot.offline.title"), context.line("boot.offline.body"), context.line("common.tryAgain")))
        }
        "blocked" -> return if (emit.string("reason") == "content-declined") {
            screen(KitComponent.boot, "declined", listOf(context.line("boot.declined.title"), context.line("boot.declined.body", context.productArgs), context.line("common.tryAgain")))
        } else {
            screen(
                KitComponent.boot,
                "blocked",
                listOf(context.line("core.gate.version-too-old.title"), context.line("core.gate.version-too-old.message", context.productArgs), context.line("status.update")),
            )
        }
        "waiting" -> if (emit.string("type") == "consent_needed") {
            val body = if (emit.boolean("metered") == true) "boot.consent.bodyMetered" else "boot.consent.body"
            return screen(
                KitComponent.boot,
                "consent",
                listOf(
                    context.line("boot.consent.title"),
                    context.line(body, mapOf("product" to context.product, "size" to CopyArgument.Text(KitFormat.bytes(emit.integer("bytes") ?: 0)))),
                    context.line("boot.consent.download"),
                    context.line("common.notNow"),
                ),
            )
        }
        "ready" -> return screen(KitComponent.boot, "progress", listOf(context.line("boot.ready")))
    }
    if (stage.string("stage") == "fetch") {
        if (emit.string("type") == "fetch_progress" && emit.integer("done") != null && emit.integer("total") != null) {
            val args = mapOf(
                "size" to CopyArgument.Text(KitFormat.bytes(emit.integer("done") ?: 0)),
                "total" to CopyArgument.Text(KitFormat.bytes(emit.integer("total") ?: 0)),
            )
            return screen(KitComponent.boot, "fetching", listOf(context.line("boot.fetchingProgress", args), context.line("a11y.progress", args)))
        }
        return screen(KitComponent.boot, "fetching", listOf(context.line("boot.fetching")))
    }
    val line = when (stage.string("stage")) {
        "sync" -> "boot.syncing"
        "gate" -> "gate.checking"
        "decide" -> "boot.deciding"
        "mount" -> "common.loading"
        else -> "boot.starting"
    }
    return screen(KitComponent.boot, "progress", listOf(context.line(line), context.line("a11y.busy")))
}

internal fun statusScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val gate = inputs.obj("gate")
    val status = gate.string("status")
    if (!inputs.isOn("license") || status == null) return hidden(KitComponent.statusScreen)
    fun allowedLines(): List<CopyLine> {
        val allowed = gate.obj("allowed")
        val min = allowed.string("min")
        val max = allowed.string("max")
        return when {
            min != null && max != null -> listOf(context.line("status.allowedRange", mapOf("min" to CopyArgument.Text(min), "max" to CopyArgument.Text(max))))
            min != null -> listOf(context.line("status.allowedMin", mapOf("min" to CopyArgument.Text(min))))
            max != null -> listOf(context.line("status.allowedMax", mapOf("max" to CopyArgument.Text(max))))
            else -> emptyList()
        }
    }
    return when (status) {
        "revoked" -> screen(
            KitComponent.statusScreen,
            "revoked",
            listOf(context.line("core.gate.revoked.title"), context.line("core.gate.revoked.message", context.productArgs), context.line("signin.key.differentKey"), context.line("common.signOut")),
        )
        "expired" -> screen(
            KitComponent.statusScreen,
            "expired",
            listOf(context.line("core.gate.expired.title"), context.line("core.gate.expired.message", context.productArgs), context.line("status.renew"), context.line("status.useAnotherLicense")),
        )
        "version-too-old" -> screen(
            KitComponent.statusScreen,
            "version-too-old",
            listOf(context.line("core.gate.version-too-old.title"), context.line("core.gate.version-too-old.message", context.productArgs)) + allowedLines() + context.line("status.update"),
        )
        "version-too-new" -> screen(
            KitComponent.statusScreen,
            "version-too-new",
            listOf(context.line("core.gate.version-too-new.title"), context.line("core.gate.version-too-new.message", context.productArgs)) + allowedLines(),
        )
        "channel-not-entitled" -> {
            val lines = mutableListOf(
                context.line("core.gate.channel-not-entitled.title"),
                context.line("core.gate.channel-not-entitled.message", context.productArgs),
                context.line("status.switchChannel"),
            )
            context.identity.developer?.let { lines += context.line("status.contact", mapOf("developer" to CopyArgument.Text(it))) }
            screen(KitComponent.statusScreen, "channel-not-entitled", lines)
        }
        else -> hidden(KitComponent.statusScreen)
    }
}

internal fun graceBannerScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val gate = inputs.obj("gate")
    if (!inputs.isOn("license")) return hidden(KitComponent.graceBanner)
    return when (gate.string("status")) {
        "grace" -> {
            val days = gate.integer("graceDaysLeft") ?: 0
            if (days <= 1) {
                screen(KitComponent.graceBanner, "last-day", listOf(context.line("grace.lastDay", context.productArgs), context.line("common.reconnect")))
            } else {
                screen(
                    KitComponent.graceBanner,
                    "days-left",
                    listOf(
                        context.line("grace.daysLeft", mapOf("days" to CopyArgument.Number(days))),
                        context.line("grace.deadline", mapOf("date" to CopyArgument.Text(KitFormat.dayAfter(days)))),
                        context.line("common.reconnect"),
                        context.line("common.dismiss"),
                    ),
                )
            }
        }
        "expired" -> screen(KitComponent.graceBanner, "expired", listOf(context.line("core.gate.expired.title"), context.line("core.gate.expired.message", context.productArgs)))
        else -> hidden(KitComponent.graceBanner)
    }
}

internal fun toastScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    return when (inputs.obj("toast").string("kind")) {
        "update" -> {
            if (!inputs.closedServices.contains("update")) hidden(KitComponent.toast)
            else screen(
                KitComponent.toast,
                "info",
                listOf(context.line("toast.updateAvailable", mapOf("product" to context.product, "version" to CopyArgument.Text(inputs.obj("update").string("version") ?: ""))), context.line("common.dismiss"), context.line("a11y.toastTimer")),
            )
        }
        "copied" -> screen(KitComponent.toast, "success", listOf(context.line("common.copied")))
        "warning" -> screen(KitComponent.toast, "warning", listOf(context.line("common.dismiss")))
        "error" -> screen(KitComponent.toast, "error", context.codeLines(inputs.obj("error").string("code")) + context.line("common.dismiss"))
        "progress" -> screen(KitComponent.toast, "with-progress", listOf(context.line("updateProgress.downloading", context.progressArgs()), context.line("toast.undo")))
        else -> hidden(KitComponent.toast)
    }
}
