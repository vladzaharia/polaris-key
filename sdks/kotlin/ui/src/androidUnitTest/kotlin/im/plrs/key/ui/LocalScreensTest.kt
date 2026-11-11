// @pkey-feature ui.kit connect.local
// Pair with a Code (CC-29K.2; ui-matrix `local` and `localLayout`): every non-hidden row of the family is drawn by the kit in both themes
// on a phone (baselines under src/test/snapshots/local/), the key states at the committed size matrix (short landscape, tablet, 200 %
// text, TV), and the rules the rows pin are checked on the screen: the code is read digit by digit, Pair answers while unavailable,
// the first focus on a consent is Not now, the switch column follows the rule and each switch is named for its device.

@file:Suppress("ktlint:standard:function-naming", "FunctionNaming", "LongParameterList", "MaxLineLength", "LongMethod")

package im.plrs.key.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** One drawn row of the matrix's `local` family: its inputs as the kit's state holders carry them. */
internal class LocalCase(
    val id: String,
    val component: KitComponent,
    val pairing: PolarisLocalPairingUi?,
    val devices: PolarisPairedDevicesUi?,
    val expectState: String,
    val expectCopy: List<String>,
    val expectDisabled: List<String>,
    /** False when the row says Compose draws nothing for it (Google's scanner is its own sheet). */
    val drawn: Boolean = true,
) {
    override fun toString(): String = id
}

private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

private fun JsonObject.int(key: String) = (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.flag(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull == true

private fun JsonElement.strings() = (this as JsonArray).map { (it as JsonPrimitive).content }

internal fun pairingUiOf(p: JsonObject) = PolarisLocalPairingUi(
    step = p.str("step")!!,
    prePrompt = p.flag("prePrompt"),
    full = p.flag("full"),
    code = p.str("code"),
    qr = p.str("qr"),
    secondsLeft = p.int("secondsLeft"),
    notice = p.str("notice"),
    busy = p.str("busy"),
    closedBy = p.str("closedBy"),
    cooldownLeft = p.int("cooldownLeft"),
    warn = p.flag("warn"),
    entry = p.str("entry"),
    error = p.str("error"),
    triesLeft = p.int("triesLeft"),
    pairDisabled = p.flag("pairDisabled"),
    categories = p["categories"]?.strings().orEmpty(),
    device = p.str("device"),
    reason = p.str("reason"),
    canOpenSettings = p.flag("canOpenSettings"),
    canScan = p.flag("canScan"),
    scanNotice = p.str("scanNotice"),
    sheetScan = p.flag("sheetScan"),
    scanShares = p.flag("scanShares"),
    cameraBusy = p.flag("cameraBusy"),
    cantConnect = p.flag("cantConnect"),
    view = p.str("view"),
    expired = p.flag("expired"),
    nameError = p.str("nameError") != null,
    max = p.int("max") ?: KitLocal.MAX_CONNECTABLE,
    name = p.str("device").orEmpty(),
    // The matrix does not carry the lit digits; the first rotation of a wrong code lights the last four.
    changed = if (p.str("notice") == "rotated" || p.str("notice") == "guessing") listOf(5, 6, 7, 8) else emptyList(),
    rotation = if (p.str("notice") != null) 2 else 1,
    replaced = p.str("notice") != null,
)

internal fun devicesUiOf(p: JsonObject): PolarisPairedDevicesUi {
    val rows = (p["devices"] as? JsonArray).orEmpty().map { it as JsonObject }.map {
        PolarisPairedDevice(
            it.str("id")!!,
            it.str("label"),
            (it["lastSeen"] as? JsonPrimitive)?.longOrNull,
            it["reachable"]?.let { r -> (r as JsonPrimitive).booleanOrNull } != false,
            it.str("platform"),
        )
    }
    val target = p.str("target")
    return PolarisPairedDevicesUi(
        step = p.str("step")!!,
        devices = rows,
        target = target,
        renameError = p.str("renameError"),
        forgetError = p.flag("forgetError"),
        notice = (p["notice"] as? JsonObject)?.let { PolarisPairedNotice(it.str("device").orEmpty(), it.str("kind")!!, it.str("id")) },
        draft = rows.firstOrNull { it.id == target }?.label.orEmpty(),
        loaded = p.str("step") != "loading",
    )
}

internal object LocalCases {
    /** Every non-hidden `local` row, in the matrix's order. */
    val all: List<LocalCase> by lazy {
        val root = requireNotNull(System.getProperty("pkey.repoRoot")) { "pkey.repoRoot is set by :ui's test task" }
        val raw = Json.parseToJsonElement(File(root, "conformance/corpus/v2/ui-matrix.json").readText()) as JsonObject
        (raw["local"] as JsonArray).mapIndexedNotNull { index, element ->
            val row = element as JsonObject
            val input = row["input"] as JsonObject
            val expect = row["expect"] as JsonObject
            val state = expect.str("state")!!
            if (state == "hidden") return@mapIndexedNotNull null
            val component = KitComponent.fromId(expect.str("component")!!)!!
            val about = (row["name"] as JsonPrimitive).content.substringAfter(": ").split(' ').take(4)
            val id = (
                listOf(
                    "%02d".format(index),
                    component.id,
                    state,
                ) + about
                ).joinToString("-").lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
            LocalCase(
                id,
                component,
                (input["localPairing"] as? JsonObject)?.let(::pairingUiOf),
                (input["pairedDevices"] as? JsonObject)?.let(::devicesUiOf),
                state,
                expect["copy"]!!.strings(),
                expect["disabled"]?.strings().orEmpty(),
                drawn = "kotlin" !in ((row["notApplicable"] as? JsonObject)?.get("sdks")?.strings().orEmpty()) && reachable(input),
            )
        }
    }

    /**
     * A choose step that can scan without the host's sheet never occurs on Android: the state holder sets both together, because Google's
     * scanner is its own sheet. A row for it would record a choose with no way to type, so it is not drawn.
     */
    private fun reachable(input: JsonObject): Boolean {
        val p = input["localPairing"] as? JsonObject ?: return true
        return !(p.str("step") == "choose" && p.flag("canScan") && !p.flag("sheetScan"))
    }

    /** The rows Compose draws. */
    val drawn: List<LocalCase> by lazy { all.filter { it.drawn } }

    fun case(prefix: String): LocalCase = drawn.first { it.id.substringAfter('-').startsWith(prefix) }
}

@Composable
internal fun LocalCase.Draw() {
    if (pairing != null) PolarisLocalPairingScreen(pairing) else PolarisPairedDevicesScreen(devices!!, nowMillis = FIXED_NOW)
}

/** A fixed "now", so "Last seen" reads the same on every run: a day after the fixtures' newest sighting. */
private const val FIXED_NOW = (1_700_000_000L + 86_400L) * 1000L

/** The inputs the stateless screens draw are the matrix's: their resolved screens are exactly the rows' expectations. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class LocalInputsTest {
    @Test
    fun everyRowsInputsResolveToItsExpectation() {
        val cases = LocalCases.all
        assertTrue("the family's drawn rows", cases.size > 50)
        for (case in cases) {
            val screen = case.pairing?.screen() ?: case.devices!!.screen()
            assertEquals("${case.id} state", case.expectState, screen.state)
            assertEquals("${case.id} copy", case.expectCopy.sorted(), screen.copyKeys)
            assertEquals("${case.id} disabled", case.expectDisabled.sorted(), screen.disabledKeys)
        }
    }
}

/** Every drawn row, in both themes on a phone. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class LocalMatrixSnapshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun themes(): List<Array<Any>> = listOf(arrayOf<Any>(true), arrayOf<Any>(false))
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyRow() {
        val cases = LocalCases.drawn
        assertEquals("a baseline name per row", cases.size, cases.map { it.id }.toSet().size)
        val variant = snapshotVariants.first { it.branding == PolarisBranding.PolarisKey && it.dark == dark && it.widthDp == 411 }
        for (case in cases) {
            rule.capture("local/${case.id}/phone-polaris-${if (dark) "dark" else "light"}", variant) {
                // Reduced motion holds the wait shimmer still, so the picture is the same on every run.
                CompositionLocalProvider(LocalPolarisReduceMotion provides true) { case.Draw() }
            }
        }
    }
}

private val localSizes = listOf(
    // The window rule: one column at every size; no logo under 480 tall, the column scrolls; the QR view splits in two from 720 wide.
    ResponsiveSize("phone-844x390", 844, 390, nativeDark = true),
    ResponsiveSize("small-landscape-640x360", 640, 360, nativeDark = false),
    ResponsiveSize("narrow-short-390x420", 390, 420, nativeDark = true),
    ResponsiveSize("tablet-1180x820", 1180, 820, nativeDark = false),
    ResponsiveSize("portrait-390x844", 390, 844, nativeDark = true),
    ResponsiveSize("phone-390x844-font200", 390, 844, fontScale = 2f, nativeDark = true),
)

/** The states where layout matters most, at the committed size matrix (and TV). */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class LocalResponsiveSnapshotTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = (localSizes.flatMap(::bothLooks) + bothLooks(tvSize))
            .filter { it.branding == PolarisBranding.PolarisKey }
            .map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theKeyStates() {
        for (prefix in listOf(
            "localpairing-show-a-wrong-code-changed",
            "localpairing-enter-a-wrong",
            "localpairing-confirm-the",
            "paireddevices-list-five",
            "localpairing-show-the-code-is",
            "localpairing-show-qr-the-qr",
            "localpairing-show-qr-the-code-expired",
            "paireddevices-renaming-in-the",
        )) {
            val case = LocalCases.drawn.firstOrNull { it.id.substringAfter('-').startsWith(prefix) } ?: continue
            rule.capture("local/${case.id}/${variant.name}", variant) {
                CompositionLocalProvider(LocalPolarisReduceMotion provides true) { case.Draw() }
            }
        }
    }
}

private const val LINK_MIN_WIDTH_DP = 120f
private const val LINK_MIN_HEIGHT_DP = 48f

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class LocalScreensTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @Composable () -> Unit) {
        rule.setContent {
            StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) { content() } }
        }
        rule.waitForIdle()
    }

    private fun top(text: String) = rule.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

    private fun pairing(step: String, change: PolarisLocalPairingUi.() -> PolarisLocalPairingUi = { this }) =
        PolarisLocalPairingUi(step = step, categories = listOf("crates", "cues")).change()

    /** A quiet link keeps its own width: at least its words on one line, never a letter a line (a one-line link is under 2 targets tall). */
    private fun assertLinkIsWholeWords(text: String) {
        val bounds = rule.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val density = rule.density.density
        assertTrue("$text is ${bounds.width / density} dp wide", bounds.width / density >= LINK_MIN_WIDTH_DP)
        assertTrue("$text is ${bounds.height / density} dp tall", bounds.height / density < 2 * LINK_MIN_HEIGHT_DP)
    }

    @Test
    fun theScanLinkOnTheFieldIsNeverSqueezed() {
        show { PolarisLocalPairingScreen(pairing("enter") { copy(entry = "", canScan = true) }) }
        assertLinkIsWholeWords("Scan the code instead")
    }

    @Test
    fun theShowLinkOnTheFieldIsNeverSqueezed() {
        show { PolarisLocalPairingScreen(pairing("enter") { copy(entry = "") }) }
        assertLinkIsWholeWords("Show a code instead")
    }

    @Test
    fun theLinkOnTheShownCodeIsNeverSqueezed() {
        show { PolarisLocalPairingScreen(pairing("show") { copy(code = "4812 3456", qr = "PKP1:T:X:Y", secondsLeft = 291) }) }
        assertLinkIsWholeWords("Show a QR code")
    }

    @Test
    fun theLinkOnTheQrViewIsNeverSqueezed() {
        show { PolarisLocalPairingScreen(pairing("show") { copy(code = "4812 3456", qr = "PKP1:T:X:Y", secondsLeft = 291, view = "qr") }) }
        assertLinkIsWholeWords("Show the code instead")
    }

    @Test
    fun cancelHugsItsWordsAndIsNotAFullWidthPill() {
        show { PolarisLocalPairingScreen(pairing("show") { copy(code = "4812 3456", qr = "PKP1:T:X:Y", secondsLeft = 291) }) }
        val cancel = rule.onNodeWithText("Cancel", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val density = rule.density.density
        assertTrue("Cancel is ${cancel.width / density} dp wide", cancel.width / density < 200f)
    }

    @Test
    fun theCodeViewShowsOnlyTheDigitsAndTheQrViewOnlyTheQr() {
        var ui by mutableStateOf(pairing("show") { copy(code = "4812 3456", qr = "PKP1:T:X:Y", secondsLeft = 291) })
        show { PolarisLocalPairingScreen(ui) }
        val qrName = KitCopy.bundled.format("a11y.qrPairing", "en")
        rule.onNodeWithContentDescription("Pairing code 4 8 1 2   3 4 5 6").assertIsDisplayed()
        rule.onNodeWithText("Enter this code on the other device.").assertIsDisplayed()
        rule.onNodeWithContentDescription(qrName).assertDoesNotExist()
        ui = ui.copy(view = "qr")
        rule.waitForIdle()
        rule.onNodeWithText("Scan to pair").assertIsDisplayed()
        rule.onNodeWithContentDescription("Pairing code 4 8 1 2   3 4 5 6").assertDoesNotExist()
    }

    @Test
    fun theLinksSwitchTheViewAndAnExpiredWindowOffersAPrimaryNewCode() {
        val pressed = mutableListOf<String>()
        val actions = object : PolarisLocalPairingActions {
            override fun showQr() {
                pressed += "qr"
            }

            override fun showCode() {
                pressed += "code"
            }

            override fun showNew() {
                pressed += "new"
            }
        }
        var ui by mutableStateOf(pairing("show") { copy(code = "4812 3456", qr = "PKP1:T:X:Y", secondsLeft = 291) })
        show { PolarisLocalPairingScreen(ui, actions = actions) }
        rule.onNodeWithText("Show a QR code").performClick()
        ui = ui.copy(view = "qr")
        rule.waitForIdle()
        rule.onNodeWithText("Show the code instead").performClick()
        ui = ui.copy(secondsLeft = 0, expired = true)
        rule.waitForIdle()
        rule.onNodeWithText("Show a new code").performClick()
        assertEquals(listOf("qr", "code", "new"), pressed)
    }

    @Test
    fun pairAnswersWhileUnavailableAndSendsNothingElse() {
        var pressed = 0
        show {
            PolarisLocalPairingScreen(
                pairing("enter") {
                    copy(entry = "4873", pairDisabled = true)
                },
                actions = object : PolarisLocalPairingActions {
                    override fun pair() {
                        pressed++
                    }
                },
            )
        }
        rule.onNodeWithText("Pair").performClick()
        assertEquals("a press on an unavailable Pair reaches the state holder, which answers its reason", 1, pressed)
    }

    @Test
    fun aConsentReadsPairBeforeNotNowAndNotNowDeclines() {
        var paired = 0
        var declined = 0
        show {
            PolarisLocalPairingScreen(
                pairing("confirm") { copy(device = "Maya's laptop") },
                actions = object : PolarisLocalPairingActions {
                    override fun confirm() {
                        paired++
                    }

                    override fun notNow() {
                        declined++
                    }
                },
            )
        }
        rule.onNodeWithText("Not now").performClick()
        assertEquals(1, declined)
        assertEquals(0, paired)
        assertTrue("Pair comes before Not now in reading order", top("Pair") < top("Not now"))
    }

    @Test
    fun theCategoriesComeBeforePairOnTheFieldsScreen() {
        show { PolarisLocalPairingScreen(pairing("enter") { copy(entry = "4812 3456") }) }
        assertTrue("the categories come before Pair", top("Each of you shares") < top("Pair"))
    }

    @Test
    fun theCooldownButtonSaysTheWaitAndIsDimmedNeverARawPlaceholder() {
        show { PolarisLocalPairingScreen(pairing("closed") { copy(closedBy = "too-many-tries", cooldownLeft = 24) }) }
        rule.onNodeWithText("Show a new code in 0:24").assertIsDisplayed()
        rule.onNodeWithText("{time}", substring = true).assertDoesNotExist()
    }

    @Test
    fun aBusyNoticeShowsItsTryAgainAndReportsTheDevice() {
        val tried = mutableListOf<String>()
        val devices = listOf(PolarisPairedDevice("L1", "Device 1", 1_700_000_000, true))
        show {
            PolarisPairedDevicesScreen(
                PolarisPairedDevicesUi(step = "list", devices = devices, loaded = true, notice = PolarisPairedNotice("Device 1", "busy", "L1")),
                actions = object : PolarisPairedDevicesActions {
                    override fun retryNotice(id: String) {
                        tried += id
                    }
                },
                nowMillis = FIXED_NOW,
            )
        }
        rule.onNodeWithText("Try again").performClick()
        assertEquals(listOf("L1"), tried)
    }

    @Test
    fun aRefusalSaysItsReasonBeforeClose() {
        show { PolarisLocalPairingScreen(pairing("off")) }
        val message = KitCopy.bundled.format("core.codes.local-pairing-off.message", "en")
        assertTrue("the reason comes before Close", top(message) < top("Close"))
    }

    @Test
    fun theSwitchColumnFollowsTheRuleAndEachSwitchIsNamedForItsDevice() {
        val few = List(3) { PolarisPairedDevice("L$it", "Device $it", 1_700_000_000, true) }
        var devices by mutableStateOf(few)
        show { PolarisPairedDevicesScreen(PolarisPairedDevicesUi(step = "list", devices = devices, loaded = true), nowMillis = FIXED_NOW) }
        rule.onNodeWithContentDescription("Let ⁨Device 1⁩ connect to this device").assertDoesNotExist()
        devices = few.mapIndexed { i, d -> if (i == 1) d.copy(reachable = false) else d }
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Let ⁨Device 1⁩ connect to this device").assertExists()
    }

    @Test
    fun theListSaysNothingAboutWhatIsPairedUntilItIsRead() {
        show { PolarisPairedDevicesScreen(PolarisPairedDevicesUi(step = "loading")) }
        rule.onNodeWithText("No paired devices yet.").assertDoesNotExist()
        rule.onNodeWithText("Pair with a Code").assertDoesNotExist()
    }

    @Test
    fun theOptionsMenuOffersRenameAndForgetAndEachStartsItsEdit() {
        val started = mutableListOf<String>()
        val devices = listOf(PolarisPairedDevice("L1", "Device 1", 1_700_000_000, true))
        show {
            PolarisPairedDevicesScreen(
                PolarisPairedDevicesUi(step = "list", devices = devices, loaded = true),
                actions = object : PolarisPairedDevicesActions {
                    override fun startRename(id: String) {
                        started += "rename:$id"
                    }

                    override fun askForget(id: String) {
                        started += "forget:$id"
                    }
                },
                nowMillis = FIXED_NOW,
            )
        }
        rule.onNodeWithContentDescription("Options for ⁨Device 1⁩").performClick()
        rule.onNodeWithText("Rename").performClick()
        rule.onNodeWithContentDescription("Options for ⁨Device 1⁩").performClick()
        rule.onNodeWithText("Forget").performClick()
        assertEquals(listOf("rename:L1", "forget:L1"), started)
    }
}

/** The keyboard (and D-pad) rules: the first focus is the safe verb, and a TV press that arrives with the prompt is ignored. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class LocalScreensKeyboardTest {
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
    fun theFirstFocusOnAConsentIsNotNowNeverPair() {
        show { LocalCases.case("localpairing-confirm-the").Draw() }
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithText("Not now").assertIsFocused()
        rule.onNodeWithText("Pair").assertIsNotFocused()
    }
}

/** The QR view of a window that ran out fades toward the paper: a decoder reads the live card and finds nothing on the dead one. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class ExpiredQrScanTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private val text = "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y"

    /** What a camera would read off the screen: the activity's window drawn to a bitmap, then a QR decoder run over it. */
    private fun scanned(scenario: ActivityScenario<ComponentActivity>): String? {
        lateinit var bitmap: Bitmap
        scenario.onActivity { activity ->
            val view = activity.window.decorView
            bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
        }
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
        // A decoder that finds no code throws one of its three not-found errors: that is "nothing scanned".
        return runCatching { QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
    }

    @Test
    fun theExpiredQrFadesTowardThePaperAndDoesNotScan() {
        var ui by mutableStateOf(
            PolarisLocalPairingUi(step = "show", code = "4812 3456", qr = text, secondsLeft = 291, view = "qr", categories = listOf("crates")),
        )
        rule.mainClock.autoAdvance = false
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    MaterialTheme(colorScheme = lightColorScheme()) {
                        PolarisTheme(branding = PolarisBranding.PolarisKey, copy = sampleCopy, darkTheme = false) {
                            CompositionLocalProvider(LocalPolarisReduceMotion provides true) { PolarisLocalPairingScreen(ui) }
                        }
                    }
                }
            }
            rule.mainClock.advanceTimeBy(2_600)
            assertEquals("the live card scans", text, scanned(scenario))
            ui = ui.copy(secondsLeft = 0, expired = true)
            rule.mainClock.advanceTimeBy(2_600)
            assertEquals("the expired card does not scan", null, scanned(scenario))
            rule.onNodeWithText("Code expired").assertIsDisplayed()
        }
    }
}
