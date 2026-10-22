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
    /** The version running now ("You have 2.4.1"), when known. */
    val currentVersion: String? = null,
    /** The changelog's summary for [version]: at most [MAX_NOTES] plain lines; empty hides "What's new". */
    val notes: List<String> = emptyList(),
    /** The release's page, the target of "All changes"; null hides the link. */
    val notesUrl: String? = null,
    /** The download size in bytes, only when the decision carries it. */
    val size: Long? = null,
    /** The outlet kind the update comes through (`play`, `app-store`, `steam`, …); null is a direct download. */
    val outlet: String? = null,
    /** Seconds left while downloading, estimated from the rate so far; null until it can be told. */
    val secondsLeft: Int? = null,
) {
    public enum class Kind {
        /** A new build to install (a binary, store or platform update). */
        Install,

        /** A staged update that applies on the next launch: restart to finish. */
        Restart,
    }

    public companion object {
        /** The most "What's new" lines the prompt draws (decision 1). */
        public const val MAX_NOTES: Int = 3

        /** [summary] as at most [MAX_NOTES] plain lines: bullets and blank lines removed. */
        public fun notesFrom(summary: String?): List<String> =
            summary.orEmpty().lines()
                .map { it.trim().trimStart('-', '*', '\u2022').trim() }
                .filter { it.isNotEmpty() }
                .take(MAX_NOTES)

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
    private var facts: UpdateFacts? = null
    private var downloadStartedAt: Long = 0L
    private var downloadStartedBytes: Long = 0L

    /** The clock the time-left estimate reads (milliseconds); tests replace it. */
    internal var now: () -> Long = System::currentTimeMillis

    /** A version the person chose to skip, remembered by the host across launches. */
    @Volatile public var skippedVersion: String? = null

    /** Called with the version when the person skips it, so the host can remember it. */
    @Volatile public var onSkip: ((String) -> Unit)? = null

    /** What the prompt says besides the version: the facts [describe] was given. */
    private data class UpdateFacts(
        val version: String?,
        val currentVersion: String?,
        val notes: List<String>,
        val notesUrl: String?,
        val size: Long?,
        val outlet: String?,
    )

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
        val at = now()
        if (_offer.value?.progress == null || done < downloadStartedBytes) {
            downloadStartedAt = at
            downloadStartedBytes = done
        }
        val bytes = done - downloadStartedBytes
        val elapsed = at - downloadStartedAt
        // An estimate needs some rate to go on: a second of progress and bytes moved.
        val left = if (bytes > 0 && elapsed >= 1_000 && total > done) {
            ((total - done) * elapsed / bytes / 1000).toInt().coerceAtLeast(1)
        } else {
            null
        }
        _offer.update { it?.copy(progress = done to total, error = null, secondsLeft = left) }
    }

    /**
     * What the prompt says about [version]: the running version, the changelog's lines and page,
     * the size when the decision carries it, and the outlet kind. Dropped when a different version
     * is on offer, so a stale changelog never rides on a newer update.
     */
    public fun describe(
        version: String?,
        currentVersion: String? = null,
        notes: List<String> = emptyList(),
        notesUrl: String? = null,
        size: Long? = null,
        outlet: String? = null,
    ) {
        facts = UpdateFacts(version, currentVersion, notes.take(PolarisUpdateUi.MAX_NOTES), notesUrl, size, outlet)
        _offer.update { it?.let(::withFacts) }
    }

    private fun withFacts(ui: PolarisUpdateUi): PolarisUpdateUi {
        val f = facts ?: return ui
        val sameVersion = f.version == null || f.version == ui.version
        return ui.copy(
            currentVersion = f.currentVersion ?: ui.currentVersion,
            outlet = f.outlet ?: ui.outlet,
            notes = if (sameVersion) f.notes else emptyList(),
            notesUrl = if (sameVersion) f.notesUrl else null,
            size = if (sameVersion) f.size else null,
        )
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
        _offer.value = ui
            ?.takeIf { it.mandatory || it.version == null || (it.version != dismissedVersion && it.version != skippedVersion) }
            ?.let(::withFacts)
    }

    /** The player chose Skip this version (never a mandatory update): the offer closes and the host is told. */
    public fun skip() {
        val current = _offer.value ?: return
        val version = current.version
        if (current.mandatory || version == null) return
        skippedVersion = version
        onSkip?.invoke(version)
        _offer.value = null
    }

    /** The player dismissed the prompt with Later (never a mandatory update); the version is not offered again this run. */
    public fun dismiss() {
        val current = _offer.value ?: return
        if (current.mandatory) return
        dismissedVersion = current.version
        _offer.value = null
    }
}

/**
 * Fetch what the prompt says for the offered version (decision 1): the changelog entry's summary
 * (three lines at most) and release page, the running version and the outlet kind. A changelog that
 * cannot be fetched leaves the prompt without notes; it never blocks the offer.
 */
public suspend fun PolarisUpdateState.loadFacts(client: PolarisKeyClient) {
    val version = offer.value?.version ?: return
    val entry = try {
        client.release.changelog().firstOrNull { it.version == version }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
    val outlet = try {
        client.update.outlet()?.kind
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
    describe(
        version = version,
        currentVersion = client.core.version,
        notes = PolarisUpdateUi.notesFrom(entry?.summary),
        notesUrl = entry?.url?.takeIf { it.isNotBlank() },
        outlet = outlet,
    )
}
