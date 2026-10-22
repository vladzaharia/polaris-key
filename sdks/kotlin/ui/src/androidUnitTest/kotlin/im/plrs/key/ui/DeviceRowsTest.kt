// @pkey-feature ui.devices
// UI-KITS.md 4.3 Devices and DeviceLimit: each row has a glyph by form factor and one meta line,
// "<platform> · last used <when>", from what the Worker's roster reports; a device whose roster row
// has no platform keeps "Last checked <when>", and a device that reports neither draws no meta.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.core.LicenseStatus
import im.plrs.key.sdk.DeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class DeviceRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy

    private fun show(devices: List<DeviceInfo>) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisDevicesScreen(PolarisDevicesUi(loading = false, devices = devices, nowMillis = NOW * 1000))
                }
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun aRowReadsPlatformDotLastUsed() {
        show(sampleDevices)
        rule.onNodeWithText("Android · last used ${copy.ago(120)}").assertIsDisplayed()
        rule.onNodeWithText("Android · last used ${copy.ago(3 * 86_400)}").assertIsDisplayed()
        rule.onNodeWithText("macOS · last used ${copy.ago(9 * 86_400)}").assertIsDisplayed()
    }

    @Test
    fun aDeviceWithNoPlatformKeepsLastChecked() {
        show(listOf(DeviceInfo("d", true, LicenseStatus.ok, lastVerifiedAt = NOW * 1000 - 120_000, label = "Pixel")))
        rule.onNodeWithText(copy.format(copy.deviceLastVerified, copy.ago(120))).assertIsDisplayed()
    }

    @Test
    fun aPlatformWithNoTimeIsJustThePlatform() {
        show(listOf(DeviceInfo("d", false, LicenseStatus.ok, label = "Desk", platform = "windows")))
        rule.onNodeWithText("Windows").assertIsDisplayed()
    }

    @Test
    fun theGlyphFollowsTheFormFactorTheScreenOrTheOsImplies() {
        // This device knows its own screen, and that wins over its OS.
        assertEquals(DeviceGlyph.Tv, deviceGlyph("android", own = "tv"))
        assertEquals(DeviceGlyph.Tablet, deviceGlyph("android", own = "tablet"))
        assertEquals(DeviceGlyph.Phone, deviceGlyph("android", own = "phone"))
        // A roster device has only its OS.
        assertEquals(DeviceGlyph.Phone, deviceGlyph("android"))
        assertEquals(DeviceGlyph.Phone, deviceGlyph("ios"))
        assertEquals(DeviceGlyph.Tablet, deviceGlyph("ipados"))
        assertEquals(DeviceGlyph.Laptop, deviceGlyph("macos"))
        assertEquals(DeviceGlyph.Laptop, deviceGlyph("windows"))
        assertEquals(DeviceGlyph.Laptop, deviceGlyph("linux"))
        assertEquals(DeviceGlyph.Tv, deviceGlyph("tvos"))
        assertEquals(DeviceGlyph.Desktop, deviceGlyph("web"))
        assertEquals(DeviceGlyph.Desktop, deviceGlyph(null))
    }

    @Test
    fun everyGlyphIsADistinctVector() {
        assertEquals(DeviceGlyph.entries.size, DeviceGlyph.entries.map { it.icon().name }.toSet().size)
    }
}
