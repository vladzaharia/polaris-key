// @pkey-feature ui.kit
// The Cloud Sync kit host's Compose side (U-42.4T, Q-7): the status row drawn from a
// [PolarisCloudSyncHost], and the unlock, ring-change and recovery-code screens in its place while a flow is up.
package im.plrs.key.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** The strip's glyph box. */
private val StripGlyph = 20.dp

/**
 * The Cloud Sync row and its screens, bound to [host]. With a flow in front only the screens draw; otherwise
 * the row, when Cloud Sync has something to say. [onSignIn] opens the app's own sign-in; null opens the
 * kit's own sign-in in the row's place (the client PolarisKeyGate or PolarisKeyProvider provides), and
 * hides the button where there is none.
 */
@Composable
public fun PolarisCloudSyncKit(host: PolarisCloudSyncHost, modifier: Modifier = Modifier, onSignIn: (() -> Unit)? = null) {
    DisposableEffect(host) {
        host.start()
        onDispose { host.stop() }
    }
    val flow by host.flow.collectAsState()
    val status by host.status.collectAsState()
    val client = LocalPolarisKey.current
    var signingIn by remember { mutableStateOf(false) }
    val open = flow
    val shown = status
    if (open != null) {
        PolarisSyncFlow(open, modifier)
    } else if (signingIn && client != null && onSignIn == null) {
        // The machine follows the sign-in's own events, so the row redraws once it is done.
        val held = rememberHeldSignIn(client to "cloudSyncStatus", client.signInActions()) { signingIn = false }
        PolarisSignIn(held, modifier, onCancel = { signingIn = false })
    } else if (shown != null) {
        PolarisCloudSyncStatus(
            shown.row.toStatus(),
            modifier,
            syncedAtMillis = shown.syncedAtMillis,
            onUnlock = host::openUnlock,
            onReview = host::openReview,
            onSignIn = onSignIn ?: client?.let { { signingIn = true } },
        )
    }
}

private fun PolarisCloudSyncRow.toStatus(): PolarisCloudSync = when (this) {
    PolarisCloudSyncRow.Synced -> PolarisCloudSync.Synced
    PolarisCloudSyncRow.Syncing -> PolarisCloudSync.Syncing
    PolarisCloudSyncRow.Offline -> PolarisCloudSync.Offline
    PolarisCloudSyncRow.Error -> PolarisCloudSync.Error
    PolarisCloudSyncRow.SignedOut -> PolarisCloudSync.SignedOut
    PolarisCloudSyncRow.Locked -> PolarisCloudSync.Locked
    PolarisCloudSyncRow.RingChanged -> PolarisCloudSync.RingChanged
}

/** The CloudSyncStatus states of a background transfer (ui-matrix `cloudSync`, U-22.K0). */
internal val TransferStates: Set<String> = setOf("transferring", "waiting", "transfer-failed")

/**
 * CloudSyncStatus while saves transfer: [screen] is `transferring` (the label, then its figures, and a
 * bar on its own row that is determinate only with a counted [fraction]), `waiting` (names its reason)
 * or `transfer-failed` (Try again, a text button, so it never competes with the host's primary). None of
 * them says Synced, whatever the last sync time was.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun PolarisCloudSyncTransfer(
    screen: KitScreen,
    modifier: Modifier = Modifier,
    fraction: Float? = null,
    onRetry: () -> Unit = {},
    catalog: KitCopy = KitCopy.bundled,
    locale: String = kitLocale(),
) {
    if (screen.isHidden || screen.state !in TransferStates) return
    val lines = remember(screen, catalog, locale) { KitLines(screen, catalog, locale) }
    val scheme = MaterialTheme.colorScheme
    val status = PolarisTheme.status
    val label = lines.text("cloudSync.transferring") ?: lines.text("cloudSync.transferFailed")
        ?: listOf("cloudSync.waitingNetwork", "cloudSync.waitingBattery", "cloudSync.waitingBackground").firstNotNullOfOrNull(lines::text).orEmpty()
    // The label comes first, its figures after it.
    val figures = lines.text("cloudSync.transferProgress")
    val (glyph, tint) = when {
        screen.state == "transfer-failed" -> PolarisSymbols.Warning to status.danger

        // A connection is the offline glyph; power or the background is information, never a warning.
        screen.state == "waiting" && lines.has("cloudSync.waitingNetwork") -> PolarisGnome.networkOffline to scheme.onSurfaceVariant

        screen.state == "waiting" -> PolarisSymbols.Info to scheme.onSurfaceVariant

        else -> PolarisSymbols.Refresh to scheme.onSurfaceVariant
    }
    PolarisSection(title = null, modifier = modifier) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = PolarisSpace.medium, vertical = PolarisSpace.controls),
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        ) {
            TransferLine(glyph, tint, label, figures)
            // The bar takes its own full-width row at every size; determinate only with counted bytes.
            // It reports its own range (no description), so the figures are not read twice.
            if (screen.state == "transferring") PolarisProgressBar(fraction, null)
            if (screen.state == "transfer-failed") {
                PolarisTextButton(
                    lines.text("common.tryAgain").orEmpty(),
                    onRetry,
                    // Its label lines up with the status text (the glyph and its gap, less the button's own padding).
                    Modifier.padding(start = PolarisSpace.controls + PolarisSpace.tight),
                )
            }
        }
    }
}

/** The status line: the glyph, then the label (the only live region) and its figures. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TransferLine(glyph: ImageVector, tint: Color, label: String, figures: String?) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        val line = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toDp() }
        Icon(
            glyph,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.padding(top = ((line - StripGlyph) / 2).coerceAtLeast(0.dp)).size(StripGlyph),
        )
        Spacer(Modifier.width(PolarisSpace.controls))
        // Only the label is a live region: a state change is announced once, byte updates are not.
        FlowRow(Modifier.weight(1f)) {
            // The separator ends the label's run, so wrapped figures never start with it; the label is read clean.
            Text(
                if (figures != null) "$label · " else label,
                style = MaterialTheme.typography.bodyLarge,
                color = scheme.onSurface,
                modifier = if (figures != null) {
                    Modifier.clearAndSetSemantics {
                        contentDescription = label
                        liveRegion = LiveRegionMode.Polite
                    }
                } else {
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                },
            )
            if (figures != null) {
                Text(figures, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
            }
        }
    }
}
