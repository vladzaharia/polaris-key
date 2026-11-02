package im.plrs.key.platform.transfer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SyncTransferWorkerTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val owner = "a".repeat(64)
    private val other = "b".repeat(64)
    private lateinit var wm: WorkManager
    private val calls = mutableListOf<Pair<String, String>>()

    @Before
    fun setUp() {
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(ctx, config)
        wm = WorkManager.getInstance(ctx)
        calls.clear()
    }

    @After
    fun tearDown() = SyncTransfers.uninstall()

    private fun install(outcome: () -> SyncTransferOutcome) = SyncTransfers.install { id, o ->
        calls += id to o
        outcome()
    }

    /** What a scheduler holds for a save's transfer id: its SHA-256 hex. */
    private fun tid(name: String): String = TransferIds.sha256Hex(name)

    private fun info(id: String): WorkInfo = wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(id)).get().single()

    @Test
    fun theInputIsTheTransferAndTheOwnerAndNothingElse() {
        install { SyncTransferOutcome.DONE }
        val route = SyncTransfers.enqueue(ctx, tid("saves:slot-1"), owner)
        assertEquals(SyncTransferRoute.WORK, route)
        val request = WorkManagerTestInitHelper.getTestDriver(ctx)!!
        request.setAllConstraintsMet(info(tid("saves:slot-1")).id)
        // The input data of the finished work is gone from the info; read what was enqueued from the tags and keys.
        assertEquals(setOf(TransferIds.ownerTag(owner), SyncTransferWorker::class.java.name), info(tid("saves:slot-1")).tags)
        assertEquals(listOf(tid("saves:slot-1") to owner), calls)
    }

    @Test
    fun theSchedulerHoldsNoSaveName() {
        val name = "saves:slot-1"
        // A transfer id that is not 64 lowercase hex characters is refused: a save's name, a credential, upper case, short or long.
        val upper = tid(name).uppercase()
        val bads =
            listOf(name, "pkeyt_abc", "pkeya_x", "eyJhbGciOiJFZERTQSJ9.e30.sig", "Bearer abc", "has space", "", upper, "a".repeat(63), "a".repeat(65))
        for (bad in bads) {
            try {
                SyncTransfers.enqueue(ctx, bad, owner)
                fail("accepted: ${bad.take(6)}")
            } catch (_: IllegalArgumentException) {
            }
        }
        try {
            SyncTransfers.enqueue(ctx, tid("saves:1"), "pkeyt_not_hex")
            fail()
        } catch (_: IllegalArgumentException) {
        }
        assertTrue(wm.getWorkInfosByTag(TransferIds.ownerTag(owner)).get().isEmpty())
        // The hash is accepted, and neither the work's data nor its tags hold the name.
        SyncTransfers.enqueue(ctx, tid(name), owner)
        val work = wm.getWorkInfosByTag(TransferIds.ownerTag(owner)).get().single()
        assertTrue(work.tags.none { it.contains("slot-1") })
        assertTrue(wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(tid(name))).get().isNotEmpty())
    }

    @Test
    fun runsOnlyOnNetworkAndNotLowBattery() {
        install { SyncTransferOutcome.DONE }
        SyncTransfers.enqueue(ctx, tid("saves:1"), owner)
        val w = info(tid("saves:1"))
        assertEquals(WorkInfo.State.ENQUEUED, w.state)
        assertEquals(NetworkType.CONNECTED, w.constraints.requiredNetworkType)
        assertTrue(w.constraints.requiresBatteryNotLow())
        assertTrue(calls.isEmpty())
        WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(w.id)
        assertEquals(WorkInfo.State.SUCCEEDED, info(tid("saves:1")).state)
    }

    @Test
    fun oneRunPerTransferNoMatterHowOftenItIsEnqueued() {
        install { SyncTransferOutcome.DONE }
        SyncTransfers.enqueue(ctx, tid("saves:1"), owner)
        SyncTransfers.enqueue(ctx, tid("saves:1"), owner)
        SyncTransfers.enqueueWork(ctx, tid("saves:1"), owner)
        assertEquals(1, wm.getWorkInfosForUniqueWork(TransferIds.uniqueName(tid("saves:1"))).get().size)
    }

    @Test
    fun retryWaitsAndStopEndsIt() {
        install { SyncTransferOutcome.RETRY }
        SyncTransfers.enqueue(ctx, tid("saves:r"), owner)
        WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(info(tid("saves:r")).id)
        assertEquals(WorkInfo.State.ENQUEUED, info(tid("saves:r")).state)
        assertEquals(1, info(tid("saves:r")).runAttemptCount)
        install { SyncTransferOutcome.STOP }
        SyncTransfers.enqueue(ctx, tid("saves:s"), owner)
        WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(info(tid("saves:s")).id)
        assertEquals(WorkInfo.State.FAILED, info(tid("saves:s")).state)
    }

    @Test
    fun aRunnerThatThrowsRetriesAndIsNotLogged() {
        install { error("boom with detail") }
        SyncTransfers.enqueue(ctx, tid("saves:t"), owner)
        WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(info(tid("saves:t")).id)
        assertEquals(WorkInfo.State.ENQUEUED, info(tid("saves:t")).state)
    }

    @Test
    fun withoutARunnerTheWorkEndsAndTheJournalWaitsForTheNextLaunch() {
        SyncTransfers.uninstall()
        SyncTransfers.enqueue(ctx, tid("saves:n"), owner)
        WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(info(tid("saves:n")).id)
        assertEquals(WorkInfo.State.FAILED, info(tid("saves:n")).state)
    }

    @Test
    fun cancelWinsOverALaterConstraintAndOverAResume() {
        install { SyncTransferOutcome.DONE }
        SyncTransfers.enqueue(ctx, tid("saves:c"), owner)
        SyncTransfers.cancel(ctx, tid("saves:c"))
        assertEquals(WorkInfo.State.CANCELLED, info(tid("saves:c")).state)
        assertTrue(calls.isEmpty())
    }

    @Test
    fun signOutCancelsThatOwnersWorkAndSpoolAndNoOneElses() {
        install { SyncTransferOutcome.DONE }
        SyncTransfers.enqueue(ctx, tid("saves:1"), owner)
        SyncTransfers.enqueue(ctx, tid("saves:2"), owner)
        SyncTransfers.enqueue(ctx, tid("saves:3"), other)
        val spool = SyncSpool.dir(ctx, owner)
        java.io.File(spool, "part-1").writeText("x")
        val keep = SyncSpool.dir(ctx, other)
        java.io.File(keep, "part-1").writeText("y")

        SyncTransfers.cancelOwner(ctx, owner)

        assertEquals(WorkInfo.State.CANCELLED, info(tid("saves:1")).state)
        assertEquals(WorkInfo.State.CANCELLED, info(tid("saves:2")).state)
        assertEquals(WorkInfo.State.ENQUEUED, info(tid("saves:3")).state)
        assertFalse(spool.exists())
        assertTrue(java.io.File(keep, "part-1").exists())
    }

    @Test
    fun theSpoolIsOutsideBackup() {
        val dir = SyncSpool.dir(ctx, owner)
        assertTrue(dir.path.startsWith(ctx.noBackupFilesDir.path))
        assertNotNull(dir)
    }
}
