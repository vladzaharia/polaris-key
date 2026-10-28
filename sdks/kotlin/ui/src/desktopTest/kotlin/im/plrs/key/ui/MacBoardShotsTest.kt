// @pkey-feature ui.kit
//
// UK-10.7: the macOS board screens rendered offscreen to PKEY_KIT_SHOTS (PNGs, dark and light at 900x640
// and 1440x900, the 480x520 floor and the Welcome / sheet focus shot), through BoardShots.kt with the
// Tidewater fixtures, for the BUILT UX review against desktop.html. The host is a full-size content
// view (the sheet floats 52 dp down). Nothing is compared: UK-10.12 commits the baseline set. Without
// PKEY_KIT_SHOTS the test only checks every screen composes.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import im.plrs.key.license.ActivationResult
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

class MacBoardShotsTest {
    private val shots: File? = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)

    private class Board(val name: String, val sizes: List<Pair<Int, Int>> = DEFAULT_SIZES, val content: @Composable () -> Unit)

    private val limit = PolarisActivationUi(
        key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV",
        error = PolarisActivationError.Refused(ActivationResult.DeviceLimit(3, 3, BoardFixtures.PORTAL)),
        manageUrl = BoardFixtures.PORTAL,
    )

    private val boards = listOf(
        Board("gate") { PolarisActivationScreen(PolarisActivationUi(), onSignIn = {}) },
        Board("activate") { PolarisActivationScreen(PolarisActivationUi(key = "pkey_tidewater_ABCDEFGHIJKLMNOPQRSTUV"), onSignIn = {}) },
        Board("sign-in") {
            PolarisSignInScreen(
                PolarisSignInUi.Showing(
                    PolarisSignInCode("WDJB-MJHT", BoardFixtures.SIGN_IN, "${BoardFixtures.SIGN_IN}?code=WDJB-MJHT", 600, 1_700_000_600, "Studio"),
                    nowSeconds = 1_700_000_000,
                ),
            )
        },
        Board("device-limit") { PolarisActivationScreen(limit) },
        // The sheet over the product, the parent visibly undimmed.
        Board("sheet", DEFAULT_SIZES + (480 to 520)) {
            BoardFixtures.Product()
            PolarisUpdatePromptHosted(
                PolarisUpdateUi(
                    version = "2.5.0", currentVersion = "2.4.1", size = 61_000_000,
                    notes = listOf("Stem export in one click, with loudness matching", "Track freeze now works with every plug-in"),
                    notesUrl = "https://polaris.locker/releases/2.5.0",
                ),
                onUpdate = {}, onLater = {}, onSkip = {},
            )
        },
        Board("message", DEFAULT_SIZES + (480 to 520)) {
            PolarisMessageScreen(PolarisMessageCopy("Can't connect", "Can't reach Polaris Locker. Check your connection and try again.", PolarisMessageKind.Offline)) {
                PolarisPrimaryButton("Try again", {})
                PolarisSecondaryButton("Continue offline", {})
            }
        },
    )

    @Test
    fun theBoardScreensCompose() {
        val old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "MacOS")
        try {
            var rendered = 0
            for (board in boards) for ((w, h) in board.sizes) {
                // Without a destination only the smallest size is composed, to keep the run short.
                if (shots == null && (w to h) != board.sizes.first()) continue
                for (render in rendersFor(first = w == 900, large = w == 1440 && (board.name == "gate" || board.name == "sheet"))) {
                    renderBoard(shots, "macos", board.name, w, h, render) {
                        CompositionLocalProvider(LocalPolarisMacFullSizeContent provides true) { board.content() }
                    }
                    rendered++
                }
            }
            assertTrue(rendered >= boards.size * 2)
        } finally {
            old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        }
    }

    private companion object {
        val DEFAULT_SIZES = listOf(900 to 640, 1440 to 900)
    }
}
