package org.polariskey.s10

import android.app.Activity
import androidx.test.core.app.ApplicationProvider
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.gms.tasks.Tasks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import android.os.Looper

/** The JVM-side check P5-06's CI job runs: the flexible flow through FakeAppUpdateManager. */
@RunWith(RobolectricTestRunner::class)
class FakeIauTest {
    @Test
    fun flexibleFlowStates() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val f = FakeAppUpdateManager(ApplicationProvider.getApplicationContext())
        f.setUpdateAvailable(2)
        f.setUpdatePriority(4)
        f.setClientVersionStalenessDays(3)
        val seen = mutableListOf<Int>()
        f.registerListener { seen.add(it.installStatus()) }
        val t = f.appUpdateInfo
        shadowOf(Looper.getMainLooper()).idle()
        val info = t.result
        assertEquals(UpdateAvailability.UPDATE_AVAILABLE, info.updateAvailability())
        assertEquals(4, info.updatePriority())
        assertTrue(f.startUpdateFlowForResult(info, activity, AppUpdateOptions.defaultOptions(AppUpdateType.FLEXIBLE), 1))
        assertTrue(f.isConfirmationDialogVisible)
        f.userAcceptsUpdate(); f.downloadStarts(); f.downloadCompletes()
        f.completeUpdate(); f.installCompletes()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(InstallStatus.PENDING, InstallStatus.DOWNLOADING, InstallStatus.DOWNLOADED, InstallStatus.INSTALLING, InstallStatus.INSTALLED), seen)
    }
}
