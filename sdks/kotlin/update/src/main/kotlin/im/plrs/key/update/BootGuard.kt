// The boot guard (registry `update.bootguard`; plans/P1-09.md §2.3, plans/P3-01.md §2.10; notes/A4
// §1.5, P9–P11), ported by P6-08 from Godot's `updater/boot_guard.gd` (P3-10), the one SDK that
// implements it: what a host runs in the stage machine's GUARD stage, before anything else loads.
//
//   run()      → {result: ok | applied | rolled-back, restart, action, error}. `result` is what
//                `guard.done` carries; with `restart` true the host restarts and sends nothing.
//   confirm()  the stage-matrix v2 confirmation rows (`bootConfirmation`): `waiting`, `blocked` and
//              `offline` confirm at once; `ready` after BOOT_OK_SECONDS (the host calls `confirmNow`
//              once that holds); `running` and `error` never.
//
// The slots (staged / current / previous) are the [UpdateSlots] port: the host's update store, which
// knows how to verify, swap and restore its own payloads. With no slots (a store-installed Android
// app, a JVM desktop build: the platform installs, nothing is staged by the SDK) nothing is counted
// and every launch is `ok`, as in Godot without a `current` slot.
//
// In order (Godot's steps 2–4; the journal of an interrupted swap is the slots port's own concern):
//  1. a `current` slot whose version is not the running version means the install was replaced from
//     outside: the slots forget it and the counting stops;
//  2. staged code is dropped when it is built for another engine, not newer than the binary, or no
//     longer verifies;
//  3. `bootGuardAction(staged, failedBoots)`: `roll-back` restores `previous`, records the bad version
//     as `skipVersion` (a decision input, so it is never re-offered) and restarts; `apply-staged`
//     swaps the staged payload in and restarts; `none` counts this launch while an applied update is
//     active. A launch reports the swap or rollback the previous launch made once.
// failedBoots counts the launches of the active slot that passed the guard and were never confirmed;
// it resets when a launch is confirmed and whenever the active slot changes.

package im.plrs.key.update

import im.plrs.key.core.BootConfirmation
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootGuardAction
import im.plrs.key.core.BootOutcome
import im.plrs.key.core.JsonText
import im.plrs.key.core.bootConfirmation
import im.plrs.key.core.bootGuardAction
import im.plrs.key.core.compareVersions
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.UpdateEventJournal
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** One slot's metadata. */
public data class SlotMeta(
    val version: String,
    val sha256: String,
    val size: Long,
    /** `godot-<major>.<minor>` for an engine-bound payload; null otherwise. */
    val engine: String? = null,
    /** The version scheme the versions compare under. */
    val scheme: String = "semver",
    /** The release record's `tag`, when it names one. */
    val tag: String? = null,
) {
    /** The update-health release id: [tag] when set, else [version] (the Worker's releaseId). */
    val releaseId: String get() = im.plrs.key.core.releaseId(version, tag)
}

/** The host's update slots: what the guard reads and the swaps it asks for. */
public interface UpdateSlots {
    public fun current(): SlotMeta?
    public fun staged(): SlotMeta?
    public fun previous(): SlotMeta?

    /** Forget a slot (`staged`, `current` or `previous`). */
    public fun drop(slot: String)

    /** Whether the staged payload still has its size and SHA-256. */
    public suspend fun verifyStaged(): Boolean

    /** Swap the staged payload in (staged → current, current → previous); false when it cannot be made. */
    public suspend fun applyStaged(): Boolean

    /** Restore `previous` as `current`; false when there is nothing to restore. */
    public suspend fun rollBack(): Boolean
}

/** Where the guard's state lives (`<data dir>/updates/state.json`): read whole, replace atomically. */
public interface BootGuardStore {
    public fun read(): String?
    public fun write(text: String)
}

/** The guard's persisted state. */
public data class BootGuardState(
    val failedBoots: Long = 0,
    /** `applied` or `rolled-back` after a swap, reported once by the next launch. */
    val notice: String? = null,
    /** The version a rollback refused: a decision input, never re-offered. */
    val skipVersion: String? = null,
    /** The binary's version while no `current` slot is active. */
    val binaryVersion: String? = null,
    /** The last version a launch confirmed healthy (`update_confirmed` fires once per new version). */
    val confirmedVersion: String? = null,
    /** [confirmedVersion]'s release id (its tag when the slot named one), the next confirmation's `fromRelease`. */
    val confirmedRelease: String? = null,
) {
    public fun toJson(): String = buildJsonObject {
        put("v", jsonInt(1))
        put("failedBoots", jsonInt(failedBoots))
        put("notice", notice?.let { JsonPrimitive(it) } ?: JsonNull)
        put("skipVersion", skipVersion?.let { JsonPrimitive(it) } ?: JsonNull)
        put("binaryVersion", binaryVersion?.let { JsonPrimitive(it) } ?: JsonNull)
        put("confirmedVersion", confirmedVersion?.let { JsonPrimitive(it) } ?: JsonNull)
        confirmedRelease?.let { put("confirmedRelease", JsonPrimitive(it)) }
    }.toString()

    public companion object {
        /** A stored state, or the empty state when there is none or it does not parse. */
        public fun parse(text: String?): BootGuardState {
            val o = text?.let { JsonText.parseOrNull(it) }.objectValue ?: return BootGuardState()
            if (o["v"].longValue != 1L) return BootGuardState()
            return BootGuardState((o["failedBoots"].longValue ?: 0).coerceAtLeast(0), o["notice"].stringValue, o["skipVersion"].stringValue, o["binaryVersion"].stringValue, o["confirmedVersion"].stringValue, o["confirmedRelease"].stringValue)
        }
    }
}

/** What [BootGuard.run] reports. */
public data class GuardOutcome(
    /** What `guard.done` carries. */
    val result: BootEvent.GuardResult,
    /** True when the host must restart now (and send nothing). */
    val restart: Boolean,
    val action: BootGuardAction,
    /** Why a swap or rollback could not be made, or null. */
    val error: String? = null,
)

/** The boot guard over a host's slots. */
public class BootGuard(
    private val store: BootGuardStore,
    /** The host's update slots; null when the platform installs updates (nothing is counted). */
    private val slots: UpdateSlots?,
    /** The running version (the build stamp's). */
    private val runningVersion: String,
    /** This runtime's engine (`godot-<major>.<minor>`), or null. */
    private val engine: String? = null,
    /**
     * Where the guard journals `update_applied`, `boot_rolled_back` and `update_confirmed`
     * (notes/SDK-PARITY-PASS.md §3.13; `client.core.updateEvents`); null journals nothing.
     */
    private val events: UpdateEventJournal? = null,
) {
    /** The version a rollback refused, for `UpdateClient.decide(skipVersion = …)`. */
    public val skipVersion: String? get() = BootGuardState.parse(store.read()).skipVersion

    /** The GUARD stage. Main-safe: the state file and the slots are read on `Dispatchers.IO` (SP-50). */
    public suspend fun run(): GuardOutcome = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runOnIo() }

    private suspend fun runOnIo(): GuardOutcome {
        val loaded = BootGuardState.parse(store.read())
        var st = loaded
        val s = slots ?: return GuardOutcome(BootEvent.GuardResult.ok, false, BootGuardAction.none)
        var cur = s.current()
        // 1. Replaced from outside.
        if (cur != null && cur.version != runningVersion) {
            s.drop("current")
            s.drop("previous")
            st = st.copy(failedBoots = 0, notice = null)
            cur = null
        }
        if (cur == null) st = st.copy(binaryVersion = runningVersion)
        // 2. Staged code that no longer applies.
        var staged = s.staged()
        if (staged != null) {
            var why = staleReason(staged, st.binaryVersion ?: runningVersion)
            if (why == null && !s.verifyStaged()) why = "corrupt"
            if (why != null) {
                s.drop("staged")
                staged = null
            }
        }
        val counting = cur != null
        val failed = if (counting) st.failedBoots else 0
        val action = bootGuardAction(staged != null, failed)
        when (action) {
            BootGuardAction.rollBack -> {
                val bad = cur!!.version
                // Events name a release by its tag when the slot has one (the Worker's releaseId).
                val badId = cur.releaseId
                val restored = s.previous()?.releaseId
                val ok = s.rollBack()
                st = st.copy(skipVersion = bad, failedBoots = 0)
                events?.record(UpdateEvent.bootRolledBack, badId, fromRelease = restored, code = if (ok) "failed-boots" else "no-previous")
                if (ok) {
                    events?.record(UpdateEvent.updateReverted, restored ?: badId, fromRelease = badId)
                    store.write(st.copy(notice = "rolled-back").toJson())
                    return GuardOutcome(BootEvent.GuardResult.rolledBack, true, action)
                }
                // Nothing to restore: the bad version is skipped from now on and counting restarts.
                store.write(st.toJson())
                return GuardOutcome(BootEvent.GuardResult.ok, false, action, "rollback-failed")
            }
            BootGuardAction.applyStaged -> {
                val from = cur?.releaseId ?: runningVersion
                if (s.applyStaged()) {
                    events?.record(UpdateEvent.updateApplied, staged!!.releaseId, fromRelease = from)
                    store.write(st.copy(failedBoots = 0, notice = "applied").toJson())
                    return GuardOutcome(BootEvent.GuardResult.applied, true, action)
                }
                // A swap that cannot be made keeps the staged update; the launch continues.
                return finishNone(s, st, action, "apply-failed", loaded)
            }
            BootGuardAction.none -> return finishNone(s, st, action, null, loaded)
        }
    }

    private fun finishNone(s: UpdateSlots, state: BootGuardState, action: BootGuardAction, error: String?, loaded: BootGuardState): GuardOutcome {
        val result = when (state.notice) {
            "applied" -> BootEvent.GuardResult.applied
            "rolled-back" -> BootEvent.GuardResult.rolledBack
            else -> BootEvent.GuardResult.ok
        }
        val st = state.copy(notice = null, failedBoots = if (s.current() != null) state.failedBoots + 1 else 0)
        if (st != loaded) store.write(st.toJson())
        return GuardOutcome(result, false, action, error)
    }

    /**
     * The stage-matrix v2 confirmation for [outcome]: `now` confirms this launch at once; `after-ok-
     * seconds` asks the host to call [confirmNow] once `ready` has held for BOOT_OK_SECONDS; `never`
     * leaves the launch counted.
     */
    public fun confirm(outcome: BootOutcome): BootConfirmation {
        val c = bootConfirmation(outcome)
        if (c == BootConfirmation.now) confirmNow()
        return c
    }

    /** Mark this launch healthy: failedBoots back to 0. */
    public fun confirmNow() {
        val st = BootGuardState.parse(store.read())
        val current = slots?.current()
        val version = current?.version ?: runningVersion
        val release = current?.releaseId ?: runningVersion
        val next = st.copy(failedBoots = 0, confirmedVersion = version, confirmedRelease = release)
        // A first install has nothing to confirm; a version change since the last healthy launch
        // (a staged swap, or Play / PackageInstaller replacing the app) is one update_confirmed.
        if (st.confirmedVersion != null && st.confirmedVersion != version) {
            events?.record(UpdateEvent.updateConfirmed, release, fromRelease = st.confirmedRelease ?: st.confirmedVersion)
        }
        if (next != st) store.write(next.toJson())
    }

    /** Why staged [meta] no longer applies (null when it does): `engine` or `not-newer`. */
    private fun staleReason(meta: SlotMeta, binaryVersion: String): String? {
        if (meta.engine != null && meta.engine != engine) return "engine"
        val c = compareVersions(meta.scheme, meta.version, binaryVersion)
        if (c == null || c <= 0) return "not-newer"
        return null
    }
}
