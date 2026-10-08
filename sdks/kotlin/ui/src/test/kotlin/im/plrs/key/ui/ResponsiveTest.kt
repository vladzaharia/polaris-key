// @pkey-feature ui.kit
// The kit at the sizes people actually run it (PolarisLayout.kt), in both looks:
//
//   small-360x640            a small phone
//   landscape-891x411        a phone in landscape (compact height: two panes)
//   small-landscape-640x360  a small phone in landscape (the tightest two-pane case)
//   foldable-673x841         an inner foldable display
//   desktop-1920x1080        a large window (wider column, larger type)
//   phone-font150            a phone at a 150 % font scale
//
// Each size renders once neutral (the host's stock Material 3, `native-*`) and once branded
// (`polaris-*`), in opposite themes, so both looks are seen light and dark. The references sit
// beside the other snapshots under src/test/snapshots/<screen>/<size>-<look>-<theme>.png.
//
// ResponsiveLayoutTest asserts what the pictures show: at every size the sign-in code (whole,
// never cut) and the primary action, and the activation screen's key field and Activate, are
// fully on screen without scrolling.

package im.plrs.key.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
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
    /** The neutral render's theme; the branded render takes the other one. */
    val nativeDark: Boolean,
)

internal val responsiveSizes = listOf(
    ResponsiveSize("small-360x640", 360, 640, nativeDark = false),
    ResponsiveSize("landscape-891x411", 891, 411, nativeDark = true),
    ResponsiveSize("small-landscape-640x360", 640, 360, nativeDark = false),
    ResponsiveSize("foldable-673x841", 673, 841, nativeDark = true),
    ResponsiveSize("desktop-1920x1080", 1920, 1080, nativeDark = false),
    ResponsiveSize("phone-font150", 411, 891, fontScale = 1.5f, nativeDark = true),
)

/** Every size in both looks: `<size>-native-<theme>` and `<size>-polaris-<theme>`. */
internal val responsiveVariants: List<SnapshotVariant> = responsiveSizes.flatMap { size ->
    fun theme(dark: Boolean) = if (dark) "dark" else "light"
    listOf(
        SnapshotVariant(
            "${size.name}-native-${theme(size.nativeDark)}", PolarisBranding.None, size.nativeDark,
            size.widthDp, size.heightDp, size.fontScale,
        ),
        SnapshotVariant(
            "${size.name}-polaris-${theme(!size.nativeDark)}", PolarisBranding.PolarisKey, !size.nativeDark,
            size.widthDp, size.heightDp, size.fontScale,
        ),
    )
}

/** The screens the responsive suite renders: sign-in, the gate's forms and messages, and the panes. */
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

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ResponsiveSnapshotTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = responsiveVariants.map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun everyResponsiveScreen() {
        for ((screen, content) in kitScreens) {
            if (screen in responsiveScreens) rule.capture("$screen/${variant.name}", variant, content = content)
        }
    }
}

/** Android TV (960 x 540 dp, the television UI mode): two panes, and the sign-in QR code. */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class TvSnapshotTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private val tvVariants = listOf(
        SnapshotVariant("tv-960x540-native-dark", PolarisBranding.None, dark = true, widthDp = 960, heightDp = 540, tv = true),
        SnapshotVariant("tv-960x540-polaris-dark", PolarisBranding.PolarisKey, dark = true, widthDp = 960, heightDp = 540, tv = true),
    )

    @Test
    fun signInAndActivationOnTv() {
        val wanted = setOf("sign-in", "gate-activation")
        for (variant in tvVariants) for ((screen, content) in kitScreens) {
            if (screen in wanted) rule.capture("$screen/${variant.name}", variant, content = content)
        }
    }
}

@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ResponsiveLayoutTest(private val variant: SnapshotVariant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = responsiveVariants.map { arrayOf<Any>(it) }
    }

    @get:Rule
    val rule = createEmptyComposeRule()

    @Test
    fun theCodeAndTheOpenButtonAreOnScreen() = show("sign-in") {
        val copy = sampleCopy
        val failures = mutableListOf<String>()
        val code = node(hasContentDescription(copy.format(copy.signInCodeDescription, ""), substring = true))
        checkOnScreen("the sign-in code", code, failures)
        // The code itself is whole: the mono text is never cut at the side or the foot.
        val layout = textLayout(node(hasText(samplePrompt.userCode), merged = false))
        if (layout == null) {
            failures += "the code has no text layout"
        } else if (layout.didOverflowWidth || layout.didOverflowHeight) {
            failures += "the code is cut: ${layout.size} for '${layout.layoutInput.text}'"
        }
        checkOnScreen("Open sign-in page", node(hasText(copy.signInOpenBrowser) and hasClickAction()), failures)
        checkOnScreen("Cancel", node(hasText(copy.cancel) and hasClickAction()), failures)
        assertTrue("${variant.name}:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun theKeyFieldAndActivateAreOnScreen() = show("gate-activation") {
        val copy = sampleCopy
        val failures = mutableListOf<String>()
        checkOnScreen("Sign in", node(hasText(copy.signIn) and hasClickAction()), failures)
        checkOnScreen("the key field", node(hasSetTextAction()), failures)
        checkOnScreen("Activate", node(hasText(copy.activate) and hasClickAction()), failures)
        assertTrue("${variant.name}:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun replaceADeviceIsOnScreen() = show("gate-device-limit-manage") {
        val copy = sampleCopy
        val failures = mutableListOf<String>()
        checkOnScreen("Activate", node(hasText(copy.activate) and hasClickAction()), failures)
        checkOnScreen("Replace a device", node(hasText(copy.freeDevice) and hasClickAction()), failures)
        assertTrue("${variant.name}:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    /** Render [screen] for this variant and run [check] on it. */
    private fun show(screen: String, check: ComposeTestRule.() -> Unit) {
        val content: @Composable () -> Unit = kitScreens.first { it.first == screen }.second
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

    private fun ComposeTestRule.node(matcher: SemanticsMatcher, merged: Boolean = true): SemanticsNode? =
        onAllNodes(matcher, useUnmergedTree = !merged).fetchSemanticsNodes().firstOrNull()

    private fun textLayout(node: SemanticsNode?): TextLayoutResult? {
        val action = node?.config?.getOrNull(SemanticsActions.GetTextLayoutResult)?.action ?: return null
        val results = mutableListOf<TextLayoutResult>()
        action(results)
        return results.firstOrNull()
    }

    /**
     * [node] is fully inside the window: its bounds in the root (clipped by every ancestor,
     * scroll viewports included) are its whole laid-out size, and inside the root.
     */
    private fun ComposeTestRule.checkOnScreen(name: String, node: SemanticsNode?, failures: MutableList<String>) {
        if (node == null) {
            failures += "$name: not found"
            return
        }
        val root = onRoot().fetchSemanticsNode().size
        val shown = node.boundsInRoot
        val whole = shown.width >= node.size.width - 1f && shown.height >= node.size.height - 1f
        val inside = shown.left >= -1f && shown.top >= -1f && shown.right <= root.width + 1f && shown.bottom <= root.height + 1f
        if (!whole || !inside || shown.isEmpty) {
            failures += "$name: shown $shown of ${node.size} in a ${root.width}x${root.height} window"
        }
    }
}
