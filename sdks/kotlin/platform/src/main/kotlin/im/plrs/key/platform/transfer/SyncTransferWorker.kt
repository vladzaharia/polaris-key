// The WorkManager side of a background transfer (U-41.3). Input data is the transfer id and the owner tag, never a
// token: the runner gets a fresh one from the SDK at run time.
package im.plrs.key.platform.transfer

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException

public class SyncTransferWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString(SyncTransfers.KEY_TRANSFER)
        val owner = inputData.getString(SyncTransfers.KEY_OWNER)
        // Input a scheduler of ours never writes ends the work, and so does no runner installed (the process started
        // for this work alone): the journal is on disk and the app's next launch enqueues it again.
        val runner = SyncTransfers.runner()
        return if (id == null || owner == null || runner == null) Result.failure() else outcome(runner, id, owner)
    }

    private suspend fun outcome(runner: SyncTransferRunner, id: String, owner: String): Result {
        if (!TransferIds.valid(id, owner)) return Result.failure()
        val outcome = try {
            runner.run(id, owner)
        } catch (e: CancellationException) {
            // The system (or a cancel) stopped the run: WorkManager decides whether it runs again.
            throw e
        } catch (
            @Suppress("TooGenericExceptionCaught", "SwallowedException") e: Exception,
        ) {
            // A runner that threw has not said STOP; try again later, up to the cap. Nothing of it is logged.
            SyncTransferOutcome.RETRY
        }
        return when (outcome) {
            SyncTransferOutcome.DONE -> Result.success()

            SyncTransferOutcome.STOP -> Result.failure()

            SyncTransferOutcome.RETRY ->
                if (runAttemptCount + 1 >= SyncTransfers.MAX_RUN_ATTEMPTS) Result.failure() else Result.retry()
        }
    }
}
