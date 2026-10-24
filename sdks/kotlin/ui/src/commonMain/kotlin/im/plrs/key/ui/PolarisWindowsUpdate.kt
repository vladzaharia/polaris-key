// The update prompt as a Windows ContentDialog (UK-10.5): the sheet presentation of the Windows
// variant. Title and lede start-aligned, the notes and progress in the body, and a footer band of
// buttons at equal width, the primary first. It reads the same PolarisUpdateUi and copy as the
// Material card; only the chrome differs.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign

@Composable
internal fun PolarisFluentUpdateDialog(ui: PolarisUpdateUi, onUpdate: () -> Unit, onLater: () -> Unit, onSkip: (() -> Unit)?) {
    val copy = PolarisTheme.copy
    val (title, body) = copy.updatePromptText(ui)
    val downloading = ui.progress != null && ui.kind == PolarisUpdateUi.Kind.Install
    // A press that arrives as the prompt opens (the one heading for the app) is ignored for 250 ms.
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(PolarisPromptInputDelayMs)
        armed = true
    }
    val primaryLabel = when {
        ui.kind == PolarisUpdateUi.Kind.Restart -> copy.updateRestartNow
        downloading -> copy.updateRestartWhenReady
        else -> copy.updateVerb(ui)
    }
    val showLater = !ui.mandatory
    val showSkip = onSkip != null && !ui.mandatory && !downloading && ui.kind == PolarisUpdateUi.Kind.Install && ui.version != null
    val footer = buildList {
        add(FluentFooterButton(primaryLabel, FluentButtonKind.Accent) { if (armed) onUpdate() })
        if (showLater) add(FluentFooterButton(copy.updateLater, FluentButtonKind.Standard) { if (armed) onLater() })
        if (showSkip) add(FluentFooterButton(copy.updateSkip, FluentButtonKind.Standard) { if (armed) onSkip!!() })
    }
    PolarisFluentContentDialog(
        footer = footer,
        onDismissOutside = if (ui.mandatory) null else onLater,
        onEscape = if (ui.mandatory) null else onLater,
    ) {
        CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisFluent.gap)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().semantics { heading() },
                )
                if (body != null) PolarisBody(body, textAlign = TextAlign.Start)
                if (ui.kind == PolarisUpdateUi.Kind.Install) {
                    copy.updateCurrentLine(ui)?.let { PolarisBody(it, textAlign = TextAlign.Start) }
                    PolarisUpdateNotes(ui)
                }
                if (ui.critical) PolarisBody(copy.updateCritical, textAlign = TextAlign.Start)
                ui.error?.let { PolarisBody(copy.updateFailureMessage(it), textAlign = TextAlign.Start) }
                if (downloading) {
                    val (done, total) = ui.progress!!
                    val line = copy.format(copy.updateDownloading, copy.bytes(done), copy.bytes(total))
                    PolarisProgressBar(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else null, line)
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
    }
}
