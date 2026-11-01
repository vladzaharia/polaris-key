// The user-initiated data transfer side (U-41.4; Android 14+): a transfer the person just started runs at once, with
// a notification, instead of waiting on WorkManager's constraints. Extras hold the transfer id and the owner tag only.
//
// If the system stops the job (its time ran out, the network went, the person dismissed the notification), the
// transfer is handed to WorkManager and resumes from the journal; a stop because the app cancelled it is final.
package im.plrs.key.platform.transfer

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public class SyncTransferJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = ConcurrentHashMap<Int, Job>()

    private class Target(val id: String, val owner: String, val runner: SyncTransferRunner)

    private fun ids(params: JobParameters): Pair<String, String>? {
        val id = params.extras.getString(SyncTransfers.KEY_TRANSFER)
        val owner = params.extras.getString(SyncTransfers.KEY_OWNER)
        return if (id != null && owner != null && TransferIds.valid(id, owner)) id to owner else null
    }

    private fun target(params: JobParameters): Target? {
        val runner = SyncTransfers.runner()
        return ids(params)?.let { (id, owner) -> runner?.let { Target(id, owner, it) } }
    }

    override fun onStartJob(params: JobParameters): Boolean {
        val t = target(params)
        if (t != null) {
            setNotification(params, NOTIFICATION_ID, SyncTransfers.notifier().build(this), JOB_END_NOTIFICATION_POLICY_DETACH)
            running[params.jobId] = scope.launch { run(params, t.runner, t.id, t.owner) }
        }
        return t != null
    }

    private suspend fun run(params: JobParameters, runner: SyncTransferRunner, id: String, owner: String) {
        val outcome = try {
            runner.run(id, owner)
        } catch (e: CancellationException) {
            throw e
        } catch (
            @Suppress("TooGenericExceptionCaught", "SwallowedException") e: Exception,
        ) {
            SyncTransferOutcome.RETRY
        }
        running.remove(params.jobId)
        // A transfer that is not finished goes on in WorkManager (network and battery constraints, with backoff).
        if (outcome == SyncTransferOutcome.RETRY) SyncTransfers.enqueueWork(applicationContext, id, owner)
        jobFinished(params, false)
    }

    override fun onStopJob(params: JobParameters): Boolean {
        running.remove(params.jobId)?.cancel()
        val cancelledByApp = params.stopReason == JobParameters.STOP_REASON_CANCELLED_BY_APP
        // Cancel wins: only a stop the system chose hands the transfer on, and the runner still refuses a cancelled one.
        if (!cancelledByApp) ids(params)?.let { (id, owner) -> SyncTransfers.enqueueWork(applicationContext, id, owner) }
        return false
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private companion object {
        const val NOTIFICATION_ID = 0x504b
    }
}
