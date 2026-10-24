// The update banner and the update prompt, over the update client's decision (UpdateCheck from
// PolarisKeyClient.update.decide()). The mapping from a decision to what the player sees is a pure
// function (PolarisUpdateUi.from), unit-tested: a binary, store or platform update offers Update;
// a code-ready update (staged, applied on the next launch) offers a restart; pack work is the
// pack progress screen's, and none or blocked offers nothing here (a block is the boot's).

package im.plrs.key.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
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
                        if (ui.critical) PolarisSymbols.Warning else PolarisSymbols.Refresh,
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
    onSkip: (() -> Unit)? = null,
) {
    PolarisUpdatePromptCard(ui, modifier, onUpdate, onLater, footer = false, onSkip = onSkip)
}

/** The verb the outlet allows for an available update: "Update on Google Play", else "Update now". */
internal fun PolarisCopy.updateVerb(ui: PolarisUpdateUi): String = when (ui.outlet) {
    "play", "play-testing" -> updateGooglePlay
    "app-store" -> updateAppStore
    "steam" -> updateSteam
    "testflight" -> updateTestflight
    "altstore", "altstore-pal" -> updateAltstore
    "web" -> updateReload
    else -> updateNow
}

/** "You have 2.4.1 · 38 MB download", or without the size when the decision carries none; null when unknown. */
internal fun PolarisCopy.updateCurrentLine(ui: PolarisUpdateUi): String? {
    val current = ui.currentVersion ?: return null
    val size = ui.size ?: return format(updateCurrentNoSize, current)
    return format(updateCurrent, current, bytes(size))
}

/** The prompt's title and body for [ui]: the kit-copy "ready" pair once it can restart. */
internal fun PolarisCopy.updatePromptText(ui: PolarisUpdateUi): Pair<String, String?> {
    val version = ui.version
    return when {
        // With no product name there is no "{product}" to fill: the banner's wording stands in.
        ui.kind == PolarisUpdateUi.Kind.Restart && productName(this) != null && version != null ->
            format(updateReadyTitle, productName, version) to updateReadyBody
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

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun PolarisUpdatePromptCard(
    ui: PolarisUpdateUi,
    modifier: Modifier,
    onUpdate: () -> Unit,
    onLater: (() -> Unit)?,
    footer: Boolean,
    sheet: Boolean = false,
    onSkip: (() -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    val window = polarisWindow
    val (title, body) = copy.updatePromptText(ui)
    val downloading = ui.progress != null && ui.kind == PolarisUpdateUi.Kind.Install
    Surface(
        // A card (not the phone's sheet) is the 560 dp message block, so its three actions fit one row.
        modifier = modifier.widthIn(max = if (sheet) PolarisMaxContentWidth else PolarisMessageBlockWidth).fillMaxWidth(),
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
                        PolarisIconBadge(if (ui.critical) PolarisSymbols.Warning else PolarisSymbols.Refresh, kind.tint().first, kind.glyph())
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
                    if (ui.kind == PolarisUpdateUi.Kind.Install) {
                        copy.updateCurrentLine(ui)?.let { PolarisBody(it, textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
                        // A short window keeps the title, version and actions on screen: no room for the notes.
                        if (!window.compactHeight) PolarisUpdateNotes(ui)
                    }
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
                        ui.secondsLeft?.let {
                            Text(
                                copy.timeLeftLine(it.toLong()),
                                style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
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
            // DL9: on a TV the D-pad lands on Later, never on the verb that can open a store, and a
            // press that arrives as the prompt opens (the one that was heading for the game) is ignored
            // for 250 ms. A mandatory update has no Later, so its one verb keeps the focus.
            val laterFirst = window.tv && onLater != null && !ui.mandatory
            var armed by remember { mutableStateOf(!window.tv) }
            if (window.tv) LaunchedEffect(Unit) {
                delay(PolarisPromptInputDelayMs)
                armed = true
            }
            val primaryLabel = when {
                ui.kind == PolarisUpdateUi.Kind.Restart -> copy.updateRestartNow
                downloading -> copy.updateRestartWhenReady
                else -> copy.updateVerb(ui)
            }
            val showLater = onLater != null && !ui.mandatory
            val showSkip = onSkip != null && !ui.mandatory && !downloading && ui.kind == PolarisUpdateUi.Kind.Install && ui.version != null
            if (!sheet && (window.compactHeight || footer) && showSkip) {
                // Skip stays a quiet text link at the start edge; Later and the verb end the row (DL4).
                // Where the three do not fit one row they stack, the verb first and Skip last.
                PolarisSkipRow {
                    PolarisTextButton(copy.updateSkip, { if (armed) onSkip!!() })
                    CompositionLocalProvider(LocalPolarisActionRow provides true) {
                        if (showLater) PolarisSecondaryButton(copy.updateLater, { if (armed) onLater!!() }, initialFocus = laterFirst)
                        PolarisPrimaryButton(primaryLabel, { if (armed) onUpdate() }, initialFocus = !laterFirst)
                    }
                }
            } else {
                PolarisActionGroup(row = window.compactHeight) {
                    // While the download runs the primary queues the restart, so it is never disabled.
                    PolarisPrimaryButton(primaryLabel, { if (armed) onUpdate() }, initialFocus = !laterFirst)
                    if (showLater) PolarisSecondaryButton(copy.updateLater, { if (armed) onLater!!() }, initialFocus = laterFirst)
                    if (showSkip) PolarisTextButton(copy.updateSkip, { if (armed) onSkip!!() })
                }
            }
        }
    }
}

/**
 * Three actions, in the order [skip, later, verb] (the last two optional beyond skip): in one row
 * with the first at the start edge and the rest at the end, or, when the labels do not fit, stacked
 * at full width with the verb on top.
 */
@Composable
private fun PolarisSkipRow(content: @Composable () -> Unit) {
    Layout(content = content, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
        val gap = PolarisSpace.controls.roundToPx()
        val maxWidth = constraints.maxWidth
        val minWidth = 96.dp.roundToPx()
        val widths = measurables.mapIndexed { i, m -> m.maxIntrinsicWidth(Constraints.Infinity).coerceAtLeast(if (i == 0) 0 else minWidth) }
        val fits = widths.sum() + gap * (measurables.size - 1).coerceAtLeast(0) <= maxWidth
        if (fits) {
            val height = measurables.zip(widths).maxOfOrNull { (m, w) -> m.minIntrinsicHeight(w) } ?: 0
            val placeables = measurables.zip(widths).map { (m, w) -> m.measure(Constraints.fixed(w, height)) }
            layout(maxWidth, height) {
                placeables.first().placeRelative(0, (height - placeables.first().height) / 2)
                var x = maxWidth
                for (p in placeables.drop(1).asReversed()) {
                    x -= p.width
                    p.placeRelative(x, 0)
                    x -= gap
                }
            }
        } else {
            val placeables = measurables.map { it.measure(Constraints(minWidth = maxWidth, maxWidth = maxWidth)) }.asReversed()
            val height = placeables.sumOf { it.height } + gap * (placeables.size - 1).coerceAtLeast(0)
            layout(maxWidth, height) {
                var y = 0
                for (p in placeables) {
                    p.placeRelative(0, y)
                    y += p.height + gap
                }
            }
        }
    }
}

/**
 * What's new: a small label over at most three plain lines, then "All changes in {version} ↗".
 * No lines hides the label; no page hides the link (UI-KITS.md 4.3 UpdatePrompt).
 */
@Composable
private fun PolarisUpdateNotes(ui: PolarisUpdateUi) {
    val copy = PolarisTheme.copy
    val scheme = MaterialTheme.colorScheme
    val opener = rememberPolarisOpener()
    val lines = ui.notes.take(PolarisUpdateUi.MAX_NOTES)
    if (lines.isEmpty() && ui.notesUrl == null) return
    Spacer(Modifier.height(16.dp))
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
        if (lines.isNotEmpty()) {
            Text(copy.updateWhatsNew, style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            for (line in lines) {
                Text(line, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface)
            }
        }
        val url = ui.notesUrl
        val version = ui.version
        if (url != null && version != null) {
            val label = copy.format(copy.updateAllChanges, version)
            Row(
                Modifier
                    .heightIn(min = 48.dp)
                    .clickable(role = androidx.compose.ui.semantics.Role.Button) { opener(url) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = scheme.primary)
                Spacer(Modifier.width(4.dp))
                Icon(PolarisSymbols.OpenInNew, contentDescription = null, tint = scheme.primary, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** How long the prompt ignores input after it opens on a TV (UI-KITS.md DL9, §4.3). */
internal const val PolarisPromptInputDelayMs: Long = 250

/** The container width below which the prompt is a bottom sheet and from which it is a card (UI-KITS.md DL2). */
internal val PolarisSheetBelow = 560.dp

/**
 * [PolarisUpdatePrompt] over the app (UI-KITS.md DL2): a bottom sheet below 560 dp wide, a card
 * from there up, both over the scrim with the host visible behind it (32 % in light, 60 % in dark).
 * A mandatory update cannot be dismissed by back or by a tap outside; an optional one can, and Later
 * is its one dismissal.
 */
@Composable
public fun PolarisUpdatePromptDialog(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit, onSkip: (() -> Unit)? = null) {
    val dark = PolarisTheme.current.dark
    Dialog(
        onDismissRequest = { if (!ui.mandatory) onLater() },
        // The sheet and the card span the window: the dialog's own width would cap them.
        properties = DialogProperties(dismissOnBackPress = !ui.mandatory, dismissOnClickOutside = !ui.mandatory, usePlatformDefaultWidth = false),
    ) {
        PolarisDialogDim(if (dark) 0.6f else 0.32f)
        PolarisUpdatePromptHosted(ui, onUpdate, onLater, onSkip)
    }
}

/**
 * The sheet or card of [PolarisUpdatePromptDialog] without the dialog window: it measures the
 * window it is in (so a short one lays the actions out as a row) and sits over whatever is behind.
 */
@Composable
internal fun PolarisUpdatePromptHosted(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit, onSkip: (() -> Unit)?) {
    // Composition locals (the kit's theme included) carry into the dialog's window;
    // the dialog measures its own window, so a short one lays the actions out as a row.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
        val sheet = maxWidth < PolarisSheetBelow
        val available = maxHeight
        CompositionLocalProvider(LocalPolarisWindow provides window) {
            // The window is the scrim: a tap on it dismisses an optional update; the card takes its own taps.
            // Taps, not click semantics: TalkBack gets no unnamed full-window control (Later and Back dismiss).
            Box(
                Modifier.fillMaxSize().pointerInput(ui.mandatory) { detectTapGestures { if (!ui.mandatory) onLater() } },
                contentAlignment = if (sheet) Alignment.BottomCenter else Alignment.Center,
            ) {
                if (sheet) {
                    PolarisUpdatePromptCard(
                        ui,
                        Modifier.navigationBarsPadding().heightIn(max = available).pointerInput(Unit) { detectTapGestures {} },
                        onUpdate,
                        onLater,
                        footer = true,
                        sheet = true,
                        onSkip = onSkip,
                    )
                } else {
                    PolarisUpdatePromptCard(
                        ui,
                        Modifier.padding(16.dp).heightIn(max = available).pointerInput(Unit) { detectTapGestures {} },
                        onUpdate,
                        onLater,
                        footer = true,
                        onSkip = onSkip,
                    )
                }
            }
        }
    }
}
