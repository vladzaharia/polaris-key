// @pkey-feature ui.kit
//
// UK-10.5: the Windows board screens, rendered headless (Compose desktop, no window) at 900x600 and
// 1440x900, dark and light, for the BUILT UX review against windows.html. With PKEY_KIT_SHOTS set,
// each render is written to <dir>/windows.<screen>/<size>-<scheme>.png; without it the test only
// checks that every screen renders. No baselines are committed here (UK-10.12 commits the set).

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import im.plrs.key.core.AllowedRange
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import java.io.File
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import javax.imageio.ImageIO
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import kotlin.test.Test
import kotlin.test.assertTrue

class WindowsBoardShotsTest {
    private val now = 1_790_000_000L
    private val manage = "${BoardFixtures.LOCKER}/activate?product=tidewater&next=free-device&for=Windows%20x64"

    private fun gateUi(status: LicenseStatus, range: AllowedRange? = null) =
        PolarisGateUi(license = LicenseState(status, allowedRange = range), nowSeconds = now)

    private val prompt = PolarisSignInCode(
        userCode = "WDJB-MJHT", verificationUri = "${BoardFixtures.LOCKER}/device",
        verificationUriComplete = "${BoardFixtures.LOCKER}/device?user_code=WDJB-MJHT", expiresIn = 600,
        expiresAt = now + 461, deviceName = "Desk PC",
    )

    private val screens: List<Pair<String, @Composable () -> Unit>> = listOf(
        "gate" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(), onSignIn = {}) },
        "activate" to { PolarisGateScreen(gateUi(LicenseStatus.needsActivation), PolarisActivationUi(key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV")) },
        "sign-in" to { PolarisSignInScreen(PolarisSignInUi.Showing(prompt, now)) },
        "device-limit" to {
            PolarisGateScreen(
                gateUi(LicenseStatus.needsActivation),
                PolarisActivationUi(
                    key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV",
                    error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(1, 1, manage)),
                    manageUrl = manage,
                ),
            )
        },
        // The REAL dialog path: the public prompt in its own window over the product.
        "sheet" to {
            BoardFixtures.Product()
            PolarisUpdatePromptDialog(
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
    fun theBoardScreensRenderAtBothSizesInBothSchemes() = withPlatform("Windows") {
        val out = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)
        var rendered = 0
        for ((name, screen) in screens) for ((w, h) in listOf(900 to 600, 1440 to 900)) {
            for (render in rendersFor(first = w == 900, large = w == 1440 && (name == "gate" || name == "sheet"))) {
                renderBoard(out, "windows", name, w, h, render, screen)
                rendered++
            }
        }
        assertTrue(rendered >= screens.size * 4)
    }

    /** The high-contrast frames (windows.html adopts one): the stock black and white contrast themes over both presets; the accent is ignored. */
    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theContrastFramesRender() = withPlatform("Windows") {
        val out = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)
        var rendered = 0
        for ((name, screen) in screens.filter { it.first in listOf("gate", "sign-in", "sheet", "device-limit") }) for (dark in listOf(true, false)) {
            runDesktopComposeUiTest(width = 900, height = 600) {
                setContent {
                    CompositionLocalProvider(LocalPolarisHostFacts provides PolarisHostFacts(dark = dark, highContrast = true)) {
                        PolarisTheme(
                            darkTheme = dark,
                            copy = PolarisCopy(productName = BoardFixtures.PRODUCT),
                            accent = BoardFixtures.tidewaterAccent,
                            logo = { BoardFixtures.TidewaterIcon() },
                            developer = BoardFixtures.DEVELOPER,
                        ) {
                            CompositionLocalProvider(LocalPolarisInitialFocus provides false) {
                                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { screen() }
                            }
                        }
                    }
                }
                waitForIdle()
                mainClock.advanceTimeBy(800)
                waitForIdle()
                if (out != null) {
                    val roots = onAllNodes(isRoot())
                    val image = roots[roots.fetchSemanticsNodes().size - 1].captureToImage()
                    val file = File(out, "windows.$name/900x600-${if (dark) "dark" else "light"}-contrast.png")
                    file.parentFile.mkdirs()
                    ImageIO.write(image.toAwtImage(), "png", file)
                }
            }
            rendered++
        }
        assertTrue(rendered == 8)
    }
}
