// @pkey-feature ui.signin
// The signIn family of ui-matrix.json: the one sign-in form (SIGN-IN.md §3.17) as SignIn, its step 2
// SignInHandoff and its step 3 LicenseChoice (with Replace a device in place). Device-code sign-ins
// never choose a license in the app (D4): they choose on the card.
package im.plrs.key.ui

import im.plrs.key.core.SIGN_IN_PROVIDER_NAME
import kotlinx.serialization.json.JsonObject

internal fun signInScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("identity")) return hidden(KitComponent.signIn)
    val signIn = inputs.obj("signIn") ?: JsonObject(emptyMap())
    val keyPath = inputs.isOn("license") && inputs.capability("keyEntry")
    val deviceCode = if (signIn.string("channel") == "device-code") inputs.obj("deviceCode") else null
    val error = inputs.obj("error")
    if (error != null) {
        return if (error.string("code") == "sign-in-unavailable") {
            screen(KitComponent.signIn, "error", listOf(context.line("signIn.noMethods", context.productArgs)))
        } else {
            val args = signIn.string("method")?.let { mapOf("method" to CopyArgument.Text(it)) } ?: emptyMap()
            screen(KitComponent.signIn, "error", listOf(context.line("signIn.methodError", args)))
        }
    }
    if (signIn.string("outcome") == "expired") {
        return screen(KitComponent.signIn, "expired", listOf(context.line("signin.handoff.tooLong"), context.line("signin.again")))
    }
    if (deviceCode.string("phase") == "expired") {
        return screen(
            KitComponent.signIn,
            "expired",
            listOf(
                context.line("core.codes.sign-in-expired.title"),
                context.line("core.codes.sign-in-expired.message", context.productArgs),
                context.line("signin.again"),
            ),
        )
    }
    if (signIn.string("outcome") == "signedIn") {
        return when {
            !inputs.isOn("license") -> screen(KitComponent.signIn, "done", listOf(context.line("signin.return.signedInShort")))
            signIn.boolean("issuedNow") == true -> screen(
                KitComponent.signIn,
                "done",
                listOf(context.line("signin.return.signedInShort"), context.line("signin.done.start", context.productArgs)),
            )
            else -> screen(
                KitComponent.signIn,
                "done",
                listOf(context.line("signin.desktop.toast", mapOf("name" to CopyArgument.Text(""), "tier" to CopyArgument.Text("")))),
            )
        }
    }
    if (signIn.string("outcome") == "choose" && signIn.string("channel") == "browser") {
        if (signIn.string("event") == "have-key" && keyPath) {
            val lines = mutableListOf(context.line("signin.key.addTitle", context.productArgs), context.line("part.keyField.label"))
            if (inputs.obj("activation").string("result") == "refused") lines += context.codeLines(inputs.obj("activation").string("code"))
            return screen(KitComponent.signIn, "key", lines)
        }
        if (signIn.string("event") == "open-replace" && signIn.string("replace") == "inline") {
            val lines = mutableListOf(
                context.line("signin.replace.open"),
                context.line("signin.replace.lede", mapOf("thisDevice" to context.thisDeviceTitle())),
            )
            if (inputs.os in setOf("macos", "ios", "visionos")) lines += context.line("signin.replace.openSystem")
            else lines += context.line("signin.replace.title", mapOf("device" to CopyArgument.Text(replaceTarget(inputs) ?: "")))
            return screen(KitComponent.signIn, "replace", lines)
        }
        val lines = mutableListOf(context.line("signin.choice.title"))
        if (inputs.isDesktop) lines += context.line("signin.desktop.notifyChoose", mapOf("app" to context.product))
        val browserReplace = signIn.string("replace") == "browser" && signIn.string("event") == "open-replace"
        return screen(KitComponent.signIn, "choose", lines, if (browserReplace) listOf(KitAction.replaceInBrowser) else emptyList())
    }
    if (signIn.boolean("redeeming") == true || deviceCode.string("phase") == "ok") {
        return screen(KitComponent.signIn, "finishing", listOf(context.line("signin.handoff.finishing"), context.line("a11y.busy")))
    }
    if (signIn.string("channel") == "device-code" || (signIn.string("outcome") == "pending" && signIn.string("event") == "use-code")) {
        return screen(KitComponent.signIn, "code")
    }
    if (signIn.string("outcome") == "pending") {
        return screen(
            KitComponent.signIn,
            "handoff",
            listOf(
                context.line("signin.handoff.title"),
                context.line("signin.handoff.browserBody", mapOf("app" to context.product)),
                context.line("signin.handoff.waiting"),
                context.line("signin.handoff.again"),
                context.line("signin.handoff.useCode"),
            ),
        )
    }
    return screen(KitComponent.signIn, "methods", signInMethodLines(context, keyPath))
}

private fun signInMethodLines(context: KitContext, keyPath: Boolean): List<CopyLine> {
    val inputs = context.inputs
    // The generic row opens Polaris Locker's own sign-in; a product that shows a provider's row of
    // its own says which with the `provider` input (the TS model's DEFAULT_PROVIDER).
    val provider = CopyArgument.Text(inputs.string("provider") ?: SIGN_IN_PROVIDER_NAME)
    val lines = mutableListOf(
        context.line("signIn.title", context.productArgs),
        context.line("signin.methods.ledeApp", context.productArgs),
        context.line("signin.provider.group"),
    )
    // The first control is the primary: on a desktop that is Continue in browser (DL9).
    if (inputs.isDesktop) lines += context.line("signin.desktop.continue")
    lines += context.line("signin.provider.continue", mapOf("provider" to provider))
    if (inputs.isDesktop) {
        if (keyPath) lines += context.line("signin.choice.keyInstead")
        lines += context.line("signin.menu.signIn")
    } else {
        lines += context.line("signin.passkey")
        lines += context.line("signin.email.continue")
        if (inputs.os != "web" && inputs.capability("deviceCode")) lines += context.line("signin.link.deviceCode")
        if (keyPath) lines += context.line("signin.choice.keyInstead")
    }
    lines += context.line("common.cancel")
    return lines
}

internal fun signInHandoffScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("identity")) return hidden(KitComponent.signInHandoff)
    val signIn = inputs.obj("signIn") ?: JsonObject(emptyMap())
    if (signIn.string("channel") == "device-code") {
        return when (inputs.obj("deviceCode").string("phase") ?: "starting") {
            "starting" -> screen(KitComponent.signInHandoff, "starting", listOf(context.line("signInHandoff.starting"), context.line("a11y.busy")))
            "waiting", "slow-down" -> screen(KitComponent.signInHandoff, "code", signInCodeLines(context))
            "ok" -> screen(KitComponent.signInHandoff, "finishing", listOf(context.line("signInHandoff.ok"), context.line("signin.handoff.finishing")))
            "denied" -> screen(
                KitComponent.signInHandoff,
                "denied",
                listOf(
                    context.line("core.codes.sign-in-denied.title"),
                    context.line("core.codes.sign-in-denied.message", context.productArgs),
                    context.line("signInHandoff.newCode"),
                ),
            )
            "expired" -> screen(
                KitComponent.signInHandoff,
                "expired",
                listOf(
                    context.line("core.codes.sign-in-expired.title"),
                    context.line("core.codes.sign-in-expired.message", context.productArgs),
                    context.line("signInHandoff.newCode"),
                ),
            )
            "cancelled" -> screen(KitComponent.signInHandoff, "cancelled", listOf(context.line("signin.handoff.cancelled"), context.line("signInHandoff.newCode")))
            else -> screen(KitComponent.signInHandoff, "starting", listOf(context.line("signInHandoff.starting"), context.line("a11y.busy")))
        }
    }
    if (signIn.boolean("redeeming") == true) return screen(KitComponent.signInHandoff, "finishing", listOf(context.line("signin.handoff.finishing")))
    if (signIn.string("outcome") == "pending" && signIn.string("event") == "use-code") {
        return screen(KitComponent.signInHandoff, "starting", listOf(context.line("signInHandoff.starting"), context.line("a11y.busy")))
    }
    if (signIn.string("outcome") == "pending" && signIn.boolean("browserOpened") == false) {
        if (signIn.string("event") == "copy-link") return screen(KitComponent.signInHandoff, "link-copied", listOf(context.line("signInHandoff.linkCopied")))
        return screen(
            KitComponent.signInHandoff,
            "no-browser",
            listOf(context.line("signin.handoff.noBrowser"), context.line("signin.handoff.noBrowserBody"), context.line("signin.handoff.copyLink")),
        )
    }
    return screen(
        KitComponent.signInHandoff,
        "waiting",
        listOf(
            context.line("signin.handoff.title"),
            context.line("signin.handoff.waiting"),
            context.line("signin.handoff.again"),
            context.line("signin.handoff.useCode"),
            context.line("common.cancel"),
        ),
    )
}

private fun signInCodeLines(context: KitContext): List<CopyLine> {
    val inputs = context.inputs
    val url = CopyArgument.Text(KitLinks.display(KitLinks.deviceCodePage(context.identity, inputs.isTv)))
    val lines = mutableListOf(
        context.line("signin.handoff.codeTitle"),
        context.line("part.code.label"),
        context.line("a11y.code", mapOf("code" to CopyArgument.Text(""))),
    )
    if (inputs.isTv) {
        lines += context.line("a11y.qr")
        if (inputs.os == "android" || inputs.os == "tvos") {
            lines += context.line("signInHandoff.scanTv")
            lines += context.line("signin.handoff.url", mapOf("url" to url))
        } else {
            lines += context.line("signInHandoff.scan", mapOf("url" to url))
            lines += context.line("part.qr.enlarge")
        }
    } else if (inputs.isHandheld) {
        lines += context.line("a11y.copyCode")
        lines += context.line("signin.handoff.url", mapOf("url" to url))
        lines += context.line("a11y.copyAddress")
        lines += context.line("signin.handoff.openBrowser")
    } else {
        lines += context.line("signin.handoff.codeBody", mapOf("url" to url))
        lines += context.line("a11y.copyCode")
        lines += context.line("signin.handoff.openBrowser")
    }
    return lines
}

internal fun licenseChoiceScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("identity") || !inputs.isOn("license")) return hidden(KitComponent.licenseChoice)
    val signIn = inputs.obj("signIn") ?: JsonObject(emptyMap())
    val title = context.line("signin.choice.title")
    if (inputs.boolean("loading") == true) return screen(KitComponent.licenseChoice, "loading", context.delayed(listOf(title, context.line("common.loading"))))
    if (signIn.boolean("grantExpired") == true) return screen(KitComponent.licenseChoice, "grant-expired", listOf(context.line("signin.handoff.tooLong"), context.line("signin.again")))
    if (signIn.boolean("raced") == true) {
        val key = if (signIn.string("event") == "confirm-replace") "signin.replace.raced" else "signin.choice.raced"
        return screen(KitComponent.licenseChoice, "raced", listOf(context.line(key)))
    }
    if (signIn.string("event") == "open-replace" && signIn.string("replace") == "inline" && inputs.obj("replaceView") != null) {
        val device = CopyArgument.Text(replaceTarget(inputs) ?: "")
        return screen(
            KitComponent.licenseChoice,
            "replace-open",
            listOf(
                context.line("signin.replace.open"),
                context.line("signin.replace.title", mapOf("device" to device)),
                context.line("signin.replace.consequence", mapOf("device" to device, "product" to context.product, "thisDevice" to context.thisDevice())),
                context.line("signin.replace.confirm"),
                context.line("signin.replace.back"),
            ),
        )
    }
    val view = inputs.obj("choices") ?: return screen(KitComponent.licenseChoice, "loading", listOf(title, context.line("common.loading")))
    val browserReplace = if (signIn.string("replace") == "browser" && signIn.string("event") == "open-replace") listOf(KitAction.replaceInBrowser) else emptyList()
    if (view.string("state") == "none") {
        val get = view.obj("getLicense")
        return if (get.boolean("keyEntry") == true) {
            screen(KitComponent.licenseChoice, "none-keys", listOf(context.line("signin.none.title", context.productArgs), context.line("signin.none.body"), context.line("signin.choice.keyInstead")))
        } else {
            val lines = mutableListOf(context.line("signin.none.title", context.productArgs), context.line("signin.none.body"))
            if (KitLinks.valid(get.string("purchaseUrl")) != null) lines += context.line("signin.none.get", context.productArgs)
            lines += context.line("signin.none.otherAccount")
            screen(KitComponent.licenseChoice, "none-no-keys", lines)
        }
    }
    if (view.string("state") == "autoIssue") return screen(
        KitComponent.licenseChoice,
        "new",
        listOf(context.line("signin.choice.ledeNew", context.productArgs + context.developerArgs), context.line("signin.choice.tag.new"), context.line("signin.choice.metaNew")),
    )
    if (inputs.string("selected") == "create" && view.obj("create") != null) {
        return screen(KitComponent.licenseChoice, "create", listOf(context.line("signin.choice.create"), context.line("signin.choice.createMeta")))
    }
    val choices = view.array("choices")?.objects() ?: emptyList()
    if (choices.isNotEmpty() && choices.all { it.string("state") == "full" }) {
        val lead = when {
            view.obj("create") != null -> context.line("signin.choice.allFullCreate")
            choices.all { it.obj("replace") == null } -> context.line("signin.choice.noneReplaceable", context.developerArgs)
            else -> context.line("signin.choice.allFull")
        }
        return screen(KitComponent.licenseChoice, "all-full", listOf(lead, context.line("signin.choice.tag.full")), browserReplace)
    }
    if (view.boolean("keep") == true) return screen(KitComponent.licenseChoice, "keep", listOf(context.line("signin.choice.keep"), context.line("signin.choice.keepMeta", context.productArgs)))
    if (choices.any { it.boolean("current") == true }) return screen(KitComponent.licenseChoice, "current", listOf(context.line("signin.choice.tag.current")))
    val accessKinds = choices.mapNotNull { it.string("access") }.toSet()
    if ("account" in accessKinds && "seats" in accessKinds) return screen(KitComponent.licenseChoice, "mixed")
    val lede = context.line("signin.choice.lede", mapOf("product" to context.product, "device" to context.thisDevice()))
    if (choices.size == 1) return screen(KitComponent.licenseChoice, "one", listOf(title, lede, context.line("signin.choice.continue")))
    val lines = mutableListOf(title, lede, context.line("signin.choice.group", context.productArgs))
    val origins = choices.map(::originKey).distinct()
    val terms = choices.map { if (it.string("expiresAt") == null) "signin.term.lifetime" else "signin.term.until" }.distinct()
    lines += context.line("signin.choice.meta", mapOf("origin" to CopyArgument.Text(""), "term" to CopyArgument.Text("")))
    lines += context.line("signin.choice.devices", mapOf("used" to CopyArgument.Number(0), "limit" to CopyArgument.Number(0)))
    lines += origins.map { context.line(it, context.developerArgs) }
    lines += terms.map { context.line(it, mapOf("date" to CopyArgument.Text(""))) }
    lines += context.line("signin.choice.continue")
    return screen(KitComponent.licenseChoice, "many", lines)
}

private fun originKey(choice: JsonObject): String = when (choice.string("origin")) {
    "signin" -> "signin.choice.origin.signIn"
    "store" -> "signin.choice.origin.store"
    "free" -> "signin.choice.origin.free"
    "developer" -> "signin.choice.origin.developer"
    else -> "signin.choice.origin.keyAdded"
}

private fun replaceTarget(inputs: KitInputs): String? {
    val devices = inputs.obj("replaceView").array("devices")?.objects() ?: return null
    return (devices.firstOrNull { it.boolean("leastRecent") == true }
        ?: devices.minByOrNull { it.integer("lastSeen") ?: Int.MAX_VALUE })?.string("label")
}
