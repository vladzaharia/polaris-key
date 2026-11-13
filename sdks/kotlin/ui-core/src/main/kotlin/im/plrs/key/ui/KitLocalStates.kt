// @pkey-feature connect.local
// Pair with a Code (ui-matrix.json `local`, CC-29K): LocalPairing, the windows two devices of one app on one network pair in by
// an 8-digit code or a QR with no account, and PairedDevices, the list of what they paired. The same rules as ui-core's
// models/local.ts, which these mirror state for state:
//  - the code is the largest thing on the show screen; nothing else takes focus first on confirm, so a stray Enter never pairs,
//    and Pair on the field's screen is the person's yes: the categories come before it;
//  - a name the other device sent is unauthenticated text: isolated, and never truncated in the consent title;
//  - Pair is drawn but unavailable ([KitScreen.disabledKeys]) with its reason on screen when the field holds fewer than 8 digits,
//    the code that just failed, or a prefix with no dial left;
//  - after Too many tries the code stays gone for 30 seconds (the cooldown is the state holder's), and a window that ran out has
//    none;
//  - the Can connect switches show only when more than 8 devices are paired or one is off.
@file:Suppress("MatchingDeclarationName", "CyclomaticComplexMethod", "LongMethod", "ReturnCount")

package im.plrs.key.ui

import kotlinx.serialization.json.JsonNull

/** Shared constants and rules of the two Pair with a Code screens. */
public object KitLocal {
    /** The most paired devices that can connect at once (`MAX_LIVE_LOCAL_ADVERTS`). */
    public const val MAX_CONNECTABLE: Int = 8

    /** The most paired devices one device holds (`MAX_LOCAL_LINKS`). */
    public const val MAX_PAIRED: Int = 32

    /** The longest name a person may give a paired device. */
    public const val MAX_NAME: Int = 64

    /** Seconds a new code waits after Too many tries. */
    public const val COOLDOWN_SECONDS: Int = 30

    private const val SECONDS_PER_MINUTE: Int = 60
    private const val QR_COLUMNS_MIN_WIDTH: Int = 720
    private const val QR_COLUMNS_MAX_HEIGHT: Int = 900
    private const val SHORT_WINDOW_HEIGHT: Int = 480

    /** `m:ss` for a countdown. */
    public fun countdown(seconds: Int): String {
        val s = maxOf(0, seconds)
        return "${s / SECONDS_PER_MINUTE}:${(s % SECONDS_PER_MINUTE).toString().padStart(2, '0')}"
    }

    /** The Can connect column rule: more than 8 paired, or one off. */
    public fun showSwitchColumn(reachable: List<Boolean>): Boolean = reachable.size > MAX_CONNECTABLE || reachable.any { !it }

    /** True when the eight that can connect are all on and more are paired. */
    public fun reachableFull(reachable: List<Boolean>): Boolean = reachable.size > MAX_CONNECTABLE && reachable.count { it } >= MAX_CONNECTABLE

    /**
     * How the show screen lays out for a window size (UI-KITS 4.3, LocalPairing): one centred column at every size, because a
     * screen shows the digits or the QR, never both. A window under 480 tall drops the logo and the column scrolls, with the
     * notice before the QR. A TV keeps its logo.
     */
    public fun layout(height: Double, tv: Boolean = false): Layout {
        val short = height < SHORT_WINDOW_HEIGHT && !tv
        return Layout(1, !short, short, short)
    }

    /**
     * The QR view's two columns (UI-KITS 4.9, Fit): from 720 dp of window at the root text size and 900 dp tall or less the text sits
     * at the start and the card at the end; otherwise one column.
     */
    public fun qrTwoColumns(width: Double, height: Double, textScale: Double = 1.0): Boolean {
        val scale = if (textScale > 0) textScale else 1.0
        return width / scale >= QR_COLUMNS_MIN_WIDTH && height <= QR_COLUMNS_MAX_HEIGHT
    }

    /** The words a scan notice says (`scanNotice` of the matrix). */
    public fun scanNoticeKey(notice: String): String? = when (notice) {
        "other-app" -> "localPairing.otherApp"
        "not-found" -> "localPairing.scanNotFound"
        "stale" -> "localPairing.scanStale"
        "not-ready" -> "localPairing.scannerNotReady"
        "preparing" -> "localPairing.scannerPreparing"
        else -> null
    }

    /** The show screen's layout: one pane at every size. */
    public data class Layout(val panes: Int, val logo: Boolean, val scrolls: Boolean, val noticeBeforeQr: Boolean)
}

private fun shares(categories: List<String>): String = if (categories.isEmpty()) "linkPairing.sharesNone" else "linkPairing.shares"

internal fun localPairingScreen(inputs: KitInputs): KitScreen {
    val p = inputs.obj("localPairing")
    if ("connect" !in inputs.closedServices || p == null) return hidden(KitComponent.localPairing)
    val context = KitContext(inputs)
    val device = p.string("device")?.takeIf { it.isNotBlank() }
    val categories = p.array("categories")?.strings().orEmpty()
    val step = p.string("step")
    val code = p.string("code")
    val args = buildMap<String, CopyArgument> {
        if (device != null) put("device", CopyArgument.Text(KitConnect.isolate(device)))
        if (code != null) put("code", CopyArgument.Text(KitConnect.spellOut(code)))
        put("time", CopyArgument.Text(KitLocal.countdown(if (step == "closed") p.integer("cooldownLeft") ?: 0 else p.integer("secondsLeft") ?: 0)))
        p.integer("triesLeft")?.let { put("left", CopyArgument.Number(it)) }
        put("max", CopyArgument.Number(p.integer("max") ?: KitLocal.MAX_CONNECTABLE))
        context.identity.inlineName.takeIf { it.isNotEmpty() }?.let { put("app", CopyArgument.Text(it)) }
    }
    fun view(state: String, keys: List<String?>, disabled: List<String?> = emptyList()) = screen(
        KitComponent.localPairing,
        state,
        keys.filterNotNull().distinct().map { context.line(it, args) },
    ).copy(disabledKeys = disabled.filterNotNull().distinct().sorted())
    val notice = p.string("notice")
    val busy = p.string("busy")
    val entry = p.string("entry").orEmpty()
    val canScan = p.boolean("canScan") == true
    val sheet = canScan && p.boolean("sheetScan") == true
    val scanNotice = p.string("scanNotice")?.let(KitLocal::scanNoticeKey)
    return when (step) {
        "choose" -> {
            val full = p.boolean("full") == true
            view(
                "choose",
                listOf(
                    "localPairing.title",
                    "localPairing.chooseBody",
                    if (sheet) scanNotice else null,
                    if (canScan) "localPairing.scan" else null,
                    "localPairing.show",
                    if (canScan && !sheet) null else "localPairing.enter",
                    if (sheet && p.boolean("scanShares") == true) shares(categories) else null,
                    if (p.boolean("prePrompt") == true && !full) "localPairing.prePrompt" else null,
                    if (full) "core.codes.local-links-full.title" else null,
                    if (full) "core.codes.local-links-full.message" else null,
                    if (full) "localPairing.pairedDevices" else null,
                    "common.cancel",
                ),
                if (full) listOf(if (canScan) "localPairing.scan" else "localPairing.enter", "localPairing.show") else emptyList(),
            )
        }

        "opening" -> view(
            "opening",
            listOf(
                "localPairing.title",
                "localPairing.showBody",
                "a11y.busy",
                "common.cancel",
            ),
        )

        "show" -> {
            val renewing = busy == "new-code"
            // The window ran out and nothing renewed it: the view stays, dimmed, with a new code one press away.
            val gone = p.boolean("expired") == true
            val n = if (gone) null else notice
            val timeLines = if (gone) emptyList() else listOf("localPairing.expires", "localPairing.waitingDevice")
            if (gone) {
                // Expired says it once, in the title (and to a screen reader): no instruction, no time and no switch, because both views
                // of a dead window are dead; the next window opens on the chosen one.
                val qrView = p.string("view") == "qr"
                return view(
                    if (qrView) "show-qr" else "show",
                    listOf(
                        "core.codes.sign-in-expired.title",
                        "localPairing.showNew",
                        "common.cancel",
                        if (qrView) {
                            "a11y.qrPairing"
                        } else if (code != null) {
                            "a11y.linkCode"
                        } else {
                            null
                        },
                        if (renewing) "a11y.busy" else null,
                    ),
                    listOf(if (renewing) "localPairing.showNew" else null),
                )
            }
            if (p.string("view") == "qr") {
                // The QR alone: no digits, said or drawn. What the code view announces is announced here too.
                view(
                    "show-qr",
                    listOf("localPairing.qrTitle", "localPairing.qrBody", "a11y.qrPairing") + timeLines + listOf(
                        "localPairing.toCode",
                        "common.cancel",
                        if (n == "blocked") "localPairing.blockedTitle" else null,
                        if (n == "blocked") "localPairing.blockedBody" else null,
                        if (n == "guessing" || n == "rotated") "localPairing.rotatedTitle" else null,
                        if (n == "guessing") "localPairing.tooManyAgainBody" else null,
                        if (n == "rotated" || n == "declined") "localPairing.rotatedBody" else null,
                        if (n == "declined") "localPairing.notPairedWith" else null,
                        if (renewing) "a11y.busy" else null,
                    ),
                    listOf(if (renewing) "localPairing.showNew" else null),
                )
            } else {
                view(
                    "show",
                    listOf("localPairing.title", "localPairing.showBody", if (code != null) "a11y.linkCode" else null) + timeLines + listOf(
                        "localPairing.toQr",
                        "common.cancel",
                        if (n == "rotated" || n == "guessing") "localPairing.rotatedTitle" else null,
                        if (n == "rotated" || n == "declined") "localPairing.rotatedBody" else null,
                        if (n == "declined") "localPairing.notPairedWith" else null,
                        if (n == "rotated" || n == "declined" || n == "guessing") "a11y.newCode" else null,
                        if (n == "blocked") "localPairing.blockedTitle" else null,
                        if (n == "blocked") "localPairing.blockedBody" else null,
                        if (n == "guessing") "localPairing.tooManyAgainBody" else null,
                        if (n != null && n != "blocked") "localPairing.showNew" else null,
                        if (renewing) "a11y.busy" else null,
                    ),
                    listOf(if (renewing) "localPairing.showNew" else null),
                )
            }
        }

        "closed" -> {
            val cooling = (p.integer("cooldownLeft") ?: 0) > 0
            val shown = if (cooling) "localPairing.showNewIn" else "localPairing.showNew"
            val warn = p.boolean("warn") == true
            view(
                "closed",
                listOf(
                    "linkPairing.failedTitle",
                    if (p.string("closedBy") == "too-many-tries") "localPairing.failedTooMany" else "localPairing.failedExpired",
                    if (warn) "localPairing.tooManyAgainTitle" else null,
                    if (warn) "localPairing.tooManyAgainBody" else null,
                    shown,
                    "common.close",
                ),
                listOf(if (cooling) "localPairing.showNewIn" else null),
            )
        }

        "scan-prompt" -> view(
            "scan-prompt",
            listOf("localPairing.cameraPromptTitle", "localPairing.cameraPrePrompt", "common.continue", "localPairing.enterInstead"),
        )

        "scan" -> view(
            "scan",
            listOf(
                "localPairing.title",
                "localPairing.scanBody",
                "a11y.cameraView",
                if (p.boolean("cameraBusy") == true) "localPairing.cameraBusy" else null,
                scanNotice,
                shares(categories),
                "localPairing.enterInstead",
                "common.back",
            ),
        )

        "camera-off" -> view(
            "camera-off",
            listOf(
                "localPairing.title",
                "localPairing.cameraOffTitle",
                "localPairing.cameraOffBody",
                if (p.boolean("canOpenSettings") != false) "localPairing.openSettings" else null,
                shares(categories),
                "localPairing.enterInstead",
                "common.back",
            ),
        )

        "enter", "joining" -> {
            val joining = step == "joining"
            val e = p.string("error")
            val triesLeft = p.integer("triesLeft")
            val spent = !joining && triesLeft == 0 && e == null
            view(
                step,
                listOf(
                    "localPairing.title",
                    "localPairing.enterBody",
                    "localPairing.codeLabel",
                    if (!joining && entry.isEmpty()) "localPairing.codePlaceholder" else null,
                    shares(categories),
                    "localPairing.pair",
                    if (joining) {
                        "a11y.busy"
                    } else if (canScan) {
                        "localPairing.scanInstead"
                    } else {
                        "localPairing.toShow"
                    },
                    if (joining) "common.cancel" else "common.back",
                    if (!joining && e == "wrong") "localPairing.wrongCode" else null,
                    if (!joining && triesLeft == 1 && e in setOf("wrong", null)) "localPairing.triesLeft" else null,
                    if (!joining && (e == "spent" || spent)) "localPairing.spentCode" else null,
                    if (!joining && e == "too-many") "localPairing.cooldownTitle" else null,
                    if (!joining && e == "too-many") "localPairing.cooldownBody" else null,
                    if (!joining && e == "not-found") "localPairing.notFoundTitle" else null,
                    if (!joining && e == "not-found") "localPairing.notFoundBody" else null,
                    if (!joining && e == "not-a-code") "localPairing.notACode" else null,
                ),
                listOf(if (joining || p.boolean("pairDisabled") == true) "localPairing.pair" else null),
            )
        }

        "confirm" -> view(
            "confirm",
            listOf(
                if (device != null) "localPairing.confirmTitle" else "localPairing.confirmUnnamed",
                "localPairing.confirmBody",
                shares(categories),
                "localPairing.pair",
                "common.notNow",
                if (busy != null) "a11y.busy" else null,
            ),
            if (busy != null) listOf("localPairing.pair", "common.notNow") else emptyList(),
        )

        "waiting" -> view(
            "waiting",
            listOf("linkPairing.waiting", if (device != null) "localPairing.waitingWith" else null, shares(categories), "common.cancel"),
        )

        "paired" -> {
            val cant = p.boolean("cantConnect") == true
            view(
                "paired",
                listOf(
                    "localPairing.pairedTitle",
                    "localPairing.pairedBody",
                    "localPairing.nameLabel",
                    "localPairing.nameHint",
                    if (cant) "localPairing.cantConnectTitle" else null,
                    if (cant) "localPairing.cantConnectBody" else null,
                    if (cant) "localPairing.pairedDevices" else null,
                    if (p.string("nameError") != null) "devices.renameFailed" else null,
                    "common.done",
                ),
            )
        }

        "failed" -> {
            val body = when (p.string("reason") ?: "closed") {
                "declined" -> "linkPairing.failedDeclined"
                "timeout" -> "linkPairing.failedTimeout"
                "full" -> "localPairing.failedFull"
                else -> "linkPairing.failedClosed"
            }
            view("failed", listOf("linkPairing.failedTitle", body, "common.tryAgain", "common.close"))
        }

        "network-blocked" -> view(
            "network-blocked",
            listOf(
                "core.codes.nearby-permission-denied.title",
                "core.codes.nearby-permission-denied.message",
                if (p.boolean("canOpenSettings") == true) "localPairing.openSettings" else null,
                "common.tryAgain",
                "common.close",
            ),
        )

        else -> view("off", listOf("core.codes.local-pairing-off.title", "core.codes.local-pairing-off.message", "common.close"))
    }
}

internal fun pairedDevicesScreen(inputs: KitInputs): KitScreen {
    val p = inputs.obj("pairedDevices")
    if ("connect" !in inputs.closedServices || p == null) return hidden(KitComponent.pairedDevices)
    val context = KitContext(inputs)
    val rows = p.array("devices")?.objects().orEmpty()
    val reachable = rows.map { it.boolean("reachable") != false }
    val seen = rows.any { it["lastSeen"].let { v -> v != null && v !is JsonNull } }
    val notice = p.obj("notice")
    val target = rows.firstOrNull { it.string("id") == p.string("target") }
    val name = target?.string("label")?.takeIf { it.isNotBlank() } ?: rows.firstOrNull()?.string("label").orEmpty()
    val renameError = p.string("renameError")
    val args = mapOf(
        "device" to CopyArgument.Text(KitConnect.isolate(notice?.string("device") ?: name)),
        "max" to CopyArgument.Number(if (renameError == "long") KitLocal.MAX_NAME else KitLocal.MAX_CONNECTABLE),
    )

    fun view(state: String, keys: List<String?>, disabled: List<String?> = emptyList()) = screen(
        KitComponent.pairedDevices,
        state,
        keys.filterNotNull().distinct().map { context.line(it, args) },
    ).copy(disabledKeys = disabled.filterNotNull().distinct().sorted())
    val step = p.string("step")
    when (step) {
        "loading" -> return view("loading", listOf("pairedDevices.title", "a11y.busy", "common.done"))

        "load-failed" -> return view("load-failed", listOf("pairedDevices.title", "pairedDevices.loadFailed", "common.tryAgain", "common.done"))

        "off" -> return view(
            "off",
            listOf(
                "pairedDevices.title",
                "core.codes.local-pairing-off.title",
                "pairedDevices.offBody",
                if (seen) "pairedDevices.lastSeen" else null,
                if (rows.isNotEmpty()) "a11y.deviceOptions" else null,
                if (rows.isNotEmpty()) "devices.rename" else null,
                if (rows.isNotEmpty()) "pairedDevices.forget" else null,
                "common.done",
            ),
        )
    }
    if (rows.isEmpty()) return view("empty", listOf("pairedDevices.title", "pairedDevices.empty", "pairedDevices.pair", "common.done"))
    val full = rows.size >= KitLocal.MAX_PAIRED
    val switches = KitLocal.showSwitchColumn(reachable)
    val state = when (step) {
        "renaming" -> "renaming"
        "forgetting" -> "forgetting"
        else -> "list"
    }
    val waits = state == "list" && KitLocal.reachableFull(reachable)
    val noticeKeys = if (state == "list") {
        when (notice?.string("kind")) {
            "not-found" -> listOf("pairedDevices.notFoundTitle", "pairedDevices.notFoundBody")
            "busy" -> listOf("pairedDevices.busyTitle", "common.tryAgain")
            "unknown" -> listOf("core.codes.link-unknown.title", "core.codes.link-unknown.message")
            else -> emptyList()
        }
    } else {
        emptyList()
    }
    val renaming = state == "renaming"
    val forgetting = state == "forgetting"
    return view(
        state,
        listOf(
            "pairedDevices.title",
            "pairedDevices.lede",
            if (seen) "pairedDevices.lastSeen" else null,
            "a11y.deviceOptions",
            "devices.rename",
            "pairedDevices.forget",
            if (switches) "pairedDevices.canConnect" else null,
            if (switches) "a11y.letConnect" else null,
            if (waits) "pairedDevices.reachableFullTitle" else null,
            if (waits) "pairedDevices.reachableFullBody" else null,
            if (state == "list" && full) "core.codes.local-links-full.title" else null,
            if (state == "list" && full) "pairedDevices.fullBody" else null,
        ) + noticeKeys + listOf(
            if (renaming) "devices.renameLabel" else null,
            if (renaming) "localPairing.nameHint" else null,
            if (renaming) "common.save" else null,
            if (renaming) "common.cancel" else null,
            if (renaming && renameError == "long") "pairedDevices.renameLong" else null,
            if (renaming && renameError == "empty") "pairedDevices.renameEmpty" else null,
            if (renaming && renameError == "failed") "devices.renameFailed" else null,
            if (forgetting) "pairedDevices.forgetConfirm" else null,
            if (forgetting) "pairedDevices.forgetBody" else null,
            if (forgetting && p.boolean("forgetError") == true) "pairedDevices.forgetFailed" else null,
            if (forgetting) "common.cancel" else null,
            "pairedDevices.pair",
            "common.done",
        ),
        listOf(if (full) "pairedDevices.pair" else null),
    )
}
