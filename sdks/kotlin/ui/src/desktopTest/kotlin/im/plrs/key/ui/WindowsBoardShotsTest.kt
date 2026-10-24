// @pkey-feature ui.kit
//
// UK-10.5: the Windows board screens, rendered headless (Compose desktop, no window) at 900x600 and
// 1440x900, dark and light, for the BUILT UX review against windows.html. With PKEY_KIT_SHOTS set,
// each render is written to <dir>/windows.<screen>/<size>-<scheme>.png; without it the test only
// checks that every screen renders. No baselines are committed here (UK-10.12 commits the set).

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.license.ActivationResult
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class WindowsBoardShotsTest {
    private val now = 1_790_000_000L
    private val manage = "https://polaris.locker/activate?product=djdl&next=free-device&for=Windows%20x64"

    private fun gateUi(status: LicenseStatus, range: AllowedRange? = null) =
        PolarisGateUi(license = LicenseState(status, allowedRange = range), nowSeconds = now)

    private val prompt = SignInPrompt(
        deviceCode = "dc_sample", userCode = "WDJB-MJHT", verificationUri = "https://polaris.locker/device",
        verificationUriComplete = "https://polaris.locker/device?user_code=WDJB-MJHT", expiresIn = 600, interval = 5,
        expiresAt = now + 461, deviceName = "Desk PC",
    )

    @Composable
    private fun Product() {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
            Text("Diceroll", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        }
    }

    private val screens: List<Pair<String, @Composable () -> Unit>> = listOf(
        "gate" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {}) },
        "activate" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")) },
        "sign-in" to { PolarisSignInScreen(PolarisSignInUi.Showing(prompt, now)) },
        "device-limit" to {
            PolarisGateScreen(
                gateUi(LicenseStatus.needsActivation),
                PolarisActivationUi(
                    key = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
                    error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, manage)),
                    manageUrl = manage,
                ),
            )
        },
        "sheet" to {
            Product()
            PolarisUpdatePromptHosted(
                PolarisUpdateUi(
                    "2.5.0", currentVersion = "2.4.1", size = 61_000_000L,
                    notes = listOf("Faster sync on slow networks", "Fixes a crash when resuming"),
                    notesUrl = "https://example.com/releases/2.5.0", outlet = "direct",
                ),
                onUpdate = {}, onLater = {}, onSkip = {},
            )
        },
        "message" to { PolarisGateScreen(gateUi(LicenseStatus.versionTooOld, AllowedRange(min = "2.4.0")), PolarisActivationUi(), onUpdate = {}) },
    )

    @Test
    fun theBoardScreensRenderAtBothSizesInBothSchemes() {
        val old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
        try {
            val out = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)
            var rendered = 0
            for ((name, screen) in screens) for ((w, h) in listOf(900 to 600, 1440 to 900)) for (dark in listOf(true, false)) {
                runDesktopComposeUiTest(width = w, height = h) {
                    setContent {
                        PolarisTheme(darkTheme = dark, copy = PolarisCopy(productName = "Diceroll")) {
                            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { screen() }
                        }
                    }
                    waitForIdle()
                    mainClock.advanceTimeBy(800)
                    waitForIdle()
                    val image = onNode(isRoot()).captureToImage()
                    if (out != null) {
                        val file = File(out, "windows.$name/${w}x$h-${if (dark) "dark" else "light"}.png")
                        file.parentFile.mkdirs()
                        ImageIO.write(image.toAwtImage(), "png", file)
                    }
                    rendered++
                }
            }
            assertTrue(rendered == screens.size * 4)
        } finally {
            old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        }
    }
}
