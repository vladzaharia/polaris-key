// @pkey-feature ui.settings ui.paywall
package im.plrs.key.ui

internal fun accountAndLicenseScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    val services = inputs.closedServices
    val title = context.line("account.title")
    if (inputs.boolean("loading") == true) {
        return screen(KitComponent.accountAndLicense, "loading", context.delayed(listOf(title, context.line("common.loading"))))
    }
    if (inputs.obj("gate").string("status") == "grace") {
        return screen(
            KitComponent.accountAndLicense,
            "offline",
            listOf(context.line("account.offline"), context.line("part.status.grace")),
        )
    }
    val tier = context.line("account.tier", mapOf("tier" to CopyArgument.Text("")))
    val signedIn = "identity" in services && inputs.obj("account").boolean("signedIn") == true
    if (!signedIn) {
        val lines = mutableListOf(title)
        if ("license" in services) lines += tier
        lines += context.line("account.keyOnly")
        if ("update" in services) lines += context.line("account.updates")
        lines += context.line("common.signOut")
        return screen(KitComponent.accountAndLicense, "key-only", lines)
    }
    val lines = mutableListOf(title)
    if ("license" in services) lines += tier
    if (inputs.obj("account").string("holder") == "account") {
        lines += context.line("account.holder", mapOf("name" to CopyArgument.Text("")))
    }
    lines += context.line("common.manage")
    lines += context.line("a11y.externalLink")
    if ("license" in services) lines += context.line("account.devices")
    if ("sync" in services) lines += context.line("account.cloudSync")
    if ("update" in services) {
        lines += context.line("account.updates")
        lines += context.line("account.autoUpdate")
        lines += context.line("account.channel")
        lines += context.line("update.checkNow")
    }
    lines += context.line("account.version", mapOf("version" to CopyArgument.Text("")))
    if ("config" in services) lines += context.line("account.managedSettings")
    lines += context.line("common.signOut")
    if (inputs.obj("integrator").string("poweredBy") != null) lines += context.line("part.poweredBy")
    return screen(KitComponent.accountAndLicense, "signed-in", lines)
}

internal fun settingsScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.closedServices.contains("config")) return hidden(KitComponent.settings)
    val title = context.line("settings.title")
    if (inputs.boolean("loading") == true) {
        return screen(KitComponent.settings, "loading", context.delayed(listOf(title, context.line("common.loading"))))
    }
    val config = inputs.array("config")?.objects()
    if (inputs.obj("error") != null) {
        return if (config == null) {
            screen(KitComponent.settings, "error", listOf(context.line("settings.loadFailed"), context.line("common.tryAgain")))
        } else {
            screen(KitComponent.settings, "error", listOf(context.line("settings.error"), context.line("common.tryAgain")))
        }
    }
    if (inputs.string("pending") == "save") {
        return screen(KitComponent.settings, "saving", listOf(context.line("settings.saving")))
    }
    if (inputs.boolean("saved") == true) {
        return screen(KitComponent.settings, "saving", listOf(context.line("settings.saved")))
    }
    val rows = config ?: return screen(KitComponent.settings, "loading", listOf(title, context.line("common.loading")))
    if (inputs.obj("edit").string("kind") == "value") {
        return screen(KitComponent.settings, "dirty", listOf(context.line("settings.unsaved"), context.line("common.save")))
    }
    rows.firstOrNull { it.boolean("locked") == true }?.let { locked ->
        val org = KitIdentity.nonEmpty(locked.string("org"))
        return if (org != null) {
            screen(
                KitComponent.settings,
                "locked",
                listOf(context.line("settings.setBy", mapOf("org" to CopyArgument.Text(org))), context.line("a11y.locked")),
            )
        } else {
            screen(
                KitComponent.settings,
                "locked",
                listOf(context.line("settings.setByGuardian"), context.line("a11y.locked")),
            )
        }
    }
    if (rows.isEmpty()) return screen(KitComponent.settings, "list", listOf(title, context.line("settings.empty")))
    val lines = mutableListOf(title)
    if (rows.size > 12) lines += context.line("settings.search")
    if (rows.any { it.string("source") == "default" }) lines += context.line("settings.fromDeveloper", context.developerArgs)
    for (source in listOf("local", "env", "default")) {
        if (rows.any { it.string("source") == source }) lines += context.line("settings.source.$source")
    }
    if (rows.any { it.string("source") == "local" }) lines += context.line("settings.reset")
    if (rows.any { it.string("type") == "number" && it.double("min") != null && it.double("max") != null }) {
        lines += context.line("settings.range", mapOf("min" to CopyArgument.Text(""), "max" to CopyArgument.Text("")))
    }
    if (rows.any { it["value"].boolean() == true }) lines += context.line("settings.on")
    if (rows.any { it["value"].boolean() == false }) lines += context.line("settings.off")
    if (rows.any { it.boolean("advanced") == true }) lines += context.line("settings.advanced")
    return screen(KitComponent.settings, "list", lines)
}

internal fun paywallScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license")) return hidden(KitComponent.paywall)
    if (inputs.boolean("loading") == true) {
        return screen(KitComponent.paywall, "loading", context.delayed(listOf(context.line("common.loading"))))
    }
    val offers = inputs.obj("offers")
    val tierName = offers.string("tier")
    val tier = mapOf(
        "product" to context.product,
        "tier" to CopyArgument.Text(tierName ?: ""),
    )
    if (inputs.string("pending") == "purchase") {
        return screen(KitComponent.paywall, "purchasing", listOf(context.line("paywall.purchasing"), context.line("a11y.busy")))
    }
    if (inputs.string("pending") == "restore") {
        return screen(KitComponent.paywall, "restore", listOf(context.line("paywall.restore")))
    }
    if (offers.boolean("purchased") == true) {
        return screen(KitComponent.paywall, "purchased", listOf(context.line("paywall.purchased", tier), context.line("common.done")))
    }
    if (offers == null) return screen(KitComponent.paywall, "loading", listOf(context.line("common.loading")))
    if (offers.boolean("available") != true) {
        val lines = mutableListOf(context.line("paywall.title", tier), context.line("paywall.notAvailable", context.productArgs))
        if (KitLinks.valid(offers.string("url")) != null) lines += context.line("paywall.portal")
        return screen(KitComponent.paywall, "not-available", lines)
    }
    val features = offers.array("features")
    val includes = if (tierName != null && features != null && features.isNotEmpty()) tier else emptyMap()
    val lines = mutableListOf(context.line("paywall.title", tier), context.line("paywall.includes", includes))
    lines += if (inputs.capability("purchase")) context.line("paywall.upgrade", tier) else context.line("paywall.portal")
    lines += context.line("paywall.redeem")
    return screen(KitComponent.paywall, "offers", lines)
}

internal fun entitlementGateScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (inputs.boolean("loading") == true) {
        return screen(KitComponent.entitlementGate, "loading", context.delayed(listOf(context.line("common.loading"))))
    }
    val entitlement = inputs.obj("entitlement")
    val tierName = entitlement.string("tier")
    val tier = tierName?.let { mapOf("tier" to CopyArgument.Text(it)) } ?: emptyMap()
    if (!inputs.isOn("license")) {
        return screen(KitComponent.entitlementGate, "not-entitled", listOf(context.line("entitlement.locked", tier)))
    }
    if (entitlement.boolean("entitled") == true) return screen(KitComponent.entitlementGate, "entitled")
    return screen(
        KitComponent.entitlementGate,
        "not-entitled",
        listOf(context.line("entitlement.locked", tier), context.line("entitlement.unlock")),
    )
}
