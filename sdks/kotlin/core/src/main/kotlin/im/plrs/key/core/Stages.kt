// The boot stage machine (`ui.stages`) — client boot behaviour, outside the wire contract.
//
// Mirrors `@polaris-key/client-core`'s `stages.ts` and Swift's `Stages.swift`: one pure reducer
// every renderer drives (a Compose boot screen, a terminal). The host does each stage's work and
// reports its result as an event; the machine decides the next stage and what to emit. No I/O, no
// clock, no randomness, so the same inputs reach the same stages, emits and outcome in every
// language. `conformance/corpus/v2/stage-matrix.json` (version 3) pins it.
//
// The normal path is idle → shell → guard → sync → gate → decide → fetch → mount → ready, every
// stage entered even with nothing to do. An event the current stage does not accept is IGNORED:
// the input state comes back unchanged with no emits, and every accepted event emits something.
// v3's `fetchConsent` and `fetchProgress` carry integers; a malformed value (negative, at or above
// 2^53, `done > total`) is ignored like any unaccepted event.

package im.plrs.key.core

/** Every stage, in boot order, then the three stops. */
public enum class BootStage(public val wire: String) {
    idle("idle"), shell("shell"), guard("guard"), sync("sync"), gate("gate"), decide("decide"),
    fetch("fetch"), mount("mount"), ready("ready"), background("background"),
    offline("offline"), blocked("blocked"), error("error"),
}

/** The outcome a renderer reports: `running` until the boot stops or the gate waits. */
public enum class BootOutcome(public val wire: String) {
    running("running"), waiting("waiting"), ready("ready"), blocked("blocked"), offline("offline"), error("error"),
}

/** What `bootGuardAction` decides at launch. */
public enum class BootGuardAction(public val wire: String) {
    none("none"), applyStaged("apply-staged"), rollBack("roll-back"),
}

/** When a launch is confirmed, by outcome (stage matrix v2). */
public enum class BootConfirmation(public val wire: String) {
    now("now"), afterOkSeconds("after-ok-seconds"), never("never"),
}

/** The events a host sends, dotted. */
public val BOOT_EVENT_TYPES: List<String> = listOf(
    "start", "shell.done", "guard.done", "sync.done", "sync.timeout", "gate.status", "decide.done",
    "fetch.done", "mount.done", "background.start", "background.done", "retry", "play-offline",
    "fail", "fetch.consent", "fetch.progress",
)

/** The emits the machine produces, snake_case. */
public val BOOT_EMIT_TYPES: List<String> = listOf(
    "stage_changed", "waiting", "update_available", "blocked", "offline", "error",
    "boot_rolled_back", "boot_ready", "consent_needed", "fetch_progress",
)

/** Unconfirmed launches of the active slot that trigger a rollback on the next launch. */
public const val MAX_FAILED_BOOTS: Int = 2

/** How long `ready` must hold, with the process alive, before a launch counts as confirmed. */
public const val BOOT_OK_SECONDS: Int = 10

private const val MAX_COUNT: Long = 9_007_199_254_740_991

/** An event the host sends: the result of its work for the current stage. */
public sealed class BootEvent(public val type: String) {
    public data object Start : BootEvent("start")
    public data object ShellDone : BootEvent("shell.done")
    public data class GuardDone(val result: GuardResult) : BootEvent("guard.done")
    public data class SyncDone(val result: SyncResult) : BootEvent("sync.done")
    public data object SyncTimeout : BootEvent("sync.timeout")
    public data class GateStatus(val status: LicenseStatus) : BootEvent("gate.status")
    public data class DecideDone(val decision: Decision) : BootEvent("decide.done")

    /** `installed` lists the pack ids present after the fetch, compared by exact string. */
    public data class FetchDone(val result: FetchResult, val installed: List<String>) : BootEvent("fetch.done")
    public data object MountDone : BootEvent("mount.done")
    public data object BackgroundStart : BootEvent("background.start")
    public data object BackgroundDone : BootEvent("background.done")
    public data object Retry : BootEvent("retry")
    public data object PlayOffline : BootEvent("play-offline")
    public data class Fail(val code: String) : BootEvent("fail")
    public data class FetchConsent(val bytes: Long, val metered: Boolean) : BootEvent("fetch.consent")
    public data class FetchProgress(val done: Long, val total: Long) : BootEvent("fetch.progress")

    public enum class GuardResult(public val wire: String) { ok("ok"), applied("applied"), rolledBack("rolled-back") }
    public enum class SyncResult(public val wire: String) { ok("ok"), offline("offline"), error("error") }
    public enum class Decision(public val wire: String) { none("none"), optional("optional"), required("required") }
    public enum class FetchResult(public val wire: String) { ok("ok"), offline("offline"), failed("failed"), declined("declined") }
}

/** What the machine emits; a renderer exposes each as a callback or a Flow value. */
public sealed class BootEmit(public val type: String) {
    public data class StageChanged(val stage: BootStage, val previous: BootStage) : BootEmit("stage_changed")
    public data class Waiting(val status: LicenseStatus) : BootEmit("waiting")
    public data object UpdateAvailable : BootEmit("update_available")
    public data class Blocked(val reason: BlockedReason) : BootEmit("blocked")
    public data class Offline(val canPlayOffline: Boolean) : BootEmit("offline")
    public data class Error(val code: String) : BootEmit("error")
    public data object BootRolledBack : BootEmit("boot_rolled_back")
    public data object BootReady : BootEmit("boot_ready")
    public data class ConsentNeeded(val bytes: Long, val metered: Boolean) : BootEmit("consent_needed")
    public data class FetchProgress(val done: Long, val total: Long) : BootEmit("fetch_progress")

    public enum class BlockedReason(public val wire: String) {
        updateRequired("update-required"), notAvailable("not-available"), contentDeclined("content-declined"),
    }
}

public data class BootOptions(
    /** Continue on local state when the sync gets no answer or an unusable one. */
    val allowOffline: Boolean = true,
    /** Let `grace` pass the gate. */
    val allowGrace: Boolean = true,
    /** Pack ids that must be installed before `mount`. */
    val requiredPacks: List<String> = emptyList(),
    /** Pack ids the boot wants before `ready` but can play without (v3). */
    val essentialPacks: List<String> = emptyList(),
)

public data class BootState(
    val stage: BootStage,
    val outcome: BootOutcome,
    val options: BootOptions,
    /** The latest sync result; a timeout is `offline`. */
    val sync: Sync,
    /** Where `retry` goes. */
    val resume: Resume,
    /** True only at a playable offline stop (v3). */
    val canPlayOffline: Boolean = false,
) {
    public enum class Sync(public val wire: String) { pending("pending"), ok("ok"), offline("offline"), error("error") }
    public enum class Resume(public val wire: String) { shell("shell"), guard("guard"), sync("sync") }
}

public data class BootTransition(val state: BootState, val emits: List<BootEmit>)

/** Stage `idle`, outcome `running`, sync `pending`, resume `shell`. */
public fun initialBootState(options: BootOptions = BootOptions()): BootState =
    BootState(BootStage.idle, BootOutcome.running, options, BootState.Sync.pending, BootState.Resume.shell)

/** The launch decision of the boot guard. */
public fun bootGuardAction(staged: Boolean, failedBoots: Long): BootGuardAction = when {
    failedBoots >= MAX_FAILED_BOOTS -> BootGuardAction.rollBack
    staged -> BootGuardAction.applyStaged
    else -> BootGuardAction.none
}

/** `waiting`, `blocked` and `offline` confirm at once; `ready` after BOOT_OK_SECONDS; the rest never. */
public fun bootConfirmation(outcome: BootOutcome): BootConfirmation = when (outcome) {
    BootOutcome.waiting, BootOutcome.blocked, BootOutcome.offline -> BootConfirmation.now
    BootOutcome.ready -> BootConfirmation.afterOkSeconds
    BootOutcome.running, BootOutcome.error -> BootConfirmation.never
}

/** The reducer: the next state and the emits, `StageChanged` first. Ignored events return the input. */
public fun bootTransition(state: BootState, event: BootEvent): BootTransition {
    val waiting = state.stage == BootStage.gate && state.outcome == BootOutcome.waiting
    val fetching = state.stage == BootStage.fetch
    val consentWaiting = fetching && state.outcome == BootOutcome.waiting
    val ignore = BootTransition(state, emptyList())

    fun go(
        stage: BootStage,
        outcome: BootOutcome,
        extra: BootEmit? = null,
        sync: BootState.Sync? = null,
        resume: BootState.Resume? = null,
        canPlayOffline: Boolean = false,
    ): BootTransition {
        val emits = ArrayList<BootEmit>()
        if (stage != state.stage) emits += BootEmit.StageChanged(stage, state.stage)
        if (extra != null) emits += extra
        val next = BootState(stage, outcome, state.options, sync ?: state.sync, resume ?: state.resume, canPlayOffline)
        return BootTransition(next, emits)
    }

    fun count(n: Long) = n in 0..MAX_COUNT
    fun missing(ids: List<String>, installed: List<String>) = !ids.all { it in installed }
    fun syncStop(result: BootState.Sync, recording: Boolean): BootTransition {
        val sync = if (recording) result else null
        return if (result == BootState.Sync.offline) {
            go(BootStage.offline, BootOutcome.offline, BootEmit.Offline(false), sync = sync)
        } else {
            go(BootStage.error, BootOutcome.error, BootEmit.Error(ErrorCode.syncFailed), sync = sync)
        }
    }
    fun onSync(result: BootState.Sync): BootTransition =
        if (result == BootState.Sync.ok || state.options.allowOffline) go(BootStage.gate, BootOutcome.running, sync = result)
        else syncStop(result, recording = true)
    fun gateHolds(status: LicenseStatus): BootTransition =
        if (state.sync == BootState.Sync.offline || state.sync == BootState.Sync.error) syncStop(state.sync, recording = false)
        else go(BootStage.gate, BootOutcome.waiting, BootEmit.Waiting(status))

    return when (event) {
        BootEvent.Start -> if (state.stage == BootStage.idle) go(BootStage.shell, BootOutcome.running) else ignore
        BootEvent.ShellDone ->
            if (state.stage == BootStage.shell) go(BootStage.guard, BootOutcome.running, resume = BootState.Resume.guard) else ignore
        is BootEvent.GuardDone ->
            if (state.stage != BootStage.guard) ignore
            else go(
                BootStage.sync, BootOutcome.running,
                if (event.result == BootEvent.GuardResult.rolledBack) BootEmit.BootRolledBack else null,
                resume = BootState.Resume.sync,
            )
        is BootEvent.SyncDone ->
            if (state.stage != BootStage.sync) ignore
            else onSync(
                when (event.result) {
                    BootEvent.SyncResult.ok -> BootState.Sync.ok
                    BootEvent.SyncResult.offline -> BootState.Sync.offline
                    BootEvent.SyncResult.error -> BootState.Sync.error
                },
            )
        BootEvent.SyncTimeout -> if (state.stage == BootStage.sync) onSync(BootState.Sync.offline) else ignore
        is BootEvent.GateStatus ->
            if (state.stage != BootStage.gate) ignore
            else when (event.status) {
                LicenseStatus.ok, LicenseStatus.notApplicable -> go(BootStage.decide, BootOutcome.running)
                LicenseStatus.grace -> if (state.options.allowGrace) go(BootStage.decide, BootOutcome.running) else gateHolds(event.status)
                LicenseStatus.expired -> gateHolds(event.status)
                LicenseStatus.needsActivation, LicenseStatus.revoked ->
                    go(BootStage.gate, BootOutcome.waiting, BootEmit.Waiting(event.status))
                LicenseStatus.versionTooOld ->
                    go(BootStage.blocked, BootOutcome.blocked, BootEmit.Blocked(BootEmit.BlockedReason.updateRequired))
                LicenseStatus.versionTooNew, LicenseStatus.channelNotEntitled ->
                    go(BootStage.blocked, BootOutcome.blocked, BootEmit.Blocked(BootEmit.BlockedReason.notAvailable))
            }
        is BootEvent.DecideDone ->
            if (state.stage != BootStage.decide) ignore
            else when (event.decision) {
                BootEvent.Decision.none -> go(BootStage.fetch, BootOutcome.running)
                BootEvent.Decision.optional -> go(BootStage.fetch, BootOutcome.running, BootEmit.UpdateAvailable)
                BootEvent.Decision.required ->
                    go(BootStage.blocked, BootOutcome.blocked, BootEmit.Blocked(BootEmit.BlockedReason.updateRequired))
            }
        is BootEvent.FetchDone -> {
            if (!fetching) return ignore
            if (missing(state.options.requiredPacks, event.installed)) {
                return when (event.result) {
                    BootEvent.FetchResult.offline -> go(BootStage.offline, BootOutcome.offline, BootEmit.Offline(false))
                    BootEvent.FetchResult.declined ->
                        go(BootStage.blocked, BootOutcome.blocked, BootEmit.Blocked(BootEmit.BlockedReason.contentDeclined))
                    else -> go(BootStage.error, BootOutcome.error, BootEmit.Error(ErrorCode.fetchFailed))
                }
            }
            if (event.result == BootEvent.FetchResult.offline && missing(state.options.essentialPacks, event.installed)) {
                return go(BootStage.offline, BootOutcome.offline, BootEmit.Offline(true), canPlayOffline = true)
            }
            go(BootStage.mount, BootOutcome.running)
        }
        is BootEvent.FetchConsent ->
            if (!fetching || consentWaiting || !count(event.bytes)) ignore
            else go(BootStage.fetch, BootOutcome.waiting, BootEmit.ConsentNeeded(event.bytes, event.metered))
        is BootEvent.FetchProgress ->
            if (!fetching || !count(event.done) || !count(event.total) || event.done > event.total) ignore
            else go(BootStage.fetch, BootOutcome.running, BootEmit.FetchProgress(event.done, event.total))
        BootEvent.MountDone -> if (state.stage == BootStage.mount) go(BootStage.ready, BootOutcome.ready, BootEmit.BootReady) else ignore
        BootEvent.BackgroundStart -> if (state.stage == BootStage.ready) go(BootStage.background, BootOutcome.ready) else ignore
        BootEvent.BackgroundDone -> if (state.stage == BootStage.background) go(BootStage.ready, BootOutcome.ready) else ignore
        BootEvent.Retry -> {
            if (!(waiting || state.stage in setOf(BootStage.offline, BootStage.blocked, BootStage.error))) return ignore
            val target = when (state.resume) {
                BootState.Resume.shell -> BootStage.shell
                BootState.Resume.guard -> BootStage.guard
                BootState.Resume.sync -> BootStage.sync
            }
            go(target, BootOutcome.running, sync = BootState.Sync.pending)
        }
        BootEvent.PlayOffline ->
            if (state.stage == BootStage.offline && state.canPlayOffline) go(BootStage.mount, BootOutcome.running) else ignore
        is BootEvent.Fail -> {
            val failing = setOf(
                BootStage.shell, BootStage.guard, BootStage.sync, BootStage.gate, BootStage.decide, BootStage.fetch, BootStage.mount,
            )
            if (state.stage !in failing || waiting || consentWaiting) ignore
            else go(BootStage.error, BootOutcome.error, BootEmit.Error(event.code))
        }
    }
}
