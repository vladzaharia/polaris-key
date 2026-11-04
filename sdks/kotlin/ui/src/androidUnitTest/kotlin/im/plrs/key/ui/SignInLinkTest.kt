// @pkey-feature identity.link
// @pkey-feature identity.redirect.native
// Rung 6 and the link steps as the sign-in screen draws them: the browser hand-off (Open browser again,
// Use a code instead, Cancel), the link offer (the link, No thanks), its two results and the two problems
// that keep the person on the offer. Copy comes from the kit's table, so a wording change moves nothing here.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class SignInLinkTest {
    @get:Rule
    val rule = createComposeRule()

    private var screen by mutableStateOf<@Composable () -> Unit>({})

    private val locale = java.util.Locale.getDefault().toLanguageTag()
    private fun t(key: String, vararg args: Pair<String, String>): String =
        KitCopy.bundled.format(key, locale, args.associate { it.first to CopyArgument.Text(it.second) })

    private val calls = mutableListOf<String>()
    private val steps = PolarisSignInSteps(
        onReopen = { calls += "reopen" },
        onLinkCopied = { calls += "copied" },
        redirectLink = { "https://key.example/authorize?client_id=c&request_uri=r" },
        onUseCode = { calls += "code" },
        onLinkAccept = { calls += "accept" },
        onLinkDecline = { calls += "decline" },
        onLinkFinished = { calls += "finished" },
        onLinkSignInAgain = { calls += "again" },
    )

    private fun show(ui: PolarisSignInUi) {
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { screen() } } }
        rule.runOnIdle { screen = { PolarisSignInScreen(ui, onCancel = { calls += "cancel" }, steps = steps) } }
        rule.waitForIdle()
    }

    private fun click(text: String) {
        rule.onNodeWithText(text).performClick()
        rule.waitForIdle()
    }

    private fun headings(): Int = rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).fetchSemanticsNodes().size

    @Test
    fun theHandOffOffersOpenAgainACodeAndCancel() {
        show(PolarisSignInUi.Redirecting())
        rule.onNodeWithText(t("signin.handoff.title")).assertExists()
        click(t("signin.handoff.again"))
        click(t("signin.handoff.useCode"))
        click(t("common.cancel"))
        assertEquals(listOf("reopen", "code", "cancel"), calls)
    }

    @Test
    fun withNoBrowserTheLinkCanBeCopied() {
        show(PolarisSignInUi.Redirecting(opened = false))
        rule.onNodeWithText(t("signin.handoff.noBrowser")).assertExists()
        click(t("signin.handoff.copyLink"))
        assertEquals(listOf("copied"), calls)
    }

    @Test
    fun theLinkOfferIsOneDecision() {
        show(PolarisSignInUi.LinkOffer("Google", "global"))
        rule.onNodeWithText(t("signin.linkOffer.title", "provider" to "Google")).assertExists()
        assertEquals("one heading", 1, headings())
        click(t("signin.linkOffer.primary", "provider" to "Google"))
        click(t("signin.linkOffer.decline"))
        assertEquals(listOf("accept", "decline"), calls)
    }

    @Test
    fun aPerDeveloperOfferNamesTheDeveloperOrTheApp() {
        show(PolarisSignInUi.LinkOffer("Apple", null))
        // No developer name in a stock host: the app-and-its-developer's-others line.
        rule.onNode(hasText(t("signin.linkOffer.bodyApp", "app" to "Diceroll"))).assertExists()
    }

    @Test
    fun linkedAndConflictEndWithDone() {
        show(PolarisSignInUi.LinkDone("Google"))
        rule.onNodeWithText(t("signin.linkOffer.done", "provider" to "Google")).assertExists()
        click(t("common.done"))
        assertEquals(listOf("finished"), calls)
    }

    @Test
    fun aConflictSaysYouAreStillSignedInAndPointsToHelp() {
        show(PolarisSignInUi.LinkConflict("Google"))
        rule.onNodeWithText(t("signin.linkOffer.conflictTitle", "provider" to "Google")).assertExists()
        rule.onNode(hasText(t("signin.linkOffer.conflict", "provider" to "Google"))).assertExists()
        rule.onNodeWithText(t("signin.linkOffer.join")).assertExists()
        click(t("common.done"))
        assertEquals(listOf("finished"), calls)
    }

    @Test
    fun aStaleSignInAsksToSignInAgain() {
        show(PolarisSignInUi.LinkOffer("Google", "global", problem = PolarisSignInUi.LinkProblem.Stale))
        rule.onNode(hasText(t("signin.linkOffer.stale", "provider" to "Google"))).assertExists()
        click(t("signin.again"))
        click(t("signin.linkOffer.decline"))
        assertEquals(listOf("again", "decline"), calls)
    }

    @Test
    fun aRefusedDeviceLeavesOnlyNoThanks() {
        show(PolarisSignInUi.LinkOffer("Google", "global", problem = PolarisSignInUi.LinkProblem.Failed))
        rule.onNode(hasText(t("signin.linkOffer.failed", "provider" to "Google"))).assertExists()
        assertTrue(rule.onAllNodes(hasText(t("signin.linkOffer.primary", "provider" to "Google"))).fetchSemanticsNodes().isEmpty())
        click(t("signin.linkOffer.decline"))
        assertEquals(listOf("decline"), calls)
    }
}
