// The update banner and the update prompt, over the update client's decision (UpdateCheck from
// PolarisKeyClient.update.decide()). The mapping from a decision to what the player sees is a pure
// function (PolarisUpdateUi.from), unit-tested: a binary, store or platform update offers Update;
// a code-ready update (staged, applied on the next launch) offers a restart; pack work is the
// pack progress screen's, and none or blocked offers nothing here (a block is the boot's).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import im.plrs.key.update.ProgressiveInstallDriver
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** An update to offer the player. */
public data class PolarisUpdateUi(
    /** The version on offer, when the decision names one. */
    val version: String?,
    /** The player cannot dismiss it. */
    val mandatory: Boolean = false,
    /** The release is marked critical (a security fix). */
    val critical: Boolean = false,
    val kind: Kind = Kind.Install,
    /**
     * Bytes downloaded so far and the total, while the platform downloads it (a Play flexible
     * update). The banner's rendering of this and [error] is the UI-kit program's (UK-*).
     */
    val progress: Pair<Long, Long>? = null,
    /** The last install attempt's failure, as copy, or null. */
    val error: String? = null,
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

/** The install the update banner's action runs. [PolarisKeyClient.updateActions] adapts the umbrella client. */
public fun interface PolarisUpdateActions {
    public suspend fun install(check: UpdateCheck): InstallResult

    /** Install an update the platform finished downloading ("Restart to finish"). */
    public suspend fun finish(): InstallResult = InstallResult.NothingToInstall

    /** A background install's stage (a Play flexible update); empty for drivers that have none. */
    public val stages: Flow<InstallStage> get() = emptyFlow()
}

/**
 * `client.update.install(check)`: Play In-App Updates or the verified self-update on Android. A
 * driver that keeps going in the background (ProgressiveInstallDriver) also reports its [stages]
 * and finishes with [PolarisUpdateActions.finish].
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
 * and the banner dismisses it or runs [install].
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
    public fun install(actions: PolarisUpdateActions, scope: CoroutineScope, copy: PolarisCopy = PolarisCopy()) {
        val finishing = downloaded
        val c = check
        if (c == null && !finishing) return
        scope.launch {
            val result = try {
                if (finishing) actions.finish() else actions.install(c!!)
            } catch (e: CancellationException) {
                throw e
            } catch (e: im.plrs.key.core.UnsupportedException) {
                InstallResult.Failed(e.code, e.unsupported.detail)
            } catch (e: Exception) {
                InstallResult.Failed(im.plrs.key.core.ErrorCode.platformError, e.message)
            }
            _offer.update { o ->
                o?.copy(error = when (result) {
                    is InstallResult.Failed -> copy.updateFailed
                    is InstallResult.Declined, InstallResult.NothingToInstall, InstallResult.Started -> null
                })
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
    public fun follow(actions: PolarisUpdateActions, scope: CoroutineScope, copy: PolarisCopy = PolarisCopy()): Job = scope.launch {
        actions.stages.collect { stage ->
            when (stage) {
                is InstallStage.Downloading -> progress(stage.done, stage.total)
                InstallStage.ReadyToRestart -> readyToRestart()
                is InstallStage.Failed -> _offer.update { it?.copy(progress = null, error = copy.updateFailed) }
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

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/** The banner line for [ui]. */
public fun PolarisCopy.updateBannerText(ui: PolarisUpdateUi): String = when {
    ui.kind == PolarisUpdateUi.Kind.Restart && ui.version != null -> format(updateRestartBody, ui.version)
    ui.version != null -> format(updateAvailable, ui.version)
    else -> updateAvailableGeneric
}

/**
 * A slim banner announcing an update: the version, an Update (or Restart) action, and a dismiss
 * button unless the update is mandatory. Place it at the top or bottom of the product's UI.
 */
@Composable
public fun PolarisUpdateBanner(
    ui: PolarisUpdateUi,
    modifier: Modifier = Modifier,
    onUpdate: () -> Unit = {},
    onDismiss: (() -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    Surface(modifier = modifier.fillMaxWidth(), color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(
                modifier = Modifier
                    .widthIn(max = PolarisMaxContentWidth * 1.5f)
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (ui.critical) Icons.Filled.Warning else Icons.Filled.Refresh,
                    contentDescription = null,
                    tint = if (ui.critical) PolarisTheme.status.warning else PolarisTheme.accent("update"),
                    modifier = Modifier.size(24.dp),
                )
                Spacer(Modifier.width(12.dp))
                Column(
                    Modifier.weight(1f).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(copy.updateBannerText(ui), style = MaterialTheme.typography.bodyLarge)
                    if (ui.critical) Text(copy.updateCritical, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.width(8.dp))
                PolarisTextButton(if (ui.kind == PolarisUpdateUi.Kind.Restart) copy.updateRestart else copy.updateAction, onUpdate)
                if (onDismiss != null && !ui.mandatory) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = copy.updateDismiss) }
                }
            }
        }
    }
}

/**
 * The update prompt as a card: title, what is on offer, and Update now / Later (Later is absent
 * when the update is mandatory). [PolarisUpdatePromptDialog] shows it in a dialog.
 */
@Composable
public fun PolarisUpdatePrompt(
    ui: PolarisUpdateUi,
    modifier: Modifier = Modifier,
    onUpdate: () -> Unit = {},
    onLater: (() -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    val (title, body) = when {
        ui.kind == PolarisUpdateUi.Kind.Restart -> copy.updateRestart to copy.format(copy.updateRestartBody, ui.version ?: "")
        ui.mandatory -> copy.updateRequiredTitle to copy.format(copy.updateRequiredBody, ui.version ?: "")
        else -> copy.updatePromptTitle to (ui.version?.let { copy.format(copy.updatePromptBody, it) } ?: copy.updateAvailableGeneric)
    }
    Surface(
        modifier = modifier.widthIn(max = PolarisMaxContentWidth).fillMaxWidth(),
        shape = MaterialTheme.shapes.extraLarge,
        color = scheme.surfaceContainerHigh,
        contentColor = scheme.onSurface,
        tonalElevation = 6.dp,
    ) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            val kind = if (ui.critical) PolarisMessageKind.Warning else PolarisMessageKind.Info
            PolarisIconBadge(if (ui.critical) Icons.Filled.Warning else Icons.Filled.Refresh, kind.tint().first, kind.glyph())
            Spacer(Modifier.height(16.dp))
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            Spacer(Modifier.height(8.dp))
            PolarisBody(body)
            if (ui.critical) {
                Spacer(Modifier.height(8.dp))
                PolarisBody(copy.updateCritical)
            }
            Spacer(Modifier.height(24.dp))
            PolarisPrimaryButton(if (ui.kind == PolarisUpdateUi.Kind.Restart) copy.updateRestart else copy.updateNow, onUpdate)
            if (onLater != null && !ui.mandatory) {
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(copy.updateLater, onLater)
            }
        }
    }
}

/** [PolarisUpdatePrompt] in a dialog; a mandatory update cannot be dismissed by back or outside tap. */
@Composable
public fun PolarisUpdatePromptDialog(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit) {
    Dialog(
        onDismissRequest = { if (!ui.mandatory) onLater() },
        properties = DialogProperties(dismissOnBackPress = !ui.mandatory, dismissOnClickOutside = !ui.mandatory),
    ) {
        // Composition locals (the kit's theme included) carry into the dialog's window.
        PolarisUpdatePrompt(ui, Modifier.padding(16.dp), onUpdate = onUpdate, onLater = onLater)
    }
}
