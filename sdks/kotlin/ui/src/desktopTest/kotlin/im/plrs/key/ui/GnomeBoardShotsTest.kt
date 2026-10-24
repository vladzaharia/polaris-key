// @pkey-feature ui.kit
//
// UK-10.6: the GNOME board screens rendered offscreen to PKEY_KIT_SHOTS (PNGs, dark and light,
// 900x600, 1440x900 and a narrow 480x640 for the stacking), through BoardShots.kt. Nothing is compared: UK-10.12 commits
// the baseline set. Without PKEY_KIT_SHOTS the test only checks every screen composes.

package im.plrs.key.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.license.ActivationResult
import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

class GnomeBoardShotsTest {
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
                    SignInPrompt("dc", "WDJB-MJHT", BoardFixtures.SIGN_IN, "${BoardFixtures.SIGN_IN}?code=WDJB-MJHT", 600, 5, 1_700_000_600, "Studio"),
                    nowSeconds = 1_700_000_000,
                ),
            )
        },
        Board("device-limit") { PolarisActivationScreen(limit) },
        // The wired path: the sign-in step with its "Replace…", and the confirm state drawn as the alert.
        Board("replace-step", DEFAULT_SIZES + (480 to 640)) {
            PolarisKitScreen(replaceStep("replace"))
        },
        Board("replace-wired", DEFAULT_SIZES + (480 to 640) + (320 to 640)) {
            PolarisKitScreen(replaceStep("replace-open"))
        },
        Board("replace-alert", DEFAULT_SIZES + (480 to 640) + (320 to 640)) {
            Box(Modifier.fillMaxSize()) {
                PolarisActivationScreen(limit)
                PolarisReplaceAlertOverlay("Mara's Mac", "this computer", BoardFixtures.PRODUCT, {}, {})
            }
        },
        // The REAL dialog path: the public prompt in its own window over the product.
        Board("sheet", DEFAULT_SIZES + (480 to 640)) {
            BoardFixtures.Product()
            PolarisUpdatePromptDialog(
                PolarisUpdateUi(
                    version = "2.5", currentVersion = "2.4.1", size = 61_000_000,
                    notes = listOf("Stem export in one click, with loudness matching", "Track freeze now works with every plug-in"),
                    progress = 38_000_000L to 61_000_000L, secondsLeft = 20,
                ),
                onUpdate = {}, onLater = {}, onSkip = {},
            )
        },
        Board("status-page", DEFAULT_SIZES + (480 to 640)) {
            PolarisMessageScreen(PolarisMessageCopy("Can't connect", "Can't reach Polaris Locker. Check your connection and try again.", PolarisMessageKind.Offline)) {
                PolarisPrimaryButton("Try again", {}, external = false)
                PolarisSecondaryButton("Continue offline", {})
            }
        },
    )

    private fun replaceStep(state: String) = KitScreen(
        component = if (state == "replace") KitComponent.signIn else KitComponent.licenseChoice,
        state = state,
        copy = listOf(
            CopyLine("signin.replace.open"),
            CopyLine("signin.replace.lede", mapOf("thisDevice" to CopyArgument.Text("this computer"))),
            CopyLine("signin.replace.title", mapOf("device" to CopyArgument.Text("Work laptop"))),
            CopyLine(
                "signin.replace.consequence",
                mapOf(
                    "device" to CopyArgument.Text("Work laptop"),
                    "product" to CopyArgument.Text(BoardFixtures.PRODUCT),
                    "thisDevice" to CopyArgument.Text("this computer"),
                ),
            ),
            CopyLine("signin.replace.confirm"),
            CopyLine("signin.replace.back"),
        ),
        actions = emptyList(),
    )

    @Test
    fun theBoardScreensCompose() = withPlatform("Gnome") {
        var rendered = 0
        for (board in boards) for ((w, h) in board.sizes) {
            // Without a destination only the smallest size is composed, to keep the run short.
            if (shots == null && (w to h) != board.sizes.first()) continue
            for (render in rendersFor(first = w == 900, large = w == 1440 && (board.name == "gate" || board.name == "sheet"))) {
                renderBoard(shots, "gnome", board.name, w, h, render, board.content)
                rendered++
            }
        }
        assertTrue(rendered >= boards.size * 2)
    }

    private companion object {
        val DEFAULT_SIZES = listOf(900 to 600, 1440 to 900)
    }
}
