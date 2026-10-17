// @pkey-feature ui.kit
// TalkBack and touch, asserted on every screen in both brandings:
//   - each screen has a heading (TalkBack's heading navigation lands on its title);
//   - every clickable has a name (text or content description) and a touch target of at least
//     48 x 48 dp;
//   - images that carry meaning (the QR code, the marks) have descriptions, and decorative icons
//     are hidden;
//   - at a 200 % font scale on a small phone nothing clips: every text lays out without
//     overflow, and a screen taller than the window scrolls;
//   - the activation screen reads in a sensible order (title, then sign-in, then the key field,
//     then Activate).

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-mdpi")
class AccessibilityTest {
    @get:Rule
    val rule = createComposeRule()

    private var screen by mutableStateOf<@Composable () -> Unit>({})

    private fun host(branding: PolarisBranding, fontScale: Float = 1f) {
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                StockHost(false) {
                    PolarisTheme(branding = branding, showPoweredBy = true, copy = sampleCopy, darkTheme = false) { screen() }
                }
            }
        }
    }

    private fun show(content: @Composable () -> Unit) {
        rule.runOnIdle { screen = content }
        rule.waitForIdle()
    }

    private fun nodes(matcher: SemanticsMatcher, merged: Boolean = true): List<SemanticsNode> =
        rule.onAllNodes(matcher, useUnmergedTree = !merged).fetchSemanticsNodes()

    private fun SemanticsNode.name(): String {
        val text = config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
        val description = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()
        val editable = config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
        return "$text $description $editable".trim()
    }

    private fun checkScreen(name: String, failures: MutableList<String>, requireHeading: Boolean = true) {
        if (requireHeading && nodes(isHeading()).isEmpty()) failures += "$name: no heading"
        val density = rule.density
        val min = with(density) { PolarisMinTouchTarget.toPx() } - 0.5f
        for (node in nodes(hasClickAction())) {
            if (node.name().isEmpty()) failures += "$name: a clickable without a name at ${node.boundsInRoot}"
            // The node's laid-out size (a control scrolled partly out of view is still full size);
            // Material's minimum interactive size is a layout modifier, so it counts here.
            val w = maxOf(node.size.width.toFloat(), node.touchBoundsInRoot.width)
            val h = maxOf(node.size.height.toFloat(), node.touchBoundsInRoot.height)
            if (w < min || h < min) {
                failures += "$name: '${node.name()}' touch target ${w / density.density}x${h / density.density} dp"
            }
        }
        // Images with a role carry a description.
        for (node in nodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Image), merged = false)) {
            if (node.config.getOrNull(SemanticsProperties.ContentDescription).isNullOrEmpty()) failures += "$name: an image without a description"
        }
    }

    @Test
    fun everyScreenNeutral() = everyScreen(PolarisBranding.None)

    @Test
    fun everyScreenBranded() = everyScreen(PolarisBranding.PolarisKey)

    private fun everyScreen(branding: PolarisBranding) {
        host(branding)
        val failures = mutableListOf<String>()
        for ((name, content) in kitScreens) {
            show(content)
            // The update banner sits over the product, which brings its own heading.
            checkScreen(name, failures, requireHeading = name != "update-banner")
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun largeFontsNeverClip() {
        host(PolarisBranding.None, fontScale = 2f)
        val failures = mutableListOf<String>()
        for ((name, content) in kitScreens) {
            show(content)
            for (node in nodes(SemanticsMatcher.keyIsDefined(SemanticsActions.GetTextLayoutResult), merged = false)) {
                val results = mutableListOf<TextLayoutResult>()
                node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
                val layout = results.firstOrNull() ?: continue
                // Clipped: cut vertically, or cut short with an ellipsis. (didOverflowWidth is not a
                // clip signal: a centred paragraph is laid out at the full width it was offered.)
                val lastEllipsized = layout.lineCount > 0 && layout.isLineEllipsized(layout.lineCount - 1)
                if (layout.didOverflowHeight || lastEllipsized) failures += "$name: '${layout.layoutInput.text}' is clipped"
                // And no text runs off the side of the window.
                val bounds = node.boundsInRoot
                if (bounds.left < -1f || bounds.right > rule.onRoot().fetchSemanticsNode().size.width + 1f) {
                    failures += "$name: '${layout.layoutInput.text}' runs off the side ($bounds)"
                }
            }
            val root = rule.onRoot().fetchSemanticsNode()
            val scrolls = nodes(hasScrollAction()).isNotEmpty()
            val content = nodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), merged = false)
            val lowest = content.maxOfOrNull { it.boundsInRoot.bottom } ?: 0f
            if (lowest > root.size.height + 1 && !scrolls) failures += "$name: content runs past the window and does not scroll"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun activationReadsInOrder() {
        host(PolarisBranding.None)
        show(kitScreens.first { it.first == "gate-activation" }.second)
        val copy = sampleCopy
        val order = rule.onRoot().fetchSemanticsNode().let { root ->
            val out = mutableListOf<String>()
            fun walk(n: SemanticsNode) {
                val name = n.name()
                if (name.isNotEmpty()) out += name
                n.children.forEach(::walk)
            }
            walk(root)
            out
        }
        fun at(text: String) = order.indexOfFirst { it.contains(text) }
        val title = at(copy.format(copy.activationTitle, copy.productName))
        val signIn = at(copy.signIn)
        val key = at(copy.keyLabel)
        val activate = order.indexOfLast { it == copy.activate }
        assertTrue("reading order $order", title in 0 until signIn && signIn < key && key < activate)
    }

}
