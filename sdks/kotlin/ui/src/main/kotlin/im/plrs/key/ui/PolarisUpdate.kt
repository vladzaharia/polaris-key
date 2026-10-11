// The update banner and the update prompt, over the update client's decision (UpdateCheck from
// PolarisKeyClient.update.decide()). The mapping from a decision to what the player sees is a pure
// function (PolarisUpdateUi.from), unit-tested: a binary, store or platform update offers Update;
// a code-ready update (staged, applied on the next launch) offers a restart; pack work is the
// pack progress screen's, and none or blocked offers nothing here (a block is the boot's).

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/** The banner line for [ui]. */
public fun PolarisCopy.updateBannerText(ui: PolarisUpdateUi): String {
    val version = ui.version
    return when {
        ui.kind == PolarisUpdateUi.Kind.Restart && version != null -> format(updateRestartBody, version)
        version != null -> format(updateAvailable, version)
        else -> updateAvailableGeneric
    }
}

/** Catalog copy for a typed install failure; backend details never appear in UI text. */
internal fun PolarisCopy.updateFailureMessage(failure: PolarisUpdateFailure): String = updateFailed

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
                    ui.error?.let { Text(copy.updateFailureMessage(it), style = MaterialTheme.typography.bodySmall) }
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
 * The update prompt as a card: the product's icon, the title, what is on offer, and the actions
 * (Update now, or Restart now once the update is ready, and Later unless the update is mandatory).
 * At compact height the actions form one trailing row; [PolarisUpdatePromptDialog] keeps them in
 * a footer outside the scrolling content, so they are always on screen.
 */
@Composable
public fun PolarisUpdatePrompt(
    ui: PolarisUpdateUi,
    modifier: Modifier = Modifier,
    onUpdate: () -> Unit = {},
    onLater: (() -> Unit)? = null,
) {
    PolarisUpdatePromptCard(ui, modifier, onUpdate, onLater, footer = false)
}

/** The prompt's title and body for [ui]: the kit-copy "ready" pair once it can restart. */
internal fun PolarisCopy.updatePromptText(ui: PolarisUpdateUi): Pair<String, String?> {
    val version = ui.version
    return when {
        // With no product name there is no "{product}" to fill: the banner's wording stands in.
        ui.kind == PolarisUpdateUi.Kind.Restart && productName(this) != null && version != null ->
            format(updateReadyTitle, productName, version) to format(updateReadyBody, productName)
        ui.kind == PolarisUpdateUi.Kind.Restart -> updateRestart to version?.let { format(updateRestartBody, it) }
        ui.mandatory && productName(this) != null ->
            format(updateMandatoryTitle, productName) to format(updateMandatoryBody, productName)
        ui.mandatory -> updateRequiredTitle to format(updateRequiredBody, version ?: "")
        // An offer says what it is, not that it is downloaded: "{product} {version}" and Update now.
        version == null -> updateAvailableGeneric to null
        productName(this) == null -> format(updateAvailable, version) to null
        else -> format(updatePromptTitle, productName, version) to null
    }
}

@Composable
private fun PolarisUpdatePromptCard(
    ui: PolarisUpdateUi,
    modifier: Modifier,
    onUpdate: () -> Unit,
    onLater: (() -> Unit)?,
    footer: Boolean,
) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    val window = polarisWindow
    val (title, body) = copy.updatePromptText(ui)
    Surface(
        modifier = modifier.widthIn(max = PolarisMaxContentWidth).fillMaxWidth(),
        shape = MaterialTheme.shapes.extraLarge,
        // One step lower than the tonal Later button's container, so Later stays visible.
        color = scheme.surfaceContainerLow,
        contentColor = scheme.onSurface,
        tonalElevation = 6.dp,
    ) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            val content: @Composable () -> Unit = {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    val kind = if (ui.critical) PolarisMessageKind.Warning else PolarisMessageKind.Info
                    if (productName(copy) != null || PolarisTheme.current.logo != null) {
                        PolarisProductIcon(56.dp)
                    } else {
                        PolarisIconBadge(if (ui.critical) Icons.Filled.Warning else Icons.Filled.Refresh, kind.tint().first, kind.glyph())
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(
                        title,
                        style = MaterialTheme.typography.headlineSmall,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().semantics { heading() },
                    )
                    Spacer(Modifier.height(8.dp))
                    if (body != null) PolarisBody(body, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    if (ui.critical) {
                        Spacer(Modifier.height(8.dp))
                        PolarisBody(copy.updateCritical, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                    ui.error?.let {
                        Spacer(Modifier.height(8.dp))
                        PolarisBody(copy.updateFailureMessage(it), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
            }
            if (footer) {
                // The dialog's height is the window's: the content scrolls, the actions stay put.
                Box(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) { content() }
            } else {
                content()
            }
            Spacer(Modifier.height(24.dp))
            PolarisActionGroup(row = window.compactHeight) {
                PolarisPrimaryButton(
                    if (ui.kind == PolarisUpdateUi.Kind.Restart) copy.updateRestartNow else copy.updateNow,
                    onUpdate,
                    initialFocus = true,
                )
                if (onLater != null && !ui.mandatory) PolarisTextButton(copy.updateLater, onLater)
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
        // Composition locals (the kit's theme included) carry into the dialog's window; the
        // dialog measures its own window, so a short one lays the actions out as a row.
        BoxWithConstraints {
            val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
            CompositionLocalProvider(LocalPolarisWindow provides window) {
                PolarisUpdatePromptCard(ui, Modifier.padding(16.dp).heightIn(max = maxHeight), onUpdate, onLater, footer = true)
            }
        }
    }
}
