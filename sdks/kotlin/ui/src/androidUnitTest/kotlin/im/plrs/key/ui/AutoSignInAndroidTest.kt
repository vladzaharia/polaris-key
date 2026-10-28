// @pkey-feature identity.autosignin ui.signin
//
// Two Android edges of the automatic sign-in steps:
//   - the return signal after Replace is the host lifecycle (ON_PAUSE then ON_RESUME), so a browser that
//     never takes window focus away is still seen coming back;
//   - with a screen reader reading by touch, the step's heading takes focus when the step appears and
//     when it changes (TalkBack then reads where the person is before any control).

package im.plrs.key.ui

import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeConsentView
import im.plrs.key.identity.ExchangeOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class AutoSignInAndroidTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val grant = "sg_" + "B".repeat(43)
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private val consent = ExchangeConsentView.of(
        obj(
            """{"client":{"appName":"Tidewater Studio","nameVerified":true},"as":{"provider":"google","email":"sam@example.com"},""" +
                """"items":[{"kind":"profile","claims":["name","email"]}],"scopeHash":"abc","firstTime":true,"changed":false}""",
        ),
    )!!

    private class Fake(var ladder: AutoSignInResult) : PolarisAutoSignInActions {
        var providerCalls = 0
        override val hasProvider: Boolean = true
        override suspend fun autoSignIn(): AutoSignInResult = ladder
        override suspend fun completeConsent(grant: String, consent: ConsentInput): ChoiceResult<ChoiceCompleted> =
            ChoiceResult.Ok(ChoiceCompleted("lic", "ps_x", "profile"))
        override suspend fun cancelGrant(grant: String) = Unit
        override suspend fun providerSignIn(): AutoSignInResult = AutoSignInResult.SignedIn("ps_x", "lic").also { providerCalls++ }
        override fun choiceActions(): PolarisLicenseChoiceActions = object : PolarisLicenseChoiceActions {
            override suspend fun licenses(grant: String) = error("unused")
            override suspend fun devices(grant: String, licenseId: String) = error("unused")
            override suspend fun complete(grant: String, choice: im.plrs.key.identity.LicenseChoice) = error("unused")
            override suspend fun cancel(grant: String) = ChoiceResult.Ok(Unit)
        }
    }

    private fun stateOf(fake: Fake) = PolarisAutoSignInState(fake, CoroutineScope(Dispatchers.Unconfined), true).also { it.start() }

    private fun move(to: Lifecycle.State) {
        rule.activityRule.scenario.moveToState(to)
        rule.waitForIdle()
    }

    @Test
    fun returningToTheAppAfterReplaceSignsInAgainWithoutAnyWindowFocusChange() {
        val fake = Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null))
        val state = stateOf(fake)
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisAutoSignIn(state) } } }
        rule.waitForIdle()
        state.replaceOpened()
        rule.waitForIdle()
        // Nothing runs while the app stays in front.
        assertEquals(0, fake.providerCalls)
        // The browser covers the app (ON_PAUSE): still nothing. Back (ON_RESUME): the sign-in runs once.
        move(Lifecycle.State.STARTED)
        assertEquals(0, fake.providerCalls)
        move(Lifecycle.State.RESUMED)
        assertEquals(1, fake.providerCalls)
        // A later pause and resume with no Replace in between does not run it again.
        move(Lifecycle.State.STARTED)
        move(Lifecycle.State.RESUMED)
        assertEquals(1, fake.providerCalls)
        assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
    }

    private fun focusedHeading(): String? = rule.onAllNodes(
        SemanticsMatcher("focused heading") {
            it.config.getOrNull(SemanticsProperties.Heading) != null && it.config.getOrNull(SemanticsProperties.Focused) == true
        },
        useUnmergedTree = true,
    ).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString { it.text }

    @Test
    fun withTouchExplorationTheHeadingTakesFocusWhenTheStepChanges() {
        val manager = ApplicationProvider.getApplicationContext<Context>().getSystemService(AccessibilityManager::class.java)
        shadowOf(manager).setTouchExplorationEnabled(true)
        val state = stateOf(Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent))))
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisAutoSignIn(state) } } }
        rule.waitForIdle()
        val first = focusedHeading()
        assertTrue("the consent heading is focused, was $first", first?.contains("Continue to") == true)
        rule.onNodeWithText("Use another account", ignoreCase = true).performClick()
        rule.waitForIdle()
        val second = focusedHeading()
        assertTrue("the next step's heading is focused, was $second", second != null && second != first)
    }

    @Test
    fun withoutTouchExplorationNoHeadingIsFocused() {
        val state = stateOf(Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent))))
        rule.setContent { StockHost(false) { PolarisTheme(copy = sampleCopy, darkTheme = false) { PolarisAutoSignIn(state) } } }
        rule.waitForIdle()
        assertEquals(null, focusedHeading())
    }
}
