// @pkey-feature ui.kit update.driver
//
// UK-10.9: the update prompt's progress on the desktop. Real bytes while the download runs, an
// indeterminate bar while the total is unknown, and no bytes or percentage once it failed.

package im.plrs.key.ui

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import kotlin.test.Test

@OptIn(ExperimentalTestApi::class)
class UpdateProgressDesktopTest {
    private val copy = PolarisCopy()
    private val hasRange = SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)

    private fun androidx.compose.ui.test.ComposeUiTest.render(ui: PolarisUpdateUi) = setContent {
        PolarisTheme(branding = PolarisBranding.None, darkTheme = false, copy = copy) { PolarisUpdatePrompt(ui, onLater = {}) }
    }

    @Test
    fun showsRealBytesAndTheEstimate() = runDesktopComposeUiTest(width = 640, height = 800) {
        render(PolarisUpdateUi("2.0.0", progress = 38_000_000L to 61_000_000L, secondsLeft = 90))
        onNodeWithText(copy.format(copy.updateDownloading, copy.bytes(38_000_000L), copy.bytes(61_000_000L))).assertExists()
        onNodeWithText(copy.timeLeftLine(90)).assertExists()
        // On a Mac host the theme reads the Mac wording of a default copy (S4).
        onNodeWithText((if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) copy.forMac() else copy).updateRestartWhenReady).assertExists()
        onAllNodesWithText("%", substring = true).assertCountEquals(0)
    }

    @Test
    fun staysIndeterminateWhileTheTotalIsUnknown() = runDesktopComposeUiTest(width = 640, height = 800) {
        render(PolarisUpdateUi("2.0.0", progress = 5_000_000L to 0L))
        onNodeWithText("${copy.packsDownloading} · ${copy.bytes(5_000_000L)}").assertExists()
        onAllNodesWithText("of", substring = true).assertCountEquals(0)
        // Material's indeterminate bar reports an empty range: no fraction to read.
        onNode(SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo.Indeterminate)).assertExists()
    }

    @Test
    fun addsNothingAfterAFailure() = runDesktopComposeUiTest(width = 640, height = 800) {
        render(PolarisUpdateUi("2.0.0", progress = null, error = PolarisUpdateFailure("payload_mismatch")))
        onNodeWithText(copy.updateFailed).assertExists()
        onAllNodes(hasRange).assertCountEquals(0)
        onAllNodesWithText("Downloading", substring = true).assertCountEquals(0)
    }
}
