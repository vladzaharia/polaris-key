// @pkey-feature sync.transfer.background
package im.plrs.key.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.sdk.BackgroundTransferOutcome
import im.plrs.key.sdk.CloudSyncBackgroundRunner
import im.plrs.key.sdk.CloudSyncHostOptions
import im.plrs.key.sdk.PolarisKeyClientOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.MessageDigest

/** The umbrella's end of background saves: what is scheduled, what a run answers, and that nothing but ids is stored. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SyncTransferBindingTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val owner = sha("ps_Alice")
    private lateinit var wm: WorkManager
    private val runs = mutableListOf<Pair<String, String>>()

    @Before
    fun setUp() {
        val executor = SynchronousExecutor()
        val config = Configuration.Builder().setExecutor(executor).setTaskExecutor(executor).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(ctx, config)
        wm = WorkManager.getInstance(ctx)
        runs.clear()
    }

    private fun sha(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun ownerTag(): String = "pkey.sync.owner." + sha(owner)

    private fun attach(b: AndroidSyncBackground, outcome: BackgroundTransferOutcome) {
        val runner = CloudSyncBackgroundRunner { id, o ->
            runs += id to o
            outcome
        }
        b.attach(runner)
    }

    @Test
    fun aWriteIsScheduledAsUserInitiatedWorkWithIdsOnly() {
        val seen = mutableListOf<List<Any>>()
        val b = AndroidSyncBackground(ctx) { _, id, o, user -> seen += listOf(id, o, user) }
        val hash = sha("saves:slot-1")
        b.enqueue(hash, owner)
        assertEquals(listOf(listOf<Any>(hash, owner, true)), seen)
        assertEquals(64, (seen.single()[0] as String).length)
        // The scheduler refuses the save's own transfer id: only its hash may be scheduled.
        try {
            AndroidSyncBackground(ctx).enqueue("saves:slot-1", owner)
            fail("the scheduler took a save's name")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun aRunAsksTheSdkAndAnswersWhatItSaid() {
        val expected = listOf(
            BackgroundTransferOutcome.DONE to WorkInfo.State.SUCCEEDED,
            BackgroundTransferOutcome.STOP to WorkInfo.State.FAILED,
            BackgroundTransferOutcome.RETRY to WorkInfo.State.ENQUEUED,
        )
        for ((outcome, state) in expected) {
            val b = AndroidSyncBackground(ctx)
            attach(b, outcome)
            runs.clear()
            val id = sha("saves:${outcome.name.lowercase()}")
            b.enqueue(id, owner)
            val unique = "pkey.sync.transfer." + sha(id)
            val info = wm.getWorkInfosForUniqueWork(unique).get().single()
            WorkManagerTestInitHelper.getTestDriver(ctx)!!.setAllConstraintsMet(info.id)
            assertEquals(listOf(id to owner), runs)
            assertEquals(outcome.name, state, wm.getWorkInfoById(info.id).get()!!.state)
        }
    }

    @Test
    fun cancelAndSignOutDropWhatIsScheduled() {
        val b = AndroidSyncBackground(ctx)
        b.enqueue(sha("saves:a"), owner)
        b.enqueue(sha("saves:b"), owner)
        b.cancel(sha("saves:a"))
        assertEquals(1, wm.getWorkInfosByTag(ownerTag()).get().count { !it.state.isFinished })
        b.cancelOwner(owner)
        assertTrue(wm.getWorkInfosByTag(ownerTag()).get().all { it.state.isFinished })
    }

    @Test
    fun nothingIsInstalledUnlessTheAppTurnsItOn() {
        val signer = TestSigner()

        fun opts(on: Boolean) = PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = "diceroll",
                version = "1.0.0",
                pinnedKeys = signer.trust,
                store = InMemoryStore("diceroll"),
            ),
            cloudSync = CloudSyncHostOptions().also { it.backgroundTransfers = on },
        )
        val off = opts(false)
        PolarisKeyAndroid.client(ctx, off).close()
        assertNull(off.cloudSync.backgroundPort)
        val on = opts(true)
        PolarisKeyAndroid.client(ctx, on).close()
        assertNotNull(on.cloudSync.backgroundPort)
        assertTrue(on.cloudSync.backgroundPort is AndroidSyncBackground)
    }
}
