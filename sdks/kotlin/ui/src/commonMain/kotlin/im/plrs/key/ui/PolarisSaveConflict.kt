// @pkey-feature ui.kit
// SaveConflict (U-22.K4; ui-matrix `saveConflict`): the same save changed on two devices and the
// person picks the one to keep. Drawn from the catalog lines of a KitScreen that KitStates resolved,
// the way the Cloud Sync screens are, so the same inputs draw the same screen as the React kit.
//
//  - `choose` is one undocked column in reading order: the two copies (side by side from 600 dp,
//    this device's first, never swapped), then the three choices, the slots-full reason under Keep
//    both, and Cancel. In a short landscape window (two panes, under 1.5x text) the copies, stacked,
//    are the first pane and the choices the second, both from the top and nothing docked. Nothing is
//    filled or focused: no choice is the default, so a save is never discarded without one. A Newer
//    tag sits in the head of the card the app names; it never fills, focuses or reorders anything;
//  - Keep both stays on the screen, disabled and described by its reason, while all 16 slots are in
//    use; when the other copy was deleted it goes, Keep the other becomes Delete it here too (an
//    outlined control in the danger colour), and the title and lede say so through every step;
//  - `keeping` offers no control and draws the busy indicator; `kept` is the success mark above the
//    result title (Done is the primary; Back is Done); `failed` offers Try again, Choose again and
//    Cancel, none filled. Every step's heading, not a button, takes the focus.
package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonElement

/** The width from which the two copies sit side by side. */
private val SIDE_BY_SIDE = 600.dp

/**
 * SaveConflict: [screen] is one of the component's states, choose, keeping, kept or failed.
 *
 * @param onKeep a choice was made; the host applies it and moves the state on (K.4T binds the saves client).
 * @param onRetry Try again, after a choice failed.
 * @param onCancel Cancel (or Back): the conflict stays as it was.
 * @param onDone Done, after the choice was kept.
 * @param onChooseAgain Choose again, after a choice failed: back to the choices with the same versions; nothing is applied.
 */
@Composable
public fun PolarisSaveConflict(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    onKeep: (PolarisSaveKeep) -> Unit = {},
    onRetry: () -> Unit = {},
    onCancel: () -> Unit = {},
    onDone: () -> Unit = {},
    onChooseAgain: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val title = saveTitle(lines, screen.state)
    // Back is Done once kept, does nothing while the choice runs, and is Cancel otherwise.
    val back = PolarisBackHandler(
        enabled = true,
        onBack = if (screen.state == "kept") {
            onDone
        } else if (screen.state == "keeping") {
            ({})
        } else {
            onCancel
        },
    )
    // A short landscape window: the copies and the choices are two panes, both from the top (the scaffold's
    // second pane scrolls on its own, nothing is docked). Everywhere else, and at large text, one column.
    val textScale = LocalDensity.current.fontScale
    PolarisScaffold(
        modifier.then(back),
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        paneActions = { window -> if (screen.state == "choose" && inPanes(window, textScale)) ({ Choices(lines, onKeep, onCancel) }) else null },
    ) {
        val panes = screen.state == "choose" && inPanes(polarisWindow, textScale)
        PolarisProductHeader()
        if (screen.state == "kept") {
            // The result is the news: the success mark (decorative) above its title.
            PolarisIconBadge(PolarisSymbols.Check, PolarisTheme.status.successContainer, PolarisTheme.status.success)
            Spacer(Modifier.height(PolarisSpace.controls))
        }
        // The heading takes the focus and is the one announcement (no live region on it).
        PolarisTitle(title, key = screen.state)
        when (screen.state) {
            "keeping" -> Keeping(lines)

            "kept" -> Kept(lines, onDone)

            "failed" -> Failed(lines, onRetry, onChooseAgain, onCancel)

            else -> {
                Copies(lines, stacked = panes)
                if (!panes) {
                    Spacer(Modifier.height(PolarisSpace.group))
                    Choices(lines, onKeep, onCancel)
                }
            }
        }
    }
}

@Composable
private fun Keeping(lines: KitLines) {
    Spacer(Modifier.height(PolarisSpace.group))
    // The busy indicator is silent: "Keeping your choice…" is the only announcement.
    PolarisWaitIndicator(Modifier.semantics { lines.text("a11y.busy")?.let { stateDescription = it } })
    Spacer(Modifier.height(PolarisSpace.controls))
    Text(
        lines.text("saveConflict.keeping").orEmpty(),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun Kept(lines: KitLines, onDone: () -> Unit) {
    lines.text("saveConflict.keptCopy")?.let {
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(it, textAlign = TextAlign.Start)
    }
    Spacer(Modifier.height(PolarisSpace.group))
    PolarisPrimaryButton(lines.format("common.done"), onDone)
}

@Composable
private fun Failed(lines: KitLines, onRetry: () -> Unit, onChooseAgain: () -> Unit, onCancel: () -> Unit) {
    Spacer(Modifier.height(PolarisSpace.tight))
    PolarisErrorLine((lines.text("saveConflict.failedDeleted") ?: lines.text("saveConflict.failed")).orEmpty())
    Spacer(Modifier.height(PolarisSpace.group))
    // None is filled: a stray Enter must not repeat an overwrite or a deletion.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        PolarisSecondaryButton(lines.format("common.tryAgain"), onRetry)
        PolarisSecondaryButton(lines.text("saveConflict.chooseAgain").orEmpty(), onChooseAgain)
        PolarisTextButton(lines.format("common.cancel"), onCancel)
    }
}

/** The step's own title: the result when kept, else the situation's (one copy and a deletion is never "two versions"). */
private fun saveTitle(lines: KitLines, state: String): String = (
    if (state == "kept") {
        KEPT_TITLES.firstNotNullOfOrNull(lines::text)
    } else {
        lines.text("saveConflict.deletedTitle") ?: lines.text("saveConflict.title")
    }
    ).orEmpty()

/** Whether the choices are the second pane: a short landscape window with two panes, under 1.5x text. */
private fun inPanes(window: PolarisWindow, fontScale: Float): Boolean = window.twoPane && window.compactHeight && fontScale < POLARIS_DOCK_FONT_SCALE

/** The result titles of `kept`: the screen carries exactly one. */
private val KEPT_TITLES = listOf(
    "saveConflict.keptLocalTitle",
    "saveConflict.keptRemoteTitle",
    "saveConflict.keptBothTitle",
    "saveConflict.keptDeletedTitle",
)

/** The lede and the two copies, this device's first, whatever the size; [stacked] in a pane. */
@Composable
private fun Copies(lines: KitLines, stacked: Boolean) {
    Spacer(Modifier.height(PolarisSpace.tight))
    (lines.text("saveConflict.deletedLede") ?: lines.text("saveConflict.lede"))?.let { PolarisBody(it, textAlign = TextAlign.Start) }
    // A choice met a newer copy: nothing was applied, and these are the new versions.
    lines.text("saveConflict.reopened")?.let {
        Spacer(Modifier.height(PolarisSpace.tight))
        Text(
            it,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    Spacer(Modifier.height(if (stacked) PolarisSpace.tight else PolarisSpace.medium))
    // Newer only tags a card (and only the app says which); it chooses nothing.
    val newer = lines.text("saveConflict.newerThis") to lines.text("saveConflict.newerOther")
    val local = lines.text("saveConflict.thisDevice").orEmpty() to lines.text("saveConflict.savedThis")
    val other = (
        lines.text("saveConflict.deletedElsewhere") ?: lines.text("saveConflict.otherDevice") ?: lines.text("saveConflict.otherUnknown")
        ).orEmpty() to lines.text("saveConflict.savedOther")
    if (!stacked && polarisWindow.width >= SIDE_BY_SIDE) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            SaveCard(local.first, local.second, newer.first, Modifier.weight(1f).fillMaxHeight())
            SaveCard(other.first, other.second, newer.second, Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
            SaveCard(local.first, local.second, newer.first, Modifier, compact = stacked)
            SaveCard(other.first, other.second, newer.second, Modifier, compact = stacked)
        }
    }
}

/** The choices, the slots-full reason under Keep both, and Cancel. The choices never swap sides. */
@Composable
private fun ColumnScope.Choices(lines: KitLines, onKeep: (PolarisSaveKeep) -> Unit, onCancel: () -> Unit) {
    val gone = lines.has("saveConflict.deletedElsewhere")
    val full = lines.has("saveConflict.bothFull")
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        PolarisSecondaryButton(lines.text("saveConflict.keepThis").orEmpty(), { onKeep(PolarisSaveKeep.Local) })
        if (gone) {
            PolarisDangerOutlineButton(lines.text("saveConflict.acceptDelete").orEmpty(), { onKeep(PolarisSaveKeep.Remote) })
        } else {
            PolarisSecondaryButton(lines.text("saveConflict.keepOther").orEmpty(), { onKeep(PolarisSaveKeep.Remote) })
        }
        lines.text("saveConflict.keepBoth")?.let { both ->
            val reason = lines.text("saveConflict.bothFull")
            // Drawn disabled while every slot is in use, and described by the reason shown under it.
            PolarisSecondaryButton(
                both,
                { onKeep(PolarisSaveKeep.Both) },
                Modifier.then(if (full && reason != null) Modifier.semantics { stateDescription = reason } else Modifier),
                enabled = !full,
            )
        }
        lines.text("saveConflict.bothFull")?.let { PolarisBody(it, textAlign = TextAlign.Start) }
        PolarisTextButton(lines.text("common.cancel").orEmpty(), onCancel)
    }
}

/** SaveConflict bound to its [state] holder; nothing draws once the person cancelled or closed the result. */
@Composable
public fun PolarisSaveConflict(
    state: PolarisSaveConflictState,
    modifier: Modifier = Modifier,
    base: Map<String, JsonElement> = emptyMap(),
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    val step by state.ui.collectAsState()
    val screen = remember(step) { state.kitScreen(base) } ?: return
    PolarisSaveConflict(screen, modifier, state::keep, state::retry, state::cancel, state::done, state::chooseAgain, catalog, locale)
}
