// The shared board-render fixtures of the desktop chromes (UK-10.5/.6 fix round): the Tidewater
// presentation (accent #26847a, an icon, developer "Harbor Audio") plus one no-accent (ink) row,
// every frame at rest (no control holds focus) except ONE keyboard-focus shot, and the end-user
// addresses in Polaris Locker's name (`polaris.locker`), never the console's.

package im.plrs.key.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import java.io.File
import javax.imageio.ImageIO

internal object BoardFixtures {
    /** The Tidewater product's accent. */
    val tidewaterAccent = Color(0xFF26847A)
    const val PRODUCT = "Tidewater Studio"
    const val DEVELOPER = "Harbor Audio"

    /** The end-user addresses: Polaris Locker's, per the naming rule. */
    const val LOCKER = "https://polaris.locker"
    const val PORTAL = "https://polaris.locker/portal"
    const val SIGN_IN = "https://polaris.locker/signin"

    /** Tidewater's icon: a teal tile with two waves. */
    @Composable
    fun TidewaterIcon() {
        Canvas(Modifier.fillMaxSize().background(tidewaterAccent)) {
            val stroke = Stroke(width = size.width * 0.08f, cap = StrokeCap.Round)
            for (row in listOf(0.40f, 0.60f)) {
                val y = size.height * row
                val path = Path().apply {
                    moveTo(size.width * 0.20f, y)
                    cubicTo(size.width * 0.35f, y - size.height * 0.14f, size.width * 0.50f, y + size.height * 0.14f, size.width * 0.65f, y)
                    cubicTo(size.width * 0.72f, y - size.height * 0.06f, size.width * 0.76f, y - size.height * 0.04f, size.width * 0.80f, y)
                }
                drawPath(path, Color.White, style = stroke) // polaris-lint: allow-colour (a fixture icon)
            }
        }
    }

    /** The product's own page behind an overlay, in the theme's ground. */
    @Composable
    fun Product() {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
            Text(PRODUCT, style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        }
    }
}

/** One render of a board: its scheme, row (Tidewater or ink) and whether the primary holds keyboard focus. */
internal class BoardRender(val dark: Boolean, val ink: Boolean = false, val focus: Boolean = false) {
    val suffix: String get() = (if (dark) "dark" else "light") + (if (ink) "-ink" else "") + (if (focus) "-focus" else "")
}

/** The renders every screen gets at [w] x [h]: at rest in both schemes; at the first size also the ink row and the focus shot. */
internal fun rendersFor(first: Boolean, large: Boolean): List<BoardRender> = buildList {
    for (dark in listOf(true, false)) {
        add(BoardRender(dark))
        if (first) add(BoardRender(dark, ink = true))
        if (large) add(BoardRender(dark, focus = true))
    }
}

/**
 * Renders [content] under the chrome's theme at [w] x [h] and, when [out] is set, writes the last
 * semantics root (a Dialog is its own root over the host's, and the last is the window as drawn) to
 * `<out>/<chrome>.<name>/<w>x<h>-<suffix>.png`. Returns after composing.
 */
@OptIn(ExperimentalTestApi::class)
internal fun renderBoard(out: File?, chrome: String, name: String, w: Int, h: Int, render: BoardRender, content: @Composable () -> Unit) {
    runDesktopComposeUiTest(width = w, height = h) {
        setContent {
            val tidewater = !render.ink
            PolarisTheme(
                darkTheme = render.dark,
                copy = PolarisCopy(productName = BoardFixtures.PRODUCT),
                accent = if (tidewater) BoardFixtures.tidewaterAccent else null,
                logo = if (tidewater) ({ BoardFixtures.TidewaterIcon() }) else null,
                developer = if (tidewater) BoardFixtures.DEVELOPER else null,
            ) {
                // The kit takes initial focus on a desktop; a frame at rest holds none (the seam carries into a Dialog's window).
                androidx.compose.runtime.CompositionLocalProvider(LocalPolarisInitialFocus provides render.focus) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
                }
            }
        }
        waitForIdle()
        mainClock.advanceTimeBy(800)
        waitForIdle()
        if (out != null) {
            val roots = onAllNodes(isRoot())
            val image = roots[roots.fetchSemanticsNodes().size - 1].captureToImage()
            val file = File(out, "$chrome.$name/${w}x$h-${render.suffix}.png")
            file.parentFile.mkdirs()
            ImageIO.write(image.toAwtImage(), "png", file)
        }
    }
}
