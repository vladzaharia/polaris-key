// @pkey-feature ui.kit connect.links connect.transfer
// The inter-account screens (CC-19.10; ui-matrix `connect`): LinkPairing and TransferOffer. Every non-hidden row of the family is
// drawn by the kit in both themes (baselines under src/test/snapshots/connect/), the code, the other device's label and the file
// name are checked as drawn, and the rules the rows pin are checked on the screen: the categories come before Codes match, the
// first focus is never the consenting verb, a press as a TV prompt opens is ignored for 250 ms, a failure that cannot succeed leads
// with Done, the stateful LinkPairing opens its window on entering the composition and closes it on leaving.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "LongParameterList", "MaxLineLength")

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** One drawn row of the matrix's `connect` family: the resolved screen and the values its inputs carry beside it. */
internal class ConnectCase(
    val id: String,
    val screen: KitScreen,
    val code: String?,
    val categories: List<String>,
    val name: String,
    val size: Long?,
    val type: String?,
) {
    override fun toString(): String = id
}

internal object ConnectCases {
    /** Every non-hidden `connect` row, in the matrix's order. */
    val all: List<ConnectCase> by lazy {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui's test task" }
        val raw = Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject
        val defaults = (raw["vocabulary"] as JsonObject)["defaults"] as JsonObject
        (raw["connect"] as JsonArray).mapNotNull { element ->
            val row = element as JsonObject
            val merged = defaults.toMutableMap()
            for ((key, value) in row["input"] as JsonObject) merged[key] = value
            val inputs = KitInputs.of(merged)
            val expect = row["expect"] as JsonObject
            val component = KitComponent.fromId((expect["component"] as JsonPrimitive).content)!!
            val screen = KitStates.resolve(component, inputs)
            if (screen.isHidden) return@mapNotNull null
            val member = (merged["linkPairing"] ?: merged["transferOffer"]) as JsonObject
            fun text(key: String) = (member[key] as? JsonPrimitive)?.content
            // "LinkPairing/code: the device gave no name" is linkpairing-code-the-device-gave-no.
            val about = (row["name"] as JsonPrimitive).content.substringAfter(": ").split(' ').take(4)
            val id = (listOf(component.id, screen.state) + about).joinToString("-").lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
            ConnectCase(
                id = id,
                screen = screen,
                code = text("code"),
                categories = (member["categories"] as? JsonArray)?.map { (it as JsonPrimitive).content }.orEmpty(),
                name = text("name").orEmpty(),
                size = text("size")?.toLong(),
                type = text("type"),
            )
        }
    }

    fun case(prefix: String): ConnectCase = all.first { it.id.startsWith(prefix) }
}

@Composable
internal fun ConnectCase.Draw() {
    if (screen.component == KitComponent.linkPairing) {
        PolarisLinkPairingScreen(screen, code, categories)
    } else {
        PolarisTransferOfferScreen(screen, name, size = size, type = type)
    }
}

/** Every drawn row, in both themes on a phone. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ConnectMatrixSnapshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun themes(): List<Array<Any>> = listOf(arrayOf<Any>(true), arrayOf<Any>(false))
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyRow() {
        val cases = ConnectCases.all
        assertEquals("the family's drawn rows (20, less the two hidden)", 18, cases.size)
        assertEquals("a baseline name per row", cases.size, cases.map { it.id }.toSet().size)
        val variant = snapshotVariants.first { it.branding == PolarisBranding.PolarisKey && it.dark == dark && it.widthDp == 411 }
        for (case in cases) {
            rule.capture("connect/${case.id}/phone-polaris-${if (dark) "dark" else "light"}", variant) {
                // Reduced motion holds the wait shimmer still, so the picture is the same on every run.
                CompositionLocalProvider(LocalPolarisReduceMotion provides true) { case.Draw() }
            }
        }
    }
}

private val connectSizes = listOf(
    // The short landscape sizes are drawn in both themes (two panes, UI-KITS.md "LinkPairing and TransferOffer").
    ResponsiveSize("phone-844x390", 844, 390, nativeDark = true),
    ResponsiveSize("phone-844x390", 844, 390, nativeDark = false),
    ResponsiveSize("small-landscape-640x360", 640, 360, nativeDark = false),
    ResponsiveSize("small-landscape-640x360", 640, 360, nativeDark = true),
    ResponsiveSize("tablet-1180x820", 1180, 820, nativeDark = false),
    // Portrait stays one column, with the choice after the categories.
    ResponsiveSize("portrait-390x844", 390, 844, nativeDark = true),
    ResponsiveSize("portrait-390x844", 390, 844, nativeDark = false),
    ResponsiveSize("phone-390x844-font200", 390, 844, fontScale = 2f, nativeDark = true),
)

/** The states where layout matters most (the code beside its choice, the offer's long name), at the committed size matrix. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ConnectResponsiveSnapshotTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = (
            connectSizes.flatMap(::bothLooks) + bothLooks(tvSize) +
                // TV is dark in both looks by default; its light render is checked too.
                SnapshotVariant("tv-960x540-polaris-light", PolarisBranding.PolarisKey, false, 960, 540, 1f, true)
            ).filter { it.branding == PolarisBranding.PolarisKey }.map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theKeyStates() {
        for (prefix in listOf("linkpairing-code-the-code", "linkpairing-confirm-waiting", "transferoffer-ask-the-contact-s-label")) {
            val case = ConnectCases.case(prefix)
            rule.capture("connect/${case.id}/${variant.name}", variant) {
                CompositionLocalProvider(LocalPolarisReduceMotion provides true) { case.Draw() }
            }
        }
    }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class ConnectScreensTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @Composable () -> Unit) {
        rule.setContent {
            StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } }
        }
        rule.waitForIdle()
    }

    private fun top(text: String) = rule.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

    private fun pairing(
        step: String,
        code: String? = "123 456",
        device: String? = "Maya's laptop",
        cats: List<String> = listOf("contacts", "photos"),
        reason: String? = null,
    ): KitScreen {
        val ui = PolarisLinkPairingUi(
            PolarisLinkStep.entries.first { it.id == step },
            device,
            code.takeIf { step == "code" || step == "confirm" },
            cats,
            PolarisLinkFailure.entries.firstOrNull { it.id == reason },
        )
        return KitStates.resolve(KitComponent.linkPairing, linkPairingInputs(ui)!!)
    }

    private fun offer(step: String, name: String = "holiday.zip", device: String? = "Maya's laptop"): KitScreen = KitStates.resolve(
        KitComponent.transferOffer,
        transferOfferInputs(PolarisTransferOfferUi(PolarisTransferOfferStep.entries.first { it.id == step }, name, device))!!,
    )

    @Test
    fun theCategoriesAndTheChoiceFollowTheCodeInThatOrder() {
        show { PolarisLinkPairingScreen(pairing("code"), "123 456", listOf("contacts", "photos")) }
        rule.onNodeWithText("Compare the code").assertIsDisplayed()
        val shares = top("Each of you shares")
        // No labels from the app: the ids are drawn as words.
        val contacts = top("⁨Contacts⁩")
        val confirm = top("Codes match")
        assertTrue("the categories come before Codes match", shares < contacts && contacts < confirm)
        assertTrue("the choice comes before the other way out", confirm < top("Not a match"))
    }

    @Test
    fun theCodeIsReadDigitByDigitAndTheLabelIsWordedAsReported() {
        show { PolarisLinkPairingScreen(pairing("code"), "123 456", listOf("contacts")) }
        rule.onNodeWithContentDescription("Pairing code 1 2 3   4 5 6").assertIsDisplayed()
        // The label the device sent is isolated text after "Reported by the device".
        rule.onNodeWithText("Reported by the device: ⁨Maya's laptop⁩").assertIsDisplayed()
        rule.onNodeWithText("The device gave no name").assertDoesNotExist()
    }

    @Test
    fun aDeviceWithNoNameSaysSoAndNothingIsMadeUp() {
        show { PolarisLinkPairingScreen(pairing("code", device = null, cats = emptyList()), "123 456", emptyList()) }
        rule.onNodeWithText("The device gave no name").assertIsDisplayed()
        rule.onNodeWithText("Nothing is shared yet.").assertIsDisplayed()
        rule.onNodeWithText("Each of you shares").assertDoesNotExist()
    }

    @Test
    fun theCategoriesTakeTheAppsOwnNames() {
        show {
            PolarisLinkPairingScreen(
                pairing("code", cats = listOf("tax-forms")),
                "123 456",
                listOf("tax-forms"),
                categoryLabels = mapOf("tax-forms" to "Tax documents"),
            )
        }
        rule.onNodeWithText("⁨Tax documents⁩", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun eachControlReportsItsOwnCallback() {
        var confirmed = 0
        var declined = 0
        show { PolarisLinkPairingScreen(pairing("code"), "123 456", listOf("contacts"), onConfirm = { confirmed++ }, onDecline = { declined++ }) }
        rule.onNodeWithText("Not a match").performClick()
        assertEquals(1, declined)
        assertEquals(0, confirmed)
        rule.onNodeWithText("Codes match").performClick()
        assertEquals(1, confirmed)
    }

    @Test
    fun theWaitKeepsTheCodeOnScreenAndOffersCancelOnly() {
        var cancelled = 0
        show { PolarisLinkPairingScreen(pairing("confirm"), "123 456", listOf("contacts"), onCancel = { cancelled++ }) }
        rule.onNodeWithContentDescription("Pairing code 1 2 3   4 5 6").assertIsDisplayed()
        rule.onNodeWithText("Codes match").assertDoesNotExist()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun aFailureThatCannotSucceedLeadsWithDoneAndOthersWithTryAgain() {
        show { PolarisLinkPairingScreen(pairing("failed", reason = "full", code = null), null, emptyList()) }
        rule.onNodeWithText("One of you has no room for another pairing. Remove one, then try again.").assertIsDisplayed()
        assertTrue("Done leads when pairing cannot succeed", top("Done") < top("Try again"))
    }

    @Test
    fun aFailureWithRoomLeadsWithTryAgainAndRetries() {
        var retried = 0
        show { PolarisLinkPairingScreen(pairing("failed", reason = "timeout", code = null), null, emptyList(), onRetry = { retried++ }) }
        assertTrue(top("Try again") < top("Done"))
        rule.onNodeWithText("Linked").assertDoesNotExist()
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retried)
    }

    @Test
    fun linksOffExplainsBeforeDone() {
        show { PolarisLinkPairingScreen(pairing("unavailable", code = null), null, emptyList()) }
        rule.onNodeWithText("Codes match").assertDoesNotExist()
        rule.onNodeWithText("Pair with Someone Nearby").assertDoesNotExist()
        val message = KitCopy.bundled.format("core.codes.connect_links_disabled.message", "en")
        assertTrue("the reason comes before Done", top(message) < top("Done"))
    }

    @Test
    fun linkedNamesTheDeviceAsPairedAndListsWhatWasApproved() {
        show { PolarisLinkPairingScreen(pairing("linked", code = null), null, listOf("contacts", "photos")) }
        rule.onNodeWithText("Paired").assertIsDisplayed()
        rule.onNodeWithText("Paired with ⁨Maya's laptop⁩.").assertIsDisplayed()
        rule.onNodeWithText("⁨Photos⁩", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun theOffersHeadingKeepsTheExtensionOfALongNameAndTheWholeNameHasItsOwnRow() {
        val long = "a-very-long-holiday-photo-collection-from-the-whole-family-trip-2026.zip"
        var accepted = 0
        show { PolarisTransferOfferScreen(offer("ask", long), long, size = 1_200_000, type = "application/zip", onAccept = { accepted++ }) }
        val shortened = KitConnect.shortName(long)
        rule.onNodeWithText("⁨Maya's laptop⁩ wants to send you a file").assertIsDisplayed()
        // The row draws the name with its middle elided; the extension shows.
        rule.onNodeWithText("⁨${KitConnect.shortName(long, 48)}⁩").assertIsDisplayed()
        rule.onNodeWithContentDescription("⁨$long⁩").assertExists()
        rule.onNodeWithText("1.2 MB · ⁨application/zip⁩").assertIsDisplayed()
        assertTrue(shortened.endsWith(".zip") && shortened.contains('…'))
        rule.onNodeWithText("Accept").performClick()
        assertEquals(1, accepted)
    }

    @Test
    fun aLongCameraNameKeepsItsExtensionInTheRow() {
        val name = "IMG_20261103_141522_holiday-photo-from-the-lake-with-the-whole-family-and-the-dog.jpg.apk"
        show { PolarisTransferOfferScreen(offer("ask", name), name) }
        val row = KitConnect.shortName(name, 48)
        assertTrue(row.endsWith(".jpg.apk") && row.contains('…'))
        rule.onNodeWithText("⁨$row⁩").assertIsDisplayed()
    }

    @Test
    fun theCategoriesAreOneItemToAScreenReader() {
        show { PolarisLinkPairingScreen(pairing("code"), "123 456", listOf("contacts", "photos")) }
        rule.onNodeWithContentDescription("Each of you shares: Contacts, Photos").assertIsDisplayed()
    }

    @Test
    fun anOfferWithNoLabelSaysAPairedDevice() {
        show { PolarisTransferOfferScreen(offer("ask", device = null), "holiday.zip") }
        rule.onNodeWithText("A paired device wants to send you a file").assertIsDisplayed()
        rule.onNodeWithText("Only accept what you expect.").assertIsDisplayed()
    }

    @Test
    fun receivingOffersCancelAndNeverAccept() {
        var cancelled = 0
        show { PolarisTransferOfferScreen(offer("receiving"), "holiday.zip", onCancel = { cancelled++ }) }
        rule.onNodeWithText("Receiving ⁨holiday.zip⁩").assertIsDisplayed()
        rule.onNodeWithText("Accept").assertDoesNotExist()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun aFailedTransferNeverSaysReceived() {
        show { PolarisTransferOfferScreen(offer("failed"), "holiday.zip") }
        rule.onNodeWithText("Couldn’t receive ⁨holiday.zip⁩").assertIsDisplayed()
        rule.onNodeWithText("Nothing was saved.").assertIsDisplayed()
        rule.onNodeWithText("Received", substring = true).assertDoesNotExist()
    }

    // ── the stateful LinkPairing ─────────────────────────────────────────────────────────────────

    private class FakeOffer : PolarisLinkOffer {
        override val label: String? = "Maya's laptop"
        override val code: String = "123 456"
        override val categories = listOf("contacts")
        val confirms = AtomicInteger()
        val declines = AtomicInteger()

        override suspend fun confirm() {
            confirms.incrementAndGet()
        }

        override suspend fun decline() {
            declines.incrementAndGet()
        }
    }

    private class FakeDriver : PolarisLinkPairingActions {
        val stops = AtomicInteger()
        val opens = AtomicInteger()
        var onCode: (PolarisLinkOffer) -> Unit = {}
        var onLinked: (String?, List<String>) -> Unit = { _, _ -> }

        override suspend fun pair(
            categories: List<String>,
            label: String?,
            seconds: Double?,
            onCode: (PolarisLinkOffer) -> Unit,
            onLinked: (String?, List<String>) -> Unit,
            onFailed: (PolarisLinkFailure) -> Unit,
        ): PolarisLinkWindow {
            opens.incrementAndGet()
            this.onCode = onCode
            this.onLinked = onLinked
            return object : PolarisLinkWindow {
                override suspend fun stop() {
                    stops.incrementAndGet()
                }
            }
        }

        override fun isUnavailable(error: Throwable): Boolean = false
    }

    @Test
    fun theWindowOpensOnEnteringAndClosesOnLeavingAndALinkIsToldOnce() {
        val driver = FakeDriver()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val state = PolarisLinkPairingState(driver, listOf("contacts"), scope = scope, cleanup = scope)
        var present by mutableStateOf(true)
        var linked = 0
        var closed = 0
        show { if (present) PolarisLinkPairing(state, onLinked = { linked++ }, onClose = { closed++ }) }
        rule.onNodeWithText("Pair with Someone Nearby").assertIsDisplayed()
        assertEquals(1, driver.opens.get())
        val offer = FakeOffer()
        rule.runOnIdle { driver.onCode(offer) }
        rule.onNodeWithContentDescription("Pairing code 1 2 3   4 5 6").assertIsDisplayed()
        rule.onNodeWithText("Codes match").performClick()
        assertEquals(1, offer.confirms.get())
        rule.runOnIdle { driver.onLinked("Maya's laptop", listOf("contacts")) }
        rule.onNodeWithText("Paired").assertIsDisplayed()
        assertEquals(1, linked)
        rule.onNodeWithText("Done").performClick()
        assertEquals(1, closed)
        assertEquals(PolarisLinkStep.Idle, state.ui.value.step)
        rule.runOnIdle { present = false }
        rule.waitForIdle()
        assertEquals(1, driver.stops.get())
    }

    @Test
    fun leavingWithACodeOnScreenDeclinesIt() {
        val driver = FakeDriver()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val state = PolarisLinkPairingState(driver, listOf("contacts"), scope = scope, cleanup = scope)
        var present by mutableStateOf(true)
        show { if (present) PolarisLinkPairing(state) }
        val offer = FakeOffer()
        rule.runOnIdle { driver.onCode(offer) }
        rule.waitForIdle()
        rule.runOnIdle { present = false }
        rule.waitForIdle()
        assertEquals(1, offer.declines.get())
        assertEquals(0, offer.confirms.get())
    }
}

/** A TV: the D-pad is a keyboard to Compose, the first focus is the safe verb, and a press as the prompt opens is ignored. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-television-mdpi")
class ConnectTvFocusTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @Composable () -> Unit) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            CompositionLocalProvider(LocalInputModeManager provides FixedInputMode(InputMode.Keyboard)) {
                StockHost(true) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = true) { content() } }
            }
        }
        rule.mainClock.advanceTimeBy(50)
    }

    @Test
    fun theFirstFocusIsNotAMatchNeverCodesMatch() {
        show { ConnectCases.case("linkpairing-code-the-code").Draw() }
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithText("Not a match").assertIsFocused()
        rule.onNodeWithText("Codes match").assertIsNotFocused()
    }

    @Test
    fun aPressAsTheCodeOpensIsIgnoredForTwoHundredFiftyMilliseconds() {
        var confirmed = 0
        val case = ConnectCases.case("linkpairing-code-the-code")
        show { PolarisLinkPairingScreen(case.screen, case.code, case.categories, onConfirm = { confirmed++ }) }
        rule.onNodeWithText("Codes match").performClick()
        assertEquals(0, confirmed)
        rule.mainClock.advanceTimeBy(PolarisPromptInputDelayMs + 50)
        rule.onNodeWithText("Codes match").performClick()
        assertEquals(1, confirmed)
    }

    @Test
    fun theOffersFirstFocusIsDeclineNeverAccept() {
        show { ConnectCases.case("transferoffer-ask-the-contact-s-label").Draw() }
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithText("Decline").assertIsFocused()
        rule.onNodeWithText("Accept").assertIsNotFocused()
    }
}

/**
 * The two-pane rule (UI-KITS.md "LinkPairing and TransferOffer"): in a short landscape window the decision is in the first viewport,
 * the code and the choice side by side, and the categories still come before Codes match.
 */
abstract class ConnectPanesBase {
    @get:Rule
    val rule = createComposeRule()

    abstract val widthDp: Int
    abstract val heightDp: Int
    open val dark: Boolean = false

    private fun show(content: @Composable () -> Unit) {
        rule.setContent {
            StockHost(dark) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = dark) { content() } }
        }
        rule.waitForIdle()
    }

    private fun bounds(text: String) = rule.onNodeWithText(text, useUnmergedTree = true).getUnclippedBoundsInRoot()

    private fun inside(label: String, text: String) {
        val b = bounds(text)
        assertTrue("$label ends inside the $heightDp dp window: ${b.bottom}", b.bottom <= heightDp.dp && b.top >= 0.dp)
        assertTrue("$label sits inside the $widthDp dp width", b.right <= widthDp.dp)
    }

    @Test
    fun theCodeAndTheChoiceAreSideBySideAndBothActionsAreInTheFirstViewport() {
        val case = ConnectCases.case("linkpairing-code-the-code")
        show { case.Draw() }
        inside("Codes match", "Codes match")
        inside("Not a match", "Not a match")
        val code = rule.onNodeWithContentDescription("Pairing code 1 2 3   4 5 6").getUnclippedBoundsInRoot()
        val confirm = bounds("Codes match")
        assertTrue("the choice is on the end side of the code", code.right <= confirm.left)
        // The categories come before Codes match: the end pane reads the reported line, the categories, then the actions.
        assertTrue(bounds("Each of you shares").top < confirm.top)
        assertTrue(confirm.top < bounds("Not a match").top)
    }

    @Test
    fun theWaitKeepsTheCodeBesideItsStatusAndCancelInTheFirstViewport() {
        val case = ConnectCases.case("linkpairing-confirm-waiting")
        show { case.Draw() }
        inside("Cancel", "Cancel")
        val code = rule.onNodeWithContentDescription("Pairing code 1 2 3   4 5 6", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("the status is beside the code", code.right <= bounds("Cancel").left)
    }

    @Test
    fun theOfferAndTheChoiceAreSideBySideAndBothActionsAreInTheFirstViewport() {
        val case = ConnectCases.case("transferoffer-ask-the-contact-s-label")
        show { case.Draw() }
        inside("Accept", "Accept")
        inside("Decline", "Decline")
        val file = bounds("⁨${KitConnect.shortName(case.name, 48)}⁩")
        assertTrue("the choice is on the end side of the offer", file.right <= bounds("Accept").left)
    }

    @Test
    fun aMessageStateStaysOneColumn() {
        val case = ConnectCases.case("transferoffer-receiving")
        show { case.Draw() }
        inside("Cancel", "Cancel")
        // One column: the heading is above its Cancel, not beside it.
        val title = bounds("Receiving ⁨holiday.zip⁩")
        val cancel = bounds("Cancel")
        assertTrue(title.bottom <= cancel.top && title.left < cancel.right && cancel.left < title.right)
    }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w844dp-h390dp-mdpi")
class ConnectPanesPhoneLandscapeTest : ConnectPanesBase() {
    override val widthDp = 844
    override val heightDp = 390
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w640dp-h360dp-mdpi")
class ConnectPanesSmallLandscapeTest : ConnectPanesBase() {
    override val widthDp = 640
    override val heightDp = 360
    override val dark = true
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-television-mdpi")
class ConnectPanesTvTest : ConnectPanesBase() {
    override val widthDp = 960
    override val heightDp = 540
    override val dark = true
}

/** Where the rule keeps one column: a portrait phone, a window under 600 dp wide, and large type in a short landscape window. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w844dp-h390dp-mdpi")
class ConnectPanesThresholdTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun theRuleAsCoded() {
        fun panes(w: Int, h: Int, fontScale: Float = 1f, tv: Boolean = false) = PolarisWindow(w.dp, h.dp, tv).connectPanes(fontScale)
        assertTrue("844 x 390", panes(844, 390))
        assertTrue("640 x 360", panes(640, 360))
        assertTrue("600 x 479", panes(600, 479))
        assertTrue("599 wide is one column", !panes(599, 360))
        assertTrue("480 tall is one column", !panes(844, 480))
        assertTrue("portrait is one column", !panes(390, 844))
        assertTrue("a tablet landscape is one column", !panes(1180, 820))
        assertTrue("large type is one column", !panes(844, 390, fontScale = 1.5f))
        assertTrue("TV is always two panes", panes(960, 540, tv = true))
        assertTrue("TV at large type too", panes(960, 540, fontScale = 2f, tv = true))
    }

    @Test
    fun largeTypeInAShortLandscapeWindowKeepsOneColumnWithTheCategoriesBeforeTheChoice() {
        org.robolectric.RuntimeEnvironment.setFontScale(2f)
        val case = ConnectCases.case("linkpairing-code-the-code")
        rule.setContent {
            StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { case.Draw() } }
        }
        rule.waitForIdle()
        val shares = rule.onNodeWithText("Each of you shares", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val confirm = rule.onNodeWithText("Codes match", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("one column: the choice is below the categories", shares.bottom <= confirm.top)
    }
}

/** Android Back while a transfer runs leaves the screen up: only its own Cancel stops it. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class ConnectBackTest {
    @get:Rule
    val rule = androidx.compose.ui.test.junit4.createAndroidComposeRule<ComponentActivity>()

    @Test
    fun backWhileReceivingChangesNothingAndCancelStaysAvailable() {
        var cancelled = 0
        var done = 0
        val screen = KitStates.resolve(
            KitComponent.transferOffer,
            transferOfferInputs(PolarisTransferOfferUi(PolarisTransferOfferStep.Receiving, "holiday.zip", "Maya's laptop"))!!,
        )
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    PolarisTransferOfferScreen(screen, "holiday.zip", onCancel = { cancelled++ }, onDone = { done++ })
                }
            }
        }
        rule.waitForIdle()
        // The handler is on, so Back is taken here and never reaches the host's activity.
        assertTrue(rule.activity.onBackPressedDispatcher.hasEnabledCallbacks())
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertTrue(!rule.activity.isFinishing)
        rule.onNodeWithText("Receiving ⁨holiday.zip⁩").assertIsDisplayed()
        rule.onNodeWithText("Cancel").assertIsDisplayed()
        assertEquals(0, cancelled)
        assertEquals(0, done)
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(1, cancelled)
    }
}

/** The offer's file row at 360 dp and 200 % text: the wrapped name keeps its extension, with or without word breaks. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-mdpi")
class ConnectLongNameTest {
    @get:Rule
    val rule = createComposeRule()

    private fun check(name: String) {
        val screen = KitStates.resolve(
            KitComponent.transferOffer,
            transferOfferInputs(PolarisTransferOfferUi(PolarisTransferOfferStep.Ask, name, "Maya's laptop"))!!,
        )
        val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        org.robolectric.RuntimeEnvironment.setFontScale(2f)
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                    PolarisTransferOfferScreen(screen, name)
                }
            }
        }
        rule.waitForIdle()
        val shown = "⁨${KitConnect.shortName(name, 48)}⁩"
        val node = rule.onNodeWithText(shown, useUnmergedTree = true)
        node.assertIsDisplayed()
        val action = node.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult]
        assertTrue(action.action?.invoke(results) == true)
        val layout = results.single()
        assertTrue("the name is not cut off", !layout.hasVisualOverflow)
        assertTrue("every character is drawn, the last line ends with the extension", layout.layoutInput.text.text.endsWith(".jpg.apk⁩"))
        val last = layout.getLineEnd(layout.lineCount - 1, visibleEnd = true)
        assertEquals("the last drawn character is the last of the text", layout.layoutInput.text.length, last)
    }

    @Test
    fun aLongNameWithWordBreaksKeepsItsExtension() =
        check("IMG 20261103 141522 holiday photo from the lake with the whole family and the dog.jpg.apk")

    @Test
    fun aLongNameWithNoWordBreaksKeepsItsExtension() =
        check("IMG_20261103_141522_holiday-photo-from-the-lake-with-the-whole-family-and-the-dog.jpg.apk")
}
