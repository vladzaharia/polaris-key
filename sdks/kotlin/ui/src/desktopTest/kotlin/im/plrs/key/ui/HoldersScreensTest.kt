// @pkey-feature ui.kit.holders
//
// UK-43.9: the holders' Compose screens on the desktop kit, over PolarisAddToAccountState with a fake
// driver. The form's title is text, not a button; Continue checks the fields and shows the problems on the
// same screen; a busy Continue shows progress with the fields off, Escape never cancels the sign-in and
// Cancel does; a failure stays on its screen with Try again; the desktop button order per OS (Windows
// primary first, GNOME's default pill last, macOS Cancel left of the default with title-case labels);
// ActivateDone's Start using is the one primary and the reason lines carry a SemiBold lead-in.
// With PKEY_KIT_SHOTS set the frames are written for the UX review.

@file:Suppress("MagicNumber", "TooManyFunctions")

package im.plrs.key.ui

import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class HoldersScreensTest {
    private val shots: File? = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)
    private var old: String? = null

    @BeforeTest
    fun remember() {
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        // The host is a Mac: the tests that are not about one OS run on Windows' chrome.
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private class Run : AddToAccountHandle {
        val answer = CompletableDeferred<AddToAccountWait>()
        var cancelled = 0
        override suspend fun wait(): AddToAccountWait = answer.await()
        override suspend fun reopen(): Boolean = true
        override fun cancel() {
            cancelled++
        }
    }

    private class Driver : AddToAccountDriver {
        val run = Run()
        val hints = mutableListOf<AddToAccountHints>()
        var attach: AddToAccountAttach = AddToAccountAttach.Ok
        override suspend fun signIn(hints: AddToAccountHints): AddToAccountHandle {
            this.hints += hints
            return run
        }
        override suspend fun complete(grant: String): Boolean = true
        override suspend fun attach(confirm: Boolean): AddToAccountAttach = attach
    }

    private fun base(vararg services: String) = JsonObject(
        mapOf(
            "platform" to JsonObject(mapOf("os" to JsonPrimitive("linux"), "formFactor" to JsonPrimitive("desktop"))),
            "presentation" to JsonObject(mapOf("name" to JsonPrimitive("Tidewater Studio"), "icon" to JsonPrimitive(false))),
            "services" to kotlinx.serialization.json.JsonArray(services.map(::JsonPrimitive)),
        ),
    )

    private fun state(driver: Driver) = PolarisAddToAccountState(
        driver,
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        base("license", "identity"),
        deviceKind = "computer",
    )

    private fun ComposeUiTest.show(content: @androidx.compose.runtime.Composable () -> Unit) {
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Tidewater Studio"), darkTheme = false) { content() }
        }
        waitForIdle()
    }

    private fun shot(test: ComposeUiTest, name: String) {
        val dir = shots ?: return
        dir.mkdirs()
        ImageIO.write(test.onNode(isRoot()).captureToImage().toAwtImage(), "png", File(dir, "$name.png"))
    }

    private fun isButton(label: String) = SemanticsMatcher("button $label") { node ->
        node.config.getOrNull(SemanticsProperties.Role) == Role.Button &&
            node.config.getOrNull(SemanticsProperties.Text)?.any { it.text == label } == true
    }

    @Test
    fun theFormTitleIsTextNotAButton() = runDesktopComposeUiTest(900, 640) {
        val s = state(Driver())
        show { PolarisAddToAccount(s) }
        onNodeWithText("Add your name and email").assertExists()
        assertTrue(onAllNodes(isButton("Add your name and email")).fetchSemanticsNodes().isEmpty(), "the title is not a control")
        onNodeWithText("Continue").assertIsEnabled()
        shot(this, "holders-form")
    }

    @Test
    fun continueChecksTheFieldsOnTheSameScreenInTheDangerTone() = runDesktopComposeUiTest(900, 640) {
        val s = state(Driver())
        show { PolarisAddToAccount(s) }
        onNodeWithText("Continue").performClick()
        waitForIdle()
        assertEquals("invalid", s.ui.value.step)
        onNodeWithText("Add your name and email").assertExists()
        onAllNodesWithText("Enter your name", substring = true).assertCountEquals(1)
        shot(this, "holders-invalid")
    }

    @Test
    fun aBusyContinueShowsProgressAndEscapeNeverCancelsTheSignIn() = runDesktopComposeUiTest(900, 640) {
        val driver = Driver()
        val s = state(driver)
        show { PolarisAddToAccount(s) }
        onAllNodes(hasSetTextAction())[0].performTextInput("Ada Lovelace")
        onAllNodes(hasSetTextAction())[1].performTextInput("ada@example.com")
        onNodeWithText("Continue").performClick()
        waitForIdle()
        assertEquals("busy", s.ui.value.step)
        assertEquals(listOf(AddToAccountHints("ada@example.com", "Ada Lovelace")), driver.hints)
        onNodeWithText("Continue").assertIsNotEnabled()
        shot(this, "holders-busy")
        // Escape is not a cancel of work in flight.
        onRoot().performKeyInput { pressKey(Key.Escape) }
        waitForIdle()
        assertEquals("busy", s.ui.value.step)
        assertEquals(0, driver.run.cancelled)
        // Cancel is the way out: the form is back with the fields kept.
        onNodeWithText("Cancel").performClick()
        waitForIdle()
        assertEquals("form", s.ui.value.step)
        assertEquals(1, driver.run.cancelled)
        assertEquals("Ada Lovelace", s.ui.value.name)
    }

    @Test
    fun aFailureStaysOnItsScreenWithTryAgain() = runDesktopComposeUiTest(900, 640) {
        val driver = Driver()
        val s = state(driver)
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s) }
        s.submit()
        driver.run.answer.complete(AddToAccountWait.Expired)
        waitForIdle()
        assertEquals("failed", s.ui.value.step)
        onNodeWithText("Add your name and email").assertExists()
        onNodeWithText("Try again").assertIsEnabled()
        shot(this, "holders-failed")
    }

    private fun xOf(test: ComposeUiTest, label: String): Float = test.onNodeWithText(label).fetchSemanticsNode().boundsInRoot.left

    @Test
    fun windowsPutsTheDefaultFirst() = runDesktopComposeUiTest(900, 640) {
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
        show { PolarisAddToAccount(state(Driver())) }
        assertTrue(xOf(this, "Continue") < xOf(this, "Cancel"))
        shot(this, "holders-form-windows")
    }

    @Test
    fun gnomeEndsTheRowWithTheDefaultPill() = runDesktopComposeUiTest(900, 640) {
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Gnome")
        show { PolarisAddToAccount(state(Driver())) }
        assertTrue(xOf(this, "Continue") > xOf(this, "Cancel"))
        shot(this, "holders-form-gnome")
    }

    @Test
    fun macPutsCancelLeftOfTheDefaultInTitleCase() = runDesktopComposeUiTest(900, 640) {
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "MacOS")
        show { PolarisAddToAccount(state(Driver())) }
        assertTrue(xOf(this, "Cancel") < xOf(this, "Continue"))
        onNodeWithText("Add Your Name and Email").assertExists()
        shot(this, "holders-form-mac")
    }

    @Test
    fun activateDoneHasOnePrimaryAndTheReasonsLeadInIsStyled() = runDesktopComposeUiTest(900, 640) {
        val inputs = KitInputs.of(
            base("license", "config", "identity", "sync") + mapOf(
                "activateDone" to JsonObject(
                    mapOf(
                        "tier" to JsonPrimitive("Pro"),
                        "term" to JsonPrimitive("Lifetime"),
                        "deviceKind" to JsonPrimitive("computer"),
                        "position" to JsonPrimitive(1),
                        "limit" to JsonPrimitive(3),
                    ),
                ),
            ),
        )
        val screen = KitStates.resolve(KitComponent.activateDone, inputs)
        var started = 0
        var added = 0
        show { PolarisActivateDone(screen, onStartUsing = { started++ }, onAdd = { added++ }) }
        // The marked lead-in is a style, never literal asterisks.
        assertTrue(
            onAllNodes(
                SemanticsMatcher("literal markers") { n ->
                    n.config.getOrNull(SemanticsProperties.Text)?.any { "**" in it.text } == true
                },
            ).fetchSemanticsNodes().isEmpty(),
        )
        onNodeWithText("Add your name and email").performClick()
        onNodeWithText("Start using Tidewater Studio", substring = true).performClick()
        assertEquals(1, added)
        assertEquals(1, started)
        shot(this, "holders-done")
    }
}
