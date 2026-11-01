// Background Cloud Sync saves on Android (U-41.7b): the umbrella's end of :platform's SyncTransfers. The SDK keeps the write
// (it fetches its token per request, in this process); this adapter only schedules and ends it. What crosses is a transfer
// id and an owner tag, nothing else: never a token, a key, a file name, WorkManager input beyond those two, or job extras.
//
// On when CloudSyncHostOptions.backgroundTransfers is true (default off). A save write is a person's action, so it is
// scheduled as user-initiated work (a job with its notification on Android 14+, WorkManager otherwise).

package im.plrs.key.android

import android.content.Context
import im.plrs.key.platform.transfer.SyncTransferOutcome
import im.plrs.key.platform.transfer.SyncTransfers
import im.plrs.key.sdk.BackgroundTransferOutcome
import im.plrs.key.sdk.CloudSyncBackgroundPort
import im.plrs.key.sdk.CloudSyncBackgroundRunner

internal class AndroidSyncBackground(
    context: Context,
    private val schedule: (Context, String, String, Boolean) -> Unit = { c, id, owner, user ->
        SyncTransfers.enqueue(c, id, owner, user)
    },
) : CloudSyncBackgroundPort {
    private val ctx: Context = context.applicationContext

    override fun attach(runner: CloudSyncBackgroundRunner) {
        SyncTransfers.install { id, owner ->
            when (runner.run(id, owner)) {
                BackgroundTransferOutcome.DONE -> SyncTransferOutcome.DONE
                BackgroundTransferOutcome.RETRY -> SyncTransferOutcome.RETRY
                BackgroundTransferOutcome.STOP -> SyncTransferOutcome.STOP
            }
        }
    }

    override fun enqueue(transferId: String, owner: String) = schedule(ctx, transferId, owner, true)

    override fun cancel(transferId: String) = SyncTransfers.cancel(ctx, transferId)

    override fun cancelOwner(owner: String) = SyncTransfers.cancelOwner(ctx, owner)
}
