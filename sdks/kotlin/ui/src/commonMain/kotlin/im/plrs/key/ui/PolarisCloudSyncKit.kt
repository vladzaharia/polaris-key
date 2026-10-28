// @pkey-feature ui.kit
// The Cloud Sync kit host's Compose side (U-42.4T, Q-7): the status row drawn from a
// [PolarisCloudSyncHost], and the unlock, ring-change and recovery-code screens in its place while a flow is up.
package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier

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
