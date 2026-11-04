// @pkey-feature ui.kit.holders
// The holders family of ui-matrix.json: ActivateDone and AddToAccount (activation without an
// account), and the SignIn form's key-done, attach and added steps that draw them. After a key
// activates the license is floating, held by the key alone; ActivateDone says so and recommends an
// account once, quietly; AddToAccount collects a name and an email, and the browser confirms the
// email. The holder is `licenseHolder.email`: empty is floating, set is waiting for that email, which
// a screen shows masked and never in full. Skipping is never a refusal: Start using is always the one
// primary.
package im.plrs.key.ui

import kotlinx.serialization.json.JsonObject

private const val NAME_FIELD = "activate.attach.name"
private const val EMAIL_FIELD = "signin.email.label"

/**
 * The copy keys of the recommendation's reason lines, in the order they show: Cloud Sync only when the
 * product has it ([sync] counts only with [identity]), getting the license back and moving it to a new
 * device when Identity is on, and with Identity off the single `activate.recommend.portal` line. The
 * first words of each line are a lead-in a renderer may style ([KitCopy.leadParts]).
 */
public fun recommendReasons(identity: Boolean, sync: Boolean): List<String> {
    if (!identity) return listOf("activate.recommend.portal")
    return buildList {
        if (sync) add("activate.recommend.sync")
        add("activate.recommend.recover")
        add("activate.recommend.devices")
    }
}

private fun activateDoneArgs(context: KitContext, done: JsonObject, activation: JsonObject?): Map<String, CopyArgument> = buildMap {
    putAll(context.productArgs)
    put("developer", CopyArgument.Text(context.identity.developer ?: context.identity.name))
    (done.string("tier") ?: activation.string("tier"))?.let { put("tier", CopyArgument.Text(it)) }
    (done.string("term") ?: activation.string("term"))?.let { put("term", CopyArgument.Text(it)) }
    done.string("deviceKind")?.let { put("deviceKind", CopyArgument.Text(it)) }
    done.integer("position")?.let { put("n", CopyArgument.Number(it)) }
    done.integer("limit")?.let { put("limit", CopyArgument.Number(it)) }
}

internal fun activateDoneScreen(inputs: KitInputs): KitScreen {
    val done = inputs.obj("activateDone")
    if ("license" !in inputs.closedServices || done == null) return hidden(KitComponent.activateDone)
    val context = KitContext(inputs)
    val args = activateDoneArgs(context, done, inputs.obj("activation"))
    // A holder email too malformed to mask counts as none: no sentence renders with an empty email.
    val masked = KitFormat.maskEmail(inputs.obj("licenseHolder").string("email"))
    // Waiting needs Identity on: with it off a holder email still draws the ready state with the portal line.
    return if (masked.isNotEmpty() && "identity" in inputs.closedServices) {
        val waitingArgs = args + ("maskedEmail" to CopyArgument.Text(masked))
        val keys = listOf("activate.done.title", "activate.done.device", "activate.waiting", "activate.waitingSignIn", "signin.done.start")
        screen(KitComponent.activateDone, "waiting", keys.map { context.line(it, waitingArgs) })
    } else {
        val portal = "identity" !in inputs.closedServices || (done.string("addIn") ?: inputs.obj("licenseHolder").string("addIn")) == "portal"
        // With Identity off, or a kit with no in-app channel, the action opens polaris.locker, so it says
        // that (an external link).
        val keys = listOf("activate.done.title", "activate.done.device", "activate.recommend.title", "activate.recommend.badge") +
            recommendReasons("identity" in inputs.closedServices, "sync" in inputs.closedServices) +
            (if (portal) listOf("signin.key.addInLocker", "a11y.externalLink") else listOf("activate.recommend.action")) +
            listOf("activate.recommend.skip", "signin.done.start")
        screen(KitComponent.activateDone, "ready", keys.map { context.line(it, args) })
    }
}

private val FORM_FIELDS = listOf(
    "activate.recommend.action",
    "activate.attach.lede",
    NAME_FIELD,
    EMAIL_FIELD,
    "activate.attach.fine",
    "common.continue",
    "common.cancel",
)

/** The messages under the fields that need fixing: the name, the email, or both. */
private fun invalidMessages(field: String): List<String> = buildList {
    if (field == "both" || field == "name") add("activate.attach.nameRequired")
    if (field != "name") add("signin.email.invalid")
}

private fun addToAccountArgs(context: KitContext, add: JsonObject, masked: String?, signedEmail: String?): Map<String, CopyArgument> = buildMap {
    putAll(context.productArgs)
    add.string("deviceKind")?.let { put("deviceKind", CopyArgument.Text(it)) }
    masked?.let { put("maskedEmail", CopyArgument.Text(it)) }
    signedEmail?.let { put("email", CopyArgument.Text(it)) }
}

/** The AddToAccount screen; [stepOverride] is the SignIn form's `added` step, which ignores the input's step. */
internal fun addToAccountScreen(inputs: KitInputs, stepOverride: String? = null): KitScreen {
    val add = inputs.obj("addToAccount")
    val services = inputs.closedServices
    if ("identity" !in services || "license" !in services || add == null) return hidden(KitComponent.addToAccount)
    val context = KitContext(inputs)
    val masked = KitIdentity.nonEmpty(add.string("typedEmail")) ?: KitFormat.maskEmail(inputs.obj("licenseHolder").string("email")).ifEmpty { null }
    val signedEmail = KitIdentity.nonEmpty(add.string("signedEmail"))
    val args = addToAccountArgs(context, add, masked, signedEmail)
    fun view(state: String, keys: List<String?>, with: Map<String, CopyArgument> = emptyMap()) =
        screen(KitComponent.addToAccount, state, keys.filterNotNull().map { context.line(it, args + with) })

    val step = stepOverride ?: add.string("step")
    return when (step) {
        "form" -> view("form", FORM_FIELDS)

        "invalid" -> {
            view("invalid", FORM_FIELDS + invalidMessages(add.string("field") ?: "both"))
        }

        "busy" -> busyScreen(inputs, ::view)

        "added", "owned", "email-bound", "other-account", "failed" -> settledStep(step, ::view, args, add, services)

        else -> hidden(KitComponent.addToAccount)
    }
}

/** The steps that end the form: added, or not added (someone else attached it, a mismatched email or account, a failure). */
private fun settledStep(
    step: String,
    view: (String, List<String?>, Map<String, CopyArgument>) -> KitScreen,
    args: Map<String, CopyArgument>,
    add: JsonObject,
    services: Set<String>,
): KitScreen {
    val masked = args["maskedEmail"]
    val signedEmail = args["email"]
    val keys = when (step) {
        // From Settings the app is already running: the screen closes with Done. Cloud Sync is named
        // only when the product has it.
        "added" -> listOf(
            "activate.attach.done",
            "activate.attach.syncOn".takeIf { "sync" in services },
            if (add.boolean("fromSettings") == true) "common.done" else "signin.done.start",
        )

        // Someone attached the license while this screen was open.
        "owned" -> listOf("activate.owned.title", "activate.owned.lede", "signin.key.ownedSignIn", "common.cancel")

        // The license's email is not the account's; the license keeps working. The sentence and
        // "Verify that email" name the email; with none known both are left out, never half-written.
        "email-bound" -> listOf(
            "activate.otherEmail.title",
            "activate.otherEmail.body".takeIf { masked != null },
            "activate.otherEmail.verify".takeIf { masked != null },
            "signin.auto.confirm.other",
            "signin.done.start",
        )

        // A different account signed in than the email typed: the license was added nowhere.
        "other-account" -> listOf(
            "activate.otherAccount.title",
            "activate.otherAccount.body".takeIf { masked != null && signedEmail != null },
            "common.tryAgain",
            "signin.done.start",
        )

        else -> listOf("activate.recommend.action", "activate.attach.failed", "common.tryAgain", "common.cancel")
    }
    return view(step, keys, emptyMap())
}

/**
 * The person confirms the email in Polaris Locker: the form gives way to `waiting`, the code they check
 * there. With no code to show, the form stays greyed behind Working, with Open the browser again and
 * Cancel as the ways on and out.
 */
private fun busyScreen(inputs: KitInputs, view: (String, List<String?>, Map<String, CopyArgument>) -> KitScreen): KitScreen {
    val code = inputs.obj("deviceCode").string("userCode")
    return if (!code.isNullOrEmpty()) {
        val keys = listOf(
            "activate.attach.waitTitle",
            "part.code.label",
            "a11y.code",
            "a11y.copyCode",
            "activate.attach.waitCheck",
            "activate.attach.reopen",
            "common.cancel",
        )
        view("waiting", keys, mapOf("code" to CopyArgument.Text(code)))
    } else {
        view("busy", FORM_FIELDS.filter { it != "common.cancel" } + listOf("common.working", "signin.handoff.again", "common.cancel"), emptyMap())
    }
}

/**
 * The SignIn form's steps after a key with no account: the holders' screens in the form's body, under
 * the form's own state names. Their copy and actions are the screens' own; a screen that is hidden
 * here (a service is off) leaves the form hidden.
 */
internal val HOLDER_STEPS: Set<String> = setOf("key-done", "attach", "added")

internal fun holderStepScreen(inputs: KitInputs, step: String): KitScreen {
    val inner = if (step == "key-done") activateDoneScreen(inputs) else addToAccountScreen(inputs, if (step == "added") "added" else null)
    if (inner.isHidden) return hidden(KitComponent.signIn)
    return inner.copy(component = KitComponent.signIn, state = step)
}
