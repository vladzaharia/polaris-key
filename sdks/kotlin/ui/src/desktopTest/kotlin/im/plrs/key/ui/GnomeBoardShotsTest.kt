// @pkey-feature ui.kit
//
// UK-10.6: the GNOME board screens rendered offscreen to PKEY_KIT_SHOTS (PNGs, dark and light,
// 900x600, 1440x900 and a narrow 480x640 for the stacking). Nothing is compared: UK-10.12 commits
// the baseline set. Without PKEY_KIT_SHOTS the test only checks every screen composes.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import im.plrs.key.license.ActivationResult
import im.plrs.key.identity.SignInPrompt
import org.jetbrains.skia.EncodedImageFormat
import org.jetbrains.skia.Image
import java.io.File
import kotlin.test.Test

class GnomeBoardShotsTest {
    private val shots: File? = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)

    private class Board(val name: String, val sizes: List<Pair<Int, Int>> = DEFAULT_SIZES, val content: @Composable () -> Unit)

    private val link = "https://key.plrs.im/portal"
    private val limit = PolarisActivationUi(
        key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV",
        error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(3, 3, link)),
        manageUrl = link,
    )

    private val boards = listOf(
        Board("gate") { PolarisActivationScreen(PolarisActivationUi(), onSignIn = {}) },
        Board("activate") { PolarisActivationScreen(PolarisActivationUi(key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV"), onSignIn = {}) },
        Board("sign-in") {
            PolarisSignInScreen(
                PolarisSignInUi.Showing(
                    SignInPrompt("dc", "WDJB-MJHT", "https://key.plrs.im/signin", "https://key.plrs.im/signin?code=WDJB-MJHT", 600, 5, 1_700_000_600, "Studio"),
                    nowSeconds = 1_700_000_000,
                ),
            )
        },
        Board("device-limit") { PolarisActivationScreen(limit) },
        Board("replace-alert", DEFAULT_SIZES + (480 to 640)) {
            Box(Modifier.fillMaxSize()) {
                PolarisActivationScreen(limit)
                PolarisReplaceAlertOverlay("Mara's Mac", "this computer", "Tidewater Studio", {}, {})
            }
        },
        Board("sheet", DEFAULT_SIZES + (480 to 640)) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                PolarisActivationScreen(PolarisActivationUi(), onSignIn = {})
                PolarisUpdatePromptHosted(
                    PolarisUpdateUi(
                        version = "2.5", currentVersion = "2.4.1", size = 61_000_000,
                        notes = listOf("Stem export in one click, with loudness matching", "Track freeze now works with every plug-in"),
                        progress = 38_000_000L to 61_000_000L, secondsLeft = 20,
                    ),
                    {}, {}, {},
                )
            }
        },
        Board("status-page", DEFAULT_SIZES + (480 to 640)) {
            PolarisMessageScreen(PolarisMessageCopy("Can't connect", "Can't reach Polaris Locker. Check your connection and try again.", PolarisMessageKind.Offline)) {
                PolarisPrimaryButton("Try again", {}, external = false)
                PolarisSecondaryButton("Continue offline", {})
            }
        },
    )

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theBoardScreensCompose() = withPlatform("Gnome") {
        for (board in boards) for (dark in listOf(true, false)) for ((w, h) in board.sizes) {
            // Without a destination only the smallest size is composed, to keep the run short.
            if (shots == null && (w to h) != board.sizes.first()) continue
            runDesktopComposeUiTest(width = w, height = h) {
                setContent {
                    PolarisTheme(
                        branding = PolarisBranding.PolarisKey,
                        copy = PolarisCopy(productName = "Tidewater Studio"),
                        darkTheme = dark,
                    ) { board.content() }
                }
                waitForIdle()
                val dir = shots ?: return@runDesktopComposeUiTest
                val out = File(dir, "${board.name}.${if (dark) "dark" else "light"}.${w}x$h.png")
                out.parentFile.mkdirs()
                val bytes = Image.makeFromBitmap(onRoot().captureToImage().asSkiaBitmap()).encodeToData(EncodedImageFormat.PNG)!!.bytes
                out.writeBytes(bytes)
            }
        }
    }

    private companion object {
        val DEFAULT_SIZES = listOf(900 to 600, 1440 to 900)
    }
}
