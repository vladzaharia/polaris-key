package im.plrs.key.platform.play

import android.app.Activity
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager
import com.google.android.play.core.install.model.ActivityResult
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * In-App Updates through Play Core's FakeAppUpdateManager. The flows are driven through
 * startUpdateFlowForResult and the fake's visibility observers, never the startUpdateFlow task
 * (which resolves before the user answers, notes/S-10 §1).
 */
@RunWith(RobolectricTestRunner::class)
class InAppUpdatesTest {
    private lateinit var activity: Activity
    private lateinit var fake: FakeAppUpdateManager
    private lateinit var iau: InAppUpdates
    private val seen = mutableListOf<Int>()

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        fake = FakeAppUpdateManager(ApplicationProvider.getApplicationContext())
        iau = InAppUpdates(fake)
        iau.addListener { seen.add(it.installStatus) }
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun check(): Result<UpdateStatus> {
        var out: Result<UpdateStatus>? = null
        iau.check { out = it }
        idle()
        return out!!
    }

    @Test
    fun flexibleFlowToCompletion() {
        fake.setUpdateAvailable(2)
        fake.setUpdatePriority(4)
        fake.setClientVersionStalenessDays(3)
        val s = check().getOrThrow()
        assertEquals(UpdateAvailability.UPDATE_AVAILABLE, s.availability)
        assertEquals(2, s.availableVersionCode)
        assertEquals(4, s.priority)
        assertEquals(3, s.stalenessDays)
        assertTrue(s.flexibleAllowed)
        assertTrue(s.immediateAllowed)
        assertFalse(s.readyToComplete)

        assertTrue(iau.start(AppUpdateType.FLEXIBLE, activity).started)
        assertTrue(fake.isConfirmationDialogVisible)
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        fake.downloadCompletes()
        idle()
        // What a relaunch sees: availability 3 with installStatus 11, i.e. "call complete".
        val downloaded = check().getOrThrow()
        assertEquals(UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS, downloaded.availability)
        assertTrue(downloaded.readyToComplete)
        assertFalse(downloaded.inProgress)

        var completed: Result<Unit>? = null
        iau.complete { completed = it }
        fake.installCompletes()
        idle()
        assertTrue(completed!!.isSuccess)
        assertEquals(listOf(InstallStatus.PENDING, InstallStatus.DOWNLOADING, InstallStatus.DOWNLOADED, InstallStatus.INSTALLING, InstallStatus.INSTALLED), seen)
        assertEquals(UpdateAvailability.UPDATE_NOT_AVAILABLE, check().getOrThrow().availability)
    }

    @Test
    fun rejectedFlexibleChangesNothing() {
        fake.setUpdateAvailable(2)
        check()
        assertTrue(iau.start(AppUpdateType.FLEXIBLE, activity).started)
        fake.userRejectsUpdate()
        idle()
        assertTrue(seen.isEmpty())
        assertEquals(UpdateAvailability.UPDATE_AVAILABLE, check().getOrThrow().availability)
    }

    @Test
    fun immediateFlowReportsNoListenerEvents() {
        fake.setUpdateAvailable(2)
        check()
        assertTrue(iau.start(AppUpdateType.IMMEDIATE, activity).started)
        assertTrue(fake.isImmediateFlowVisible)
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        idle()
        // Interrupted mid-download, a relaunch reads "in progress": the game re-starts the
        // immediate flow (Play's resume rule; the fake itself does not model the restart).
        val mid = check().getOrThrow()
        assertTrue(mid.inProgress)
        assertEquals(InstallStatus.DOWNLOADING, mid.installStatus)
        fake.downloadCompletes()
        fake.installCompletes()
        idle()
        assertTrue(seen.isEmpty())
    }

    @Test
    fun flexibleOnlyRefusesImmediate() {
        fake.setUpdateAvailable(2, AppUpdateType.FLEXIBLE)
        val s = check().getOrThrow()
        assertFalse(s.immediateAllowed)
        val r = iau.start(AppUpdateType.IMMEDIATE, activity)
        assertFalse(r.started)
        assertEquals("type-not-allowed", r.reason)
        assertTrue(iau.start(AppUpdateType.FLEXIBLE, activity).started)
    }

    @Test
    fun notAvailableRefusesToStart() {
        fake.setUpdateNotAvailable()
        assertEquals(UpdateAvailability.UPDATE_NOT_AVAILABLE, check().getOrThrow().availability)
        assertEquals("not-available", iau.start(AppUpdateType.FLEXIBLE, activity).reason)
    }

    @Test
    fun startNeedsACheckAndEachInfoStartsOneFlow() {
        assertEquals("no-check", iau.start(AppUpdateType.FLEXIBLE, activity).reason)
        fake.setUpdateAvailable(2)
        check()
        assertTrue(iau.start(AppUpdateType.FLEXIBLE, activity).started)
        assertEquals("no-check", iau.start(AppUpdateType.FLEXIBLE, activity).reason)
    }

    @Test
    fun downloadFailureAndCancelReportStatuses() {
        fake.setUpdateAvailable(2)
        check()
        iau.start(AppUpdateType.FLEXIBLE, activity)
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        fake.downloadFails()
        idle()
        assertEquals(InstallStatus.FAILED, seen.last())
        assertEquals(UpdateAvailability.UPDATE_AVAILABLE, check().getOrThrow().availability)
    }

    @Test
    fun anErrorCodeIsUnavailableWithTheCode() {
        fake.setInstallErrorCode(-6)
        val e = check().exceptionOrNull() as UpdatesUnavailable
        assertEquals(-6, e.installErrorCode)
        assertEquals(-6, e.toJson().getInt("installErrorCode"))
        assertEquals("unavailable", e.toJson().getString("error"))
    }

    @Test
    fun anyFailureIsUnavailable() {
        // Without the Play Store the real manager fails with an internal exception, not an
        // InstallException (notes/S-10 §1): it still maps to "unavailable", with no code.
        val e = UpdatesUnavailable.of(IllegalStateException("Failed to bind to the service."))
        assertNull(e.installErrorCode)
        assertEquals("java.lang.IllegalStateException", e.exception)
        assertNotNull(e.toJson().get("installErrorCode"))
    }

    @Test
    fun activityResultsAndTypesMap() {
        assertEquals("accepted", InAppUpdates.activityResult(Activity.RESULT_OK))
        assertEquals("canceled", InAppUpdates.activityResult(Activity.RESULT_CANCELED))
        assertEquals("failed", InAppUpdates.activityResult(ActivityResult.RESULT_IN_APP_UPDATE_FAILED))
        assertEquals("unknown", InAppUpdates.activityResult(42))
        assertEquals(AppUpdateType.FLEXIBLE, InAppUpdates.typeOf("flexible"))
        assertEquals(AppUpdateType.IMMEDIATE, InAppUpdates.typeOf("immediate"))
        assertNull(InAppUpdates.typeOf("instant"))
    }

    @Test
    fun removedListenerHearsNothing() {
        val other = mutableListOf<Int>()
        val l: (InstallProgress) -> Unit = { other.add(it.installStatus) }
        iau.addListener(l)
        iau.removeListener(l)
        fake.setUpdateAvailable(2)
        check()
        iau.start(AppUpdateType.FLEXIBLE, activity)
        fake.userAcceptsUpdate()
        idle()
        assertTrue(other.isEmpty())
        assertEquals(listOf(InstallStatus.PENDING), seen)
    }
}
