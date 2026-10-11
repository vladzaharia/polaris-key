// @pkey-feature ui.devicelimit ui.devices
package im.plrs.key.ui

internal fun deviceLimitScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license")) return hidden(KitComponent.deviceLimit)
    val devices = inputs.array("devices")?.objects() ?: emptyList()
    val target = leastRecentDevice(devices)
    val replacement = inputs.obj("replacement")
    val device = CopyArgument.Text(replacement.string("device") ?: target.string("name") ?: "")
    if (replacement != null) {
        return if (replacement.string("outcome") == "done") {
            screen(
                KitComponent.deviceLimit,
                "removed",
                listOf(context.line("deviceLimit.removed", mapOf("device" to device, "product" to context.product))),
            )
        } else {
            screen(
                KitComponent.deviceLimit,
                "failed",
                listOf(context.line("deviceLimit.failed", mapOf("device" to device)), context.line("common.tryAgain")),
            )
        }
    }
    if (inputs.string("pending") == "replace") {
        return screen(
            KitComponent.deviceLimit,
            "busy",
            listOf(context.line("deviceLimit.primary"), context.line("common.working"), context.line("a11y.busy")),
        )
    }
    val activation = inputs.obj("activation")
    val used = activation.integer("deviceCount") ?: devices.size
    val limit = activation.integer("limit") ?: devices.size
    val seats = mapOf("used" to CopyArgument.Number(used), "limit" to CopyArgument.Number(limit))
    if (devices.isNotEmpty()) {
        val lines = mutableListOf(
            context.line("deviceLimit.title"),
            context.line("deviceLimit.heading", seats),
            context.line("deviceLimit.lede", mapOf("formFactor" to context.formFactor)),
        )
        if (activation.integer("limit") != null && activation.integer("deviceCount") != null) {
            lines += context.line("part.seatMeter.caption", seats)
            lines += context.line("a11y.seatMeter", seats)
        }
        lines += context.line(
            "signin.replace.meta",
            mapOf("platform" to CopyArgument.Text(""), "when" to CopyArgument.Text("")),
        )
        lines += context.line("signin.replace.leastRecent")
        lines += context.line("a11y.formFactor", mapOf("formFactor" to context.formFactor))
        lines += context.line("deviceLimit.confirmTitle", mapOf("device" to device))
        lines += context.line(
            "deviceLimit.consequence",
            mapOf("device" to device, "product" to context.product, "thisDevice" to context.thisDevice()),
        )
        lines += context.line("deviceLimit.primary")
        lines += context.line("common.back")
        return screen(KitComponent.deviceLimit, "default", lines)
    }
    val lines = mutableListOf(
        context.line("deviceLimit.title"),
        context.line("deviceLimit.browser", context.productArgs),
    )
    if (KitLinks.valid(activation.string("manageUrl")) != null) {
        if (inputs.isTv) {
            lines += context.line("deviceLimit.scan")
            lines += context.line("a11y.qr")
        } else {
            lines += context.line("deviceLimit.openBrowser")
            lines += context.line("a11y.externalLink")
        }
    }
    return screen(KitComponent.deviceLimit, "browser-mode", lines)
}

internal fun devicesScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license")) return hidden(KitComponent.devices)
    val title = context.line("devices.title")
    if (inputs.boolean("loading") == true) {
        return screen(KitComponent.devices, "loading", context.delayed(listOf(title, context.line("common.loading"))))
    }
    val edit = inputs.obj("edit")
    val device = CopyArgument.Text(edit.string("device") ?: "")
    if (inputs.obj("error") != null) {
        val code = inputs.obj("error").string("code")
        val key = when (code) {
            "device_rename_failed" -> "devices.renameFailed"
            "device_deauthorize_failed" -> "devices.removeFailed"
            "device_list_failed" -> "devices.loadFailed"
            else -> when (edit.string("kind")) {
                "rename" -> "devices.renameFailed"
                "remove" -> "devices.removeFailed"
                else -> "devices.loadFailed"
            }
        }
        return screen(
            KitComponent.devices,
            "error",
            listOf(context.line(key, mapOf("device" to device)), context.line("common.tryAgain")),
        )
    }
    if (inputs.boolean("browserMode") == true) {
        return screen(
            KitComponent.devices,
            "browser-mode",
            listOf(context.line("devices.browser"), context.line("devices.manage"), context.line("a11y.externalLink")),
        )
    }
    when (edit.string("kind")) {
        "rename" -> return screen(
            KitComponent.devices,
            "renaming",
            listOf(context.line("devices.renameLabel"), context.line("common.save"), context.line("common.cancel")),
        )
        "remove" -> return screen(
            KitComponent.devices,
            "confirming",
            listOf(
                context.line("devices.removeConfirm", mapOf("device" to device, "product" to context.product)),
                context.line("devices.remove"),
                context.line("common.cancel"),
            ),
        )
    }
    val devices = inputs.array("devices")?.objects()
        ?: return screen(KitComponent.devices, "loading", listOf(title, context.line("common.loading")))
    if (devices.isEmpty()) return screen(KitComponent.devices, "empty", listOf(context.line("devices.empty")))
    val lines = mutableListOf(
        title,
        context.line("devices.lede"),
        context.line("devices.count", mapOf("count" to CopyArgument.Number(devices.size))),
        context.line("devices.meta", mapOf("platform" to CopyArgument.Text(""), "when" to CopyArgument.Text(""))),
    )
    devices.firstOrNull { it.boolean("current") == true }?.let { current ->
        lines += context.line(
            "part.thisDeviceTitle",
            mapOf("formFactor" to CopyArgument.Text(current.string("formFactor") ?: "other")),
        )
    }
    if (devices.any { KitIdentity.nonEmpty(it.string("name")) == null }) lines += context.line("devices.unnamed")
    lines += context.line("devices.rename")
    lines += context.line("devices.remove")
    lines += context.line("a11y.renameDevice", mapOf("device" to CopyArgument.Text("")))
    lines += context.line("a11y.removeDevice", mapOf("device" to CopyArgument.Text("")))
    lines += context.line("a11y.formFactor", mapOf("formFactor" to CopyArgument.Text("")))
    return screen(KitComponent.devices, "list", lines)
}

private fun leastRecentDevice(devices: List<kotlinx.serialization.json.JsonObject>): kotlinx.serialization.json.JsonObject? =
    devices.filter { it.boolean("current") != true }.maxByOrNull { it.integer("lastSeenDays") ?: Int.MIN_VALUE }
