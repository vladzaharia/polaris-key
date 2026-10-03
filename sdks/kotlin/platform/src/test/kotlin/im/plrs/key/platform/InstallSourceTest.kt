package im.plrs.key.platform

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class InstallSourceTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @Test
    @Config(sdk = [34])
    fun readsInstallSourceInfoOnApi34() {
        shadowOf(ctx.packageManager).setInstallSourceInfo(ctx.packageName, "com.android.shell", "com.android.vending")
        val s = InstallSource.read(ctx)
        assertEquals("installSourceInfo", s.api)
        assertEquals("com.android.vending", s.installer)
        assertEquals("com.android.shell", s.initiator)
        assertEquals(34, s.sdkInt)
        // The forgeable case S-06 measured: Play as installer, the shell as initiator.
        assertFalse(s.selfUpdated)
        val j = s.toJson()
        assertEquals("com.android.vending", j.getString("installer"))
        assertTrue(j.has("packageSource"))
        assertTrue(j.has("updateOwner"))
        assertTrue(j.has("initiatorCertSha256"))
    }

    @Test
    @Config(sdk = [34])
    fun recognisesASelfUpdate() {
        shadowOf(ctx.packageManager).setInstallSourceInfo(ctx.packageName, ctx.packageName, ctx.packageName)
        val s = InstallSource.read(ctx)
        assertTrue(s.selfUpdated)
        assertTrue(s.toJson().getBoolean("selfUpdated"))
    }

    @Test
    @Config(sdk = [30])
    fun api30HasNoPackageSourceOrOwner() {
        shadowOf(ctx.packageManager).setInstallSourceInfo(ctx.packageName, "org.fdroid.fdroid", "org.fdroid.fdroid")
        val s = InstallSource.read(ctx)
        assertEquals("org.fdroid.fdroid", s.installer)
        assertNull(s.packageSource)
        assertNull(s.updateOwner)
    }

    @Test
    @Config(sdk = [29])
    fun fallsBackToInstallerPackageNameBelowApi30() {
        @Suppress("DEPRECATION")
        ctx.packageManager.setInstallerPackageName(ctx.packageName, "com.android.vending")
        val s = InstallSource.read(ctx)
        assertEquals("installerPackageName", s.api)
        assertEquals("com.android.vending", s.installer)
        assertNull(s.initiator)
        assertNull(s.initiatorSigners)
    }

    @Test
    @Config(sdk = [34])
    fun absentInstallerIsNull() {
        shadowOf(ctx.packageManager).setInstallSourceInfo(ctx.packageName, null, null)
        val s = InstallSource.read(ctx)
        assertNull(s.installer)
        assertEquals(org.json.JSONObject.NULL, s.toJson().get("installer"))
    }

    @Test
    fun digestsAreLowerHexSha256() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Digests.sha256(ByteArray(0)))
        assertTrue(Digests.isSha256Hex("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"))
        assertFalse(Digests.isSha256Hex("e3b0"))
        assertFalse(Digests.isSha256Hex(null))
        assertFalse(Digests.isSha256Hex("g".repeat(64)))
    }

    @Test
    fun flavourIsFixedAtBuildTime() {
        assertTrue(PolarisKeyPlatform.flavor == "play" || PolarisKeyPlatform.flavor == "direct")
        assertEquals(PolarisKeyPlatform.isPlay, !PolarisKeyPlatform.isDirect)
    }
}
