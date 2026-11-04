// @pkey-feature ui.kit connect.links connect.transfer
//
// CC-19.10: LinkPairing and TransferOffer on the Compose desktop kit. The button order is the platform's: on macOS a trailing row with
// the safe verb directly left of the default (Not a Match | Codes Match, in the Mac's title case), elsewhere a stack with the primary
// first. Return never confirms or accepts on arrival (there is no default key here); Escape declines a code or an offer, cancels the
// window and does nothing while a transfer is in flight. The rows' pictures are the Android kit's baselines (ConnectScreensTest).

@file:Suppress("MagicNumber", "FunctionNaming")

package im.plrs.key.ui

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class ConnectScreensDesktopTest {
    private val code = KitStates.resolve(
        KitComponent.linkPairing,
        linkPairingInputs(PolarisLinkPairingUi(PolarisLinkStep.Code, "Maya's laptop", "123 456", listOf("contacts", "photos")))!!,
    )

    private fun failed(reason: PolarisLinkFailure) = KitStates.resolve(
        KitComponent.linkPairing,
        linkPairingInputs(PolarisLinkPairingUi(PolarisLinkStep.Failed, reason = reason))!!,
    )

    private fun offer(step: PolarisTransferOfferStep) = KitStates.resolve(
        KitComponent.transferOffer,
        transferOfferInputs(PolarisTransferOfferUi(step, "holiday.zip", "Maya's laptop"))!!,
    )

    @Test
    fun onTheMacTheSafeVerbSitsLeftOfTheDefaultInOneRowInTheMacsWording() = withPlatform("MacOS") {
        matrixFrame(900, 640, dark = false, content = { PolarisLinkPairingScreen(code, "123 456", listOf("contacts", "photos")) }, after = {
            val decline = onNodeWithText("Not a Match").getBoundsInRoot()
            val confirm = onNodeWithText("Codes Match").getBoundsInRoot()
            assertEquals(decline.top, confirm.top, "one row")
            assertTrue(decline.right <= confirm.left, "Not a Match | Codes Match")
            // The categories still come first, in reading order.
            assertTrue(onNodeWithText("Each of you shares", useUnmergedTree = true).getBoundsInRoot().bottom <= confirm.top)
        })
    }

    @Test
    fun onTheMacAFailureThatCanBeRetriedHasDoneLeftOfTryAgain() = withPlatform("MacOS") {
        matrixFrame(900, 640, dark = false, content = { PolarisLinkPairingScreen(failed(PolarisLinkFailure.Timeout), null, emptyList()) }, after = {
            val done = onNodeWithText("Done").getBoundsInRoot()
            val retry = onNodeWithText("Try Again").getBoundsInRoot()
            assertEquals(done.top, retry.top, "one row")
            assertTrue(done.right <= retry.left, "Done | Try Again")
        })
    }

    @Test
    fun onWindowsAndGnomeThePrimaryIsFirstInAStack() {
        for (platform in listOf("Windows", "Gnome")) {
            withPlatform(platform) {
                matrixFrame(900, 640, dark = false, content = {
                    PolarisTransferOfferScreen(offer(PolarisTransferOfferStep.Ask), "holiday.zip")
                }, after = {
                    val accept = onNodeWithText("Accept").getBoundsInRoot()
                    val decline = onNodeWithText("Decline").getBoundsInRoot()
                    assertTrue(accept.top < decline.top, "$platform: Accept above Decline")
                })
            }
        }
    }

    @Test
    fun returnConfirmsNothingAndEscapeDeclinesACodeOrAnOffer() = withPlatform("Windows") {
        var confirmed = 0
        var declined = 0
        matrixFrame(
            900,
            640,
            dark = false,
            content = { PolarisLinkPairingScreen(code, "123 456", listOf("contacts"), onConfirm = { confirmed++ }, onDecline = { declined++ }) },
            after = {
                onRoot().performKeyInput { pressKey(Key.Enter) }
                waitForIdle()
                assertEquals(0, confirmed, "Return never confirms a code nobody compared")
                assertEquals(0, declined)
                onNodeWithText("Not a match").requestFocus()
                onRoot().performKeyInput { pressKey(Key.Escape) }
                waitForIdle()
                assertEquals(1, declined, "Escape is Not a match")
                assertEquals(0, confirmed)
            },
        )
        var accepted = 0
        var offerDeclined = 0
        matrixFrame(
            900,
            640,
            dark = false,
            content = {
                PolarisTransferOfferScreen(offer(PolarisTransferOfferStep.Ask), "holiday.zip", onAccept = {
                    accepted++
                }, onDecline = { offerDeclined++ })
            },
            after = {
                onRoot().performKeyInput { pressKey(Key.Enter) }
                waitForIdle()
                onNodeWithText("Decline").requestFocus()
                onRoot().performKeyInput { pressKey(Key.Escape) }
                waitForIdle()
                assertEquals(0, accepted, "Return never accepts a transfer")
                assertEquals(1, offerDeclined, "Escape is Decline")
            },
        )
    }

    @Test
    fun escapeDoesNotStopATransferInFlightAndCancelsAWindow() = withPlatform("Windows") {
        var offerCancelled = 0
        var offerDone = 0
        matrixFrame(
            900,
            640,
            dark = false,
            content = {
                PolarisTransferOfferScreen(offer(PolarisTransferOfferStep.Receiving), "holiday.zip", onCancel = {
                    offerCancelled++
                }, onDone = { offerDone++ })
            },
            after = {
                onNodeWithText("Cancel").requestFocus()
                onRoot().performKeyInput { pressKey(Key.Escape) }
                waitForIdle()
                assertEquals(0, offerCancelled, "a transfer in flight is stopped by its own Cancel")
                assertEquals(0, offerDone)
            },
        )
        var cancelled = 0
        val open = KitStates.resolve(KitComponent.linkPairing, linkPairingInputs(PolarisLinkPairingUi(PolarisLinkStep.Open))!!)
        matrixFrame(
            900,
            640,
            dark = false,
            content = { PolarisLinkPairingScreen(open, null, emptyList(), onCancel = { cancelled++ }) },
            after = {
                onNodeWithText("Cancel").requestFocus()
                onRoot().performKeyInput { pressKey(Key.Escape) }
                waitForIdle()
                assertEquals(1, cancelled, "Escape cancels the window")
            },
        )
    }
}
