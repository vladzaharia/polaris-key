// @pkey-feature ui.kit
// The kit at the sizes people actually run it (PolarisLayout.kt), in both looks.
//
// REFERENCES (ResponsiveSnapshotTest, TvSnapshotTest, FocusSnapshotTest, AccentSnapshotTest).
// Each size renders once neutral (the host's stock Material 3, `native-*`) and once branded
// (`polaris-*`), in opposite themes, so both looks are seen light and dark. The references sit
// beside the other snapshots under src/test/snapshots/<screen>/<size>-<look>-<theme>.png:
//
//   small-360x640, landscape-891x411, small-landscape-640x360, foldable-673x841,
//   desktop-1920x1080, phone-font150   sign-in, the gate's forms and stops, devices, settings,
//                                      the update prompt
//   landscape-891x411, small-landscape-640x360
//                                      also every message screen (they never split)
//   window-960x540, laptop-1280x720, desktop-2560x1440
//                                      sign-in and the activation screen in wide landscape windows
//   tv-960x540 (the television UI mode) sign-in and its stops, activation, device limit with its
//                                      QR code, revoked and expired, with the D-pad's first focus
//   focus/                             the focus ring on TV and with a keyboard on a phone
//   accent/                            a product accent over a custom host (native dark)
//
// ASSERTIONS (ResponsiveLayoutTest). At every size above plus 800x600, 1280x800, 1366x768, a
// 411x440 split, 891x411 at 150 % and 200 % and 640x360 at 150 %, and on both TV variants: on
// sign-in, activation, the device-limit screens and every message screen (and the update dialog
// where it used to lose Later), every control is fully on screen (never clipped by its pane, the
// window or the dialog) and at least 48 dp tall, and the sign-in code is never cut.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** One size, rendered in both looks. */
internal data class ResponsiveSize(
    val name: String,
    val widthDp: Int,
    val heightDp: Int,
    val fontScale: Float = 1f,
    /** The neutral render's theme; the branded render takes the other one (TV: dark in both). */
    val nativeDark: Boolean,
    val tv: Boolean = false,
)

/** Both looks of [size]: `<size>-native-<theme>` and `<size>-polaris-<theme>`. */
internal fun bothLooks(size: ResponsiveSize): List<SnapshotVariant> {
    fun theme(dark: Boolean) = if (dark) "dark" else "light"
    val nativeDark = size.nativeDark
    // TV is dark in both looks (UI-KITS.md: games and TV default to dark).
    val polarisDark = if (size.tv) true else !nativeDark
    return listOf(
        SnapshotVariant("${size.name}-native-${theme(nativeDark)}", PolarisBranding.None, nativeDark, size.widthDp, size.heightDp, size.fontScale, size.tv),
        SnapshotVariant("${size.name}-polaris-${theme(polarisDark)}", PolarisBranding.PolarisKey, polarisDark, size.widthDp, size.heightDp, size.fontScale, size.tv),
    )
}

internal val responsiveSizes = listOf(
    ResponsiveSize("small-360x640", 360, 640, nativeDark = false),
    ResponsiveSize("landscape-891x411", 891, 411, nativeDark = true),
    ResponsiveSize("small-landscape-640x360", 640, 360, nativeDark = false),
    ResponsiveSize("foldable-673x841", 673, 841, nativeDark = true),
    ResponsiveSize("desktop-1920x1080", 1920, 1080, nativeDark = false),
    ResponsiveSize("phone-font150", 411, 891, fontScale = 1.5f, nativeDark = true),
)

/** Wide landscape windows: sign-in and activation go two-pane here. */
internal val wideSizes = listOf(
    ResponsiveSize("window-960x540", 960, 540, nativeDark = true),
    ResponsiveSize("laptop-1280x720", 1280, 720, nativeDark = false),
    ResponsiveSize("desktop-2560x1440", 2560, 1440, nativeDark = true),
)

internal val tvSize = ResponsiveSize("tv-960x540", 960, 540, nativeDark = true, tv = true)

/** Sizes the layout test checks beyond the referenced ones. */
internal val layoutOnlySizes = listOf(
    ResponsiveSize("window-800x600", 800, 600, nativeDark = false),
    ResponsiveSize("tablet-1280x800", 1280, 800, nativeDark = true),
    ResponsiveSize("laptop-1366x768", 1366, 768, nativeDark = false),
    ResponsiveSize("split-411x440", 411, 440, nativeDark = true),
    ResponsiveSize("tablet-portrait-800x1280", 800, 1280, nativeDark = false),
    ResponsiveSize("landscape-891x411-font150", 891, 411, fontScale = 1.5f, nativeDark = false),
    ResponsiveSize("landscape-891x411-font200", 891, 411, fontScale = 2f, nativeDark = true),
    ResponsiveSize("small-landscape-640x360-font150", 640, 360, fontScale = 1.5f, nativeDark = false),
)

/** The variants of the main reference set. */
internal val responsiveVariants: List<SnapshotVariant> = responsiveSizes.flatMap(::bothLooks)

/** The screens every main-set size renders. */
internal val responsiveScreens: List<String> = listOf(
    "sign-in",
    "gate-activation",
    "gate-device-limit-manage",
    "gate-revoked",
    "gate-expired",
    "devices",
    "settings",
    "update-prompt",
)

/** Every screen drawn with PolarisMessageScreen (or its layout). */
internal val messageScreens: List<String> = listOf(
    "boot-consent", "boot-offline", "boot-blocked", "boot-error",
    "gate-expired", "gate-version-too-old", "gate-version-too-new", "gate-channel-not-entitled",
    "sign-in-starting", "sign-in-expired", "sign-in-failed",
)

/** Where the layout test checks controls: the control groups and every message screen. */
internal val controlScreens: List<String> =
    (listOf("sign-in", "gate-activation", "gate-activation-error", "gate-device-limit-manage", "gate-revoked") + messageScreens).distinct()

internal fun kitScreen(name: String): @Composable () -> Unit = kitScreens.first { it.first == name }.second

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ResponsiveSnapshotTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = (responsiveVariants + wideSizes.flatMap(::bothLooks)).map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyResponsiveScreen() {
        val wide = wideSizes.any { variant.name.startsWith(it.name) }
        val short = variant.name.startsWith("landscape-891x411") || variant.name.startsWith("small-landscape-640x360")
        val screens = when {
            wide -> listOf("sign-in", "gate-activation")
            short -> (responsiveScreens + messageScreens).distinct()
            else -> responsiveScreens
        }
        for (name in screens) rule.capture("$name/${variant.name}", variant, content = kitScreen(name))
    }
}

/** Android TV (960 x 540 dp, the television UI mode): two panes, the QR codes, the D-pad's first focus. */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class TvSnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theTvScreens() {
        val screens: List<Pair<String, @Composable () -> Unit>> = listOf(
            // On TV the gate offers its key field back: "Use a license key instead".
            "sign-in" to { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), onUseKey = {}) },
            "sign-in-expired" to kitScreen("sign-in-expired"),
            "sign-in-failed" to kitScreen("sign-in-failed"),
            "gate-activation" to kitScreen("gate-activation"),
            "gate-device-limit-manage-tv" to deviceLimitTv,
            "gate-revoked" to kitScreen("gate-revoked"),
            "gate-expired" to kitScreen("gate-expired"),
        )
        for (variant in bothLooks(tvSize)) for ((name, content) in screens) rule.capture("$name/${variant.name}", variant, settle = true, content = content)
    }
}

/**
 * The kit's focus ring: TV opens with D-pad focus on the first real control (sign-in, the gate, a
 * message screen), and a phone with a keyboard in use shows the ring on the focused Sign in.
 */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class FocusSnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theFocusRing() {
        val tv = bothLooks(tvSize)[1]
        rule.capture("focus/tv-sign-in-polaris-dark", tv, settle = true) { PolarisSignInScreen(PolarisSignInUi.Showing(samplePrompt, NOW), onUseKey = {}) }
        rule.capture("focus/tv-gate-activation-polaris-dark", tv, settle = true, content = kitScreen("gate-activation"))
        rule.capture("focus/tv-gate-expired-polaris-dark", tv, settle = true, content = kitScreen("gate-expired"))
        val phone = SnapshotVariant("phone-native-light", PolarisBranding.None, dark = false)
        rule.capture("focus/phone-gate-activation-keyboard-native-light", phone, keyboard = true, settle = true, content = kitScreen("gate-activation"))
    }
}

/** A product accent over a custom host scheme: resolved against the host's own grounds (UI-KITS.md §3.3). */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class AccentSnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun aNavyAccentOverAGreyHost() {
        val grey = Color(0xFF3A3D45)
        val host = darkColorScheme(
            background = grey,
            surface = grey,
            surfaceContainerLow = Color(0xFF42454E),
            surfaceContainer = Color(0xFF474A53),
            surfaceContainerHigh = Color(0xFF4D5059),
            surfaceContainerHighest = Color(0xFF555861),
        )
        val variant = SnapshotVariant("phone-native-dark", PolarisBranding.None, dark = true)
        rule.capture("accent/navy-over-3a3d45-native-dark", variant, accent = Color(0xFF1B2A6B), host = host, content = kitScreen("gate-activation"))
    }
}

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ResponsiveLayoutTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> =
            (responsiveSizes + wideSizes + layoutOnlySizes + tvSize).flatMap(::bothLooks).map { arrayOf<Any>(it) }

        /** The sizes the update dialog is checked at (where it lost Later). */
        private val dialogSizes = setOf("landscape-891x411-font150", "small-landscape-640x360", "small-landscape-640x360-font150", "window-800x600")
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyControlIsOnScreenAndFullSize() {
        val failures = mutableListOf<String>()
        val screens = controlScreens.map { it to kitScreen(it) } +
            (if (variant.tv) listOf("gate-device-limit-manage-tv" to deviceLimitTv) else emptyList())
        for ((name, content) in screens) show(content) {
            checkControls(name, failures)
            if (name == "sign-in") {
                // The code itself is whole: the mono text is never cut at the side or the foot.
                val code = onAllNodes(hasText(samplePrompt.userCode), useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
                val layout = textLayout(code)
                if (layout == null) failures += "sign-in: the code has no text layout"
                else if (layout.didOverflowWidth || layout.didOverflowHeight) failures += "sign-in: the code is cut (${layout.size})"
                checkWhole("sign-in", "the code", code, failures)
            }
        }
        assertTrue("${variant.name}:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun theUpdateDialogKeepsItsActions() {
        val size = variant.name.substringBefore("-native").substringBefore("-polaris")
        if (size !in dialogSizes) return
        val failures = mutableListOf<String>()
        show(updateDialog) {
            checkControls("update-dialog", failures, expected = listOf(sampleCopy.updateNow, sampleCopy.updateLater))
        }
        assertTrue("${variant.name}:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    /** Render [content] for this variant and run [check] on it. */
    private fun show(content: @Composable () -> Unit, check: ComposeTestRule.() -> Unit) {
        RuntimeEnvironment.setQualifiers(variant.qualifiers)
        RuntimeEnvironment.setFontScale(variant.fontScale)
        rule.mainClock.autoAdvance = false
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    StockHost(variant.dark) {
                        PolarisTheme(branding = variant.branding, copy = sampleCopy, darkTheme = variant.dark) { content() }
                    }
                }
            }
            rule.mainClock.advanceTimeBy(2_600)
            rule.check()
        }
    }

    private fun textLayout(node: SemanticsNode?): TextLayoutResult? {
        val action = node?.config?.getOrNull(SemanticsActions.GetTextLayoutResult)?.action ?: return null
        val results = mutableListOf<TextLayoutResult>()
        action(results)
        return results.firstOrNull()
    }

    private fun SemanticsNode.label(): String {
        val text = config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
        val description = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()
        val editable = config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
        return "$text $description $editable".trim()
    }

    /**
     * Every clickable and editable node: whole (its bounds in its root, clipped by every ancestor,
     * scroll viewports and dialogs included, are its full size), inside its root, and at least
     * 48 dp tall. With [expected], each of those labels must be among them.
     */
    private fun ComposeTestRule.checkControls(screen: String, failures: MutableList<String>, expected: List<String> = emptyList()) {
        val min = with(density) { PolarisMinTouchTarget.toPx() } - 0.5f
        val controls = onAllNodes(hasClickAction() or hasSetTextAction()).fetchSemanticsNodes()
        for (node in controls) {
            checkWhole(screen, node.label(), node, failures)
            val height = maxOf(node.size.height.toFloat(), node.touchBoundsInRoot.height)
            if (height < min) failures += "$screen: '${node.label()}' is ${height / density.density} dp tall"
        }
        val labels = controls.map { it.label() }
        for (label in expected) if (labels.none { it.contains(label) }) failures += "$screen: '$label' is missing ($labels)"
    }

    private fun checkWhole(screen: String, name: String, node: SemanticsNode?, failures: MutableList<String>) {
        if (node == null) {
            failures += "$screen: $name not found"
            return
        }
        val root = generateSequence(node) { it.parent }.last().size
        val shown = node.boundsInRoot
        val whole = shown.width >= node.size.width - 1f && shown.height >= node.size.height - 1f
        val inside = shown.left >= -1f && shown.top >= -1f && shown.right <= root.width + 1f && shown.bottom <= root.height + 1f
        if (!whole || !inside || shown.isEmpty) {
            failures += "$screen: '$name' shows $shown of ${node.size} in ${root.width}x${root.height}"
        }
    }
}
