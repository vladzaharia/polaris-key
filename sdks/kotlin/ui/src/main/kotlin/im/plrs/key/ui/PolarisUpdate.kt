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
import kotlinx.coroutines.flow.MutableStateFlow
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

/** Holds the update on offer; the host feeds it each check and the banner dismisses it. */
public class PolarisUpdateState {
    private val _offer = MutableStateFlow<PolarisUpdateUi?>(null)
    public val offer: StateFlow<PolarisUpdateUi?> = _offer.asStateFlow()
    private var dismissedVersion: String? = null

    /** Offer what [check] decided; a version the player dismissed stays dismissed unless mandatory. */
    public fun show(check: UpdateCheck) {
        show(PolarisUpdateUi.from(check))
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
                Spacer(Modifier.height(8.dp))
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
