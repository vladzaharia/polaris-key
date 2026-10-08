// The kit's responsive rules, in one place, so every screen sizes and spaces itself the same way.
//
// THE WINDOW. A kit screen measures the space it is given (after the safe-drawing insets) and
// provides it as a PolarisWindow. These questions decide every layout:
//
//   compactHeight  under 480 dp tall (a phone in landscape, a split-screen pane).
//   wide           840 dp wide or more and not compact height (a tablet, an open foldable, a
//                  desktop window). The column grows and the title steps up a role.
//   large          1600 x 900 dp or more (a large desktop window). The column grows again, the
//                  title steps up again, and the screen's type scale is 1.125x.
//   twoPane        a screen with a control group (sign-in, activation) puts its content on the
//                  start side and its controls on the end side: at compact height, on Android TV,
//                  and in a landscape window 840 dp wide or more (width / height at least 1.4),
//                  always with at least 560 dp to split.
//   card           a message screen sets itself on a card: on TV and in a wide landscape window.
//
// THE RHYTHM. One scale on the 4 dp grid (UI-KITS.md §1.5 rule 5):
//
//   tight     8 dp   a title and its lede, a value and its caption
//   controls 12 dp   stacked controls in one group (the spec's 10–16)
//   group    24 dp   two groups inside one region (Sign in, then the key path)
//   gutter   48 dp   between the two panes
//   section  the gap between the header, the content and the controls: 24 dp on a phone, 32 wide,
//            40 large, and 16 at compact height, where height is what runs out.

package im.plrs.key.ui

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The space a kit screen lays out in, and the measures that follow from it. */
@Immutable
internal class PolarisWindow(
    val width: Dp,
    val height: Dp,
    /** Android TV (the UI mode, not the size). */
    val tv: Boolean = false,
) {
    /** Under 480 dp tall. */
    val compactHeight: Boolean get() = height < COMPACT_HEIGHT

    /** 840 dp wide or more, and not compact height: a tablet, an open foldable, a desktop. */
    val wide: Boolean get() = width >= WIDE_WIDTH && !compactHeight

    /** 1600 x 900 dp or more: a large desktop window. */
    val large: Boolean get() = width >= LARGE_WIDTH && height >= LARGE_HEIGHT

    /** A landscape window 840 dp wide or more, at least 1.4 times as wide as it is tall. */
    val wideLandscape: Boolean get() = width >= WIDE_WIDTH && width / height >= WIDE_RATIO

    /** Content beside its controls (screens with a control group only). */
    val twoPane: Boolean get() = width >= TWO_PANE_MIN_WIDTH && (compactHeight || tv || wideLandscape)

    /** A message screen on a card: on TV and in a wide landscape window. */
    val card: Boolean get() = tv || (width >= WIDE_WIDTH && width > height && !compactHeight)

    /** The widest a single column grows. */
    val columnWidth: Dp
        get() = when {
            large -> 600.dp
            wide -> 520.dp
            else -> PolarisMaxContentWidth
        }

    /** The gap between the header, the content and the controls. */
    val section: Dp
        get() = when {
            compactHeight -> 16.dp
            large -> 40.dp
            wide -> 32.dp
            else -> 24.dp
        }

    /** The screen's side padding: TV keeps 48 dp of overscan. */
    val horizontalPadding: Dp get() = if (tv) 48.dp else 24.dp

    /** The screen's vertical padding: less where height runs out, the title-safe band on TV. */
    val verticalPadding: Dp
        get() = when {
            tv -> 28.dp
            compactHeight -> 16.dp
            large -> 48.dp
            else -> 24.dp
        }

    /** The top inset of a single column (focused steps top-anchor under it); short windows keep their height. */
    val topInset: Dp
        get() = when {
            compactHeight -> 16.dp
            width >= 600.dp -> 56.dp
            else -> 48.dp
        }

    /** The multiplier on the screen's type scale (1.125 on large windows). */
    val textScale: Float get() = if (large) 1.125f else 1f

    /** The kit's one QR size: 200 dp, or 40 % of the window's height when that is smaller. */
    val qrSize: Dp get() = minOf(200.dp, height * 0.4f)

    internal companion object {
        val COMPACT_HEIGHT: Dp = 480.dp
        val WIDE_WIDTH: Dp = 840.dp
        val LARGE_WIDTH: Dp = 1600.dp
        val LARGE_HEIGHT: Dp = 900.dp
        val TWO_PANE_MIN_WIDTH: Dp = 560.dp
        const val WIDE_RATIO: Float = 1.4f

        /** A phone in portrait: what a screen outside a kit scaffold lays out for. */
        val Phone: PolarisWindow = PolarisWindow(411.dp, 891.dp)
    }
}

/** The fixed steps of the kit's spacing rhythm (the window adds `section`). */
internal object PolarisSpace {
    /** A title and its lede; a value and its caption. */
    val tight: Dp = 8.dp

    /** Stacked controls in one group. */
    val controls: Dp = 12.dp

    /** Two groups inside one region. */
    val group: Dp = 24.dp

    /** Between the two panes. */
    val gutter: Dp = 48.dp
}

internal val LocalPolarisWindow = staticCompositionLocalOf { PolarisWindow.Phone }

/** How titles and bodies align: centred in a hero column, start-aligned on focused steps and in panes. */
internal val LocalPolarisTextAlign = staticCompositionLocalOf { TextAlign.Center }

/** The window the current kit screen lays out in. */
internal val polarisWindow: PolarisWindow
    @Composable @ReadOnlyComposable
    get() = LocalPolarisWindow.current

/** True on Android TV (the configuration's UI mode type). */
@Composable
@ReadOnlyComposable
internal fun isTelevision(): Boolean =
    (androidx.compose.ui.platform.LocalConfiguration.current.uiMode and Configuration.UI_MODE_TYPE_MASK) ==
        Configuration.UI_MODE_TYPE_TELEVISION
