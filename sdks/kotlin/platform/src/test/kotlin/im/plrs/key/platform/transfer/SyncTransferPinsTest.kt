// The controls of the Android background-transfer schedulers that hold in code and are pinned here: what the work's
// input holds, the worker refusing input it did not write, the retry cap, the neutral notification, the user-initiated
// jobs' own namespace, and sign-out waiting for the owner's work to stop.
package im.plrs.key.platform.transfer

import android.app.Notification
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.content.Context
import android.os.PersistableBundle
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.concurrent.Executor
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
class SyncTransferPinsTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val owner = "a".repeat(64)
    private lateinit var wm: WorkManager
    private val ran = mutableListOf<String>()
    private val jobs = mutableMapOf<Int, JobInfo>()
    private val real = UserInitiatedJobs.jobPort

    private fun tid(name: String): String = TransferIds.sha256Hex(name)

    private fun startWorkManager(executor: Executor) {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            ctx,
            Configuration.Builder().setExecutor(executor).setTaskExecutor(executor).build(),
        )
        wm = WorkManager.getInstance(ctx)
    }

    @Before
    fun setUp() {
        startWorkManager(SynchronousExecutor())
        ran.clear()
        jobs.clear()
        SyncTransfers.install { id, _ ->
            ran += id
            SyncTransferOutcome.DONE
        }
        UserInitiatedJobs.jobPort = {
            object : JobPort {
                override fun schedule(info: JobInfo): Int {
                    jobs[info.id] = info
                    return JobScheduler.RESULT_SUCCESS
                }

                override fun cancel(id: Int) {
                    jobs.remove(id)
                }

                override fun pending(): List<JobInfo> = jobs.values.toList()
            }
        }
    }

    @After
    fun tearDown() {
        SyncTransfers.uninstall()
        UserInitiatedJobs.jobPort = real
    }

    private fun spec(id: String): WorkInfo = wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(id)).get().single()

    @Test
    fun workInputIsTransferAndOwnerOnly() {
        val id = tid("saves:slot-1")
        SyncTransfers.enqueue(ctx, id, owner)
        // The work's stored input, read from the work database (the tags are not the input).
        val db = wm.javaClass.getMethod("getWorkDatabase").invoke(wm)
        val dao = db.javaClass.getMethod("workSpecDao").invoke(db)
        val workSpec = dao.javaClass.getMethod("getWorkSpec", String::class.java).invoke(dao, spec(id).id.toString())
        val input = workSpec.javaClass.getField("input").get(workSpec) as Data
        assertEquals(setOf(SyncTransfers.KEY_TRANSFER, SyncTransfers.KEY_OWNER), input.keyValueMap.keys)
        assertEquals(id, input.getString(SyncTransfers.KEY_TRANSFER))
        assertEquals(owner, input.getString(SyncTransfers.KEY_OWNER))
    }

    @Test
    fun theWorkerRefusesTamperedInput() = runBlocking {
        for ((t, o) in listOf("pkeyt_secret" to owner, tid("ok") to "nothex", "Bearer abc" to owner, "saves:slot-1" to owner)) {
            val worker = TestListenableWorkerBuilder<SyncTransferWorker>(ctx)
                .setInputData(Data.Builder().putString(SyncTransfers.KEY_TRANSFER, t).putString(SyncTransfers.KEY_OWNER, o).build())
                .build()
            assertTrue(worker.doWork() is ListenableWorker.Result.Failure)
        }
        val missing = TestListenableWorkerBuilder<SyncTransferWorker>(ctx)
            .setInputData(Data.Builder().putString(SyncTransfers.KEY_TRANSFER, tid("ok")).build())
            .build()
        assertTrue(missing.doWork() is ListenableWorker.Result.Failure)
        assertTrue("the runner was never asked", ran.isEmpty())
    }

    @Test
    fun retryIsBoundedAtTen() = runBlocking {
        SyncTransfers.install { _, _ -> SyncTransferOutcome.RETRY }

        fun attempt(n: Int) = TestListenableWorkerBuilder<SyncTransferWorker>(ctx)
            .setInputData(Data.Builder().putString(SyncTransfers.KEY_TRANSFER, tid("ok")).putString(SyncTransfers.KEY_OWNER, owner).build())
            .setRunAttemptCount(n)
            .build()
        assertTrue(attempt(8).doWork() is ListenableWorker.Result.Retry)
        assertTrue("the tenth run is the last", attempt(9).doWork() is ListenableWorker.Result.Failure)
    }

    @Test
    @Config(sdk = [34])
    fun theNotificationIsNeutral() {
        val n: Notification = SyncTransferNotifier.Default.build(ctx)
        assertEquals("Syncing", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(null, n.extras.getCharSequence(Notification.EXTRA_TEXT))
        assertTrue(n.flags and Notification.FLAG_ONGOING_EVENT != 0)
    }

    @Test
    @Config(sdk = [34])
    fun userInitiatedJobsUseTheirOwnNamespace() {
        assertEquals("pkey.sync", UserInitiatedJobs.NAMESPACE)
        val id = tid("saves:1")
        assertEquals(SyncTransferRoute.USER_INITIATED_JOB, SyncTransfers.enqueue(ctx, id, owner, userInitiated = true))
        assertEquals(TransferIds.jobId(id), jobs.keys.single())
        // A job the system refuses runs as WorkManager work instead.
        UserInitiatedJobs.jobPort = {
            object : JobPort {
                override fun schedule(info: JobInfo): Int = JobScheduler.RESULT_FAILURE

                override fun cancel(id: Int) = Unit

                override fun pending(): List<JobInfo> = emptyList()
            }
        }
        val other = tid("saves:2")
        assertEquals(SyncTransferRoute.WORK, SyncTransfers.enqueue(ctx, other, owner, userInitiated = true))
        assertEquals(1, wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(other)).get().size)
    }

    @Test
    @Config(sdk = [34])
    fun aJobWithoutARunnerDoesNotStart() {
        SyncTransfers.uninstall()
        val service = Robolectric.buildService(SyncTransferJob::class.java).create().get()
        val extras = PersistableBundle().apply {
            putString(SyncTransfers.KEY_TRANSFER, tid("ok"))
            putString(SyncTransfers.KEY_OWNER, owner)
        }
        val params = ReflectionHelpers.callConstructor(JobParameters::class.java)
        ReflectionHelpers.setField(params, "jobId", 1)
        ReflectionHelpers.setField(params, "extras", extras)
        assertFalse(service.onStartJob(params))
    }

    @Test
    fun cancelOwnerReturnsOnlyOnceTheOwnersWorkIsCancelled() {
        // One thread that is slow to run anything, so a cancel that is not waited for returns first.
        val slow = Executors.newSingleThreadExecutor()
        val delaying = Executor { task ->
            slow.execute {
                Thread.sleep(SLOW_MS)
                task.run()
            }
        }
        try {
            startWorkManager(delaying)
            val id = tid("saves:c")
            SyncTransfers.enqueue(ctx, id, owner)
            val began = System.nanoTime()
            SyncTransfers.cancelOwner(ctx, owner)
            val tookMs = (System.nanoTime() - began) / NANOS_PER_MS
            assertTrue("cancelOwner returned after ${tookMs}ms, before the cancel had run", tookMs >= SLOW_MS)
            assertEquals(WorkInfo.State.CANCELLED, spec(id).state)
        } finally {
            slow.shutdownNow()
        }
    }

    private companion object {
        const val SLOW_MS = 300L
        const val NANOS_PER_MS = 1_000_000L
    }
}
