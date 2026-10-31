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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * The Cloud Sync row and its screens, bound to [host]. With a flow in front only the screens draw; otherwise
 * the row, when Cloud Sync has something to say. [onSignIn] opens the app's own sign-in; null hides the button.
 */
@Composable
public fun PolarisCloudSyncKit(host: PolarisCloudSyncHost, modifier: Modifier = Modifier, onSignIn: (() -> Unit)? = null) {
    DisposableEffect(host) {
        host.start()
        onDispose { host.stop() }
    }
    val flow by host.flow.collectAsState()
    val status by host.status.collectAsState()
    val open = flow
    val shown = status
    if (open != null) {
        PolarisSyncFlow(open, modifier)
    } else if (shown != null) {
        val row = when (shown.row) {
            PolarisCloudSyncRow.Synced -> PolarisCloudSync.Synced
            PolarisCloudSyncRow.Syncing -> PolarisCloudSync.Syncing
            PolarisCloudSyncRow.Offline -> PolarisCloudSync.Offline
            PolarisCloudSyncRow.Error -> PolarisCloudSync.Error
            PolarisCloudSyncRow.SignedOut -> PolarisCloudSync.SignedOut
            PolarisCloudSyncRow.Locked -> PolarisCloudSync.Locked
            PolarisCloudSyncRow.RingChanged -> PolarisCloudSync.RingChanged
        }
        PolarisCloudSyncStatus(
            row,
            modifier,
            syncedAtMillis = shown.syncedAtMillis,
            onUnlock = host::openUnlock,
            onReview = host::openReview,
            onSignIn = onSignIn,
        )
    }
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
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                val line = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toDp() }
                Icon(
                    glyph,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.padding(top = ((line - 20.dp) / 2).coerceAtLeast(0.dp)).size(20.dp),
                )
                Spacer(Modifier.width(PolarisSpace.controls))
                // Only the label is a live region: a state change is announced once, byte updates are not.
                FlowRow(Modifier.weight(1f)) {
                    Text(
                        label,
                        style = MaterialTheme.typography.bodyLarge,
                        color = scheme.onSurface,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    if (figures != null) {
                        Text(" · $figures", style = MaterialTheme.typography.bodyLarge, color = scheme.onSurface)
                    }
                }
            }
            // The bar takes its own full-width row at every size; determinate only with counted bytes.
            // It reports its own range (no description), so the figures are not read twice.
            if (screen.state == "transferring") PolarisProgressBar(fraction, null)
            if (screen.state == "transfer-failed") PolarisTextButton(lines.text("common.tryAgain").orEmpty(), onRetry)
        }
    }
}
