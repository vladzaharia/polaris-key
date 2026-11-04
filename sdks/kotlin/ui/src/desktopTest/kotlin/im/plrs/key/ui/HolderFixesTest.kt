// @pkey-feature ui.kit.holders
//
// UK-43.10 fix round (UX pass C): typing after a wrong field lands in the right field; the code's copy button copies the
// code; the device-code wait shows where to go; a license waiting for an email signs in for that address; email-bound
// and other-account lead with the web's primary; the license line without a term; the card at large type; the desktop
// action row inside the content column; the TV QR with no link.

@file:Suppress("MagicNumber", "TooManyFunctions")

package im.plrs.key.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class HolderFixesTest {
    private var old: String? = null

    @BeforeTest
    fun forceWindows() {
        old = System.getProperty(PolarisPlatformVariant.FORCE_PROPERTY)
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Windows")
    }

    @AfterTest
    fun restore() {
        old?.let { System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, it) } ?: System.clearProperty(PolarisPlatformVariant.FORCE_PROPERTY)
    }

    private class Run(override val userCode: String? = null, override val address: String? = null, override val link: String? = null) :
        AddToAccountHandle {
        val answer = CompletableDeferred<AddToAccountWait>()
        var reopened = 0
        override suspend fun wait(): AddToAccountWait = answer.await()
        override suspend fun reopen(): Boolean {
            reopened++
            return true
        }
        override fun cancel() = Unit
    }

    private class Driver(val run: Run = Run(), var attach: AddToAccountAttach = AddToAccountAttach.Ok) : AddToAccountDriver {
        override suspend fun signIn(hints: AddToAccountHints): AddToAccountHandle = run
        override suspend fun complete(grant: String): Boolean = true
        override suspend fun attach(confirm: Boolean): AddToAccountAttach = attach
    }

    private fun base(vararg services: String, extra: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap()) = JsonObject(
        mapOf(
            "platform" to JsonObject(mapOf("os" to JsonPrimitive("linux"), "formFactor" to JsonPrimitive("desktop"))),
            "presentation" to JsonObject(mapOf("name" to JsonPrimitive("Tidewater Studio"), "icon" to JsonPrimitive(false))),
            "services" to JsonArray(services.map(::JsonPrimitive)),
        ) + extra,
    )

    private fun state(driver: Driver, holder: String? = null) = PolarisAddToAccountState(
        driver,
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        base("license", "identity", extra = holder?.let { mapOf("licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive(it)))) } ?: emptyMap()),
        deviceKind = "computer",
    )

    private fun ComposeUiTest.show(content: @androidx.compose.runtime.Composable () -> Unit) {
        setContent {
            PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Tidewater Studio"), darkTheme = false) { content() }
        }
        waitForIdle()
    }

    @Test
    fun typingAfterAWrongFieldLandsInTheRightFieldAtTheEnd() = runDesktopComposeUiTest(900, 640) {
        val s = state(Driver())
        show { PolarisAddToAccount(s) }
        onAllNodes(hasSetTextAction())[0].performTextInput("Ada Lovelace")
        onAllNodes(hasSetTextAction())[1].performTextInput("ada")
        onNodeWithText("Continue").performClick()
        waitForIdle()
        assertEquals("invalid", s.ui.value.step)
        // Focus is on the wrong field (the email); the keystrokes go after what is there, and the name is untouched.
        onAllNodes(hasSetTextAction())[1].performTextInput("@example.com")
        waitForIdle()
        assertEquals("ada@example.com", s.ui.value.email)
        assertEquals("Ada Lovelace", s.ui.value.name)
        assertEquals("form", s.ui.value.step)
    }

    @Test
    fun typingAfterBothFieldsWereWrongKeepsEachFieldsText() = runDesktopComposeUiTest(900, 640) {
        val s = state(Driver())
        show { PolarisAddToAccount(s) }
        onNodeWithText("Continue").performClick()
        waitForIdle()
        assertEquals("invalid", s.ui.value.step)
        onAllNodes(hasSetTextAction())[0].performTextInput("Ada")
        onAllNodes(hasSetTextAction())[0].performTextInput(" Lovelace")
        waitForIdle()
        assertEquals("Ada Lovelace", s.ui.value.name)
        assertEquals("", s.ui.value.email)
    }

    @Test
    fun theWaitShowsTheCopyCodeButtonAndWhereToTypeTheCode() = runDesktopComposeUiTest(1400, 900) {
        val driver = Driver(Run("WDJB-MJHT", "https://polaris.locker/device", "https://polaris.locker/device?code=WDJB-MJHT"))
        val s = state(driver)
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s, extras = HolderExtras(opened = false)) }
        s.submit()
        waitForIdle()
        assertEquals("busy", s.ui.value.step)
        assertEquals("https://polaris.locker/device", s.ui.value.address)
        onNodeWithText("Or go to https://polaris.locker/device").assertExists()
        // The button names the code, and "Copy link" is nowhere.
        onAllNodes(hasContentDescription("Copy code")).assertCountEquals(1)
        onAllNodes(hasContentDescription("Copy link")).assertCountEquals(0)
        // Until the page has opened once the button says Open browser, not "again".
        onNodeWithText("Open browser").assertExists()
        onAllNodesWithText("Open Polaris Locker again").assertCountEquals(0)
    }

    @Test
    fun afterTheFirstOpenTheButtonSaysAgainAndAFailedOpenSaysSoInTheDangerLine() = runDesktopComposeUiTest(900, 640) {
        val driver = Driver(Run("WDJB-MJHT", "https://polaris.locker/device", "https://polaris.locker/device?code=WDJB-MJHT"))
        val s = state(driver)
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s, extras = HolderExtras(opened = true, problem = "We couldn't open your browser")) }
        s.submit()
        waitForIdle()
        onNodeWithText("Open Polaris Locker again").assertExists()
        onNodeWithText("We couldn't open your browser").assertExists()
    }

    @Test
    fun theCopyButtonCopiesTheCode() = runDesktopComposeUiTest(900, 640) {
        val copied = mutableListOf<String>()
        show { PolarisUserCode("WDJB-MJHT", androidx.compose.ui.Modifier, "WDJB-MJHT" to { copied += it }, "Copy code", "Copied") }
        onAllNodes(hasContentDescription("Copy code"))[0].performClick()
        assertEquals(listOf("WDJB-MJHT"), copied)
    }

    @Test
    fun aLicenseWaitingForAnEmailSignsInForThatAddressNotTheBlankForm() = runDesktopComposeUiTest(900, 700) {
        val inputs = base(
            "license",
            "identity",
            extra = mapOf(
                "licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive("mary@example.com"), "addIn" to JsonPrimitive("app"))),
                "activateDone" to JsonObject(mapOf("tier" to JsonPrimitive("Pro"))),
            ),
        )
        val screen = KitStates.resolve(KitComponent.activateDone, KitInputs.fromJson(inputs))
        var signedIn = 0
        var added = 0
        show { PolarisActivateDone(screen, onStartUsing = {}, onAdd = { added++ }, onWaitingSignIn = { signedIn++ }) }
        onNodeWithText("Sign in as m•••@example.com", substring = true).performClick()
        assertEquals(1, signedIn)
        assertEquals(0, added)
    }

    @Test
    fun theLicenseLineIsSaidWithoutATermAndFallsBackToTheTier() = runDesktopComposeUiTest(900, 700) {
        fun done(vararg members: Pair<String, kotlinx.serialization.json.JsonElement>) = KitStates.resolve(
            KitComponent.activateDone,
            KitInputs.fromJson(base("license", extra = mapOf("activateDone" to JsonObject(members.toMap())))),
        )
        show {
            PolarisActivateDone(
                done(
                    "tier" to JsonPrimitive("Pro"),
                    "deviceKind" to JsonPrimitive("computer"),
                    "position" to JsonPrimitive(2),
                    "limit" to JsonPrimitive(3),
                ),
                {},
                {},
            )
        }
        onNodeWithText("Pro · this computer is device 2 of 3.").assertExists()
    }

    @Test
    fun withNoPositionTheLineFallsBackToTheTierAlone() = runDesktopComposeUiTest(900, 700) {
        val screen = KitStates.resolve(
            KitComponent.activateDone,
            KitInputs.fromJson(base("license", extra = mapOf("activateDone" to JsonObject(mapOf("tier" to JsonPrimitive("Pro")))))),
        )
        show { PolarisActivateDone(screen, {}, {}) }
        onNodeWithText("Pro license").assertExists()
    }

    private fun ComposeUiTest.driveTo(attach: AddToAccountAttach, onVerify: () -> Unit = {}, onTry: () -> Unit = {}): PolarisAddToAccountState {
        val driver = Driver(attach = attach)
        driver.run.answer.complete(AddToAccountWait.SignedIn("ada@example.com"))
        val s = state(driver, holder = "mary@example.com")
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s, onVerify = onVerify, onTryAgain = onTry) }
        s.submit()
        waitForIdle()
        return s
    }

    @Test
    fun emailBoundLeadsWithVerifyAndKeepsStartUsingAsTheQuietLink() = runDesktopComposeUiTest(900, 700) {
        var verified = 0
        val s = driveTo(AddToAccountAttach.Refused("license_email_bound"), onVerify = { verified++ })
        assertEquals("email-bound", s.ui.value.step)
        // Verify leads the row (Windows: the primary first), Use another account follows, Start using is the quiet link under it.
        assertTrue(xOf("Verify that email") < xOf("Use another account"))
        onNodeWithText("Start using Tidewater Studio").assertExists()
        onNodeWithText("Verify that email").performClick()
        assertEquals(1, verified)
    }

    @Test
    fun otherAccountLeadsWithTryAgain() = runDesktopComposeUiTest(900, 700) {
        var tries = 0
        val driver = Driver()
        driver.run.answer.complete(AddToAccountWait.SignedIn("grace@example.com"))
        val s = state(driver)
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s, onTryAgain = { tries++ }) }
        s.submit()
        waitForIdle()
        assertEquals("other-account", s.ui.value.step)
        onNodeWithText("Try again").performClick()
        assertEquals(1, tries)
        onNodeWithText("Start using Tidewater Studio").assertExists()
    }

    private fun ComposeUiTest.xOf(label: String): Float = onNodeWithText(label).fetchSemanticsNode().boundsInRoot.left

    @Test
    fun theTvQrWithNoLinkSaysSoAndNeverDrawsScan() = runDesktopComposeUiTest(900, 700) {
        show { HolderQr(null, androidx.compose.ui.Modifier, onBack = {}) }
        // A TV opens nothing, so it never says it could not open a browser.
        onAllNodesWithText("We couldn't open your browser").assertCountEquals(0)
        onNodeWithText("That link doesn't open anything here.").assertExists()
        onAllNodesWithText("Scan to add this key", substring = true).assertCountEquals(0)
        onNodeWithText("Or go to https://polaris.locker").assertExists()
    }

    @Test
    fun theCardTitleDoesNotBreakAtLargeType() = runDesktopComposeUiTest(420, 900) {
        val inputs = base("license", "identity", extra = mapOf("activateDone" to JsonObject(mapOf("tier" to JsonPrimitive("Pro")))))
        val screen = KitStates.resolve(KitComponent.activateDone, KitInputs.fromJson(inputs))
        setContent {
            CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides Density(1f, fontScale = 2f)) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = PolarisCopy(productName = "Tidewater Studio"), darkTheme = false) {
                    PolarisActivateDone(screen, {}, {})
                }
            }
        }
        waitForIdle()
        val node = onNodeWithText("Keep Tidewater Studio in your account").fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
        val layout = layouts.single()
        // Every line break falls at a space: no word is cut.
        val text = layout.layoutInput.text.text
        for (i in 0 until layout.lineCount - 1) {
            val end = layout.getLineEnd(i, visibleEnd = false)
            assertTrue(end <= text.length && (text.getOrNull(end - 1) == ' ' || text.getOrNull(end) == ' '), "line $i breaks mid-word in '$text'")
        }
    }

    @Test
    fun theDesktopActionRowEndsWhereTheFieldsEnd() = runDesktopComposeUiTest(900, 640) {
        System.setProperty(PolarisPlatformVariant.FORCE_PROPERTY, "Gnome")
        show { PolarisAddToAccount(state(Driver())) }
        val fieldRight = onAllNodes(hasSetTextAction())[0].fetchSemanticsNode().boundsInRoot.right
        val continueRight = onNodeWithText("Continue").fetchSemanticsNode().boundsInRoot.right
        assertTrue(continueRight <= fieldRight + 2f, "Continue ($continueRight) overhangs the fields ($fieldRight)")
    }

    @Test
    fun anOwnedSignInThatRunsKeepsCancelLiveAndTheOthersOff() = runDesktopComposeUiTest(900, 700) {
        var cancelled = 0
        val driver = Driver(attach = AddToAccountAttach.Refused("license_owned"))
        driver.run.answer.complete(AddToAccountWait.SignedIn("ada@example.com"))
        val s = state(driver)
        s.setField(AddToAccountField.Name, "Ada Lovelace")
        s.setField(AddToAccountField.Email, "ada@example.com")
        show { PolarisAddToAccount(s, onCancel = { cancelled++ }, extras = HolderExtras(working = true)) }
        s.submit()
        waitForIdle()
        assertEquals("owned", s.ui.value.step)
        onNodeWithText("Sign in to that account").assertIsNotEnabled()
        onNodeWithText("Cancel").assertIsEnabled()
        onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun aWaitingDoneSignInShowsABusyButtonAndALiveCancel() = runDesktopComposeUiTest(900, 700) {
        val inputs = base(
            "license",
            "identity",
            extra = mapOf(
                "licenseHolder" to JsonObject(mapOf("email" to JsonPrimitive("mary@example.com"), "addIn" to JsonPrimitive("app"))),
                "activateDone" to JsonObject(mapOf("tier" to JsonPrimitive("Pro"))),
            ),
        )
        val screen = KitStates.resolve(KitComponent.activateDone, KitInputs.fromJson(inputs))
        var cancelled = 0
        show { PolarisHolderScreen(screen, handlers = HolderHandlers(onCancel = { cancelled++ }), extras = HolderExtras(working = true)) }
        onNodeWithText("Sign in as m•••@example.com", substring = true).assertIsNotEnabled()
        onNodeWithText("Start using Tidewater Studio").assertIsNotEnabled()
        onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun anAccountSignInOnTheDeviceCodeChannelShowsTheCodeTheAddressAndALiveCancel() = runDesktopComposeUiTest(1400, 900) {
        val inputs = JsonObject(
            base("license", "identity") +
                ("deviceCode" to JsonObject(mapOf("phase" to JsonPrimitive("waiting"), "userCode" to JsonPrimitive("WDJB-MJHT")))) +
                ("addToAccount" to JsonObject(mapOf("step" to JsonPrimitive("busy")))),
        )
        val screen = KitStates.resolve(KitComponent.addToAccount, KitInputs.fromJson(inputs))
        val ui =
            PolarisAddToAccountUi(
                step = "busy",
                userCode = "WDJB-MJHT",
                address = "https://polaris.locker/device",
                link = "https://polaris.locker/device?code=WDJB-MJHT",
            )
        var cancelled = 0
        var reopened = 0
        show {
            PolarisHolderScreen(
                screen,
                ui = ui,
                handlers = HolderHandlers(onCancel = { cancelled++ }, onReopen = { reopened++ }),
                extras = HolderExtras(opened = false),
            )
        }
        onNodeWithText("Or go to https://polaris.locker/device").assertExists()
        onNodeWithText("Scan with your phone instead").assertExists()
        onNodeWithText("Open browser").performClick()
        assertEquals(1, reopened)
        onNodeWithText("Cancel").assertIsEnabled()
        onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }
}
