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
//  - `kept` follows only a resolver that returned, and names the choice that was made;
//  - a keep that meets a newer copy (a refusal `conflict` with the request reopened) goes back to the choices on
//    the request's current sides, says so, and applies nothing: Try again must never run on a reopened request.
package im.plrs.key.ui

import im.plrs.key.core.MergeChoice
import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.MergeSide
import im.plrs.key.sdk.MergeOutcome
import im.plrs.key.sdk.MergeRequest
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

    public companion object {
        /**
         * The resolver of a saves [MergeRequest] (plans/U-08.md section 6): a choice is one `keep`, and a refusal throws so
         * the screen says both saves are unchanged. The host holds the bytes, so nothing is asked of it here.
         */
        public fun of(request: MergeRequest): PolarisSaveResolver = of { request.keep(it) }

        /** The resolver of any `keep`: [keep] answers a [MergeOutcome]. */
        public fun of(keep: suspend (MergeKeep) -> MergeOutcome): PolarisSaveResolver = PolarisSaveResolver { choice ->
            val mapped = when (choice) {
                PolarisSaveKeep.Local -> MergeKeep.Local
                PolarisSaveKeep.Remote -> MergeKeep.Remote
                PolarisSaveKeep.Both -> MergeKeep.Both
            }
            val out = keep(mapped)
            if (out is MergeOutcome.Refused) throw PolarisSaveRefused(out.code, out.reopened)
        }
    }
}

/** A choice a request refused: its [code] (`conflict`, `slots-full`, `sync-merge-closed`, a failure code) and whether it is open again. */
public class PolarisSaveRefused(public val code: String, public val reopened: Boolean) : IllegalStateException(code)

/** What a request holds right now: both copies, the choices it accepts, and which copy is newer. */
public data class PolarisSaveSides(
    val local: MergeSide,
    val remote: MergeSide?,
    val choices: List<String>,
    val newer: String?,
)

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
public class PolarisSaveConflictState private constructor(
    private val read: () -> Sides,
    private val resolver: PolarisSaveResolver,
    private val scope: CoroutineScope,
    /** The sides were fixed when the holder was built: a request that reopens has new ones this holder cannot show. */
    private val fixedSides: Boolean = false,
) {
    /** The two copies as the screen draws them: read again on every step, so a bound request's moves show. */
    private class Sides(
        val local: PolarisSaveVersion,
        val remote: PolarisSaveVersion?,
        val bothAvailable: Boolean,
        val newer: PolarisSaveNewer?,
    )

    public constructor(
        local: PolarisSaveVersion,
        remote: PolarisSaveVersion?,
        bothAvailable: Boolean,
        resolver: PolarisSaveResolver,
        scope: CoroutineScope,
        newer: PolarisSaveNewer? = null,
    ) : this({ Sides(local, remote, bothAvailable, newer) }, resolver, scope)

    /** A keep met a newer copy and nothing was applied: the choices show the new versions and say so. */
    private var reopened = false

    private val _ui = MutableStateFlow<PolarisSaveConflictUi>(PolarisSaveConflictUi.Choose)
    public val ui: StateFlow<PolarisSaveConflictUi> = _ui.asStateFlow()

    private var job: Job? = null
    private val running: Boolean get() = job?.isActive == true

    /** Apply [keep]. Ignored while a choice runs, after one was kept, and for Keep both without a free slot or a copy. */
    public fun keep(keep: PolarisSaveKeep) {
        if (_ui.value != PolarisSaveConflictUi.Choose || running) return
        val sides = read()
        if (keep == PolarisSaveKeep.Both && (sides.remote == null || !sides.bothAvailable)) return
        reopened = false
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
        reopened = false
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
            } catch (e: Exception) {
                val refused = e as? PolarisSaveRefused
                _ui.value = when {
                    // The request ended meanwhile: nothing is left to choose, and Try again could never succeed.
                    refused?.code == CLOSED -> PolarisSaveConflictUi.Cancelled
                    // The sides were fixed at build time, so the choices could only return on copies the person
                    // has seen replaced: close instead, and the host opens the screen again on the reopened request.
                    fixedSides && refused != null && refused.reopened && refused.code == "conflict" ->
                        PolarisSaveConflictUi.Cancelled
                    // The other copy moved while the keep ran (or Keep both lost its slot): nothing was applied.
                    // Back to the choices, read again from the request.
                    refused != null && refused.reopened && (refused.code == "conflict" || refused.code == SLOTS_FULL) -> {
                        reopened = refused.code == "conflict"
                        PolarisSaveConflictUi.Choose
                    }
                    // The screen says both saves are unchanged; the cause is not shown.
                    else -> PolarisSaveConflictUi.Failed(keep)
                }
            }
        }
    }

    /** The matrix component and inputs the current step draws, or null when it draws none. */
    public fun kitScreen(base: Map<String, JsonElement> = emptyMap()): KitScreen? {
        val step = _ui.value
        if (step == PolarisSaveConflictUi.Cancelled || step == PolarisSaveConflictUi.Done) return null
        val sides = read()
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
            put("local", version(sides.local))
            put("remote", sides.remote?.let(::version) ?: JsonNull)
            put("bothAvailable", JsonPrimitive(sides.bothAvailable))
            sides.newer?.let { put("newer", JsonPrimitive(it.id)) }
            if (reopened && step == PolarisSaveConflictUi.Choose) put("reopened", JsonPrimitive(true))
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

    public companion object {
        /**
         * The state holder of a saves [MergeRequest]: the copies, `newer` and the free-slot flag come from the request,
         * and a choice is its `keep`. [describe] names a copy for the screen; by default a copy shows [PolarisWhen.worded] of its `savedAt`, and the other copy also names its device.
         */
        public fun of(
            request: MergeRequest,
            scope: CoroutineScope,
            describe: ((MergeSide, other: Boolean) -> PolarisSaveVersion)? = null,
        ): PolarisSaveConflictState = of(
            { PolarisSaveSides(request.local ?: MergeSide(JsonNull, null), request.remote, request.choices, request.newer) },
            PolarisSaveResolver.of(request),
            scope,
            describe,
        )

        /**
         * The state holder over a request read again on every step (a keep that meets a newer copy goes back to the
         * choices on the request's new sides), never once when the holder is built. [read] returns the live sides.
         */
        public fun of(
            read: () -> PolarisSaveSides,
            resolver: PolarisSaveResolver,
            scope: CoroutineScope,
            describe: ((MergeSide, other: Boolean) -> PolarisSaveVersion)? = null,
        ): PolarisSaveConflictState = PolarisSaveConflictState(
            { read().let { sides(it.local, it.remote, it.choices, it.newer, describe) } },
            resolver,
            scope,
        )

        /**
         * [of] from the pieces of a request, so a host that holds them another way binds the same screen. The pieces
         * are fixed: a keep that meets a newer copy reopens the request on sides these pieces do not show, so that
         * ends the screen (Cancelled) rather than returning to the old cards. A host that wants the choices to
         * come back on the new copies binds the request, or [of] with a `read` that returns its live sides.
         */
        @Suppress("LongParameterList")
        public fun of(
            local: MergeSide,
            remote: MergeSide?,
            choices: List<String>,
            newer: String?,
            resolver: PolarisSaveResolver,
            scope: CoroutineScope,
            describe: ((MergeSide, other: Boolean) -> PolarisSaveVersion)? = null,
        ): PolarisSaveConflictState {
            return PolarisSaveConflictState(
                { sides(local, remote, choices, newer, describe) },
                resolver,
                scope,
                fixedSides = true,
            )
        }

        private fun sides(
            local: MergeSide,
            remote: MergeSide?,
            choices: List<String>,
            newer: String?,
            describe: ((MergeSide, other: Boolean) -> PolarisSaveVersion)?,
        ): Sides {
            val name = describe ?: ::defaultVersion
            return Sides(
                name(local, false),
                remote?.let { name(it, true) },
                remote != null && MergeChoice.both in choices,
                PolarisSaveNewer.entries.firstOrNull { it.id == newer },
            )
        }

        private const val CLOSED = "sync-merge-closed"
        private const val SLOTS_FULL = "slots-full"

        private fun defaultVersion(side: MergeSide, other: Boolean): PolarisSaveVersion =
            PolarisSaveVersion(side.savedAt?.let { PolarisWhen.worded(it) }, if (other) side.device else null)
    }
}
