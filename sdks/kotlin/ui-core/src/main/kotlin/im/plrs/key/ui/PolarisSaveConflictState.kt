// @pkey-feature ui.kit
// The Compose-free SaveConflict state holder (U-22.K4): the choose, keeping, kept and failed steps of
// the ui-matrix `saveConflict` family, driven by one resolver the host binds to the saves client
// (K.4T). A renderer draws [PolarisSaveConflictUi] through [kitScreen]; every host folds the same steps.
//
// Rules kept here (UI-KITS Must not):
//  - a save is never discarded without a choice: nothing is applied until [keep] is called, and a
//    second choice while one runs (or after it was kept) is ignored, so a choice is applied once;
//  - Keep both needs a free slot and a copy to keep: without them it is ignored, not applied;
//  - Choose again after a failure returns to the choices with the same versions and applies nothing;
//  - `kept` follows only a resolver that returned, and names the choice that was made.
package im.plrs.key.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The copy the person keeps: this device's, the other, or both (the other as a copy). */
public enum class PolarisSaveKeep(public val id: String) {
    Local("local"),
    Remote("remote"),
    Both("both"),
}

/** One copy of the save, display-ready: when it was saved, and on which device (the other copy only). */
public data class PolarisSaveVersion(val whenText: String? = null, val device: String? = null)

/** Applies a choice; throws when it could not (both copies then stay as they were). */
public fun interface PolarisSaveResolver {
    public suspend fun keep(keep: PolarisSaveKeep)
}

/** Where the conflict is. */
public sealed interface PolarisSaveConflictUi {
    public data object Choose : PolarisSaveConflictUi

    public data class Keeping(val keep: PolarisSaveKeep) : PolarisSaveConflictUi

    public data class Kept(val keep: PolarisSaveKeep) : PolarisSaveConflictUi

    public data class Failed(val keep: PolarisSaveKeep) : PolarisSaveConflictUi

    /** The person left the conflict: it stays as it was. */
    public data object Cancelled : PolarisSaveConflictUi

    /** The person closed the result: nothing more to draw. */
    public data object Done : PolarisSaveConflictUi
}

/** The version the app knows was saved later (its own metadata, never the display strings). */
public enum class PolarisSaveNewer(public val id: String) {
    Local("local"),
    Remote("remote"),
}

/**
 * The SaveConflict state holder. [remote] null means the other copy was deleted: Keep the other
 * then accepts the deletion and Keep both is not offered. [bothAvailable] is true only with a free
 * slot of the 16. [newer] tags that version's card on the choices; it chooses nothing and is ignored
 * when the other copy was deleted.
 */
public class PolarisSaveConflictState(
    private val local: PolarisSaveVersion,
    private val remote: PolarisSaveVersion?,
    private val bothAvailable: Boolean,
    private val resolver: PolarisSaveResolver,
    private val scope: CoroutineScope,
    private val newer: PolarisSaveNewer? = null,
) {
    private val _ui = MutableStateFlow<PolarisSaveConflictUi>(PolarisSaveConflictUi.Choose)
    public val ui: StateFlow<PolarisSaveConflictUi> = _ui.asStateFlow()

    private var job: Job? = null
    private val running: Boolean get() = job?.isActive == true

    /** Apply [keep]. Ignored while a choice runs, after one was kept, and for Keep both without a free slot or a copy. */
    public fun keep(keep: PolarisSaveKeep) {
        if (_ui.value != PolarisSaveConflictUi.Choose || running) return
        if (keep == PolarisSaveKeep.Both && (remote == null || !bothAvailable)) return
        apply(keep)
    }

    /** Repeat the choice that failed. */
    public fun retry() {
        val failed = _ui.value as? PolarisSaveConflictUi.Failed ?: return
        if (running) return
        apply(failed.keep)
    }

    /** Return a failed choice to the choices; nothing is applied. */
    public fun chooseAgain() {
        if (_ui.value !is PolarisSaveConflictUi.Failed || running) return
        _ui.value = PolarisSaveConflictUi.Choose
    }

    /** Leave the conflict as it was (Cancel). Ignored while a choice runs. */
    public fun cancel() {
        if (running || _ui.value is PolarisSaveConflictUi.Kept) return
        _ui.value = PolarisSaveConflictUi.Cancelled
    }

    /** Close the result of a kept choice. */
    public fun done() {
        if (_ui.value is PolarisSaveConflictUi.Kept) _ui.value = PolarisSaveConflictUi.Done
    }

    private fun apply(keep: PolarisSaveKeep) {
        _ui.value = PolarisSaveConflictUi.Keeping(keep)
        job = scope.launch {
            try {
                resolver.keep(keep)
                _ui.value = PolarisSaveConflictUi.Kept(keep)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The screen says both saves are unchanged; the cause is not shown.
                _ui.value = PolarisSaveConflictUi.Failed(keep)
            }
        }
    }

    /** The matrix component and inputs the current step draws, or null when it draws none. */
    public fun kitScreen(base: Map<String, JsonElement> = emptyMap()): KitScreen? {
        val step = _ui.value
        if (step == PolarisSaveConflictUi.Cancelled || step == PolarisSaveConflictUi.Done) return null
        val body = buildMap<String, JsonElement> {
            put(
                "step",
                JsonPrimitive(
                    when (step) {
                        is PolarisSaveConflictUi.Keeping -> "keeping"
                        is PolarisSaveConflictUi.Kept -> "kept"
                        is PolarisSaveConflictUi.Failed -> "failed"
                        else -> "choose"
                    },
                ),
            )
            put("local", version(local))
            put("remote", remote?.let(::version) ?: JsonNull)
            put("bothAvailable", JsonPrimitive(bothAvailable))
            newer?.let { put("newer", JsonPrimitive(it.id)) }
            when (step) {
                is PolarisSaveConflictUi.Keeping -> put("keep", JsonPrimitive(step.keep.id))
                is PolarisSaveConflictUi.Kept -> put("keep", JsonPrimitive(step.keep.id))
                is PolarisSaveConflictUi.Failed -> put("keep", JsonPrimitive(step.keep.id))
                else -> Unit
            }
        }
        return KitStates.resolve(KitComponent.saveConflict, KitInputs.of(base + ("saveConflict" to JsonObject(body))))
    }

    private fun version(v: PolarisSaveVersion): JsonObject = JsonObject(
        buildMap {
            v.whenText?.let { put("when", JsonPrimitive(it)) }
            v.device?.let { put("device", JsonPrimitive(it)) }
        },
    )
}
