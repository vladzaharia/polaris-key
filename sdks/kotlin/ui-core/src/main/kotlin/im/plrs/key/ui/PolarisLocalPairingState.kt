// @pkey-feature connect.local
// The Compose-free state holder behind LocalPairing (CC-29K), the Kotlin twin of ui-core's `LocalPairingModel`
// (packages/ui-core/src/localPairingModel.ts) and of the Swift `LocalPairingModel`. It runs over [PolarisLocalLinks]:
//
//   choose -> show (closed) | enter (joining, waiting) -> confirm -> paired | failed
//
//  - show: the window runs from `expiresAt`; a wrong guess changes the code (the changed digits are lit, the new code announced); an
//    end of `too-many-tries` closes it and a new code waits 30 s (the SDK enforces the same floor and rejects `cooldown`, which waits
//    out the rest); a window that ran out waits for nothing;
//  - the second `too-many-tries` in a row, or 5 wrong codes over renewed windows with no pairing, warns that someone nearby may be
//    guessing codes (D4);
//  - enter: Pair is unavailable with fewer than 8 digits, a prefix with no dial left, or the very code that just failed; pressing it
//    answers its reason under the field. After `wrong` the first two digits stay and the rest clears; after `spent` the field is empty
//    and editable. The failed code is held only while the screen is up and never shown or logged;
//  - Pair is the joiner's consent: the other device's prompt is confirmed at once and the screen waits for the other person.
//
// Every mutation runs on [scope]'s dispatcher: the SDK's callbacks, which arrive on service threads, hop onto it first. The clock
// ([now], seconds) and the one-second tick are injected, so a test drives them.
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions", "LongParameterList", "CyclomaticComplexMethod", "LongMethod")

package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LocalLinksCap
import im.plrs.key.core.PairingCodeFailedReason
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** What the pairing screen shows: the matrix's `localPairing` input, plus what a renderer needs beside it. */
public data class PolarisLocalPairingUi(
    val step: String = "choose",
    val prePrompt: Boolean = false,
    val full: Boolean = false,
    val code: String? = null,
    val qr: String? = null,
    val secondsLeft: Int? = null,
    val notice: String? = null,
    val busy: String? = null,
    val closedBy: String? = null,
    val cooldownLeft: Int? = null,
    val warn: Boolean = false,
    val entry: String? = null,
    val error: String? = null,
    val triesLeft: Int? = null,
    val pairDisabled: Boolean = false,
    val categories: List<String> = emptyList(),
    val device: String? = null,
    val reason: String? = null,
    val canOpenSettings: Boolean = false,
    val cantConnect: Boolean = false,
    val nameError: Boolean = false,
    val max: Int = KitLocal.MAX_CONNECTABLE,
    /** show: the digit positions (0-8, the space counted) that changed in the last rotation. */
    val changed: List<Int> = emptyList(),
    /** show: bumps with each new code, so a renderer can restart its highlight and announce it. */
    val rotation: Int = 0,
    /** paired: the name field's text; Done renames when it changed. */
    val name: String = "",
    /** paired: the pairing's id. */
    val id: String? = null,
    /** show: this code replaced one the person was looking at (a wrong guess, a Not now, Show a new code). */
    val replaced: Boolean = false,
    /** The person left (Cancel on choose, Close, Done): the host closes the screen. */
    val left: Boolean = false,
) {
    /** The matrix's `localPairing` input for this step. */
    public fun toInputs(): KitInputs {
        val members = buildMap<String, JsonElement> {
            put("step", JsonPrimitive(step))
            if (prePrompt) put("prePrompt", JsonPrimitive(true))
            if (full) put("full", JsonPrimitive(true))
            code?.let { put("code", JsonPrimitive(it)) }
            qr?.let { put("qr", JsonPrimitive(it)) }
            secondsLeft?.let { put("secondsLeft", JsonPrimitive(it)) }
            notice?.let { put("notice", JsonPrimitive(it)) }
            busy?.let { put("busy", JsonPrimitive(it)) }
            closedBy?.let { put("closedBy", JsonPrimitive(it)) }
            cooldownLeft?.let { put("cooldownLeft", JsonPrimitive(it)) }
            if (warn) put("warn", JsonPrimitive(true))
            entry?.let { put("entry", JsonPrimitive(it)) }
            error?.let { put("error", JsonPrimitive(it)) }
            put("triesLeft", triesLeft?.let { JsonPrimitive(it) } ?: JsonNull)
            if (pairDisabled) put("pairDisabled", JsonPrimitive(true))
            put("categories", JsonArray(categories.map(::JsonPrimitive)))
            device?.let { put("device", JsonPrimitive(it)) }
            reason?.let { put("reason", JsonPrimitive(it)) }
            if (canOpenSettings) put("canOpenSettings", JsonPrimitive(true))
            if (cantConnect) put("cantConnect", JsonPrimitive(true))
            if (nameError) put("nameError", JsonPrimitive("failed"))
            put("max", JsonPrimitive(max))
        }
        return KitInputs.of(mapOf("localPairing" to kotlinx.serialization.json.JsonObject(members)))
    }

    /** The resolved screen. */
    public fun screen(base: KitInputs? = null): KitScreen {
        val inputs = base?.let { KitInputs.fromJson(kotlinx.serialization.json.JsonObject(it.raw + toInputs().raw)) } ?: toInputs()
        return KitStates.resolve(KitComponent.localPairing, inputs)
    }
}

/** The pairing screens' state holder. [scope] runs the SDK calls and every mutation. */
public class PolarisLocalPairingState(
    private val driver: PolarisLocalLinks,
    private val categories: List<String>,
    private val scope: CoroutineScope,
    private val label: String? = null,
    private val prePrompt: Boolean = false,
    private val canOpenSettings: Boolean = false,
    /** Seconds since the epoch. */
    private val now: () -> Double = { System.currentTimeMillis() / MILLIS_PER_SECOND },
    /** Wait [ms], then run the one-second tick; tests replace it with a manual one. */
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val _ui = MutableStateFlow(
        PolarisLocalPairingUi(categories = categories.toList(), prePrompt = prePrompt),
    )
    public val ui: StateFlow<PolarisLocalPairingUi> = _ui.asStateFlow()

    private var shower: PolarisLocalWindow? = null
    private var offer: PolarisLocalOffer? = null
    private var joinJob: Job? = null
    private var tickJob: Job? = null
    private var expiresAt = 0.0
    private var cooldownUntil = 0.0
    private var tooMany = 0
    private var wrong = 0
    private var failedCode: String? = null
    private var lastDevice: String? = null
    private var epoch = 0
    private var typed = ""
    private var blocked: Pair<String, String>? = null

    private fun ui(change: PolarisLocalPairingUi.() -> PolarisLocalPairingUi) {
        _ui.value = _ui.value.change()
    }

    // ── Start ────────────────────────────────────────────────────────────────────────────────────

    /** Read the gate and the cap: the entry screen says so before either button. */
    public suspend fun start() {
        close()
        if (!driver.localPairing()) {
            go(PolarisLocalPairingUi(step = "off"))
            return
        }
        val full = try {
            driver.list().size >= KitLocal.MAX_PAIRED
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            false
        }
        go(entryStep().copy(full = full))
    }

    // ── Show ─────────────────────────────────────────────────────────────────────────────────────

    /** This device shows the code. */
    public suspend fun show() {
        if (_ui.value.full) return
        openWindow()
    }

    /** Show a new code: closes the window and opens one with new first two digits. Waits out the 30 seconds after Too many tries. */
    public suspend fun showNew() {
        if (cooldownLeft() > 0) return
        openWindow(renew = true)
    }

    private suspend fun openWindow(renew: Boolean = false) {
        val renewing = renew && shower != null
        if (!renewing) epoch++
        val mine = epoch
        fun live() = mine == epoch
        // A second press while the first is answered does nothing.
        if (renewing && _ui.value.busy != null) return
        if (renewing) ui { copy(busy = "new-code") } else go(PolarisLocalPairingUi(step = "opening"))
        try {
            val current = shower
            if (renewing && current != null) {
                val next = current.renew()
                if (live()) rotate(next)
            } else {
                close(bump = false)
                if (live()) startWindow(::live)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (live()) fail(e, "show")
        }
    }

    private suspend fun startWindow(live: () -> Boolean) {
        val events = PolarisLocalEvents(
            onCode = { c -> scope.launch { if (live()) rotate(c) } },
            onConfirm = { o -> scope.launch { if (live()) confirmPrompt(o) } },
            onLinked = { l -> scope.launch { if (live()) linked(l) } },
            onInterrupted = { n -> scope.launch { if (live() && interrupted(n)) ui { copy(notice = "blocked") } } },
            onEnd = { r -> scope.launch { if (live()) ended(r) } },
        )
        val window = driver.pair(categories, label, events)
        if (live()) shower = window else window.stop()
    }

    private fun interrupted(n: Int): Boolean = n >= BLOCKED_AFTER && _ui.value.step == "show"

    private fun rotate(c: PolarisLocalCode) {
        val prev = _ui.value
        expiresAt = c.expiresAt.toDouble()
        val opened = c.reason == "opened"
        val wrongCode = c.reason == "wrong-code"
        // A changed code ends the session that was at the prompt: whatever the reason, its offer is over, or the next device would be
        // refused as "one at a time" by a prompt that is gone.
        if (prev.step == "confirm" || (!opened && !wrongCode)) offer = null
        if (wrongCode) wrong++
        val diff = if (!opened && prev.code != null) {
            c.code.indices.filter { it >= prev.code.length || c.code[it] != prev.code[it] }
        } else {
            emptyList()
        }
        val notice = when {
            opened -> null
            wrongCode -> if (wrong >= TOO_MANY_WRONG) "guessing" else "rotated"
            else -> "declined"
        }
        go(
            PolarisLocalPairingUi(
                step = "show",
                code = c.code,
                qr = c.qr,
                secondsLeft = maxOf(0, kotlin.math.ceil(expiresAt - now()).toInt()),
                notice = notice,
                device = if (notice == "declined") lastDevice else null,
                changed = diff,
                rotation = prev.rotation + 1,
                replaced = prev.step == "show" || prev.step == "confirm",
            ),
        )
        tick()
    }

    private fun ended(reason: String) {
        offer = null
        shower = null
        cancelTick()
        when (reason) {
            "too-many-tries" -> {
                tooMany++
                cooldownUntil = now() + KitLocal.COOLDOWN_SECONDS
                go(PolarisLocalPairingUi(step = "closed", closedBy = "too-many-tries", cooldownLeft = KitLocal.COOLDOWN_SECONDS, warn = tooMany >= 2))
                tick()
            }

            "expired" -> go(PolarisLocalPairingUi(step = "closed", closedBy = "expired", warn = tooMany >= 2))

            "off" -> go(PolarisLocalPairingUi(step = "off"))

            "stored" -> Unit

            // `onLinked` took the screen to paired

            else -> go(entryStep()) // the person's own stop: back to the entry, nothing kept
        }
    }

    // ── Confirm ──────────────────────────────────────────────────────────────────────────────────

    private fun confirmPrompt(o: PolarisLocalOffer) {
        if (offer != null) {
            // One device at a time: the next one is declined, not left waiting.
            scope.launch { runCatching { o.decline() } }
            return
        }
        offer = o
        lastDevice = o.label
        go(PolarisLocalPairingUi(step = "confirm", categories = o.categories.toList(), device = o.label?.takeIf { it.isNotBlank() }))
    }

    private fun idleOffer(): PolarisLocalOffer? = offer.takeIf { _ui.value.step == "confirm" && _ui.value.busy == null }

    /** Pair, at the prompt: the person's yes. The link exists once the other person agrees too. */
    public suspend fun confirm() {
        val o = idleOffer() ?: return
        ui { copy(busy = "pair") }
        runCatching { o.confirm() }.onFailure { clearBusy(o) }
    }

    /** Not now: nothing is stored; the shower stays on its changed code. */
    public suspend fun notNow() {
        val o = idleOffer() ?: return
        ui { copy(busy = "not-now") }
        runCatching { o.decline() }.onFailure { clearBusy(o) }
    }

    /** The press could not be answered: the controls are available again, if the prompt is still the one pressed. */
    private fun clearBusy(o: PolarisLocalOffer) {
        if (offer === o && _ui.value.step == "confirm") ui { copy(busy = null) }
    }

    private fun linked(l: PolarisLocalPaired) {
        shower = null
        cancelTick()
        stored(l)
    }

    private fun stored(l: PolarisLocalPaired) {
        offer = null
        joinJob = null
        tooMany = 0
        wrong = 0
        failedCode = null
        lastDevice = null
        go(PolarisLocalPairingUi(step = "paired", device = l.label?.takeIf { it.isNotBlank() }, name = l.label.orEmpty(), id = l.id))
        scope.launch { checkReachable(l.id) }
    }

    /** A pairing kept with Can connect off because 8 already are says so. */
    private suspend fun checkReachable(id: String) {
        val mine = epoch
        val row = try {
            driver.list().firstOrNull { it.id == id }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            null
        }
        if (row != null && !row.reachable && mine == epoch) ui { copy(cantConnect = true) }
    }

    /** The name field of the paired screen. */
    public fun setName(text: String) {
        if (_ui.value.step == "paired") ui { copy(name = text, nameError = false) }
    }

    private fun renamed(s: PolarisLocalPairingUi, name: String): Boolean = name.isNotEmpty() && s.name != s.device

    /** Done: a changed name is saved on this device, then the screen is left. */
    public suspend fun done() {
        val s = _ui.value
        val name = s.name.trim()
        if (s.step == "paired" && s.id != null && renamed(s, name)) {
            try {
                driver.rename(s.id, name)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // The name was not kept: the screen stays and says so.
                ui { copy(nameError = true) }
                return
            }
        }
        leave()
    }

    // ── Enter ────────────────────────────────────────────────────────────────────────────────────

    /** This device types the code. */
    public suspend fun enter() {
        if (_ui.value.full) return
        close()
        failedCode = null
        go(PolarisLocalPairingUi(step = "enter", entry = ""))
        refreshEntry()
    }

    /** The field changed. Spaces and hyphens in a paste are dropped; at most 8 digits are kept. */
    public fun setEntry(text: String) {
        val s = _ui.value
        if (s.step != "enter") return
        val d = digits(text)
        val prev = digits(s.entry.orEmpty())
        // A wrong code's line stays until the person types past the two digits the shower proved.
        val keepWrong = s.error == "wrong" && d.length <= 2
        ui { copy(entry = grouped(d), error = if (keepWrong) "wrong" else null) }
        if (d != prev) refreshEntry()
    }

    private fun refreshEntry() {
        val s = _ui.value
        if (s.step != "enter") return
        val d = digits(s.entry.orEmpty())
        val left = driver.dialsLeft(d)
        val stale = failedCode != null && d == failedCode
        ui { copy(triesLeft = left, pairDisabled = d.length < CODE_DIGITS || left == 0 || stale) }
    }

    /** Pair. Unavailable, it answers its reason under the field and sends nothing. */
    public suspend fun pair() {
        val s = _ui.value
        if (s.step != "enter") return
        val d = digits(s.entry.orEmpty())
        if (s.pairDisabled) {
            val reason = if (failedCode != null && d == failedCode) {
                "wrong"
            } else if (s.triesLeft == 0) {
                "spent"
            } else {
                "not-a-code"
            }
            ui { copy(error = reason) }
            return
        }
        typed = grouped(d)
        val mine = ++epoch
        fun live() = mine == epoch
        ui { copy(step = "joining", error = null) }
        val job = scope.launch {
            try {
                val link = driver.join(d, categories, label) { o ->
                    scope.launch {
                        if (!live()) return@launch
                        offer = o
                        // Pair was the yes: confirm at once and wait for the other person.
                        ui { copy(step = "waiting", categories = o.categories.toList(), device = o.label?.takeIf { it.isNotBlank() } ?: device) }
                        runCatching { o.confirm() }
                    }
                }
                if (live()) stored(link)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (live()) joinFailed(e, d)
            }
        }
        joinJob = job
        job.join()
    }

    private fun joinFailed(e: Throwable, code: String) {
        joinJob = null
        offer = null
        val f = e as? PolarisLocalFailure
        when {
            f?.code == ErrorCode.pairingCodeFailed && f.reason == PairingCodeFailedReason.spent -> {
                // B2: the field is empty and editable; Pair waits for first two digits that differ.
                failedCode = null
                back("", "too-many")
            }

            f?.code == ErrorCode.pairingCodeFailed && f.reason == PairingCodeFailedReason.invalid -> back(grouped(code), "not-a-code")

            f?.code == ErrorCode.pairingCodeFailed -> {
                // B1: `wrong` and another app's QR read alike. The first two digits stay.
                failedCode = code
                back(code.take(2), "wrong")
            }

            f?.code == ErrorCode.pairingNotFound -> back(grouped(code), "not-found")

            f?.code == ErrorCode.peerClosed && f.reason == "cancelled" -> back(grouped(code), null)

            f?.code == ErrorCode.peerClosed -> go(
                PolarisLocalPairingUi(step = "failed", reason = if (f.reason == "declined" || f.reason == "timeout") f.reason else "closed"),
            )

            else -> fail(e, "enter", grouped(code))
        }
    }

    private fun back(entry: String, error: String?) {
        go(PolarisLocalPairingUi(step = "enter", entry = entry, error = error))
        refreshEntry()
    }

    /** Show a code instead, from the field. */
    public suspend fun toShow(): Unit = openWindow()

    /** Enter a code instead, from a shown code: the window is withdrawn at once. */
    public suspend fun toEnter(): Unit = enter()

    // ── Leaving ──────────────────────────────────────────────────────────────────────────────────

    /** Cancel: withdraws the code, stops a join or declines a prompt, and returns one step. */
    public suspend fun cancel() {
        when (_ui.value.step) {
            "joining", "waiting" -> {
                val o = offer
                joinJob?.cancel()
                epoch++
                joinJob = null
                offer = null
                if (o != null) runCatching { o.decline() }
                // Cancel stops the join, not the typing: the code is still in the field.
                failedCode = null
                go(PolarisLocalPairingUi(step = "enter", entry = typed))
                refreshEntry()
            }

            "opening", "show", "confirm" -> {
                close()
                go(entryStep())
            }

            else -> leave()
        }
    }

    /** Back, from the field: to the entry. */
    public suspend fun backToChoose() {
        close()
        go(entryStep())
    }

    /** Close, Done or Cancel on the entry: the host closes the screen. */
    public suspend fun closeScreen() {
        close()
        leave()
    }

    private suspend fun close(bump: Boolean = true) {
        if (bump) epoch++
        cancelTick()
        val o = offer
        val w = shower
        val j = joinJob
        offer = null
        shower = null
        joinJob = null
        j?.cancel()
        withContext(NonCancellable) {
            o?.let { runCatching { it.decline() } }
            w?.let { runCatching { it.stop() } }
        }
    }

    /** Try again, from a failed pairing, or from the network answer: back to the step it came from, with the field kept. */
    public suspend fun retry() {
        if (_ui.value.step != "network-blocked") {
            enter()
            return
        }
        val from = blocked
        blocked = null
        if (from?.first == "enter") {
            enter()
            setEntry(from.second)
            return
        }
        openWindow()
    }

    /** The renderer left the composition: withdraw the code, stop a join and decline a prompt, whatever the step. */
    public fun dispose() {
        scope.launch { close() }
    }

    private fun leave() {
        scope.launch { close() }
        ui { copy(left = true) }
    }

    // ── Time ─────────────────────────────────────────────────────────────────────────────────────

    private fun cooldownLeft(): Int = maxOf(0, kotlin.math.ceil(cooldownUntil - now()).toInt())

    /** One second passed: the ring and the wait follow the clock. Public so a test drives it. */
    public fun tick() {
        cancelTick()
        val s = _ui.value
        if (s.step == "show") {
            ui { copy(secondsLeft = maxOf(0, kotlin.math.ceil(expiresAt - now()).toInt())) }
        } else if (s.step == "closed" && (s.cooldownLeft ?: 0) > 0) {
            val left = cooldownLeft()
            ui { copy(cooldownLeft = left) }
            if (left == 0) return
        } else {
            return
        }
        tickJob = scope.launch {
            sleep(TICK_MS)
            tick()
        }
    }

    private fun cancelTick() {
        tickJob?.cancel()
        tickJob = null
    }

    // ── Errors ───────────────────────────────────────────────────────────────────────────────────

    /** A rejection no screen of the flow names: the gate, the cap, the network, or the shower. */
    private fun fail(e: Throwable, where: String, entry: String = "") {
        val f = e as? PolarisLocalFailure
        when {
            f?.code == ErrorCode.localPairingOff -> go(PolarisLocalPairingUi(step = "off"))

            f?.code == ErrorCode.nearbyPermissionDenied -> {
                blocked = where to entry
                go(PolarisLocalPairingUi(step = "network-blocked", canOpenSettings = canOpenSettings))
            }

            f?.code == ErrorCode.localLinksFull && f.cap == LocalLinksCap.stored ->
                go(PolarisLocalPairingUi(step = if (where == "show") "choose" else "failed", full = true, reason = "full"))

            f?.code == ErrorCode.peerClosed && f.reason == "cooldown" -> {
                // The SDK's floor is on: wait out the rest of the 30 s on the closed screen.
                cooldownUntil = maxOf(cooldownUntil, now() + KitLocal.COOLDOWN_SECONDS)
                go(PolarisLocalPairingUi(step = "closed", closedBy = "too-many-tries", cooldownLeft = cooldownLeft()))
                tick()
            }

            else -> go(PolarisLocalPairingUi(step = "failed", reason = "closed"))
        }
    }

    // ── Plumbing ─────────────────────────────────────────────────────────────────────────────────

    private fun entryStep() = PolarisLocalPairingUi(step = "choose", prePrompt = prePrompt)

    /** Replace the screen: only what is named survives, with the categories and the rotation count kept. */
    private fun go(next: PolarisLocalPairingUi) {
        val prev = _ui.value
        _ui.value = next.copy(
            categories = if (next.step == "confirm" || next.categories.isNotEmpty()) next.categories else categories.toList(),
            rotation = if (next.step == "show") next.rotation else prev.rotation,
            left = prev.left,
            canOpenSettings = next.canOpenSettings,
        )
    }

    private companion object {
        const val TOO_MANY_WRONG = 5
        const val CODE_DIGITS = 8
        const val TICK_MS = 1000L
        const val MILLIS_PER_SECOND = 1000.0
        const val BLOCKED_AFTER = 3
        const val GROUP = 4

        fun digits(text: String): String = text.filter { it in '0'..'9' }.take(CODE_DIGITS)

        fun grouped(d: String): String = if (d.length > GROUP) "${d.take(GROUP)} ${d.drop(GROUP)}" else d
    }
}
