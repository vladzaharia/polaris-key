// The kit's responsive rules, in one place, so every screen sizes and spaces itself the same way.
//
// THE WINDOW. PolarisScreen measures the space it is given (after the safe-drawing insets) and
// provides it as a PolarisWindow. Three questions decide every layout:
//
//   compactHeight  under 480 dp tall (a phone in landscape, a split-screen pane). A screen with
//                  controls lays out as two panes, content on the start side and controls on the
//                  end side, so nothing falls below the fold.
//   wide           840 dp wide or more and not compact height (a tablet, an open foldable, a
//                  desktop window). The column grows and the title steps up a role.
//   large          1600 x 900 dp or more (a large desktop window, a TV at 1x). The column grows
//                  again, the title steps up again, and every text in the screen scales by 1.125
//                  (16 sp body reads as 18 sp), so a big window is not a phone column of phone type.
//
// Android TV always uses the two panes (Leanback's guided-step layout: guidance on the start side,
// actions on the end side), whatever its size.
//
// THE RHYTHM. One scale on the 4 dp grid (UI-KITS.md §1.5 rule 5):
//
//   tight     8 dp   a title and its lede, a value and its caption
//   controls 12 dp   stacked controls in one group (the spec's 10–16)
//   group    24 dp   two groups inside one region (Sign in, then the key path)
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
    /** Android TV (the UI mode, not the size): always two panes. */
    val tv: Boolean = false,
) {
    /** Under 480 dp tall: screens with controls go two-pane. */
    val compactHeight: Boolean get() = height < COMPACT_HEIGHT

    /** 840 dp wide or more, and not compact height: a tablet, an open foldable, a desktop. */
    val wide: Boolean get() = width >= WIDE_WIDTH && !compactHeight

    /** 1600 x 900 dp or more: a large desktop window or a TV at 1x. */
    val large: Boolean get() = width >= LARGE_WIDTH && height >= LARGE_HEIGHT

    /** Content beside its controls: at compact height when there is room for two panes, and on TV. */
    val twoPane: Boolean get() = (compactHeight || tv) && width >= TWO_PANE_MIN_WIDTH

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

    /** The screen's vertical padding: less where height runs out. */
    val verticalPadding: Dp
        get() = when {
            compactHeight -> 16.dp
            large -> 48.dp
            else -> 32.dp
        }

    /** The multiplier on every text size in the screen (1.125 on large windows). */
    val textScale: Float get() = if (large) 1.125f else 1f

    internal companion object {
        val COMPACT_HEIGHT: Dp = 480.dp
        val WIDE_WIDTH: Dp = 840.dp
        val LARGE_WIDTH: Dp = 1600.dp
        val LARGE_HEIGHT: Dp = 900.dp
        val TWO_PANE_MIN_WIDTH: Dp = 560.dp

        /** A phone in portrait: what a screen outside PolarisScreen lays out for. */
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
}

internal val LocalPolarisWindow = staticCompositionLocalOf { PolarisWindow.Phone }

/** How titles and bodies align: centred in a column, start-aligned in the content pane. */
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
