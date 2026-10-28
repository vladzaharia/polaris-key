// @pkey-feature identity.autosignin ui.signin
//
// I-45.6: the gate's automatic sign-in on the Compose desktop kit. The consent (with the license line's
// arguments), the licence choice, the device limit and the sign-in form are drawn from the v7 states;
// Continue completes the consent, "Use another account" goes to the form; the provider row only exists
// with a provider; the gate runs the ladder once, and `autoSignIn = false` runs none. With
// PKEY_KIT_SHOTS set, the confirm / needs-sign-in / device-limit frames are written (light and dark, font
// scale 1 and 2) for the UX review.

package im.plrs.key.ui

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.graphics.toAwtImage
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.identity.AutoSignInReason
import im.plrs.key.identity.AutoSignInResult
import im.plrs.key.identity.ChoiceCompleted
import im.plrs.key.identity.ChoiceResult
import im.plrs.key.identity.ConsentInput
import im.plrs.key.identity.ExchangeConsentView
import im.plrs.key.identity.ExchangeOutcome
import im.plrs.key.identity.LicenseChoiceView
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class AutoSignInScreensTest {
    private val shots: File? = System.getenv("PKEY_KIT_SHOTS")?.takeIf { it.isNotBlank() }?.let(::File)
    private val grant = "sg_" + "B".repeat(43)
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private val consent = ExchangeConsentView.of(
        obj(
            """{"client":{"appName":"Tidewater Studio","nameVerified":true},"as":{"provider":"google","email":"sam@example.com"},""" +
                """"items":[{"kind":"license","anchor":{"name":"Tidewater Pro","tierName":"Pro","term":1893456000,"seat":{"position":2,"limit":3}},"more":0},""" +
                """{"kind":"profile","claims":["name","email"]}],"scopeHash":"abc","firstTime":true,"changed":false}""",
        ),
    )!!

    private val full = LicenseChoiceView.of(
        obj(
            """{"state":"choose","choices":[{"id":"lic_1","state":"full","tierName":"Pro","name":"Tidewater Pro","origin":"signin","seats":{"used":3,"limit":3},"replace":{"allowed":true}}]}""",
        ),
    )!!

    /** The same row with Replace refused (the developer manages devices): the lede names them, no Replace button. */
    private val fullManaged = LicenseChoiceView.of(
        obj(
            """{"state":"choose","choices":[{"id":"lic_1","state":"full","tierName":"Pro","name":"Tidewater Pro","origin":"signin","seats":{"used":3,"limit":3},"replace":{"allowed":false,"retryAfter":null}}]}""",
        ),
    )!!

    private class Fake(var ladder: AutoSignInResult, override val hasProvider: Boolean = true) : PolarisAutoSignInActions {
        var calls = 0
        var providerCalls = 0
        var providerResult: AutoSignInResult = AutoSignInResult.SignedIn("ps_x", "lic")
        var completed: ConsentInput? = null
        var cancelled = false
        override suspend fun autoSignIn(): AutoSignInResult = ladder.also { calls++ }
        override suspend fun completeConsent(grant: String, consent: ConsentInput): ChoiceResult<ChoiceCompleted> {
            completed = consent
            return ChoiceResult.Ok(ChoiceCompleted("lic", "ps_x", "profile"))
        }
        override suspend fun cancelGrant(grant: String) { cancelled = true }
        override suspend fun providerSignIn(): AutoSignInResult = providerResult.also { providerCalls++ }
        override fun choiceActions(): PolarisLicenseChoiceActions = object : PolarisLicenseChoiceActions {
            override suspend fun licenses(grant: String) = error("unused")
            override suspend fun devices(grant: String, licenseId: String) = error("unused")
            override suspend fun complete(grant: String, choice: im.plrs.key.identity.LicenseChoice) = error("unused")
            override suspend fun cancel(grant: String) = ChoiceResult.Ok(Unit)
        }
    }

    private fun stateOf(fake: Fake, enabled: Boolean = true): PolarisAutoSignInState =
        PolarisAutoSignInState(fake, CoroutineScope(Dispatchers.Unconfined), enabled).also { it.start() }

    private fun shot(name: String, dark: Boolean, scale: Float, test: ComposeUiTest) {
        val out = shots ?: return
        val roots = test.onAllNodes(isRoot())
        val image = roots[roots.fetchSemanticsNodes().size - 1].captureToImage()
        val file = File(out, "$name-${if (dark) "dark" else "light"}-fs${scale.toInt()}.png")
        file.parentFile.mkdirs()
        ImageIO.write(image.toAwtImage(), "png", file)
    }

    private fun texts(test: ComposeUiTest, vararg wanted: String) {
        val shown = test.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("text") { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.Text) }, useUnmergedTree = true)
            .fetchSemanticsNodes().flatMap { it.config[androidx.compose.ui.semantics.SemanticsProperties.Text] }.map { it.text }
        for (t in wanted) assertTrue(shown.any { it.contains(t, ignoreCase = true) }, "missing: $t in $shown")
    }

    @Test
    fun theConsentShowsTheLicenseLineAndContinueCompletesIt() {
        val fake = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val state = stateOf(fake)
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(state) }, after = {
            texts(this, "Continue to Tidewater Studio", "as sam@example.com", "Tidewater Pro", "becomes device 2 of 3", "Use another account")
            onNodeWithText("Continue").performClick()
            waitForIdle()
            assertEquals(ConsentInput(listOf("name", "email")), fake.completed)
            assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
        })
        // Use another account: the grant is given up and the form shows; a provider installed, so its row says Google.
        val other = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val second = stateOf(other)
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(second) }, after = {
            onNodeWithText("Use another account", ignoreCase = true).performClick()
            waitForIdle()
            assertTrue(other.cancelled)
            texts(this, "Continue with Google")
            onNodeWithText("Continue with Google", ignoreCase = true).performClick()
            waitForIdle()
            assertEquals(1, other.providerCalls)
        })
    }

    @Test
    fun noProviderNoGoogleRowAndTheDesktopLadderFallsBackSilently() {
        val form = stateOf(Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.Terms), hasProvider = false))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(form) }, after = {
            assertTrue(onAllNodesWithText("Continue with Google").fetchSemanticsNodes().isEmpty())
        })
        val desktop = stateOf(Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.NoCredential), hasProvider = false))
        assertEquals(PolarisAutoSignInUi.Idle, desktop.ui.value)
    }

    @Test
    fun theDeviceLimitOffersReplaceInTheBrowser() {
        val state = stateOf(Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", full)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(state) }, after = {
            texts(this, "Replace")
        })
    }

    @Test
    fun theDeviceLimitWithRowsOffersReplaceOnlyWhenSomeRowCanBeReplaced() {
        val managed = stateOf(Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", fullManaged)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(managed) }, after = {
            texts(this, "manages devices", "Use another account", "Cancel")
            assertTrue(onAllNodesWithText("Replace a device", ignoreCase = true).fetchSemanticsNodes().isEmpty())
        })
        val replaceable = stateOf(Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", full)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(replaceable) }, after = {
            texts(this, "Replace a device", "Use another account", "Cancel")
            onNodeWithText("Use another account", ignoreCase = true).performClick()
            waitForIdle()
            assertTrue(replaceable.ui.value is PolarisAutoSignInUi.SignInForm)
        })
    }

    @Test
    fun theLimitWithNoRowsIsItsOwnStepAndNeverTheKeyScreen() {
        val state = stateOf(Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(state) }, after = {
            texts(this, "Device limit reached", "Replace a device", "Use another account", "Cancel")
            assertTrue(onAllNodesWithText("Use a different key", ignoreCase = true).fetchSemanticsNodes().isEmpty())
            onNodeWithText("Use another account", ignoreCase = true).performClick()
            waitForIdle()
            assertTrue(state.ui.value is PolarisAutoSignInUi.SignInForm)
        })
        val cancel = stateOf(Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(cancel) }, after = {
            onNodeWithText("Cancel", ignoreCase = true).performClick()
            waitForIdle()
            assertEquals(PolarisAutoSignInUi.Idle, cancel.ui.value)
        })
        // Without a link the fix is named in words and there is no Replace.
        val bare = stateOf(Fake(AutoSignInResult.DeviceLimit(null, null)))
        matrixFrame(420, 760, dark = false, content = { PolarisAutoSignIn(bare) }, after = {
            texts(this, "Sign out of", "Cancel")
            assertTrue(onAllNodesWithText("Replace a device", ignoreCase = true).fetchSemanticsNodes().isEmpty())
        })
    }

    @Test
    fun comingBackFromTheBrowserAfterReplaceSignsInAgain() {
        val fake = Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null))
        val state = stateOf(fake)
        val foreground = androidx.compose.runtime.mutableStateOf(true)
        matrixFrame(
            420, 760, dark = false,
            content = {
                androidx.compose.runtime.CompositionLocalProvider(LocalPolarisForeground provides { foreground.value }) { PolarisAutoSignIn(state) }
            },
            after = {
                state.replaceOpened()
                waitForIdle()
                // Still in front: nothing runs. Away and back: the provider sign-in runs once.
                assertEquals(0, fake.providerCalls)
                foreground.value = false
                waitForIdle()
                assertEquals(0, fake.providerCalls)
                foreground.value = true
                waitForIdle()
                assertEquals(1, fake.providerCalls)
                assertEquals(PolarisAutoSignInUi.Done, state.ui.value)
            },
        )
    }

    @Test
    fun theGateRunsTheLadderOnceAndTheOptOutRunsNone() {
        val fake = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val actions = object : PolarisGateActions {
            override val autoSignIn: PolarisAutoSignInActions = fake
            override suspend fun status(): LicenseState = LicenseState(LicenseStatus.needsActivation)
            override suspend fun activate(key: String): ActivationResult = ActivationResult.Error("unused")
        }
        val gate = PolarisGateState(actions, CoroutineScope(Dispatchers.Unconfined)).also { it.start() }
        matrixFrame(420, 760, dark = false, content = { PolarisGate(gate) { androidx.compose.material3.Text("Product") } }, after = {
            texts(this, "Use another account")
        })
        assertEquals(1, fake.calls)
        val off = Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent)))
        val quiet = PolarisGateState(object : PolarisGateActions {
            override val autoSignIn: PolarisAutoSignInActions = off
            override suspend fun status(): LicenseState = LicenseState(LicenseStatus.needsActivation)
            override suspend fun activate(key: String): ActivationResult = ActivationResult.Error("unused")
        }, CoroutineScope(Dispatchers.Unconfined), autoSignIn = false).also { it.start() }
        matrixFrame(420, 760, dark = false, content = { PolarisGate(quiet) { androidx.compose.material3.Text("Product") } }, after = {
            assertTrue(onAllNodesWithText("Use another account", ignoreCase = true).fetchSemanticsNodes().isEmpty())
        })
        assertEquals(0, off.calls)
    }

    @Test
    fun shotsForTheReview() {
        if (shots == null) return
        val frames = mapOf(
            "confirm" to Fake(AutoSignInResult.Confirm(ExchangeOutcome.PendingConsent(grant, 300.0, consent))),
            "needs-sign-in" to Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.Terms)),
            "needs-sign-in-nogoogle" to Fake(AutoSignInResult.NeedsSignIn(null, AutoSignInReason.Terms), hasProvider = false),
            "device-limit" to Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", full)),
            "device-limit-managed" to Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", fullManaged)),
            "device-limit-no-rows" to Fake(AutoSignInResult.DeviceLimit("https://polaris.locker/manage", null)),
        )
        // The Android phone layout at 420 x 760 and the macOS desktop layout at 900 x 640.
        for ((variant, size) in listOf("Android" to (420 to 760), "MacOS" to (900 to 640))) withPlatform(variant) {
            for ((name, fake) in frames) for (dark in listOf(false, true)) for (scale in listOf(1f, 2f)) {
                val state = stateOf(Fake(fake.ladder, fake.hasProvider))
                matrixFrame(size.first, size.second, dark = dark, fontScale = scale, content = { PolarisAutoSignIn(state) }, after = { shot("${variant.lowercase()}-$name", dark, scale, this) })
            }
        }
    }
}
