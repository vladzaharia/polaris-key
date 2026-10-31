package im.plrs.key.platform

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The `direct` flavour answers Unavailable("outlet") on every call and holds no Block Store class. */
@RunWith(RobolectricTestRunner::class)
class DirectBackupTest {
    @Test
    fun everyCallIsUnavailableWithTheOutletReason() {
        val backup = PlatformBackup.create(ApplicationProvider.getApplicationContext())
        assertFalse(backup.isSupported)
        val key = PlatformBackup.RESTORE_PREFIX + "tidewater"
        var read: PlatformBackupRead? = null
        var write: PlatformBackupWrite? = null
        var deleted: PlatformBackupWrite? = null
        var cloud: Boolean? = null
        backup.get(key) { read = it }
        backup.set(key, byteArrayOf(1)) { write = it }
        backup.delete(key) { deleted = it }
        backup.cloudBackup { cloud = it }
        assertEquals(PlatformBackupRead.Unavailable("outlet"), read)
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), write)
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), deleted)
        assertEquals(false, cloud)
    }

    @Test
    fun blockStoreIsNotOnTheClasspath() {
        val missing = try {
            Class.forName("com.google.android.gms.auth.blockstore.Blockstore")
            false
        } catch (_: ClassNotFoundException) {
            true
        }
        assertEquals(true, missing)
    }
}
