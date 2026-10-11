// The Compose-free update offer and install state. Renderers decide whether an offer is a banner,
// card or notification; this layer owns the SDK decision mapping, dismissal and install lifecycle.
package im.plrs.key.ui

import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import im.plrs.key.update.ProgressiveInstallDriver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** An update to offer the player. */
public data class PolarisUpdateUi(
    /** The version on offer, when the decision names one. */
    val version: String?,
    /** The player cannot dismiss it. */
    val mandatory: Boolean = false,
    /** The release is marked critical (a security fix). */
    val critical: Boolean = false,
    val kind: Kind = Kind.Install,
    /** Bytes downloaded so far and the total, while the platform downloads it. */
    val progress: Pair<Long, Long>? = null,
    /** The last install attempt's typed failure, or null. */
    val error: PolarisUpdateFailure? = null,
) {
    public enum class Kind {
        /** A new build to install (a binary, store or platform update). */
        Install,

        /** A staged update that applies on the next launch: restart to finish. */
        Restart,
    }

    public companion object {
        /** What [decision] offers the player, or null when it offers nothing here. */
        public fun from(decision: UpdateDecision): PolarisUpdateUi? = when (decision) {
            is UpdateDecision.Binary -> PolarisUpdateUi(decision.release.version, decision.mandatory, decision.critical)
            is UpdateDecision.Store -> PolarisUpdateUi(decision.release.version, decision.mandatory, decision.critical)
            is UpdateDecision.Platform -> PolarisUpdateUi(decision.release.version, decision.mandatory, decision.critical)
            is UpdateDecision.CodeReady -> PolarisUpdateUi(decision.release.version, false, decision.critical, Kind.Restart)
            is UpdateDecision.None, is UpdateDecision.Blocked, is UpdateDecision.Packs -> null
        }

        public fun from(check: UpdateCheck): PolarisUpdateUi? = from(check.decision)
    }
}

/** A platform install failure, kept typed so each renderer supplies its own catalog copy. */
public data class PolarisUpdateFailure(val code: String, val detail: String? = null)

/** The install the update banner's action runs. [PolarisKeyClient.updateActions] adapts the umbrella client. */
public fun interface PolarisUpdateActions {
    public suspend fun install(check: UpdateCheck): InstallResult

    /** Install an update the platform finished downloading ("Restart to finish"). */
    public suspend fun finish(): InstallResult = InstallResult.NothingToInstall

    /** A background install's stage (a Play flexible update); empty for drivers that have none. */
    public val stages: Flow<InstallStage> get() = emptyFlow()
}

/**
 * `client.update.install(check)`: Play In-App Updates or the verified self-update. A driver that
 * keeps going in the background also reports [stages] and finishes with [PolarisUpdateActions.finish].
 */
public fun PolarisKeyClient.updateActions(): PolarisUpdateActions {
    val client = this
    return object : PolarisUpdateActions {
        override suspend fun install(check: UpdateCheck): InstallResult = client.update.install(check)

        override suspend fun finish(): InstallResult =
            (client.update.installDriver as? ProgressiveInstallDriver)?.finish() ?: InstallResult.NothingToInstall

        override val stages: Flow<InstallStage>
            get() = (client.update.installDriver as? ProgressiveInstallDriver)?.progress ?: emptyFlow()
    }
}

/**
 * Holds the update on offer; the host feeds it each check (`bootHost(onCheck = state::show)` does)
 * and the renderer dismisses it or runs [install].
 */
public class PolarisUpdateState {
    private val _offer = MutableStateFlow<PolarisUpdateUi?>(null)
    public val offer: StateFlow<PolarisUpdateUi?> = _offer.asStateFlow()
    private var dismissedVersion: String? = null

    /** Whether the platform reported the update downloaded, so [install] finishes it. */
    @Volatile private var downloaded = false

    /** The decision behind the offer, for [install]. */
    @Volatile public var check: UpdateCheck? = null
        private set

    /** Offer what [check] decided; a version the player dismissed stays dismissed unless mandatory. */
    public fun show(check: UpdateCheck) {
        this.check = check
        show(PolarisUpdateUi.from(check))
    }

    /**
     * Hand the offered decision to the platform installer ([actions]). A typed N/A or a failure
     * stays on the offer as [PolarisUpdateUi.error]; a started install keeps the offer until the
     * platform reports it downloaded ([readyToRestart]) or the app restarts.
     */
    public fun install(actions: PolarisUpdateActions, scope: CoroutineScope) {
        val finishing = downloaded
        val currentCheck = check
        if (currentCheck == null && !finishing) return
        scope.launch {
            val result = try {
                if (finishing) actions.finish() else actions.install(currentCheck!!)
            } catch (e: CancellationException) {
                throw e
            } catch (e: im.plrs.key.core.UnsupportedException) {
                InstallResult.Failed(e.code, e.unsupported.detail)
            } catch (e: Exception) {
                InstallResult.Failed(im.plrs.key.core.ErrorCode.platformError, e.message)
            }
            _offer.update { offer ->
                offer?.copy(error = (result as? InstallResult.Failed)?.let { PolarisUpdateFailure(it.code, it.detail) })
            }
        }
    }

    /** The platform's download progress (a Play flexible update's InstallState). */
    public fun progress(done: Long, total: Long) {
        _offer.update { it?.copy(progress = done to total, error = null) }
    }

    /**
     * Follow [actions]' background install: its progress, then "Restart to finish" (whose action
     * [install] turns into [PolarisUpdateActions.finish]), or its failure. Runs until [scope] ends.
     */
    public fun follow(actions: PolarisUpdateActions, scope: CoroutineScope): Job = scope.launch {
        actions.stages.collect { stage ->
            when (stage) {
                is InstallStage.Downloading -> progress(stage.done, stage.total)
                InstallStage.ReadyToRestart -> readyToRestart()
                is InstallStage.Failed -> _offer.update {
                    it?.copy(progress = null, error = PolarisUpdateFailure(stage.code, stage.detail))
                }
                InstallStage.Idle -> _offer.update { it?.copy(progress = null) }
            }
        }
    }

    /** The platform downloaded the update: the offer becomes "Restart to finish". */
    public fun readyToRestart() {
        downloaded = true
        _offer.update { (it ?: PolarisUpdateUi(null)).copy(kind = PolarisUpdateUi.Kind.Restart, progress = null, error = null) }
    }

    public fun show(ui: PolarisUpdateUi?) {
        _offer.value = ui?.takeIf { it.mandatory || it.version == null || it.version != dismissedVersion }
    }

    /** The player dismissed the banner (never a mandatory update). */
    public fun dismiss() {
        val current = _offer.value ?: return
        if (current.mandatory) return
        dismissedVersion = current.version
        _offer.value = null
    }
}
