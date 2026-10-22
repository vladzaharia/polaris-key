// @pkey-feature ui.devices
// UI-KITS.md 4.1 Devices and 1.5 rule 3: rename is inline, not an always-open form and not a dialog;
// Remove has an inline confirm that names the consequence before the button; neither is a stock
// AlertDialog. The current device carries a quiet "This phone" tag.

package im.plrs.key.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class DevicesInlineTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy
    private val renamed = mutableListOf<Pair<String, String>>()
    private val removed = mutableListOf<String>()

    private fun show() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) {
                    PolarisDevicesScreen(
                        PolarisDevicesUi(loading = false, devices = sampleDevices, nowMillis = NOW * 1000),
                        onRename = { id, name -> renamed += id to name },
                        onDeauthorize = { removed += it },
                    )
                }
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun renameOpensInTheRowNotInADialog() {
        show()
        rule.onNodeWithContentDescription(copy.format(copy.deviceRenameDescription, "Ada's tablet")).performClick()
        rule.waitForIdle()
        rule.onAllNodes(isDialog()).assertCountEquals(0)
        rule.onNodeWithText(copy.deviceRenameLabel).assertIsDisplayed()
        // The product's own screen is still there behind it: the title and the other rows.
        rule.onNodeWithText(copy.devicesTitle).assertIsDisplayed()
        rule.onNodeWithText("Pixel 9 Pro").assertIsDisplayed()
        // Save waits for a change, then saves; Cancel puts the row back.
        rule.onNodeWithText(copy.deviceSave).assertIsNotEnabled()
        rule.onNode(hasSetTextAction()).performTextReplacement("Ada's iPad")
        rule.onNodeWithText(copy.deviceSave).assertIsEnabled().performClick()
        assertEquals(listOf("dev_2" to "Ada's iPad"), renamed)
    }

    @Test
    fun cancelPutsTheRowBack() {
        show()
        rule.onNodeWithContentDescription(copy.format(copy.deviceRenameDescription, "Ada's tablet")).performClick()
        rule.onNodeWithText(copy.cancel).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(copy.deviceRenameLabel).assertDoesNotExist()
        rule.onNodeWithContentDescription(copy.format(copy.deviceRenameDescription, "Ada's tablet")).assertIsDisplayed()
    }

    @Test
    fun removeAsksInlineWithTheConsequenceBeforeTheButton() {
        show()
        rule.onNodeWithContentDescription(copy.format(copy.deviceDeauthorizeDescription, "Ada's tablet")).performClick()
        rule.waitForIdle()
        rule.onAllNodes(isDialog()).assertCountEquals(0)
        rule.onNodeWithText(copy.format(copy.deviceRemoveConfirm, "Ada's tablet", "Diceroll")).assertIsDisplayed()
        assertEquals(emptyList<String>(), removed)
        rule.onNodeWithText(copy.deviceDeauthorize).performClick()
        assertEquals(listOf("dev_2"), removed)
    }

    @Test
    fun theCurrentDeviceIsTaggedByWhatItIs() {
        show()
        rule.onNodeWithText("This phone").assertIsDisplayed()
        rule.onNodeWithText(copy.deviceThis).assertDoesNotExist()
    }
}
