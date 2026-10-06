// @pkey-feature update.driver
package im.plrs.key.android

import android.app.Activity
import androidx.test.core.app.ApplicationProvider
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager
import com.google.android.play.core.install.model.AppUpdateType
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.platform.play.InAppUpdates
import im.plrs.key.update.InstallResult
import im.plrs.key.update.InstallStage
import org.robolectric.shadows.ShadowLooper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** update.driver on a play build: the In-App Updates table, through Play Core's FakeAppUpdateManager. */
@RunWith(RobolectricTestRunner::class)
class PlayInstallDriverTest {
    private lateinit var activity: Activity
    private lateinit var fake: FakeAppUpdateManager
    private var host: Activity? = null

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        fake = FakeAppUpdateManager(ApplicationProvider.getApplicationContext())
        host = activity
    }

    private fun driver(policy: PlayUpdatePolicy = PlayUpdatePolicy()) = PlayInstallDriver(InAppUpdates(fake), { host }, policy)

    private val release = DecisionRelease("1.4.0", 14)

    private fun store(mandatory: Boolean = false, critical: Boolean = false) = check(
        UpdateDecision.Store(release, "https://play.google.com/store/apps/details?id=gg.vlad.diceroll", mandatory, critical, false),
    )

    private fun check(d: UpdateDecision) = UpdateCheck("stable", d, UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())

    private fun install(d: PlayInstallDriver, c: UpdateCheck): InstallResult = pumped { d.install(c) }

    @Test
    fun anAvailableUpdateStartsTheFlexibleFlow() {
        fake.setUpdateAvailable(15)
        assertEquals(InstallResult.Started, install(driver(), store()))
        assertTrue(fake.isConfirmationDialogVisible)
        assertFalse(fake.isImmediateFlowVisible)
    }

    @Test
    fun anUrgentDecisionStartsTheImmediateFlow() {
        fake.setUpdateAvailable(15)
        assertEquals(InstallResult.Started, install(driver(), store(mandatory = true)))
        assertTrue(fake.isImmediateFlowVisible)
    }

    @Test
    fun urgentFallsBackToFlexibleWhenImmediateIsNotAllowed() {
        fake.setUpdateAvailable(15, AppUpdateType.FLEXIBLE)
        assertEquals(InstallResult.Started, install(driver(), store(critical = true)))
        assertTrue(fake.isConfirmationDialogVisible)
    }

    @Test
    fun playsPriorityAndStalenessMakeItUrgentWhenTheHostAsks() {
        fake.setUpdateAvailable(15)
        fake.setUpdatePriority(5)
        assertEquals(InstallResult.Started, install(driver(PlayUpdatePolicy(immediatePriority = 4)), store()))
        assertTrue(fake.isImmediateFlowVisible)

        val f2 = FakeAppUpdateManager(ApplicationProvider.getApplicationContext())
        f2.setUpdateAvailable(15)
        f2.setClientVersionStalenessDays(9)
        assertEquals(InstallResult.Started, pumped { PlayInstallDriver(InAppUpdates(f2), { activity }, PlayUpdatePolicy(immediateAfterDays = 7)).install(store()) })
        assertTrue(f2.isImmediateFlowVisible)

        // Off by default (Godot's behaviour): the same signals start the flexible flow.
        val f3 = FakeAppUpdateManager(ApplicationProvider.getApplicationContext())
        f3.setUpdateAvailable(15)
        f3.setUpdatePriority(5)
        assertEquals(InstallResult.Started, pumped { PlayInstallDriver(InAppUpdates(f3), { activity }).install(store()) })
        assertTrue(f3.isConfirmationDialogVisible)
    }

    @Test
    fun aDownloadedUpdateIsCompleted() {
        fake.setUpdateAvailable(15)
        val d = driver()
        assertEquals(InstallResult.Started, install(d, store()))
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        fake.downloadCompletes()
        assertEquals(InstallResult.Started, install(d, store()))
        assertTrue("complete() shows Play's install splash", fake.isInstallSplashScreenVisible)
    }

    /** SP-K08: a flexible flow reports its download, then "restart to finish", which finish() runs. */
    @Test
    fun aFlexibleFlowReportsProgressAndFinishes() {
        fake.setUpdateAvailable(15)
        val d = driver()
        assertEquals(InstallStage.Idle, d.progress.value)
        assertEquals(InstallResult.Started, install(d, store()))
        fake.userAcceptsUpdate()
        fake.setTotalBytesToDownload(1_000)
        fake.downloadStarts()
        fake.setBytesDownloaded(250)
        ShadowLooper.idleMainLooper()
        val downloading = d.progress.value
        assertTrue("$downloading", downloading is InstallStage.Downloading)
        fake.downloadCompletes()
        ShadowLooper.idleMainLooper()
        assertEquals(InstallStage.ReadyToRestart, d.progress.value)
        assertEquals(InstallResult.Started, pumped { d.finish() })
        assertTrue(fake.isInstallSplashScreenVisible)
    }

    @Test
    fun aResumeFindsADownloadedUpdateAndAResultIsFolded() {
        fake.setUpdateAvailable(15)
        assertEquals(InstallResult.Started, install(driver(), store()))
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        fake.downloadCompletes()
        val d = driver()
        pumped { d.resume() }
        assertEquals(InstallStage.ReadyToRestart, d.progress.value)
        assertFalse("another request code is not ours", d.activityResult(1, Activity.RESULT_CANCELED))
        val fresh = driver()
        assertTrue(fresh.activityResult(InAppUpdates.REQUEST_CODE, 1))
        assertTrue(fresh.progress.value is InstallStage.Failed)
    }

    @Test
    fun anUpdateInProgressIsLeftAloneUnlessUrgent() {
        fake.setUpdateAvailable(15)
        val d = driver()
        assertEquals(InstallResult.Started, install(d, store(mandatory = true)))
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        // Not urgent: Play has it; nothing more to start.
        assertEquals(InstallResult.Started, install(d, store()))
        // Urgent: Play's resume rule starts the immediate flow again. The fake does not model the
        // restart (it refuses a second flow while its first is open), so the attempt shows as Play's
        // refusal, never as "nothing to do".
        val resumed = install(d, store(mandatory = true))
        assertTrue(resumed is InstallResult.Failed && resumed.detail!!.contains("refused"))
        assertTrue(fake.isImmediateFlowVisible)
    }

    @Test
    fun anUpdatePlayHasNotOfferedYetIsStaging() {
        fake.setUpdateNotAvailable()
        assertEquals(InstallResult.Declined(PlayInstallDriver.STAGING), install(driver(), store()))
        val urgent = install(driver(), store(mandatory = true))
        assertTrue(urgent is InstallResult.Failed)
        urgent as InstallResult.Failed
        assertEquals(ErrorCode.platformError, urgent.code)
        assertTrue("the failure offers the listing", urgent.detail!!.contains("https://play.google.com/store/apps/details?id=gg.vlad.diceroll"))
    }

    @Test
    fun withoutAnActivityTheFlowCannotStart() {
        fake.setUpdateAvailable(15)
        host = null
        val r = install(driver(), store())
        assertTrue(r is InstallResult.Failed && r.code == ErrorCode.platformError)
        assertFalse(fake.isConfirmationDialogVisible)
    }

    @Test
    fun otherDecisions() {
        val d = driver()
        val binary = install(d, check(UpdateDecision.Binary("native", DecisionRelease("1.4.0", 14, "ab".repeat(32)), "android-arm64", false, false, emptyList(), false)))
        assertTrue("a play build never self-updates", binary is InstallResult.Failed && binary.code == ErrorCode.unsupported)
        assertEquals(InstallResult.NothingToInstall, install(d, check(UpdateDecision.Platform(release, false, false, false))))
        assertEquals(InstallResult.NothingToInstall, install(d, check(UpdateDecision.None("up-to-date", false, false))))
    }
}
