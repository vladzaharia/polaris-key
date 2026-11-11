// @pkey-feature connect.local
// The Compose-free state holder behind PairedDevices (CC-29K), the Kotlin twin of ui-core's `PairedDevicesModel`
// (packages/ui-core/src/pairedDevicesModel.ts), over the same [PolarisLocalLinks] driver as [PolarisLocalPairingState]. It re-reads
// `list()` on `onChange`, so a pairing, a rename in another window, a forget or a gate flip shows without a refresh.
//
//  - rows: the switch column's rule is [KitLocal.showSwitchColumn] (more than 8, or one off);
//  - Rename and Forget work in the row: a refused name keeps its text and says why; after a Forget focus moves to the next row, or the
//    title when none is left;
//  - a switch the SDK refuses with `cap: reachable` says "Up to 8 can connect", never the 32-device copy; an unreadable record is
//    `load-failed` with Try again;
//  - with the gate off only Rename and Forget remain, and the host's entry shows while a link is held ([PolarisPairedDevicesUi.entryVisible]).
@file:Suppress("TooGenericExceptionCaught", "SwallowedException", "TooManyFunctions")

package im.plrs.key.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Where focus goes after an edit or a Forget: the row's options button, or the title. */
public sealed interface PolarisPairedFocus {
    public data class Row(val id: String) : PolarisPairedFocus

    public data object Title : PolarisPairedFocus
}

/** What the list shows: the matrix's `pairedDevices` input, plus what a renderer needs beside it. */
public data class PolarisPairedDevicesUi(
    val step: String = "loading",
    val devices: List<PolarisPairedDevice> = emptyList(),
    val target: String? = null,
    val renameError: String? = null,
    val forgetError: Boolean = false,
    val notice: PolarisPairedNotice? = null,
    /** The text in the rename field. */
    val draft: String = "",
    /** Set after an edit; the renderer moves focus and consumes it. */
    val focus: PolarisPairedFocus? = null,
    /** True once the first read finished. */
    val loaded: Boolean = false,
    /** The host's "Paired devices" entry shows: pairing is on, or at least one link is held. */
    val entryVisible: Boolean = false,
    val left: Boolean = false,
    /** The person asked to pair another (the host opens Pair with a Code). */
    val pairAnother: Boolean = false,
) {
    /** The matrix's `pairedDevices` input for this step. */
    public fun toInputs(): KitInputs {
        val members = buildMap<String, JsonElement> {
            put("step", JsonPrimitive(step))
            put(
                "devices",
                JsonArray(
                    devices.map {
                        JsonObject(
                            mapOf(
                                "id" to JsonPrimitive(it.id),
                                "label" to (it.label?.let(::JsonPrimitive) ?: JsonNull),
                                "lastSeen" to (it.lastSeen?.let(::JsonPrimitive) ?: JsonNull),
                                "reachable" to JsonPrimitive(it.reachable),
                            ),
                        )
                    },
                ),
            )
            target?.let { put("target", JsonPrimitive(it)) }
            renameError?.let { put("renameError", JsonPrimitive(it)) }
            if (forgetError) put("forgetError", JsonPrimitive(true))
            notice?.let {
                put(
                    "notice",
                    JsonObject(buildMap { put("device", JsonPrimitive(it.device)); put("kind", JsonPrimitive(it.kind)); it.id?.let { id -> put("id", JsonPrimitive(id)) } }),
                )
            }
        }
        return KitInputs.of(mapOf("pairedDevices" to JsonObject(members)))
    }

    /** The resolved screen. */
    public fun screen(base: KitInputs? = null): KitScreen {
        val inputs = base?.let { KitInputs.fromJson(JsonObject(it.raw + toInputs().raw)) } ?: toInputs()
        return KitStates.resolve(KitComponent.pairedDevices, inputs)
    }
}

/** An answer the app's own connection to a device gave: [kind] is `not-found`, `busy` or `unknown`. */
public data class PolarisPairedNotice(val device: String, val kind: String, val id: String? = null)

/** The paired devices' state holder. Calls run in the caller's coroutine; the renderer calls them from its scope. */
public class PolarisPairedDevicesState(private val driver: PolarisLocalLinks) {
    private val _ui = MutableStateFlow(PolarisPairedDevicesUi())
    public val ui: StateFlow<PolarisPairedDevicesUi> = _ui.asStateFlow()

    private var unsubscribe: (() -> Unit)? = null
    private var reads = 0

    private fun ui(change: PolarisPairedDevicesUi.() -> PolarisPairedDevicesUi) {
        _ui.value = _ui.value.change()
    }

    /** Read the list and follow the SDK's changes until [stop]. [onChange] is how a change from the SDK reaches this holder's scope. */
    public suspend fun start(onChange: (suspend () -> Unit) -> Unit = {}) {
        if (unsubscribe == null) unsubscribe = driver.onChange { onChange { refresh() } }
        refresh()
    }

    public fun stop() {
        unsubscribe?.invoke()
        unsubscribe = null
    }

    /** Read `list()` and the gate again (also Try again). */
    public suspend fun refresh() {
        val read = ++reads
        // Try again from a failed read shows the loading treatment, not the stale failure.
        if (_ui.value.step == "load-failed") ui { copy(step = "loading") }
        val on = driver.localPairing()
        val rows = try {
            driver.list()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (read != reads) return
            ui { copy(step = "load-failed", devices = emptyList(), loaded = true, entryVisible = false) }
            return
        }
        if (read != reads) return
        ui {
            val editing = step == "renaming" || step == "forgetting"
            val stillThere = editing && rows.any { it.id == target }
            copy(
                devices = rows,
                loaded = true,
                entryVisible = on || rows.isNotEmpty(),
                step = if (!on) "off" else if (stillThere) step else "list",
                target = if (!on || !stillThere) null else target,
                renameError = if (!on || !stillThere) null else renameError,
            )
        }
    }

    // ── Rows ─────────────────────────────────────────────────────────────────────────────────────

    /** Rename, from the row's menu. The field starts with the name now held. */
    public fun startRename(id: String) {
        val d = _ui.value.devices.firstOrNull { it.id == id } ?: return
        ui { copy(step = "renaming", target = id, draft = d.label.orEmpty(), renameError = null, focus = null) }
    }

    public fun setDraft(text: String) {
        if (_ui.value.step == "renaming") ui { copy(draft = text, renameError = null) }
    }

    /** Save: a refused name keeps its text and focus and says why. Nothing is sent to the other device. */
    public suspend fun saveRename() {
        val s = _ui.value
        val target = s.target
        if (s.step != "renaming" || target == null) return
        val name = s.draft.trim()
        if (name.isEmpty()) {
            ui { copy(renameError = "empty") }
            return
        }
        if (name.codePointCount(0, name.length) > KitLocal.MAX_NAME) {
            ui { copy(renameError = "long") }
            return
        }
        try {
            driver.rename(target, name)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // `bad_input` is a name the SDK cleans to nothing; any other rejection is the store's. The text and the focus stay either way.
            ui { copy(renameError = if ((e as? PolarisLocalFailure)?.reason == "bad_input") "empty" else "failed") }
            return
        }
        endEdit(target)
        refresh()
    }

    /** Forget, from the row's menu: asks inside the row. */
    public fun askForget(id: String) {
        if (_ui.value.devices.none { it.id == id }) return
        ui { copy(step = "forgetting", target = id, renameError = null, forgetError = false, focus = null) }
    }

    /** Forget: deletes it here only; the other device is not told. Focus moves on. */
    public suspend fun confirmForget() {
        val s = _ui.value
        val target = s.target
        if (s.step != "forgetting" || target == null) return
        val at = s.devices.indexOfFirst { it.id == target }
        val next = s.devices.getOrNull(at + 1) ?: s.devices.getOrNull(at - 1)
        try {
            driver.remove(target)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // Not forgotten: the question stays, with the reason, so Forget can be pressed again.
            ui { copy(forgetError = true) }
            return
        }
        endEdit(null)
        refresh()
        val remaining = _ui.value.devices
        ui { copy(focus = if (next != null && remaining.any { it.id == next.id }) PolarisPairedFocus.Row(next.id) else PolarisPairedFocus.Title) }
    }

    /** Cancel an edit: the row is as it was. */
    public fun cancelEdit(): Unit = endEdit(_ui.value.target)

    /** The renderer took the focus request. */
    public fun focusHandled(): Unit = ui { copy(focus = null) }

    private fun endEdit(row: String?) = ui {
        copy(
            step = if (driver.localPairing()) "list" else "off",
            target = null,
            renameError = null,
            forgetError = false,
            draft = "",
            focus = row?.let { PolarisPairedFocus.Row(it) },
        )
    }

    /**
     * A Can connect switch. A ninth is refused by the SDK (`cap: reachable`); the list says "Up to 8 can connect" itself, so the
     * refusal changes nothing but the re-read that puts the switch back.
     */
    public suspend fun setReachable(id: String, on: Boolean) {
        try {
            driver.setReachable(id, on)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // refused: the re-read puts the switch back
        }
        refresh()
    }

    /** The answer of the app's own connection to a device, shown with the list ([kind] null clears it). */
    public fun report(id: String, kind: String?) {
        val d = _ui.value.devices.firstOrNull { it.id == id }
        ui { copy(notice = if (kind != null && d != null) PolarisPairedNotice(d.label.orEmpty(), kind, id) else null) }
    }

    /** Pair with a Code, the one primary. */
    public fun requestPair(): Unit = ui { copy(pairAnother = true) }

    /** Done. */
    public fun done() {
        stop()
        ui { copy(left = true) }
    }
}
