package im.plrs.key.platform.transfer

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.content.Context
import android.os.PersistableBundle
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
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

@RunWith(RobolectricTestRunner::class)
class SyncTransferJobTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val owner = "c".repeat(64)
    private lateinit var wm: WorkManager

    @Before
    fun setUp() {
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(ctx, config)
        wm = WorkManager.getInstance(ctx)
        SyncTransfers.install { _, _ -> SyncTransferOutcome.DONE }
        jobs.clear()
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

    private val jobs = mutableMapOf<Int, JobInfo>()
    private val real = UserInitiatedJobs.jobPort

    @After
    fun tearDown() {
        SyncTransfers.uninstall()
        UserInitiatedJobs.jobPort = real
    }

    private fun pending(): List<JobInfo> = jobs.values.toList()

    /** What a scheduler holds for a save's transfer id: its SHA-256 hex. */
    private fun tid(name: String): String = TransferIds.sha256Hex(name)

    private fun works(id: String): List<WorkInfo> = wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(id)).get()

    @Test
    @Config(sdk = [34])
    fun aUserStartedSaveOnAndroid14IsAUserInitiatedJob() {
        val route = SyncTransfers.enqueue(ctx, tid("saves:1"), owner, userInitiated = true)
        assertEquals(SyncTransferRoute.USER_INITIATED_JOB, route)
        val job = pending().single()
        assertTrue(job.isUserInitiated)
        assertEquals(JobInfo.NETWORK_TYPE_ANY, job.networkType)
        assertEquals("im.plrs.key.platform.transfer.SyncTransferJob", job.service.className)
        // Extras: the transfer and the owner, nothing else.
        assertEquals(setOf(SyncTransfers.KEY_TRANSFER, SyncTransfers.KEY_OWNER), job.extras.keySet())
        // The transfer in them is the hash of the save's transfer id, never the id (which names the save).
        assertEquals(tid("saves:1"), job.extras.getString(SyncTransfers.KEY_TRANSFER))
        assertFalse(job.extras.getString(SyncTransfers.KEY_TRANSFER)!!.contains("saves"))
        assertTrue(works(tid("saves:1")).isEmpty())
    }

    @Test
    @Config(sdk = [34])
    fun everythingElseGoesToWorkManager() {
        assertEquals(SyncTransferRoute.WORK, SyncTransfers.enqueue(ctx, tid("saves:2"), owner))
        assertTrue(pending().isEmpty())
        assertEquals(1, works(tid("saves:2")).size)
    }

    @Test
    @Config(sdk = [33])
    fun beforeAndroid14AUserStartedSaveUsesWorkManager() {
        assertEquals(SyncTransferRoute.WORK, SyncTransfers.enqueue(ctx, tid("saves:3"), owner, userInitiated = true))
        assertEquals(1, works(tid("saves:3")).size)
    }

    @Test
    @Config(sdk = [34])
    fun cancelAndSignOutRemoveTheJobsToo() {
        SyncTransfers.enqueue(ctx, tid("saves:1"), owner, userInitiated = true)
        SyncTransfers.enqueue(ctx, tid("saves:2"), owner, userInitiated = true)
        SyncTransfers.enqueue(ctx, tid("saves:3"), "d".repeat(64), userInitiated = true)
        SyncTransfers.cancel(ctx, tid("saves:1"))
        assertEquals(2, pending().size)
        SyncTransfers.cancelOwner(ctx, owner)
        val left = pending().single()
        assertEquals(tid("saves:3"), left.extras.getString(SyncTransfers.KEY_TRANSFER))
    }

    @Test
    @Config(sdk = [34])
    fun theManifestDeclaresTheJobAndNoPermission() {
        val pm = ctx.packageManager
        val info = pm.getPackageInfo(
            ctx.packageName,
            android.content.pm.PackageManager.GET_SERVICES or android.content.pm.PackageManager.GET_PERMISSIONS,
        )
        val svc = info.services!!.single { it.name == "im.plrs.key.platform.transfer.SyncTransferJob" }
        assertEquals("android.permission.BIND_JOB_SERVICE", svc.permission)
        assertFalse(svc.exported)
        // The library declares no permission: the app (the Godot export plugin) adds RUN_USER_INITIATED_JOBS.
        assertTrue(info.requestedPermissions.orEmpty().none { it == "android.permission.RUN_USER_INITIATED_JOBS" })
    }

    private fun params(job: Int, owner: String?, id: String?, stop: Int = 0): JobParameters {
        val extras = PersistableBundle().apply {
            if (id != null) putString(SyncTransfers.KEY_TRANSFER, id)
            if (owner != null) putString(SyncTransfers.KEY_OWNER, owner)
        }
        val p = ReflectionHelpers.callConstructor(JobParameters::class.java)
        ReflectionHelpers.setField(p, "jobId", job)
        ReflectionHelpers.setField(p, "extras", extras)
        ReflectionHelpers.setField(p, "mStopReason", stop)
        return p
    }

    @Test
    @Config(sdk = [34])
    fun aStopTheSystemChoseHandsTheTransferToWorkManagerAndACancelDoesNot() {
        val svc = Robolectric.buildService(SyncTransferJob::class.java).create().get()
        assertFalse(svc.onStopJob(params(1, owner, tid("saves:9"), JobParameters.STOP_REASON_TIMEOUT)))
        assertEquals(1, works(tid("saves:9")).size)
        assertFalse(svc.onStopJob(params(2, owner, tid("saves:8"), JobParameters.STOP_REASON_CANCELLED_BY_APP)))
        assertTrue(works(tid("saves:8")).isEmpty())
    }

    @Test
    @Config(sdk = [34])
    fun aJobWithoutValidExtrasDoesNotRun() {
        val svc = Robolectric.buildService(SyncTransferJob::class.java).create().get()
        assertFalse(svc.onStartJob(params(3, "not-hex", tid("saves:1"))))
        assertFalse(svc.onStartJob(params(4, owner, null)))
        assertFalse(svc.onStartJob(params(5, owner, "pkeyt_secret")))
    }
}
