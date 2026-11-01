// Background Cloud Sync transfers on Android (U-41.3, U-41.4). :platform is standalone, so it knows nothing of
// the SDK: it schedules and keeps the process alive, and a [SyncTransferRunner] the app installs does the
// transfer. Two schedulers, one rule for each:
//
//   user-started (a save the person tapped), Android 14+   a user-initiated data transfer job (UIDT): [SyncTransferJob]
//                                                           with its notification, running at once and not
//                                                           deferred for battery;
//   everything else, and Android 13 and older              WorkManager: [SyncTransferWorker], on a network and
//                                                           not-low-battery constraint.
//
// Both are unique per transfer id, so a second enqueue of the same transfer never starts a second run.
//
// Tokens. Nothing a scheduler stores can carry a bearer token: the work's input data and the job's extras hold the
// transfer id and an opaque owner tag, nothing else, and [enqueue] refuses a value that looks like a credential. The
// runner asks the SDK for a fresh token at run time, per request, from the SDK's own store. Expiry is the SDK's:
// a token the SDK cannot refresh yet is [SyncTransferOutcome.RETRY] (WorkManager backs off, the job hands over to
// WorkManager); a refresh the server refuses, a sign-out, another person or a transfer the person cancelled is
// [SyncTransferOutcome.STOP], which ends the work for good.
//
// Sign-out and forget, in this order: the SDK takes its lock, then calls [cancelOwner] (the owner's scheduled work
// and jobs, then their spooled files), then removes the pin. Cancel always wins: [cancel] removes the work, and a
// run that still starts afterwards finds no entry in the SDK's queue and answers STOP.
package im.plrs.key.platform.transfer

import android.annotation.SuppressLint
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.annotation.RequiresApi
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** What one run of a transfer came to. */
public enum class SyncTransferOutcome {
    /** The transfer finished (or has nothing left to do). */
    DONE,

    /** Not now: no network, a token the SDK cannot refresh yet, a server that asked to wait. Run again later. */
    RETRY,

    /** Never run again: cancelled, failed for good, signed out, another person, or a root that changed. */
    STOP,
}

/** The app's side: installed once per process, in `Application.onCreate`, before any work can start. */
public fun interface SyncTransferRunner {
    /**
     * Run [transferId] for [owner] to its end or to the next stop. Look the transfer up in the SDK's own queue: an
     * entry that is gone, paused, or bound to another person or another root is [SyncTransferOutcome.STOP].
     * Cancellation of the coroutine means the system stopped the run; keep the journal and let it resume.
     */
    public suspend fun run(transferId: String, owner: String): SyncTransferOutcome
}

/** Which scheduler took a transfer. */
public enum class SyncTransferRoute { USER_INITIATED_JOB, WORK }

public object SyncTransfers {
    internal const val KEY_TRANSFER: String = "t"
    internal const val KEY_OWNER: String = "o"
    private const val BACKOFF_SECONDS = 30L
    internal const val MAX_RUN_ATTEMPTS: Int = 10
    private const val UPSIDE_DOWN_CAKE = 34

    @Volatile private var runner: SyncTransferRunner? = null

    @Volatile private var notifier: SyncTransferNotifier = SyncTransferNotifier.Default

    /** Install the runner. A later call replaces it. */
    public fun install(runner: SyncTransferRunner) {
        this.runner = runner
    }

    /** Replace the user-initiated job's notification (its text must not carry a save name). */
    public fun notifier(n: SyncTransferNotifier) {
        notifier = n
    }

    internal fun runner(): SyncTransferRunner? = runner

    /** For tests: no runner installed. */
    internal fun uninstall() {
        runner = null
    }

    internal fun notifier(): SyncTransferNotifier = notifier

    /**
     * Schedule [transferId] for [owner]. [userInitiated] is for a transfer the person just started and can see: on
     * Android 14+ it runs as a user-initiated job, and when the system will not take that job (or on older Android)
     * it falls back to WorkManager. Anything else goes to WorkManager. Scheduling twice is one run.
     */
    public fun enqueue(context: Context, transferId: String, owner: String, userInitiated: Boolean = false): SyncTransferRoute {
        require(TransferIds.valid(transferId, owner)) { "transfer id or owner is not an opaque id" }
        if (userInitiated && Build.VERSION.SDK_INT >= UPSIDE_DOWN_CAKE && UserInitiatedJobs.schedule(context, transferId, owner)) {
            return SyncTransferRoute.USER_INITIATED_JOB
        }
        enqueueWork(context, transferId, owner)
        return SyncTransferRoute.WORK
    }

    /** WorkManager only: what a stopped job and a relaunch use. KEEP: a run already queued or running stays. */
    public fun enqueueWork(context: Context, transferId: String, owner: String) {
        TransferIds.requireId(transferId)
        TransferIds.requireOwner(owner)
        val input = Data.Builder().putString(KEY_TRANSFER, transferId).putString(KEY_OWNER, owner).build()
        val request = OneTimeWorkRequest.Builder(SyncTransferWorker::class.java)
            .setInputData(input)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .addTag(TransferIds.ownerTag(owner))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(TransferIds.uniqueName(transferId), ExistingWorkPolicy.KEEP, request)
    }

    /** Remove [transferId] from both schedulers. Wins over any enqueue that has not started running. */
    public fun cancel(context: Context, transferId: String) {
        TransferIds.requireId(transferId)
        WorkManager.getInstance(context).cancelUniqueWork(TransferIds.uniqueName(transferId))
        if (Build.VERSION.SDK_INT >= UPSIDE_DOWN_CAKE) UserInitiatedJobs.cancel(context) { it.getString(KEY_TRANSFER) == transferId }
    }

    /**
     * Sign-out and forget (call off the main thread): remove everything scheduled for [owner] from both schedulers,
     * wait until WorkManager has stopped it, then delete the owner's spooled files. The caller holds the SDK's lock
     * first and removes the pin after this returns.
     */
    public fun cancelOwner(context: Context, owner: String) {
        TransferIds.requireOwner(owner)
        WorkManager.getInstance(context).cancelAllWorkByTag(TransferIds.ownerTag(owner)).result.get()
        if (Build.VERSION.SDK_INT >= UPSIDE_DOWN_CAKE) UserInitiatedJobs.cancel(context) { it.getString(KEY_OWNER) == owner }
        SyncSpool.purge(context, owner)
    }
}

/** The user-initiated jobs, in their own JobScheduler namespace so their ids never meet the app's or WorkManager's. */
internal object UserInitiatedJobs {
    const val NAMESPACE: String = "pkey.sync"
    private const val UPSIDE_DOWN_CAKE = 34

    // RUN_USER_INITIATED_JOBS is the app's to declare (no permission in the AAR); a refusal is caught below and the
    // transfer then runs as a WorkManager job. Lint cannot see that for a normal permission.
    @SuppressLint("MissingPermission")
    @RequiresApi(UPSIDE_DOWN_CAKE)
    @Suppress("SwallowedException")
    fun schedule(context: Context, transferId: String, owner: String): Boolean {
        val scheduler = namespaced(context)
        val extras = PersistableBundle().apply {
            putString(SyncTransfers.KEY_TRANSFER, transferId)
            putString(SyncTransfers.KEY_OWNER, owner)
        }
        val info = JobInfo.Builder(TransferIds.jobId(transferId), ComponentName(context, SyncTransferJob::class.java))
            .setUserInitiated(true)
            // A user-initiated job must name a network; it is not deferred for battery or idle.
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setExtras(extras)
            .build()
        // One job per transfer: an identical id is replaced, which is the same transfer.
        return try {
            scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS
        } catch (e: SecurityException) {
            false
        }
    }

    @RequiresApi(UPSIDE_DOWN_CAKE)
    fun cancel(context: Context, match: (PersistableBundle) -> Boolean) {
        val scheduler = namespaced(context)
        for (job in scheduler.pending()) if (match(job.extras)) scheduler.cancel(job.id)
    }

    @RequiresApi(UPSIDE_DOWN_CAKE)
    private fun namespaced(context: Context): JobPort = jobPort(context)

    /** The jobs of our namespace. Robolectric does not model namespaces, so the tests replace this. */
    internal var jobPort: (Context) -> JobPort = { context -> platformPort(context) }

    @SuppressLint("NewApi") // Only reached from the API 34 paths above.
    private fun platformPort(context: Context): JobPort {
        val scheduler = context.getSystemService(JobScheduler::class.java).forNamespace(NAMESPACE)
        return object : JobPort {
            override fun schedule(info: JobInfo): Int = scheduler.schedule(info)

            override fun cancel(id: Int) = scheduler.cancel(id)

            override fun pending(): List<JobInfo> = scheduler.allPendingJobs
        }
    }
}

internal interface JobPort {
    fun schedule(info: JobInfo): Int

    fun cancel(id: Int)

    fun pending(): List<JobInfo>
}

/** The user-initiated job's notification; it never names a save or a file. */
public fun interface SyncTransferNotifier {
    public fun build(context: Context): android.app.Notification

    public companion object {
        // Only the API 34 job asks for it, so the API 26 calls are safe.
        @SuppressLint("NewApi")
        internal val Default: SyncTransferNotifier = SyncTransferNotifier { context ->
            val manager = context.getSystemService(android.app.NotificationManager::class.java)
            manager.createNotificationChannel(
                android.app.NotificationChannel(CHANNEL, "Sync", android.app.NotificationManager.IMPORTANCE_LOW),
            )
            android.app.Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Syncing")
                .setOngoing(true)
                .build()
        }
        internal const val CHANNEL: String = "pkey_sync_transfer"
    }
}

/** Where a transfer's spooled copies live: app-private, excluded from backup, one directory per owner. */
public object SyncSpool {
    /** `noBackupFilesDir` is credential-encrypted storage (readable after the first unlock) and never backed up. */
    public fun dir(context: Context, owner: String): File {
        TransferIds.requireOwner(owner)
        return File(File(context.noBackupFilesDir, "pkey-sync-spool"), owner).also { it.mkdirs() }
    }

    /** Delete every spooled file of [owner]. */
    public fun purge(context: Context, owner: String) {
        TransferIds.requireOwner(owner)
        File(File(context.noBackupFilesDir, "pkey-sync-spool"), owner).deleteRecursively()
    }
}

/** Names and checks for what the schedulers store: opaque ids only, never a credential. */
internal object TransferIds {
    private const val UNIQUE_PREFIX = "pkey.sync.transfer."
    private const val OWNER_TAG_PREFIX = "pkey.sync.owner."
    private const val ID_MAX = 256
    private const val OWNER_LEN = 64
    private const val FIRST_PRINTABLE = 0x21
    private const val LAST_PRINTABLE = 0x7e
    private const val BYTE_MASK = 0xff
    private const val BITS_PER_BYTE = 8
    private const val JOB_ID_BYTES = 4
    private val CREDENTIAL_SHAPE = Regex("^pkey[a-z]*_|^eyJ|^Bearer", RegexOption.IGNORE_CASE)

    fun ownerTag(owner: String): String = OWNER_TAG_PREFIX + sha256Hex(owner)

    fun uniqueName(transferId: String): String = UNIQUE_PREFIX + sha256Hex(transferId)

    /** A job id in the namespace: collisions only replace a job of the same namespace, i.e. ours. */
    fun jobId(transferId: String): Int {
        val d = MessageDigest.getInstance("SHA-256").digest(transferId.toByteArray(Charsets.UTF_8))
        return d.take(JOB_ID_BYTES).fold(0) { acc, b -> (acc shl BITS_PER_BYTE) or (b.toInt() and BYTE_MASK) } and Int.MAX_VALUE
    }

    fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** A bounded printable string that is no token shape. */
    fun requireId(id: String) {
        require(id.isNotEmpty() && id.length <= ID_MAX && id.all { it.code in FIRST_PRINTABLE..LAST_PRINTABLE }) {
            "transfer id is not an opaque id"
        }
        require(!CREDENTIAL_SHAPE.containsMatchIn(id)) { "transfer id looks like a credential" }
    }

    fun requireOwner(owner: String) {
        require(owner.length == OWNER_LEN && owner.all { it in '0'..'9' || it in 'a'..'f' }) { "owner is not a SHA-256 hex tag" }
    }

    fun valid(id: String?, owner: String?): Boolean = id != null && owner != null && runCatching {
        requireId(id)
        requireOwner(owner)
    }.isSuccess
}
