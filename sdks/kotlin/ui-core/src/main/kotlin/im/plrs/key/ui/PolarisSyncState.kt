// The Compose-free Cloud Sync unlock state holder (U-42): the UnlockSync, RingChange and RecoveryCode
// screens of the ui-matrix `cloudSync` family, driven by `client.keyring`'s verbs. A renderer draws
// the [PolarisSyncUi] through [kitScreen]; every host folds the same steps.
//
// Security points kept here (U-sync clients plan section 9):
//  - S13: a typed recovery code lives in memory only while one request runs (and for its Try again),
//    is passed to `recover` and nowhere else, and is dropped on success, cancel and start over. A new
//    code reaches the screen once, as a [PolarisRecoveryCode] that prints as redacted.
//  - S5: Accept hands `acceptRingChange` the ring the person was shown (`served`), never a fresh
//    read; a ring that moved since is shown again.
//  - T22: Start over runs only from its warning step.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.SyncKeyring
import im.plrs.key.sdk.SyncRingPin
import im.plrs.key.sdk.SyncUnlockResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A recovery code the screen shows once. It prints as redacted and is never part of an equality or a log. */
public class PolarisRecoveryCode(private val text: String) {
    /** The code, for the screen that draws it and the clipboard copy. */
    public fun reveal(): String = text

    override fun toString(): String = "PolarisRecoveryCode(redacted)"
}

/** The Cloud Sync key ring calls the unlock screens make: `client.keyring`'s verbs, as [asSyncActions] adapts them. */
public interface PolarisSyncActions {
    /** Opens this device's own wrap and holds the root; the result says what to show next. */
    public suspend fun unlock(): SyncUnlockResult

    /** Recovers the root from the typed code; throws `recovery-code-invalid` for a code that is not this ring's. */
    public suspend fun recover(code: String)

    /** Starts over: a new ring and a new recovery code (null when none was made). */
    public suspend fun startOver(): String?

    /** The first ring of an account: the new recovery code (null when none was made). */
    public suspend fun create(): String?

    /** A new recovery code for the ring this device holds; the old one stops working. */
    public suspend fun newRecoveryCode(): String

    /** Confirms the ring the person was shown. */
    public suspend fun acceptRingChange(served: SyncRingPin): SyncUnlockResult
}

/** `client.keyring` as the unlock screens' actions. */
public fun SyncKeyring.asSyncActions(): PolarisSyncActions {
    val keyring = this
    return object : PolarisSyncActions {
        override suspend fun unlock(): SyncUnlockResult = keyring.unlock()

        override suspend fun recover(code: String) {
            keyring.recover(code)
        }

        override suspend fun startOver(): String? = keyring.reset().recoveryCode

        override suspend fun create(): String? = keyring.create().recoveryCode

        override suspend fun newRecoveryCode(): String = keyring.setRecoveryCode()

        override suspend fun acceptRingChange(served: SyncRingPin): SyncUnlockResult = keyring.acceptRingChange(served)
    }
}

/** The steps of the UnlockSync screen (the matrix's `unlockSync.step`). */
public enum class PolarisUnlockStep(public val id: String) {
    Code("code"),
    Invalid("invalid"),
    Working("working"),
    Failed("failed"),
    StartOver("start-over"),
}

/** Where the Cloud Sync unlock flow is. */
public sealed interface PolarisSyncUi {
    /** No screen: unlocked, or nobody asked. */
    public data object Idle : PolarisSyncUi

    /** Unlock with the recovery code, or start over. */
    public data class Unlock(val step: PolarisUnlockStep = PolarisUnlockStep.Code) : PolarisSyncUi

    /** A different ring is served. [by] names the device that set it up; [served] is what Accept confirms. */
    public data class RingChange(val by: String?, val served: SyncRingPin?) : PolarisSyncUi

    /** A new recovery code, shown once; [saved] is the person's confirmation that they kept it. */
    public data class RecoveryCode(val code: PolarisRecoveryCode, val saved: Boolean = false) : PolarisSyncUi

    /** The flow finished: the device is unlocked. */
    public data object Done : PolarisSyncUi

    /** The matrix component and inputs this step draws, or null when it draws none. */
    public fun kitScreen(base: Map<String, JsonElement> = emptyMap()): KitScreen? {
        fun resolve(component: KitComponent, member: String, value: JsonObject) = KitStates.resolve(component, KitInputs.of(base + (member to value)))
        return when (this) {
            Idle, Done -> null

            is Unlock -> resolve(KitComponent.unlockSync, "unlockSync", JsonObject(mapOf("step" to JsonPrimitive(step.id))))

            is RecoveryCode -> resolve(KitComponent.recoveryCode, "recoveryCode", JsonObject(mapOf("saved" to JsonPrimitive(saved))))

            is RingChange -> resolve(
                KitComponent.ringChange,
                "ringChange",
                JsonObject(
                    buildMap {
                        if (by != null) put("by", JsonPrimitive(by))
                        if (served != null) {
                            put(
                                "served",
                                JsonObject(
                                    mapOf(
                                        "ringId" to JsonPrimitive(served.ringId),
                                        "epoch" to JsonPrimitive(served.epoch),
                                        "rootKid" to JsonPrimitive(served.rootKid),
                                    ),
                                ),
                            )
                        }
                    },
                ),
            )
        }
    }
}

/**
 * The unlock flow's state holder. [open] starts from "Unlock sync" or "Review"; the other verbs are
 * the screens' controls. One request runs at a time: a control pressed meanwhile is ignored.
 */
public class PolarisSyncState(private val actions: PolarisSyncActions, private val scope: CoroutineScope) {
    private val _ui = MutableStateFlow<PolarisSyncUi>(PolarisSyncUi.Idle)
    public val ui: StateFlow<PolarisSyncUi> = _ui.asStateFlow()

    // What Try again repeats. It holds a typed code only until the request settles well or the person leaves.
    private var retryOp: (() -> Unit)? = null
    private var job: Job? = null
    private val running: Boolean get() = job?.isActive == true

    /** Unlock this device with its own wrap, then show what is needed: nothing, the code step, or the changed ring. */
    public fun open() {
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) { next(actions.unlock()) }
    }

    /** Submit the typed recovery code. A blank code is not sent. */
    public fun submitCode(code: String) {
        val typed = code.trim()
        if (typed.isEmpty() || running || _ui.value !is PolarisSyncUi.Unlock) return
        retryOp = { submitCode(typed) }
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) {
            try {
                actions.recover(typed)
                retryOp = null
                PolarisSyncUi.Done
            } catch (e: PolarisException) {
                when (e.code) {
                    ErrorCode.recoveryCodeInvalid -> PolarisSyncUi.Unlock(PolarisUnlockStep.Invalid).also { retryOp = null }

                    // No recovery code on the account: trying again cannot help, so show the way out (Start over's warning).
                    ErrorCode.notFound -> PolarisSyncUi.Unlock(PolarisUnlockStep.StartOver).also { retryOp = null }

                    else -> throw e
                }
            }
        }
    }

    /** The person edited the code: an `invalid` step goes back to the plain code step. */
    public fun editCode() {
        if (_ui.value == PolarisSyncUi.Unlock(PolarisUnlockStep.Invalid)) _ui.value = PolarisSyncUi.Unlock(PolarisUnlockStep.Code)
    }

    /** Show Start over's warning. Nothing is replaced yet. */
    public fun startOver() {
        if (_ui.value is PolarisSyncUi.Unlock && !running) _ui.value = PolarisSyncUi.Unlock(PolarisUnlockStep.StartOver)
    }

    /** Replace the sync key. Only from the warning step (T22). */
    public fun confirmStartOver() {
        if (_ui.value != PolarisSyncUi.Unlock(PolarisUnlockStep.StartOver)) return
        replaceKey()
    }

    private fun replaceKey() {
        if (running) return
        retryOp = ::replaceKey
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) { shown(actions.startOver()) }
    }

    /** A first ring for this account: shows its recovery code. */
    public fun create() {
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) { shown(actions.create()) }
    }

    /** A new recovery code for the ring this device holds. */
    public fun newRecoveryCode() {
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) { shown(actions.newRecoveryCode()) }
    }

    /** Accept the ring that was shown (never a fresh read). */
    public fun acceptRingChange() {
        val change = _ui.value as? PolarisSyncUi.RingChange ?: return
        accept(change.served ?: return)
    }

    private fun accept(served: SyncRingPin) {
        if (running) return
        retryOp = { accept(served) }
        run(PolarisSyncUi.Unlock(PolarisUnlockStep.Working)) { next(actions.acceptRingChange(served)) }
    }

    /** From the ring confirmation to the recovery code step. */
    public fun useRecoveryCode() {
        if (_ui.value is PolarisSyncUi.RingChange) _ui.value = PolarisSyncUi.Unlock(PolarisUnlockStep.Code)
    }

    /** Repeat the step that failed. */
    public fun retry() {
        if (_ui.value != PolarisSyncUi.Unlock(PolarisUnlockStep.Failed)) return
        val op = retryOp
        if (op != null) op() else open()
    }

    /** The person saved (or un-saved) the new code. Done follows only a saved code. */
    public fun markSaved(saved: Boolean) {
        val shown = _ui.value as? PolarisSyncUi.RecoveryCode ?: return
        _ui.value = shown.copy(saved = saved)
    }

    /** Done on the recovery code screen; refused until the code is marked saved. */
    public fun done() {
        val shown = _ui.value as? PolarisSyncUi.RecoveryCode ?: return
        if (shown.saved) _ui.value = PolarisSyncUi.Done
    }

    /** Leave the flow. Nothing typed is kept. */
    public fun cancel() {
        if (_ui.value is PolarisSyncUi.RecoveryCode) return
        job?.cancel()
        retryOp = null
        _ui.value = PolarisSyncUi.Idle
    }

    private fun next(result: SyncUnlockResult): PolarisSyncUi = when (result) {
        is SyncUnlockResult.Unlocked -> PolarisSyncUi.Done
        is SyncUnlockResult.Locked -> PolarisSyncUi.Unlock(PolarisUnlockStep.Code)
        is SyncUnlockResult.RingChanged -> PolarisSyncUi.RingChange(result.by, result.served)
    }.also { retryOp = null }

    private fun shown(code: String?): PolarisSyncUi {
        retryOp = null
        return if (code != null) PolarisSyncUi.RecoveryCode(PolarisRecoveryCode(code)) else PolarisSyncUi.Done
    }

    private fun run(working: PolarisSyncUi, step: suspend () -> PolarisSyncUi) {
        if (running) return
        _ui.value = working
        job = scope.launch {
            try {
                _ui.value = step()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The screen says "Couldn't unlock"; the cause is not shown (it could name a ring or a device).
                _ui.value = PolarisSyncUi.Unlock(PolarisUnlockStep.Failed)
            }
        }
    }
}
