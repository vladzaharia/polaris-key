// @pkey-feature ui.kit ui.gate ui.signin ui.paywall ui.settings
// The generic kit screen (PolarisKitScreen over a KitStates answer) against UI-KITS.md: no dangling
// text (DL8), the product heads every screen but the Welcome, whose hero icon, one primary, tonal
// secondary and quiet row of extras are 4.3's, the key field with its paste control inside it, the
// seat meter, the account pane's grouped rows with Sign out in its own group, and the toast.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class KitScreenLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun case(id: String): KitScreen = MatrixCases.all.first { it.id == id }.screen

    private fun show(screen: KitScreen, onAction: (KitAction?) -> Unit = {}) {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Diceroll"), darkTheme = false) {
                    androidx.compose.runtime.CompositionLocalProvider(LocalPolarisReduceMotion provides true) {
                        PolarisKitScreen(screen, onAction = onAction)
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    private fun texts(): List<String> =
        rule.onAllNodes(SemanticsMatcher("has text") { it.config.contains(SemanticsProperties.Text) }, useUnmergedTree = true)
            .fetchSemanticsNodes()
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }
            .map { it.text.trim() }
            .filter { it.isNotEmpty() }

    @Test
    fun aLineWithAnUnfilledArgumentIsDangling() {
        val catalog = KitCopy.bundled
        assertTrue(catalog.isDangling(CopyLine("signin.choice.origin.store")))
        assertTrue(catalog.isDangling(CopyLine("account.tier", mapOf("tier" to CopyArgument.Text("")))))
        assertTrue(catalog.isDangling(CopyLine("signin.choice.devices", mapOf("used" to CopyArgument.Number(0), "limit" to CopyArgument.Number(0)))))
        assertFalse(catalog.isDangling(CopyLine("part.seatMeter.caption", mapOf("used" to CopyArgument.Number(3), "limit" to CopyArgument.Number(3)))))
        assertFalse(catalog.isDangling(CopyLine("common.cancel")))
    }

    @Test
    fun noMatrixStateDrawsAnUnfilledPlaceholderOrAFragment() {
        val catalog = KitCopy.bundled
        for (case in MatrixCases.all) {
            for (line in case.screen.copy.filterNot { catalog.isDangling(it) }) {
                val text = catalog.format(line, "en")
                assertFalse("${case.id}/${line.key} shows a placeholder: $text", '{' in text || '}' in text)
                assertFalse("${case.id}/${line.key} shows an empty count: $text", Regex("""\b0 of 0\b""").containsMatchIn(text))
            }
        }
    }

    @Test
    fun theWelcomeIsHeroIconTitleDeveloperLedePrimarySecondaryAndAQuietRow() {
        show(case("welcome-default"))
        val t = texts()
        assertTrue("title: $t", "Welcome to Tidewater Studio" in t)
        assertTrue("developer: $t", "by Harbor Audio" in t)
        assertTrue("T" in t) // the monogram of the product the lines name, at hero size
        // Sign in is the filled primary; Use a license key the tonal secondary, the same width.
        val signIn = rule.onNodeWithText("Sign in").getUnclippedBoundsInRoot()
        val useKey = rule.onNodeWithText("Use a license key").getUnclippedBoundsInRoot()
        assertEquals(signIn.right - signIn.left, useKey.right - useKey.left)
        assertTrue(useKey.top > signIn.bottom)
        // The extras are links, not buttons of that width, and sit below with no divider.
        for (extra in listOf("Start a free trial", "Continue free", "Restore purchase", "Activate offline")) {
            val bounds = rule.onNodeWithText(extra).getUnclippedBoundsInRoot()
            assertTrue("$extra is a link: ${bounds.right - bounds.left}", bounds.right - bounds.left < (signIn.right - signIn.left) - 24.dp)
            assertTrue("$extra is under the secondary", bounds.top >= useKey.bottom)
        }
    }

    @Test
    fun theKeyFieldKeepsPasteInsideItAndTheShapeErrorUnderIt() {
        show(case("activate-rejected"))
        rule.onNodeWithText("License key").assertIsDisplayed()
        rule.onNodeWithContentDescription("Paste").assertIsDisplayed()
        rule.onNodeWithText("That doesn't look like a license key. Keys start with pkey_.").assertIsDisplayed()
        // Paste is not also a line of text under the lede.
        assertEquals(0, texts().count { it == "Paste" })
    }

    @Test
    fun theDeviceLimitStepDrawsTheMeterAfterItsLede() {
        show(case("deviceLimit-default"))
        val lede = rule.onNodeWithText("To use it on this Mac, replace one. You can add it back later.").getUnclippedBoundsInRoot()
        val caption = rule.onNodeWithText("3 of 3 in use").getUnclippedBoundsInRoot()
        assertTrue("the meter and its caption come after the lede", caption.top > lede.bottom)
        rule.onNodeWithText("Replace Work laptop?").assertIsDisplayed()
        rule.onNodeWithText("Replace and continue").assertIsDisplayed()
    }

    @Test
    fun theAccountPaneIsGroupedRowsWithSignOutAloneAndNoDuplicateButtons() {
        val actions = mutableListOf<KitAction?>()
        show(case("accountAndLicense-signed-in")) { actions += it }
        rule.onNodeWithText("Manage ↗").assertIsDisplayed()
        // One Sign out, and the row is the control: no button list repeats the rows.
        assertEquals(1, texts().count { it == "Sign out" })
        assertEquals(1, texts().count { it == "Check for updates" })
        rule.onNodeWithText("Manage ↗").performClick()
        // Manage is a control the action vocabulary has no entry for: the host gets null and opens the portal itself.
        assertEquals(listOf<KitAction?>(null), actions)
    }

    @Test
    fun theUpdatePromptHasNoStrayWhatsNewLabel() {
        show(case("updatePrompt-available"))
        val t = texts()
        assertFalse("a label with nothing under it: $t", "What's new" in t)
        assertTrue("Update now" in t)
        assertTrue("Later" in t)
    }

    @Test
    fun theProductHeadsAScreenThatIsNotTheWelcome() {
        show(case("statusScreen-revoked"))
        assertTrue("the product's name heads the stop: ${texts()}", "Tidewater Studio" in texts())
    }

    @Test
    fun aStateWithNothingToSayDrawsNoHeaderEither() {
        show(case("gate-licensed"))
        assertEquals("a licensed gate is the product, not a screen: ${texts()}", emptyList<String>(), texts())
    }
}
