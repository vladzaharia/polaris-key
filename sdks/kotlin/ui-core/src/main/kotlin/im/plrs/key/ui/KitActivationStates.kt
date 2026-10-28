// @pkey-feature ui.activate
// The activate family of ui-matrix.json: Welcome, Activate and OfflineActivation.
package im.plrs.key.ui

import kotlinx.serialization.json.JsonObject

/**
 * The gate's first screen: the product hero, Sign in and Use a license key, and the extras the
 * product supports.
 */
internal fun welcomeScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    // No name anywhere: the neutral "Welcome", never "Welcome to" and nothing after it.
    val nameless = context.identity.name.isEmpty()
    val title = if (nameless) context.line("common.welcomeNoProductTitle") else context.line("welcome.title", context.productArgs)
    val signInOnlyLede =
        if (nameless) context.line("common.signInToContinue") else context.line("welcome.ledeSignInOnly", context.productArgs)
    if (!inputs.isOn("license")) {
        // No license, so no key path: sign-in registers, or an open product has no gate.
        if (inputs.string("registration") != "requires-identity") return hidden(KitComponent.welcome)
        return screen(
            KitComponent.welcome,
            "capability-limited",
            listOf(title, signInOnlyLede),
        )
    }
    if (inputs.string("pending") != null) {
        return screen(KitComponent.welcome, "busy", listOf(title, context.line("common.working"), context.line("a11y.busy")))
    }
    val signIn = inputs.isOn("identity") && inputs.capability("signIn")
    val keyEntry = inputs.capability("keyEntry")
    if (!signIn && keyEntry) {
        return screen(KitComponent.welcome, "capability-limited", listOf(title, context.line("welcome.ledeKeyOnly")))
    }
    if (signIn && !keyEntry) {
        return screen(
            KitComponent.welcome,
            "capability-limited",
            listOf(title, signInOnlyLede),
        )
    }
    val lines = mutableListOf(context.line("a11y.productIcon", context.productArgs), title)
    context.identity.developer?.let { developer ->
        lines += context.line("common.byDeveloper", mapOf("developer" to CopyArgument.Text(developer)))
    }
    lines += listOf(context.line("welcome.lede"), context.line("welcome.signIn"), context.line("welcome.useKey"))
    if (inputs.capability("trial")) lines += context.line("welcome.trial")
    if (inputs.capability("enroll")) lines += context.line("welcome.continueFree")
    if (inputs.capability("restore")) lines += context.line("welcome.restore")
    if (inputs.capability("offlineActivation")) lines += context.line("welcome.offline")
    return screen(KitComponent.welcome, "default", lines)
}

/** What every field-state Activate screen carries: its heading, lede and the key field (ui-matrix v4). */
private fun activateBase(context: KitContext): List<CopyLine> = listOf(
    context.line("activate.title"),
    context.line("activate.lede"),
    context.line("part.keyField.label"),
    context.line("part.keyField.placeholder"),
    context.line("common.paste"),
)

/** The focused refusals a different key cannot fix: the key-entry limit, or a license another account holds. */
internal enum class KeyRefusal(val state: String) { KeyEntryLimit("key-entry-limit"), LicenseOwned("license-owned") }

/** The focused refusal [activation] is, or null: any other refusal stays stacked under the field. */
internal fun keyRefusalOf(activation: JsonObject): KeyRefusal? {
    val result = activation.string("result")
    return when {
        result == "key-entry-limit" -> KeyRefusal.KeyEntryLimit
        result == "license-owned" || ((result == "refused" || result == "error") && activation.string("code") == "license_owned") -> KeyRefusal.LicenseOwned
        else -> null
    }
}

/**
 * The focused step (UI-KITS DL6): no field, lede or paste; Sign in is the primary. For the limit,
 * the add-key page (a QR with its caption on a TV), then Use a different key. The state is
 * `key-entry-limit` / `license-owned` on Activate and `key-refused` on SignIn.
 */
internal fun keyRefusalScreen(component: KitComponent, refusal: KeyRefusal, activation: JsonObject, context: KitContext): KitScreen {
    val limit = refusal == KeyRefusal.KeyEntryLimit
    val link = if (limit) KitLinks.valid(activation.string("manageUrl")) else null
    val lines = mutableListOf(
        context.line(if (limit) "core.activation.key-entry-limit.title" else "core.codes.license_owned.title"),
        context.line(if (limit) "core.activation.key-entry-limit.message" else "core.codes.license_owned.message"),
        context.line(if (limit) "signin.key.signIn" else "signin.key.ownedSignIn"),
    )
    if (link != null) {
        if (context.inputs.isTv) {
            lines += context.line("signin.key.scan")
            lines += context.line("a11y.qrAddKey")
        } else {
            lines += context.line("signin.key.addInLocker")
            lines += context.line("a11y.externalLink")
        }
    }
    lines += context.line("signin.key.differentKey")
    val state = if (component == KitComponent.signIn) "key-refused" else refusal.state
    return screen(component, state, lines)
}

/** The refusal's lines less its title: the screen's own heading is already in the base. */
private fun messageOnly(lines: List<CopyLine>): List<CopyLine> = lines.filter { !it.key.endsWith(".title") }

/**
 * License key entry with a live verdict. A floating key never needs an account (the Must not): an
 * `ok` activation is `done` whether or not anyone is signed in.
 */
internal fun activateScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license")) return hidden(KitComponent.activate)
    if (inputs.string("pending") == "activate") {
        return screen(KitComponent.activate, "busy", activateBase(context) + listOf(context.line("activate.busy"), context.line("a11y.busy")))
    }
    inputs.obj("activation")?.takeIf { it.string("result") != null }?.let { activation ->
        return activationOutcome(activation, context)
    }
    val field = inputs.obj("keyField")
    val verdict = KeyVerdict.of(field.string("text") ?: "", submitted = field.boolean("submitted") == true)
    return when (verdict.kind) {
        KeyVerdict.Kind.SubmittedEmpty -> screen(KitComponent.activate, "rejected", activateBase(context) + context.line("part.keyField.empty"))
        KeyVerdict.Kind.Empty -> screen(
            KitComponent.activate,
            "empty",
            activateBase(context) + context.line("activate.submit"),
        )
        KeyVerdict.Kind.Malformed -> screen(KitComponent.activate, "rejected", activateBase(context) + context.line("part.keyField.malformed"))
        KeyVerdict.Kind.Typing -> screen(
            KitComponent.activate,
            "typing",
            activateBase(context) + context.line("activate.submit"),
        )
        KeyVerdict.Kind.Parsed -> screen(
            KitComponent.activate,
            "parsed",
            activateBase(context) + listOf(context.line("part.keyField.forProduct", context.productArgs), context.line("activate.submit")),
        )
        KeyVerdict.Kind.CutShort -> screen(
            KitComponent.activate,
            "cut-short",
            activateBase(context) + listOf(
                context.line(
                    "part.keyField.cutShort",
                    mapOf(
                        "prefix" to CopyArgument.Text(verdict.keyPrefix ?: KeyVerdict.PREFIX),
                        "used" to CopyArgument.Number(verdict.used),
                        "limit" to CopyArgument.Number(KeyVerdict.SECRET_LENGTH),
                    ),
                ),
            ),
        )
    }
}

private fun activationOutcome(activation: JsonObject, context: KitContext): KitScreen {
    val result = activation.string("result")
    keyRefusalOf(activation)?.let { return keyRefusalScreen(KitComponent.activate, it, activation, context) }
    return when (result) {
        "ok" -> screen(
            KitComponent.activate,
            "done",
            listOf(
                context.line("core.activation.ok.title"),
                context.line("core.activation.ok.message", context.productArgs),
                context.line(
                    "part.keyField.verdict",
                    mapOf("product" to context.product, "tier" to CopyArgument.Text(""), "term" to CopyArgument.Text("")),
                ),
            ),
        )
        "device-limit" -> {
            val lines = mutableListOf(
                context.line("core.activation.device-limit.title"),
                context.line("core.activation.device-limit.message", context.productArgs),
                context.line("deviceLimit.title"),
            )
            val used = activation.integer("deviceCount")
            val limit = activation.integer("limit")
            if (used != null && limit != null) {
                lines += context.line(
                    "part.seatMeter.caption",
                    mapOf("used" to CopyArgument.Number(used), "limit" to CopyArgument.Number(limit)),
                )
            }
            // A missing link hides its control and names the fix in words (DL6, DL14).
            if (KitLinks.valid(activation.string("manageUrl")) == null) {
                lines += context.line("deviceLimit.noManage", context.productArgs)
            }
            screen(KitComponent.activate, "device-limit", lines)
        }
        "refused" -> screen(KitComponent.activate, "rejected", activateBase(context) + messageOnly(context.codeLines(activation.string("code"))))
        else -> {
            val base = "core.activation.$result"
            if (KitCopy.bundled.has("$base.title")) {
                screen(
                    KitComponent.activate,
                    "rejected",
                    activateBase(context) + context.line("$base.message", context.productArgs),
                )
            } else {
                screen(KitComponent.activate, "rejected", activateBase(context) + messageOnly(context.codeLines(activation.string("code"))))
            }
        }
    }
}

/**
 * Two numbered actions, then the verdict. A loaded file is not an activation until its signature
 * verifies (the Must not).
 */
internal fun offlineActivationScreen(inputs: KitInputs): KitScreen {
    val context = KitContext(inputs)
    if (!inputs.isOn("license") || !inputs.capability("offlineActivation")) return hidden(KitComponent.offlineActivation)
    val offline = inputs.obj("offline") ?: JsonObject(emptyMap())
    val submitted = offline.boolean("submitted") == true
    val file = offline.boolean("file") == true
    if (submitted && file && offline.boolean("verified") == true) {
        return screen(
            KitComponent.offlineActivation,
            "done",
            listOf(context.line("offlineActivation.title"), context.line("offlineActivation.done"), context.line("common.done")),
        )
    }
    // The two-step form stays in every state but done; the request QR has its own label.
    val base = listOf(
        context.line("offlineActivation.title"),
        context.line("offlineActivation.request"),
        context.line("offlineActivation.copyCode"),
        context.line("a11y.qrRequest"),
        context.line("offlineActivation.loadHint"),
        context.line("offlineActivation.loadFile"),
        context.line("offlineActivation.paste"),
        context.line("offlineActivation.dropHint"),
        context.line("offlineActivation.submit"),
    )
    if (submitted && file && offline.boolean("verified") == false) {
        return screen(
            KitComponent.offlineActivation,
            "rejected-signature",
            base + context.line("core.codes.bundle-jws-rejected.message", context.productArgs),
        )
    }
    if (submitted && file) return screen(KitComponent.offlineActivation, "loaded", base)
    if (submitted) return screen(KitComponent.offlineActivation, "loaded", base + context.line("offlineActivation.empty"))
    if (file) return screen(KitComponent.offlineActivation, "loaded", base)
    if (offline.boolean("copied") == true) {
        return screen(KitComponent.offlineActivation, "loaded", base + context.line("offlineActivation.codeCopied"))
    }
    return screen(KitComponent.offlineActivation, "default", base)
}

/**
 * The live verdict on what is in the key field (UI-KITS §4.3): the prefix names the product as soon
 * as it parses, a short secret is caught on submit. The shape is the Worker's (`LICENSE_KEY_SHAPE`
 * in packages/worker/src/platform/crypto.ts): `pkey_<slug>_` and 22 base64url characters.
 */
internal class KeyVerdict private constructor(val kind: Kind, val slug: String?, val used: Int) {
    enum class Kind { Empty, Typing, Parsed, CutShort, Malformed, SubmittedEmpty }

    /** `pkey_<slug>_`, the key's public prefix. */
    val keyPrefix: String? get() = slug?.let { "$PREFIX${it}_" }

    companion object {
        const val PREFIX: String = "pkey_"
        const val SECRET_LENGTH: Int = 22
        private const val SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-"
        private const val SECRET_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

        fun of(text: String, submitted: Boolean = false): KeyVerdict {
            val key = text.trim()
            if (key.isEmpty()) return KeyVerdict(if (submitted) Kind.SubmittedEmpty else Kind.Empty, null, 0)
            if (!key.startsWith(PREFIX)) {
                val typing = PREFIX.startsWith(key) && !submitted
                return KeyVerdict(if (typing) Kind.Typing else Kind.Malformed, null, 0)
            }
            val rest = key.substring(PREFIX.length)
            val underscore = rest.indexOf('_')
            if (underscore < 0) {
                val slugSoFar = rest.all { it in SLUG_CHARS }
                return KeyVerdict(if (slugSoFar && !submitted) Kind.Typing else Kind.Malformed, null, 0)
            }
            val slug = rest.substring(0, underscore)
            val secret = rest.substring(underscore + 1)
            if (slug.isEmpty() || !slug.all { it in SLUG_CHARS } || !secret.all { it in SECRET_CHARS }) {
                return KeyVerdict(Kind.Malformed, null, 0)
            }
            val used = secret.length
            val kind = when {
                used == SECRET_LENGTH -> Kind.Parsed
                used > SECRET_LENGTH -> Kind.Malformed
                submitted -> Kind.CutShort
                else -> Kind.Typing
            }
            return KeyVerdict(kind, slug, used)
        }
    }
}
