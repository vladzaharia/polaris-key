// The update banner and the update prompt, over the update client's decision (UpdateCheck from
// PolarisKeyClient.update.decide()). The mapping from a decision to what the player sees is a pure
// function (PolarisUpdateUi.from), unit-tested: a binary, store or platform update offers Update;
// a code-ready update (staged, applied on the next launch) offers a restart; pack work is the
// pack progress screen's, and none or blocked offers nothing here (a block is the boot's).

package im.plrs.key.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
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
 * A slim banner announcing an update: the version, an Update (or Restart now) action, and Later
 * unless the update is mandatory. One dismissal and the verb, with no X (UI-KITS.md 4.3 UpdatePrompt).
 * Place it at the top or bottom of the product's UI. The actions sit under the text, so neither is
 * squeezed at a large font scale.
 *
 * @param onDismiss what Later does; null (or a mandatory update) leaves the banner without it.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
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
            Column(
                modifier = Modifier
                    .widthIn(max = PolarisMaxContentWidth * 1.5f)
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 4.dp),
            ) {
                Row(verticalAlignment = Alignment.Top) {
                    // A section accent is a service cue, which product screens never draw (UI-KITS.md 1.2).
                    Icon(
                        if (ui.critical) Icons.Filled.Warning else Icons.Filled.Refresh,
                        contentDescription = null,
                        tint = if (ui.critical) PolarisTheme.status.warning else scheme.onSecondaryContainer,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(
                        Modifier.weight(1f).padding(end = 8.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(copy.updateBannerText(ui), style = MaterialTheme.typography.bodyLarge)
                        if (ui.critical) Text(copy.updateCritical, style = MaterialTheme.typography.bodySmall)
                        ui.error?.let { Text(copy.updateFailureMessage(it), style = MaterialTheme.typography.bodySmall) }
                    }
                }
                androidx.compose.foundation.layout.FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
                ) {
                    if (onDismiss != null && !ui.mandatory) PolarisTextButton(copy.updateLater, onDismiss)
                    PolarisTextButton(if (ui.kind == PolarisUpdateUi.Kind.Restart) copy.updateRestartNow else copy.updateAction, onUpdate)
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
    sheet: Boolean = false,
) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    val window = polarisWindow
    val (title, body) = copy.updatePromptText(ui)
    val downloading = ui.progress != null && ui.kind == PolarisUpdateUi.Kind.Install
    Surface(
        modifier = modifier.widthIn(max = PolarisMaxContentWidth).fillMaxWidth(),
        // A bottom sheet rounds its top edge only (radius 28); a card rounds all four.
        shape = if (sheet) polarisSheetShape else MaterialTheme.shapes.extraLarge,
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
                    if (downloading) {
                        // Counted bytes only: the bar and "Downloading · 38 of 61 MB" (UI-KITS.md 4.3).
                        val (done, total) = ui.progress!!
                        val line = copy.format(copy.updateDownloading, copy.bytes(done), copy.bytes(total))
                        Spacer(Modifier.height(16.dp))
                        PolarisProgressBar(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else null, line)
                        Spacer(Modifier.height(8.dp))
                        Text(
                            line,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
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
                // While the download runs the primary queues the restart, so it is never disabled.
                PolarisPrimaryButton(
                    when {
                        ui.kind == PolarisUpdateUi.Kind.Restart -> copy.updateRestartNow
                        downloading -> copy.updateRestartWhenReady
                        else -> copy.updateNow
                    },
                    onUpdate,
                    initialFocus = true,
                )
                if (onLater != null && !ui.mandatory) PolarisSecondaryButton(copy.updateLater, onLater)
            }
        }
    }
}

/** The container width below which the prompt is a bottom sheet and from which it is a card (UI-KITS.md DL2). */
internal val PolarisSheetBelow = 560.dp

/**
 * [PolarisUpdatePrompt] over the app (UI-KITS.md DL2): a bottom sheet below 560 dp wide, a card
 * from there up, both over the scrim with the host visible behind it (32 % in light, 60 % in dark).
 * A mandatory update cannot be dismissed by back or by a tap outside; an optional one can, and Later
 * is its one dismissal.
 */
@Composable
public fun PolarisUpdatePromptDialog(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit) {
    val dark = PolarisTheme.current.dark
    Dialog(
        onDismissRequest = { if (!ui.mandatory) onLater() },
        // The sheet and the card span the window: the dialog's own width would cap them.
        properties = DialogProperties(dismissOnBackPress = !ui.mandatory, dismissOnClickOutside = !ui.mandatory, usePlatformDefaultWidth = false),
    ) {
        val dialogWindow = (androidx.compose.ui.platform.LocalView.current.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window
        androidx.compose.runtime.SideEffect { dialogWindow?.setDimAmount(if (dark) 0.6f else 0.32f) }
        // Composition locals (the kit's theme included) carry into the dialog's window; the
        // dialog measures its own window, so a short one lays the actions out as a row.
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
            val sheet = maxWidth < PolarisSheetBelow
            val available = maxHeight
            CompositionLocalProvider(LocalPolarisWindow provides window) {
                // The window is the scrim: a tap on it dismisses an optional update; the card takes its own taps.
                val absorb = remember { MutableInteractionSource() }
                Box(
                    Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { if (!ui.mandatory) onLater() },
                    contentAlignment = if (sheet) Alignment.BottomCenter else Alignment.Center,
                ) {
                    if (sheet) {
                        PolarisUpdatePromptCard(
                            ui,
                            Modifier.navigationBarsPadding().heightIn(max = available).clickable(interactionSource = absorb, indication = null) {},
                            onUpdate,
                            onLater,
                            footer = true,
                            sheet = true,
                        )
                    } else {
                        PolarisUpdatePromptCard(
                            ui,
                            Modifier.padding(16.dp).heightIn(max = available).clickable(interactionSource = absorb, indication = null) {},
                            onUpdate,
                            onLater,
                            footer = true,
                        )
                    }
                }
            }
        }
    }
}
