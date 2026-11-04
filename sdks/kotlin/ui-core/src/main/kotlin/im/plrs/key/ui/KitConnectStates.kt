// The inter-account screens (ui-matrix.json `connect`, CC-19.9/CC-19.10): LinkPairing, the window where two
// people pair their devices once, and TransferOffer, the prompt for something a contact offers (D-8: consent
// per transfer). The same rules as ui-core's models/connect.ts, which these mirror state for state:
//  - the code is what both people compare; the categories that would be shared come before the confirm button;
//  - the other device's label is unauthenticated: worded as reported by the device, an absent label says so;
//  - no state confirms by default (the kit keeps focus off Codes match and Accept);
//  - a failed session says why in its own line and stored nothing; links turned off are their own neutral state.
@file:Suppress("MatchingDeclarationName", "CyclomaticComplexMethod")

package im.plrs.key.ui

/** Shared helpers of the two inter-account screens. */
public object KitConnect {
    /** The most characters a heading carries for a file name: the middle is elided so the extension stays. */
    public const val NAME_LIMIT: Int = 40

    /** [name] shortened to at most [limit] characters (code points), the middle elided. */
    public fun shortName(name: String, limit: Int = NAME_LIMIT): String {
        val points = name.codePoints().toArray()
        if (points.size <= limit) return name
        val keep = limit - 1
        val tail = (keep + 1) / 2
        val head = keep - tail
        val sb = StringBuilder()
        for (i in 0 until head) sb.appendCodePoint(points[i])
        sb.append('…')
        for (i in points.size - tail until points.size) sb.appendCodePoint(points[i])
        return sb.toString()
    }

    /** A category id as words when the app gave it no label: "tax-forms" becomes "Tax forms". */
    public fun categoryFallback(id: String): String {
        val words = id.replace(Regex("[-_]+"), " ").trim()
        return if (words.isEmpty()) id else words.substring(0, 1).uppercase() + words.substring(1)
    }

    /**
     * [text] the other side chose (a label, a file name), set apart from the words around it so a right-to-left name cannot
     * reorder them: the first-strong isolate pair. The kit draws every such text through this.
     */
    public fun isolate(text: String): String = "\u2068$text\u2069"

    /** A code as separate characters, for a screen reader ("123 456" is read digit by digit). */
    public fun spellOut(code: String): String = code.codePoints().toArray().joinToString(" ") { String(Character.toChars(it)) }
}

private val FAILED_BODY: Map<String, String> = mapOf(
    "declined" to "linkPairing.failedDeclined",
    "timeout" to "linkPairing.failedTimeout",
    "full" to "linkPairing.failedFull",
    "closed" to "linkPairing.failedClosed",
)

internal fun linkPairingScreen(inputs: KitInputs): KitScreen {
    val pairing = inputs.obj("linkPairing")
    if ("connect" !in inputs.closedServices || pairing == null) return hidden(KitComponent.linkPairing)
    val context = KitContext(inputs)
    val device = pairing.string("device")?.takeIf { it.isNotBlank() }
    val code = pairing.string("code")
    val none = (pairing.array("categories")?.strings() ?: emptyList()).isEmpty()
    val args = buildMap<String, CopyArgument> {
        if (device != null) put("device", CopyArgument.Text(KitConnect.isolate(device)))
        if (code != null) put("code", CopyArgument.Text(KitConnect.spellOut(code)))
    }
    fun step(state: String, vararg keys: String?) = screen(KitComponent.linkPairing, state, keys.filterNotNull().map { context.line(it, args) })
    val reported = if (device != null) "linkPairing.reported" else "linkPairing.reportedUnnamed"
    val shares = if (none) "linkPairing.sharesNone" else "linkPairing.shares"
    return when (pairing.string("step")) {
        "code" -> step(
            "code",
            "linkPairing.codeTitle",
            "linkPairing.codeBody",
            if (code != null) "a11y.linkCode" else null,
            reported,
            shares,
            "linkPairing.confirm",
            "linkPairing.decline",
        )

        "confirm" -> step("confirm", "linkPairing.waiting", if (code != null) "a11y.linkCode" else null, reported, shares, "common.cancel")

        "linked" -> step(
            "linked",
            "linkPairing.linkedTitle",
            if (device != null) "linkPairing.linkedWith" else "linkPairing.linkedBody",
            shares,
            "common.done",
        )

        "failed" -> {
            val reason = pairing.string("reason") ?: "closed"
            step("failed", "linkPairing.failedTitle", FAILED_BODY[reason] ?: FAILED_BODY.getValue("closed"), "common.tryAgain", "common.done")
        }

        "unavailable" -> step(
            "unavailable",
            "core.codes.connect_links_disabled.title",
            "core.codes.connect_links_disabled.message",
            "common.done",
        )

        else -> step("open", "linkPairing.title", "linkPairing.openBody", "linkPairing.searching", "common.cancel")
    }
}

internal fun transferOfferScreen(inputs: KitInputs): KitScreen {
    val offer = inputs.obj("transferOffer")
    if ("connect" !in inputs.closedServices || offer == null) return hidden(KitComponent.transferOffer)
    val context = KitContext(inputs)
    val device = offer.string("device")?.takeIf { it.isNotBlank() }
    // The title carries a shortened name; the kit shows the whole one on its own row.
    val args = buildMap<String, CopyArgument> {
        if (device != null) put("device", CopyArgument.Text(KitConnect.isolate(device)))
        put("name", CopyArgument.Text(KitConnect.isolate(KitConnect.shortName(offer.string("name").orEmpty()))))
    }
    fun step(state: String, vararg keys: String) = screen(KitComponent.transferOffer, state, keys.map { context.line(it, args) })
    return when (offer.string("step")) {
        "receiving" -> step("receiving", "transferOffer.receiving", "common.cancel")

        "done" -> step("done", "transferOffer.done", "common.done")

        "failed" -> step("failed", "transferOffer.failed", "transferOffer.failedBody", "common.done")

        else -> step(
            "ask",
            if (device != null) "transferOffer.ask" else "transferOffer.askUnnamed",
            "transferOffer.askBody",
            "transferOffer.accept",
            "transferOffer.decline",
        )
    }
}
