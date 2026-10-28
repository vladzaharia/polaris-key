// The scaffold every kit screen shares, so no screen can drift out of alignment: a full-screen
// surface in the theme's background, the safe-drawing insets (status and navigation bars, display
// cutouts and the IME) applied once, and a layout chosen from the window (PolarisLayout.kt):
//
//   - a tall window (a phone or a foldable in portrait, a portrait tablet): one column of at most
//     480 dp (520 and 600 on wider windows). A focused step top-anchors its content under a 48 dp
//     inset and docks its controls at the foot, where they ride above the keyboard; the welcome
//     centres its hero in the space above them; a progress screen centres everything.
//   - a screen with a control group in a short window (a phone in landscape), on Android TV or in
//     a wide landscape window: two panes, each scrolling on its own, the content on the start
//     side and the controls on the end side, top-aligned and centred in the window as a block.
//   - a message screen never splits: a centred column on a tall window, and elsewhere one
//     start-aligned block of at most 560 dp with its actions in a trailing row (on a card on TV
//     and wide windows).
//
// A large window (1600 x 900 dp and up) also scales the screen's type scale by 1.125 through a
// MaterialTheme typography copy, so Android 14's non-linear font scaling still applies on top.
//
// Plus the building blocks the screens compose: the title and body, the primary, secondary
// (tonal) and text buttons (56 dp, 60 on TV, full round, with the kit's keyboard and D-pad focus
// ring), the action row, the filled text field, the notices and the section card.

package im.plrs.key.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import im.plrs.key.ui.brand.PolarisKitGlyphs

/** The widest a kit screen's column grows on a phone. */
public val PolarisMaxContentWidth: Dp = 480.dp

/** The minimum touch target of every kit control (Material and Android accessibility guidance). */
public val PolarisMinTouchTarget: Dp = 48.dp

/** The widest the two panes grow together. */
internal val PolarisTwoPaneMaxWidth: Dp = 1040.dp

/** The end pane's column cap in the two-pane layout. */
internal val PolarisEndColumnMaxWidth: Dp = 360.dp

/** The widest a message block grows outside a phone column. */
internal val PolarisMessageBlockWidth: Dp = 560.dp

/** The kit's button height: 56 dp (UI-KITS.md §2.1 Android `controlHeight`), 60 on TV. */
internal val PolarisWindow.controlHeight: Dp get() = if (tv) 60.dp else variant.controlHeight

/** The smallest target of a control: 48 dp on Android (60 on TV); 24 dp under a mouse and 44 dp under touch on the desktop (U6). */
internal val PolarisWindow.minTarget: Dp get() = if (tv) {
    60.dp
} else if (!variant.isDesktop) {
    PolarisMinTouchTarget
} else if (touch) {
    44.dp
} else {
    24.dp
}

/** How a single column places its content on a tall window. */
internal enum class PolarisAnchor {
    /** Everything centred (progress screens, cards). */
    Center,

    /** Content top-anchored under the top inset, controls docked at the foot (focused steps, lists). */
    Top,

    /** The content (a hero) centred in the space above the docked controls (the welcome). */
    Hero,
}

/** True inside a trailing action row: the kit's buttons size to their labels there. */
internal val LocalPolarisActionRow = staticCompositionLocalOf { false }

/**
 * A full-screen kit scaffold: background, insets, the theme's logo on top, the optional "Powered
 * by" badge at the foot, and a layout chosen from the window (see PolarisLayout.kt).
 *
 * On a tall window [content] sits at the top and [actions] dock at the foot. In a short window
 * (under 480 dp, a phone in landscape) and on Android TV the two sit side by side, [content] on
 * the start side and [actions] on the end side, each scrolling on its own. In a wide landscape
 * window (a tablet) the start pane is the product art alone and the end pane holds [content] and
 * [actions] (PolarisTwoPane). A screen without [actions] is always one column, centred.
 *
 * @param showLogo shows the theme's logo (the host's product icon) above [content].
 * @param maxContentWidth caps the single column; unspecified (the default) follows the window:
 *   480 dp on a phone, 520 on a tablet, 600 on a large window.
 * @param actions the screen's control group. Each screen spaces its own controls.
 */
@Composable
public fun PolarisScreen(
    modifier: Modifier = Modifier,
    showLogo: Boolean = true,
    maxContentWidth: Dp = Dp.Unspecified,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    PolarisScaffold(
        modifier = modifier,
        showLogo = showLogo,
        maxContentWidth = maxContentWidth,
        anchor = if (actions != null) PolarisAnchor.Top else PolarisAnchor.Center,
        contentAlign = TextAlign.Center,
        actions = actions,
        content = content,
    )
}

/**
 * The kit surface: the background, the insets, and the window measured and provided (with the
 * large-window type scale) to [content].
 */
@Composable
internal fun PolarisSurface(modifier: Modifier = Modifier, content: @Composable (window: PolarisWindow, maxHeight: Dp) -> Unit) {
    val tv = isTelevision()
    val touch = LocalPolarisTouchInput.current
    if (LocalPolarisEmbedded.current) {
        // A pane of a list-detail screen: the host surface already set the background and the insets.
        BoxWithConstraints(modifier.fillMaxSize()) {
            val window = PolarisWindow(maxWidth, maxHeight, tv, touch = touch)
            CompositionLocalProvider(LocalPolarisWindow provides window) { PolarisGnomeTypeScope(window) { content(window, maxHeight) } }
        }
        return
    }
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val body: @Composable () -> Unit = {
            BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                val window = PolarisWindow(maxWidth, maxHeight, tv, touch = touch)
                val height = maxHeight
                CompositionLocalProvider(LocalPolarisWindow provides window) {
                    if (window.textScale == 1f) {
                        PolarisGnomeTypeScope(window) { content(window, height) }
                    } else {
                        // A copy of the type scale, not a density override: the platform's own
                        // (non-linear) font scaling keeps applying on top of it.
                        MaterialTheme(
                            colorScheme = MaterialTheme.colorScheme,
                            shapes = MaterialTheme.shapes,
                            typography = MaterialTheme.typography.scaled(window.textScale),
                        ) { PolarisGnomeTypeScope(window) { content(window, height) } }
                    }
                }
            }
        }
        // macOS: the window floor is 480 x 520; a smaller host scrolls instead of clipping.
        if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) PolarisMacFloor(body) else body()
    }
}

/**
 * The scaffold behind [PolarisScreen], with the choices a kit screen makes for itself.
 *
 * @param anchor how a single column places its content on a tall window.
 * @param contentAlign the single column's text alignment (panes are always start-aligned).
 * @param navigationIcon an optional control above a top-anchored title (a list screen's Back).
 * @param detail what follows [content] in a column and heads the end pane in two panes (the
 *   sign-in code, the TV QR code).
 */
@Composable
internal fun PolarisScaffold(
    modifier: Modifier = Modifier,
    showLogo: Boolean = false,
    maxContentWidth: Dp = Dp.Unspecified,
    anchor: PolarisAnchor = PolarisAnchor.Center,
    contentAlign: TextAlign = TextAlign.Center,
    navigationIcon: (@Composable () -> Unit)? = null,
    detail: (@Composable ColumnScope.() -> Unit)? = null,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
    /** At large type (font scale 1.5 and up) the actions dock below the scrolling body, so the primary stays in the first viewport. */
    dockActionsAtLargeType: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val theme = PolarisTheme.current
    val artName = LocalPolarisArtName.current
    PolarisSurface(modifier) { window, maxHeight ->
        val logo = theme.logo?.takeIf { showLogo }
        if (LocalPolarisEmbedded.current) {
            // The detail pane of a list-detail screen: one start-aligned column that scrolls on its own.
            CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(
                        rememberScrollState(),
                    ).padding(horizontal = LocalPolarisEmbeddedInset.current, vertical = window.section),
                    horizontalAlignment = Alignment.Start,
                ) {
                    navigationIcon?.let {
                        it()
                        Spacer(Modifier.height(PolarisSpace.tight))
                    }
                    content()
                    detail?.invoke(this)
                    actions?.let {
                        Spacer(Modifier.height(window.section))
                        it()
                    }
                }
            }
            return@PolarisSurface
        }
        val hasArt = theme.logo != null
        if (actions != null && window.twoPane && !window.tv && !window.compactHeight) {
            PolarisTwoPane(window, hasArt, artName, navigationIcon, detail, actions, content)
            return@PolarisSurface
        }
        if (actions != null && window.twoPane) {
            CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) {
                Box(
                    Modifier
                        .fillMaxSize()
                        // The panes pad themselves (PolarisSpace.controls) inside their scroll.
                        .padding(
                            horizontal = window.horizontalPadding,
                            vertical = (window.verticalPadding - PolarisSpace.controls).coerceAtLeast(0.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(
                        modifier = Modifier.widthIn(max = PolarisTwoPaneMaxWidth).fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(PolarisSpace.gutter),
                        verticalAlignment = Alignment.Top,
                    ) {
                        // Each pane scrolls on its own; the inner padding leaves room for a focused
                        // control's ring and TV scale at the pane's edge.
                        Column(
                            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = PolarisSpace.controls),
                            horizontalAlignment = Alignment.Start,
                        ) {
                            navigationIcon?.let {
                                it()
                                Spacer(Modifier.height(PolarisSpace.tight))
                            }
                            if (logo != null) {
                                logo()
                                Spacer(Modifier.height(window.section))
                            }
                            content()
                        }
                        Column(
                            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = PolarisSpace.controls),
                            horizontalAlignment = Alignment.Start,
                        ) {
                            if (detail != null) {
                                detail()
                                Spacer(Modifier.height(window.section))
                            }
                            actions()
                        }
                    }
                }
            }
            return@PolarisSurface
        }
        if (actions != null && dockActionsAtLargeType && LocalDensity.current.fontScale >= POLARIS_DOCK_FONT_SCALE) {
            val dockWidth = if (maxContentWidth == Dp.Unspecified) window.columnWidth else maxContentWidth
            val dockHorizontal = if (contentAlign == TextAlign.Start) Alignment.Start else Alignment.CenterHorizontally
            CompositionLocalProvider(LocalPolarisTextAlign provides contentAlign) {
                Column(Modifier.fillMaxSize().padding(horizontal = window.horizontalPadding), horizontalAlignment = Alignment.CenterHorizontally) {
                    Column(
                        Modifier.widthIn(
                            max = dockWidth,
                        ).fillMaxWidth().weight(1f, fill = true).verticalScroll(rememberScrollState()).padding(top = window.topInset),
                        horizontalAlignment = dockHorizontal,
                    ) {
                        navigationIcon?.let {
                            it()
                            Spacer(Modifier.height(PolarisSpace.tight))
                        }
                        if (logo != null) {
                            logo()
                            Spacer(Modifier.height(window.section))
                        }
                        content()
                        if (detail != null) {
                            Spacer(Modifier.height(window.section))
                            detail()
                        }
                    }
                    // The dock: its own scroll if the actions alone exceed 60 % of the window.
                    Column(
                        Modifier.widthIn(max = dockWidth).fillMaxWidth().heightIn(max = maxHeight * 0.6f).verticalScroll(rememberScrollState())
                            .padding(top = PolarisSpace.controls, bottom = window.verticalPadding),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        content = actions,
                    )
                }
            }
            return@PolarisSurface
        }
        // On a tablet-sized window a docked action group would sit far from its content: the
        // whole column, actions included, is centred instead.
        val place = if (actions != null && window.width >= 600.dp && window.height >= 600.dp) PolarisAnchor.Center else anchor
        val width = if (maxContentWidth == Dp.Unspecified) window.columnWidth else maxContentWidth
        val horizontal = if (contentAlign == TextAlign.Start) Alignment.Start else Alignment.CenterHorizontally
        CompositionLocalProvider(LocalPolarisTextAlign provides contentAlign) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = window.horizontalPadding),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(
                    modifier = Modifier
                        .widthIn(max = width)
                        .fillMaxWidth()
                        .heightIn(min = maxHeight)
                        .padding(
                            top = if (place == PolarisAnchor.Center) window.verticalPadding else window.topInset,
                            bottom = window.verticalPadding,
                        ),
                    horizontalAlignment = horizontal,
                ) {
                    if (place != PolarisAnchor.Top) Spacer(Modifier.weight(1f))
                    navigationIcon?.let {
                        it()
                        Spacer(Modifier.height(PolarisSpace.tight))
                    }
                    if (logo != null) {
                        logo()
                        Spacer(Modifier.height(window.section))
                    }
                    content()
                    if (detail != null) {
                        Spacer(Modifier.height(window.section))
                        detail()
                    }
                    if (place == PolarisAnchor.Center) {
                        if (actions != null) {
                            Spacer(Modifier.height(window.section))
                            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, content = actions)
                        }
                        Spacer(Modifier.weight(1f))
                    } else {
                        // The controls dock at the foot: everything above takes the free height.
                        Spacer(Modifier.height(window.section))
                        Spacer(Modifier.weight(1f))
                        if (actions != null) {
                            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, content = actions)
                        }
                    }
                }
            }
        }
    }
}

/** The font scale from which a sign-in step's actions dock (Android font scale 2 is the reference; SwiftUI docks at AX5). */
internal const val POLARIS_DOCK_FONT_SCALE: Float = 1.5f

/** The side inset of an embedded pane: the pane gutter beside a list, the window's own margin when the item is the whole phone screen. */
internal val LocalPolarisEmbeddedInset = staticCompositionLocalOf { PolarisSpace.gutter }

/** True inside a list-detail pane: screens draw as a plain column, without their own surface, insets or product header. */
internal val LocalPolarisEmbedded = staticCompositionLocalOf { false }

/** True inside the two-pane layout, where the start pane draws the product art and the content must not repeat it. */

/** The product name a screen presents when it differs from the theme's (the integrator's name, else the product its lines name). */
internal val LocalPolarisArtName = staticCompositionLocalOf<String?> { null }

internal val LocalPolarisArtInPane = staticCompositionLocalOf { false }

/** The art in a column (a hero icon, then a section gap); nothing in two panes, whose start pane is the art. */
@Composable
internal fun PolarisHeroIcon(name: String? = null) {
    if (LocalPolarisArtInPane.current) return
    val window = polarisWindow
    PolarisProductIcon(if (window.compactHeight) 56.dp else 120.dp, name = name)
    if (name != null || productName(PolarisTheme.current.copy) != null || PolarisTheme.current.logo != null) Spacer(Modifier.height(window.section))
}

/**
 * The shared two-pane layout (UI-KITS.md DL1, decision B10.2) for tablets and landscape windows:
 * the product art or icon alone on a sunken panel in the start pane; the title, lede, detail and
 * actions in the end pane, top-aligned. Without any art the end pane sits alone, centred. Android TV
 * and a short window (under 480 dp: a phone in landscape) keep the content-and-controls split, since
 * the art, title, lede and controls do not fit one column there.
 */
@Composable
private fun PolarisTwoPane(
    window: PolarisWindow,
    hasArt: Boolean,
    artName: String?,
    navigationIcon: (@Composable () -> Unit)?,
    detail: (@Composable ColumnScope.() -> Unit)?,
    actions: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    CompositionLocalProvider(
        LocalPolarisTextAlign provides TextAlign.Start,
        // A short window (under 600 dp) leaves no room for the product header above the title: the controls stay on screen.
        LocalPolarisArtInPane provides (hasArt || window.height < 600.dp),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .padding(horizontal = window.horizontalPadding, vertical = (window.verticalPadding - PolarisSpace.controls).coerceAtLeast(0.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                modifier = Modifier.widthIn(max = PolarisTwoPaneMaxWidth).fillMaxWidth().fillMaxHeight(),
                horizontalArrangement = Arrangement.spacedBy(PolarisSpace.gutter),
                verticalAlignment = Alignment.Top,
            ) {
                if (hasArt) {
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .padding(vertical = PolarisSpace.controls)
                            .clip(PolarisTheme.cardShape)
                            .background(MaterialTheme.colorScheme.surfaceContainerLow),
                        contentAlignment = Alignment.Center,
                    ) {
                        PolarisProductIcon(if (window.compactHeight) 96.dp else 120.dp, name = artName)
                    }
                }
                Column(
                    Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = PolarisSpace.controls),
                    horizontalAlignment = if (hasArt) Alignment.Start else Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    // The copy keeps a ~360 dp measure (UK-10.15 #5); the actions use the pane's width (a step's trailing
                    // row can need more, the hero buttons cap themselves at 320).
                    val paneModifier = if (hasArt) Modifier.fillMaxWidth() else Modifier.widthIn(max = 520.dp).fillMaxWidth()
                    Column(paneModifier, horizontalAlignment = Alignment.Start) {
                        Column(Modifier.widthIn(max = PolarisEndColumnMaxWidth).fillMaxWidth()) {
                            navigationIcon?.let {
                                it()
                                Spacer(Modifier.height(PolarisSpace.tight))
                            }
                            content()
                            if (detail != null) {
                                Spacer(Modifier.height(window.section))
                                detail()
                            }
                        }
                        Spacer(Modifier.height(window.section))
                        actions()
                    }
                }
            }
        }
    }
}

/** [this] type scale with every style's size and line height multiplied by [factor]. */
internal fun Typography.scaled(factor: Float): Typography {
    fun TextUnit.scaledBy(f: Float): TextUnit = if (isSpecified) this * f else this
    fun TextStyle.scaled(): TextStyle = copy(fontSize = fontSize.scaledBy(factor), lineHeight = lineHeight.scaledBy(factor))
    return Typography(
        displayLarge = displayLarge.scaled(), displayMedium = displayMedium.scaled(), displaySmall = displaySmall.scaled(),
        headlineLarge = headlineLarge.scaled(), headlineMedium = headlineMedium.scaled(), headlineSmall = headlineSmall.scaled(),
        titleLarge = titleLarge.scaled(), titleMedium = titleMedium.scaled(), titleSmall = titleSmall.scaled(),
        bodyLarge = bodyLarge.scaled(), bodyMedium = bodyMedium.scaled(), bodySmall = bodySmall.scaled(),
        labelLarge = labelLarge.scaled(), labelMedium = labelMedium.scaled(), labelSmall = labelSmall.scaled(),
    )
}

/** The icon a message kind shows in this window: GNOME's offline status page draws network-offline (a state, not an action). */
@Composable
internal fun polarisMessageIcon(kind: PolarisMessageKind): ImageVector =
    if (polarisWindow.isGnome && kind == PolarisMessageKind.Offline) PolarisGnome.networkOffline else kind.icon()

/** The icon a message kind shows. */
internal fun PolarisMessageKind.icon(): ImageVector = when (this) {
    PolarisMessageKind.Info -> PolarisSymbols.Info

    PolarisMessageKind.Warning, PolarisMessageKind.Danger -> PolarisSymbols.Warning

    PolarisMessageKind.Offline -> PolarisSymbols.Refresh

    // DL6: a refusal the person can resolve carries no error glyph.
    PolarisMessageKind.Blocked, PolarisMessageKind.Locked -> PolarisSymbols.Info
}

/** The container and text colours of a message kind's notice. */
@Composable
internal fun PolarisMessageKind.tint(): Pair<Color, Color> {
    val status = PolarisTheme.status
    val scheme = MaterialTheme.colorScheme
    return when (this) {
        PolarisMessageKind.Info -> scheme.primaryContainer to scheme.onPrimaryContainer

        PolarisMessageKind.Offline -> scheme.secondaryContainer to scheme.onSecondaryContainer

        PolarisMessageKind.Warning -> status.warningContainer to status.onWarningContainer

        PolarisMessageKind.Danger -> status.dangerContainer to status.onDangerContainer

        // DL6: a resolvable refusal is a neutral callout: default text on the sunken surface.
        PolarisMessageKind.Blocked, PolarisMessageKind.Locked -> scheme.surfaceContainerHighest to scheme.onSurface
    }
}

/** The glyph colour of a message kind's icon: the status colour on its container. */
@Composable
internal fun PolarisMessageKind.glyph(): Color {
    val status = PolarisTheme.status
    return when (this) {
        PolarisMessageKind.Info -> MaterialTheme.colorScheme.primary
        PolarisMessageKind.Offline -> MaterialTheme.colorScheme.onSecondaryContainer
        PolarisMessageKind.Warning -> status.warning
        PolarisMessageKind.Danger -> status.danger
        PolarisMessageKind.Blocked, PolarisMessageKind.Locked -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

/** A round tinted badge holding an icon; decorative (the adjacent title names the state). */
@Composable
public fun PolarisIconBadge(icon: ImageVector, container: Color, content: Color, modifier: Modifier = Modifier) {
    Surface(modifier = modifier.size(64.dp), shape = CircleShape, color = container, contentColor = content) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(32.dp))
        }
    }
}

/**
 * The product's icon at [size]: the theme's logo (the host's icon, with the host's own semantics)
 * in the kit's squircle, or a monogram tile of the product's initial (Rubik 600 on the highest
 * container) when there is none; the monogram is decorative, since the product's name always sits
 * beside it or in the title. Nothing when the theme has no logo and neither [name] nor the copy
 * names the product.
 */
@Composable
internal fun PolarisProductIcon(size: Dp, modifier: Modifier = Modifier, name: String? = null) {
    val theme = PolarisTheme.current
    val logo = theme.logo
    val shape = PolarisTheme.iconShape
    if (logo != null) {
        Box(modifier.size(size).clip(shape), contentAlignment = Alignment.Center) { logo() }
        return
    }
    val initial =
        (name?.takeIf { it.isNotBlank() } ?: productName(theme.copy))?.trim()?.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar() ?: return
    val fontSize = with(LocalDensity.current) { (size * 0.46f).toSp() }
    Surface(
        modifier = modifier.size(size).clearAndSetSemantics {},
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        contentColor = MaterialTheme.colorScheme.onSurface,
        // The icon's 8 % hairline (UI-KITS.md §1.4, Android), so the tile reads on any ground.
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = initial.toString(),
                style = TextStyle(fontFamily = PolarisRubik, fontWeight = FontWeight.SemiBold, fontSize = fontSize, lineHeight = fontSize),
            )
        }
    }
}

/** The product's name when the copy names it (not the kit's "this app" default). */
internal fun productName(copy: PolarisCopy): String? = copy.productName.takeIf { it != DEFAULT_PRODUCT_NAME && it.isNotBlank() }

/**
 * The product header of a focused step (UI-KITS.md §1.2): the product icon at 28 dp beside the
 * product's name at 17 sp, weight 600 (LOGO-2; the tile is no control), then a section gap. Nothing when there is neither.
 */
@Composable
internal fun PolarisProductHeader(presentedName: String? = null, gap: Dp = polarisWindow.section) {
    if (LocalPolarisArtInPane.current) return
    val theme = PolarisTheme.current
    val name = presentedName?.takeIf { it.isNotBlank() } ?: productName(theme.copy)
    if (name == null && theme.logo == null) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        PolarisProductIcon(28.dp, name = name)
        if (name != null) {
            Text(
                name,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
    Spacer(Modifier.height(gap))
}

/**
 * A screen title: a TalkBack heading, centred in a hero column and start-aligned on focused steps
 * and in panes. It steps up a role as the window grows (headline small on a phone, medium on a
 * tablet, large on a large window), so it always ranks clearly above the body; its lines are
 * balanced.
 */
@Composable
public fun PolarisTitle(text: String, modifier: Modifier = Modifier) {
    val window = polarisWindow
    val typography = MaterialTheme.typography
    // A screen reader reading by touch lands on the step's heading when the step appears (as the React
    // and SwiftUI kits do), so the person hears where they are before any control. Everyone else is unchanged.
    val requester = remember { FocusRequester() }
    val screenReader = rememberScreenReaderOn() && LocalPolarisInitialFocus.current
    if (screenReader) {
        LaunchedEffect(text) { runCatching { requester.requestFocus() } }
    }
    Text(
        text = text,
        style = when {
            window.large -> typography.headlineLarge
            window.wide -> typography.headlineMedium
            else -> typography.headlineSmall
        }.copy(lineBreak = LineBreak.Heading),
        color = MaterialTheme.colorScheme.onSurface,
        textAlign = LocalPolarisTextAlign.current,
        modifier = (if (screenReader) modifier.focusRequester(requester).focusable() else modifier).fillMaxWidth().semantics { heading() },
    )
}

/** Secondary copy under a title: centred in a hero column, start-aligned on focused steps and in panes. */
@Composable
public fun PolarisBody(text: String, modifier: Modifier = Modifier, textAlign: TextAlign = LocalPolarisTextAlign.current) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge.copy(lineBreak = LineBreak.Paragraph),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = textAlign,
        modifier = modifier.fillMaxWidth(),
    )
}

/** Whether a screen's first control takes focus as it opens; a test or a board render turns it off to draw a frame at rest. */
internal val LocalPolarisInitialFocus = androidx.compose.runtime.staticCompositionLocalOf { true }

/**
 * The kit's focus indication (UI-KITS.md §1.5 rule 7, §3.3): a ring in the accent's focus colour,
 * 2 dp wide at a 2 dp offset (3 dp on TV), shown on keyboard focus and always on TV, where a
 * focused control also grows to 1.05. With [initialFocus] the control takes focus when the screen
 * opens on TV or with a keyboard in use.
 */
internal fun Modifier.polarisFocusIndication(interaction: InteractionSource, shape: Shape, initialFocus: Boolean = false): Modifier = composed {
    val focused by interaction.collectIsFocusedAsState()
    val window = polarisWindow
    val keyboard = LocalInputModeManager.current.inputMode == InputMode.Keyboard
    // The desktop shows the ring on any focus from launch: a window opens with the keyboard in play.
    val show = focused && (window.tv || keyboard || window.variant.isDesktop)
    val color = PolarisTheme.focusColor
    val ring = if (window.tv) 3.dp else 2.dp
    // Windows (UK-10.5): the Fluent two-tone ring, the text colour around the surface colour.
    val fluent = window.fluent
    val fluentOuter = MaterialTheme.colorScheme.onSurface
    val fluentInner = MaterialTheme.colorScheme.background
    val scale by animateFloatAsState(if (window.tv && focused) 1.05f else 1f, label = "PolarisFocusScale")
    val requester = remember { FocusRequester() }
    // The first focus goes in once the control is placed (a request before that has nothing to land on).
    var placed by remember { mutableStateOf(false) }
    if (initialFocus && placed && LocalPolarisInitialFocus.current) {
        LaunchedEffect(Unit) {
            if (window.tv || keyboard || window.variant.isDesktop) runCatching { requester.requestFocus() }
        }
    }
    Modifier
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .drawWithContent {
            drawContent()
            if (show && fluent) {
                drawFluentFocusRing(shape, fluentOuter, fluentInner)
            } else if (show && window.isGnome) {
                // GNOME: the ring sits inside the control's edge (offset -2, width 2).
                val stroke = PolarisGnome.focusWidth.toPx()
                val outline = shape.createOutline(Size(size.width - stroke, size.height - stroke), layoutDirection, this)
                translate(stroke / 2, stroke / 2) { drawOutline(outline, color, style = Stroke(stroke)) }
                // A thin page-coloured line inside the ring keeps it readable on a fill of its own colour (the ink pill).
                val gap = 1.dp.toPx()
                val inner = shape.createOutline(Size(size.width - 2 * stroke - gap, size.height - 2 * stroke - gap), layoutDirection, this)
                translate(stroke + gap / 2, stroke + gap / 2) { drawOutline(inner, fluentInner, style = Stroke(gap)) }
            } else if (show) {
                val stroke = ring.toPx()
                val inset = 2.dp.toPx() + stroke / 2
                val outline = shape.createOutline(Size(size.width + inset * 2, size.height + inset * 2), layoutDirection, this)
                translate(-inset, -inset) { drawOutline(outline, color, style = Stroke(stroke)) }
            }
        }
        .focusRequester(requester)
        .onPlaced { if (!placed) placed = true }
}

/** The 16 dp ring a busy button shows beside its label (UI-KITS.md §1.5 rule 4). */
@Composable
private fun PolarisBusyRing() {
    CircularProgressIndicator(
        modifier = Modifier.size(16.dp),
        strokeWidth = 2.dp,
        color = LocalContentColor.current,
    )
    Spacer(Modifier.size(ButtonDefaults.IconSpacing))
}

/** True where a control's label may wrap: GNOME's pill and the Mac's control then grow with it instead of holding one line. */
internal val LocalPolarisActionGrows = staticCompositionLocalOf { false }

/** Full width in a stacked group, sized to the label in a trailing row; 56 dp tall (60 on TV). */
@Composable
internal fun Modifier.controlSize(): Modifier {
    val height = polarisWindow.controlHeight
    val row = LocalPolarisActionRow.current
    val sized = if (row) this else this.fillMaxWidth()
    // Material's button holds a 40 dp floor of its own; GNOME's 40 px pill and the Mac's 28 pt control need the height fixed to get under it.
    // The Mac's 28 pt is a minimum: it grows with the font scale (the label's line plus 5 dp above and below).
    if (polarisWindow.isMac) {
        val grown = with(LocalDensity.current) { MaterialTheme.typography.labelLarge.lineHeight.toDp() } + 10.dp
        val floor = maxOf(if (LocalPolarisMacHero.current) PolarisMac.heroButtonHeight else height, grown)
        return if (LocalPolarisActionGrows.current) sized.heightIn(min = floor) else sized.height(floor)
    }
    // GNOME: both actions of a pair are 40 px pills (the lead's decision); a pill grows with its label at a larger font scale.
    if (polarisWindow.isGnome) {
        // The focus ring sits on the pill's fixed height; only a larger font scale lets the pill grow with its label.
        return if (LocalDensity.current.fontScale > 1f ||
            LocalPolarisActionGrows.current
        ) {
            sized.heightIn(min = PolarisGnome.actionHeight)
        } else {
            sized.height(PolarisGnome.actionHeight)
        }
    }
    return sized.heightIn(min = height)
}

/** The primary action: filled, full round, 56 dp tall (60 on TV), full width in a stacked group. */
@Composable
public fun PolarisPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    initialFocus: Boolean = false,
    /** The action leaves the app (rule 11): the new-window glyph follows the label. */
    external: Boolean = false,
    /** A destructive confirm (Remove): the error tone instead of the accent. */
    danger: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val shape = polarisActionShape(suggested = true)
    if (polarisWindow.fluent) {
        PolarisFluentButton(
            FluentButtonKind.Accent,
            text,
            onClick,
            interaction,
            enabled = enabled,
            busy = busy,
            external = external,
            modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize().polarisExternalSemantics(external),
        )
        return
    }
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = shape,
        colors = if (danger) {
            ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            )
        } else {
            ButtonDefaults.buttonColors()
        },
        contentPadding = if (polarisWindow.isMac) PolarisMac.buttonPadding else polarisButtonPadding(),
        border = if (polarisWindow.isMac) polarisMacControlBorder() else null,
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize().polarisExternalSemantics(external),
    ) {
        if (busy) PolarisBusyRing()
        // The glyph stays beside a label that wraps (GNOME at a large font scale), not pushed out of the pill.
        Text(text, textAlign = TextAlign.Center, modifier = if (external) Modifier.weight(1f, fill = false) else Modifier)
        if (external) PolarisNewWindowGlyph()
    }
}

/**
 * The new-window glyph that follows the label of an action that leaves the app (UI-KITS.md 1.5
 * rule 11, DL6). It is decorative: the control says where it goes ([polarisExternalSemantics]).
 */
@Composable
internal fun PolarisNewWindowGlyph(modifier: Modifier = Modifier) {
    Spacer(Modifier.width(8.dp))
    Icon(
        imageVector = PolarisKitGlyphs.NewWindow,
        contentDescription = null,
        modifier = modifier.size(18.dp),
    )
}

/** The catalog's "Opens in your browser" (a11y.externalLink) as the state of an action that leaves the app. */
@Composable
internal fun Modifier.polarisExternalSemantics(external: Boolean): Modifier {
    if (!external) return this
    val note = remember { KitCopy.bundled }.message(PolarisKitGlyphs.NEW_WINDOW_COPY_KEY, kitLocale()) ?: return this
    return semantics { stateDescription = note }
}

/** A secondary action: tonal, full round, the same size as the primary. */
@Composable
public fun PolarisSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    initialFocus: Boolean = false,
    /** The action leaves the app (rule 11): the new-window glyph follows the label. */
    external: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val shape = polarisActionShape(suggested = false)
    if (polarisWindow.fluent) {
        PolarisFluentButton(
            FluentButtonKind.Standard,
            text,
            onClick,
            interaction,
            enabled = enabled,
            busy = busy,
            external = external,
            modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize().polarisExternalSemantics(external),
        )
        return
    }
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = shape,
        // A busy secondary keeps its label at full contrast beside the ring (rule 7).
        colors = if (polarisWindow.isMac) {
            polarisMacSecondaryColors()
        } else if (busy) {
            ButtonDefaults.filledTonalButtonColors(
                disabledContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                disabledContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        } else {
            ButtonDefaults.filledTonalButtonColors()
        },
        contentPadding = if (polarisWindow.isMac) PolarisMac.buttonPadding else polarisButtonPadding(),
        border = if (polarisWindow.isMac) polarisMacBezel() else null,
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize().polarisExternalSemantics(external),
    ) {
        if (busy) PolarisBusyRing()
        // The glyph stays beside a label that wraps (GNOME at a large font scale), not pushed out of the pill.
        Text(text, textAlign = TextAlign.Center, modifier = if (external) Modifier.weight(1f, fill = false) else Modifier)
        if (external) PolarisNewWindowGlyph()
    }
}

/**
 * A tertiary action: a text button with a 48 dp target (60 on TV), centred under a stacked group.
 * In a trailing action row it is the row's secondary, so it takes the tonal form there (rule 10:
 * never bare text beside a primary).
 */
@Composable
public fun PolarisTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    initialFocus: Boolean = false,
) {
    if (LocalPolarisActionRow.current) {
        PolarisSecondaryButton(text, onClick, modifier, enabled, initialFocus = initialFocus)
        return
    }
    val interaction = remember { MutableInteractionSource() }
    val shape = polarisActionShape(suggested = false, aux = true)
    val tv = polarisWindow.tv
    if (polarisWindow.fluent) {
        PolarisFluentButton(
            FluentButtonKind.Subtle,
            text,
            onClick,
            interaction,
            enabled = enabled,
            modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus),
        )
        return
    }
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = shape,
        colors = ButtonDefaults.textButtonColors(contentColor = PolarisTheme.accentText),
        interactionSource = interaction,
        modifier = modifier
            .polarisFocusIndication(interaction, shape, initialFocus)
            .heightIn(min = polarisWindow.minTarget),
    ) { Text(text, textAlign = TextAlign.Center) }
}

/**
 * A group of actions. Stacked ([row] false): full width, primary first, 12 dp apart. In a
 * trailing row ([row] true): trailing-aligned at equal height, primary last (so the emission order
 * stays primary first), each sized to its label and at least 96 dp wide; when the labels do not
 * fit side by side the group stacks instead (UI-KITS.md §1.5 rule 10). On the Mac a [visualOrder]
 * group's children are emitted left to right (Cancel first, the default last): the row is placed
 * from its leftmost child, so Tab runs left to right, and a stack puts the default on top.
 */
@Composable
internal fun PolarisActionGroup(row: Boolean, modifier: Modifier = Modifier, visualOrder: Boolean = false, content: @Composable () -> Unit) {
    if (!row) {
        Column(
            modifier = modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        ) { content() }
        return
    }
    // Windows (UK-10.5): the primary first, the row's buttons at equal width, 8 dp apart.
    val fluent = polarisWindow.fluent
    val isMac = polarisWindow.isMac
    CompositionLocalProvider(LocalPolarisActionRow provides true) {
        Layout(content = content, modifier = modifier.fillMaxWidth()) { measurables, constraints ->
            val gap = (if (fluent || isMac) 8.dp else PolarisSpace.controls).roundToPx()
            val minWidth = 96.dp.roundToPx()
            val maxWidth = constraints.maxWidth
            val natural = measurables.map { it.maxIntrinsicWidth(Constraints.Infinity).coerceAtLeast(minWidth) }
            val widths = if (fluent) natural.map { natural.max() } else natural
            val fits = widths.sum() + gap * (measurables.size - 1).coerceAtLeast(0) <= maxWidth
            val macOrder = isMac && visualOrder
            if (fits) {
                val height = measurables.zip(widths).maxOfOrNull { (m, w) -> m.minIntrinsicHeight(w) } ?: 0
                val placeables = measurables.zip(widths).map { (m, w) -> m.measure(Constraints.fixed(w, height)) }
                layout(maxWidth, height) {
                    if (macOrder) {
                        var x = maxWidth - (widths.sum() + gap * (widths.size - 1).coerceAtLeast(0))
                        for (p in placeables) {
                            p.placeRelative(x, 0)
                            x += p.width + gap
                        }
                    } else if (fluent) {
                        var x = 0
                        for (p in placeables) {
                            p.placeRelative(x, 0)
                            x += p.width + gap
                        }
                    } else {
                        var x = maxWidth
                        for (p in placeables) {
                            x -= p.width
                            p.placeRelative(x, 0)
                            x -= gap
                        }
                    }
                }
            } else {
                val placeables = measurables.map {
                    it.measure(Constraints(minWidth = maxWidth, maxWidth = maxWidth))
                }.let { if (macOrder) it.asReversed() else it }
                val height = placeables.sumOf { it.height } + gap * (placeables.size - 1).coerceAtLeast(0)
                layout(maxWidth, height) {
                    var y = 0
                    for (p in placeables) {
                        p.placeRelative(0, y)
                        y += p.height + gap
                    }
                }
            }
        }
    }
}

/**
 * A full-screen message: icon badge, title, body and actions. The screen every terminal gate
 * state and boot stop uses. It never splits into panes: a centred column with stacked actions on a
 * tall window, and elsewhere one start-aligned block of at most 560 dp with its actions in a
 * trailing row, on a card on TV and wide windows.
 */
@Composable
public fun PolarisMessageScreen(message: PolarisMessageCopy, modifier: Modifier = Modifier, actions: (@Composable () -> Unit)? = null) {
    PolarisMessageLayout(
        modifier = modifier,
        emblem = { PolarisIconBadge(polarisMessageIcon(message.kind), message.kind.tint().first, message.kind.glyph()) },
        title = message.title,
        body = message.body,
        actions = actions,
    )
}

/**
 * The message layout behind [PolarisMessageScreen] (and sign-in's Starting step): [emblem], the
 * [title] (the screen's heading, a polite live region and its pane title, so TalkBack reads the
 * new state when the screen changes), the optional [body] and the [actions].
 */
@Composable
internal fun PolarisMessageLayout(
    modifier: Modifier = Modifier,
    emblem: @Composable () -> Unit,
    title: String,
    body: String?,
    titleStyle: @Composable () -> TextStyle = { MaterialTheme.typography.headlineSmall },
    actions: (@Composable () -> Unit)?,
) {
    PolarisSurface(modifier) { window, maxHeight ->
        // AdwStatusPage (GNOME): always one centred column, never a card or a start-aligned block.
        val block = !window.isGnome && (window.compactHeight || window.card)
        val align = if (block) TextAlign.Start else TextAlign.Center
        val horizontal = if (block) Alignment.Start else Alignment.CenterHorizontally
        val inner: @Composable ColumnScope.() -> Unit = {
            // The persistent product header (UI-KITS.md section 1.2): every stop names its product.
            // A short window gives the gap up first, so the controls stay on screen.
            PolarisProductHeader(gap = if (window.compactHeight) 4.dp else window.section)
            emblem()
            Spacer(Modifier.height(window.section))
            Text(
                text = title,
                style = titleStyle().copy(lineBreak = LineBreak.Heading),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = align,
                modifier = Modifier.fillMaxWidth().semantics {
                    heading()
                    liveRegion = LiveRegionMode.Polite
                    paneTitle = title
                },
            )
            if (body != null) {
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(body, textAlign = align)
            }
            if (actions != null) {
                Spacer(Modifier.height(window.section))
                PolarisActionGroup(row = block, modifier = statusActionsModifier(window), content = actions)
            }
        }
        CompositionLocalProvider(LocalPolarisTextAlign provides align) {
            if (!block) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = window.horizontalPadding),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Column(
                        modifier = Modifier
                            .widthIn(max = window.columnWidth)
                            .fillMaxWidth()
                            .heightIn(min = maxHeight)
                            .padding(vertical = window.verticalPadding),
                        horizontalAlignment = horizontal,
                        verticalArrangement = Arrangement.Center,
                        content = inner,
                    )
                }
                return@CompositionLocalProvider
            }
            Box(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .padding(horizontal = window.horizontalPadding, vertical = window.verticalPadding),
                contentAlignment = Alignment.Center,
            ) {
                if (window.card) {
                    Surface(
                        modifier = Modifier.widthIn(max = PolarisMessageBlockWidth).fillMaxWidth(),
                        shape = PolarisTheme.cardShape,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    ) {
                        Column(Modifier.padding(32.dp), horizontalAlignment = horizontal, content = inner)
                    }
                } else {
                    Column(Modifier.widthIn(max = PolarisMessageBlockWidth).fillMaxWidth(), horizontalAlignment = horizontal, content = inner)
                }
            }
        }
    }
}

/**
 * The kit's text field: the Material 3 filled field (UI-KITS.md §1.5 rule 1; never the outlined
 * or notched one), single line, label inside. Neutral it is the host's stock filled field;
 * branded it takes radius 16 with the resting indicator removed, and the focused indicator (2 dp,
 * the accent) stays. Under the field, [error] shows announced as an error, or [supporting] as
 * neutral text (rule 9: a full licence is a limit, not an error).
 */
@Composable
internal fun PolarisTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    enabled: Boolean = true,
    error: String? = null,
    supporting: List<String> = emptyList(),
    /** A control inside the field at its end (the key field's paste). */
    trailing: (@Composable () -> Unit)? = null,
    focusRequester: FocusRequester? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    /** The value is a key or a code: macOS draws it in monospace. */
    monospace: Boolean = false,
    /** A long code: the Material field wraps over up to three lines in monospace instead of scrolling one line. */
    multiline: Boolean = false,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    val branded = PolarisTheme.current.branding == PolarisBranding.PolarisKey
    val shape = PolarisTheme.fieldShape
    val fluent = polarisWindow.fluent
    Column(modifier.fillMaxWidth()) {
        if (polarisWindow.isMac) {
            PolarisMacTextField(
                value, onValueChange, label, Modifier, placeholder, enabled, error != null, trailing, focusRequester,
                keyboardOptions, keyboardActions, monospace,
            )
        } else if (fluent) {
            PolarisFluentTextField(
                value, onValueChange, label, Modifier, placeholder, enabled, error != null, trailing, focusRequester,
                keyboardOptions, keyboardActions,
            )
        } else if (polarisWindow.isGnome) {
            PolarisGnomeEntry(
                value, onValueChange, label, placeholder, enabled, error != null, trailing, focusRequester, keyboardOptions, keyboardActions,
            )
        } else {
            TextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text(label) },
                placeholder = placeholder?.let { { Text(it) } },
                trailingIcon = trailing,
                visualTransformation = visualTransformation,
                singleLine = !multiline,
                maxLines = if (multiline) 3 else 1,
                textStyle = if (multiline) LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace) else LocalTextStyle.current,
                enabled = enabled,
                isError = error != null,
                shape = shape,
                colors = if (branded) {
                    TextFieldDefaults.colors(
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    )
                } else {
                    TextFieldDefaults.colors()
                },
                keyboardOptions = keyboardOptions,
                keyboardActions = keyboardActions,
                // Branded corners round at the bottom too, so the indicator is clipped to them.
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                    .then(if (branded) Modifier.clip(shape) else Modifier),
            )
        }
        val supportingStyle = MaterialTheme.typography.bodySmall.copy(lineBreak = LineBreak.Paragraph)
        if (error != null) {
            Text(
                text = error,
                style = supportingStyle,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 4.dp)
                    .semantics {
                        liveRegion = LiveRegionMode.Assertive
                        error(error)
                    },
            )
        }
        for ((i, line) in supporting.withIndex()) {
            Text(
                text = line,
                style = supportingStyle,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 4.dp)
                    .then(if (i == 0) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier),
            )
        }
    }
}

/** A centred progress state: an indicator and a label, announced politely. */
@Composable
public fun PolarisProgressScreen(label: String, modifier: Modifier = Modifier, progress: Float? = null) {
    PolarisScreen(modifier = modifier) {
        // The label is the screen's only text, so it is the heading TalkBack lands on.
        PolarisProgress(label = label, progress = progress, asHeading = true)
    }
}

/** A labelled progress indicator: indeterminate unless [progress] (0..1) is given. */
@Composable
public fun PolarisProgress(label: String, modifier: Modifier = Modifier, progress: Float? = null, asHeading: Boolean = false) {
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        // A visible track, so the ring reads as progress at every frame of the animation.
        val track = MaterialTheme.colorScheme.surfaceContainerHighest
        if (progress == null) {
            PolarisWaitIndicator()
        } else {
            CircularProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = Modifier.size(40.dp), trackColor = track)
        }
        Spacer(Modifier.height(PolarisSpace.controls))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().semantics {
                liveRegion = LiveRegionMode.Polite
                if (asHeading) heading()
            },
        )
    }
}

/**
 * The kit's wait indicator for the waits with no known end (UI-KITS.md DL7, §1.5 rule 4): the 2 dp
 * shimmer, a soft band sweeping a muted track every `shimmer` token; still under reduced motion.
 */
@Composable
internal fun PolarisWaitIndicator(modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    SkeletonBar(
        phase = rememberShimmerPhase(),
        base = scheme.surfaceContainerHighest,
        sweep = scheme.primary.copy(alpha = 0.5f),
        modifier = modifier.width(120.dp).height(2.dp),
    )
}

/** An inline, neutral notice: one announced line on the highest container (no status colour). */
@Composable
internal fun PolarisInlineNotice(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Paragraph),
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/** A card section: the theme's container colour and medium shape, with a heading row. */
@Composable
public fun PolarisSection(
    title: String?,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.padding(vertical = 8.dp)) {
            if (title != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // A group header: 13 sp at weight 500 in the muted text colour (UI-KITS.md 4.3), a heading to TalkBack.
                    Text(
                        text = title,
                        style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp, lineHeight = 18.sp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    trailing()
                }
            }
            content()
        }
    }
}

/** The most segments the seat meter draws; a larger limit draws one continuous bar. */
internal const val SEAT_METER_SEGMENTS: Int = 12

/**
 * The neutral seat meter (UI-KITS.md 1.5 rule 9, 4.3 DeviceLimit): [limit] segments, [used] of them
 * filled in the strongest text colour at 80 % and the rest at 10 %, with no status colour (a full
 * license is a limit, not an error) and its caption ("3 of 3 in use") under it. The bar is one image
 * to TalkBack, labelled with the count; the caption is the visible text label (rule: never colour alone).
 * A null [caption] draws the bar alone, for a row that states the count beside it.
 *
 * @param description what TalkBack says for the bar ("3 of 3 devices in use").
 */
@Composable
internal fun PolarisSeatMeter(used: Int, limit: Int, caption: String?, description: String, modifier: Modifier = Modifier) {
    val ink = MaterialTheme.colorScheme.onSurface
    val segments = limit.coerceIn(1, SEAT_METER_SEGMENTS)
    val filled = if (limit <= SEAT_METER_SEGMENTS) used.coerceIn(0, segments) else 0
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PolarisSpace.tight)) {
        Row(
            Modifier.fillMaxWidth().semantics {
                contentDescription = description
                role = Role.Image
            },
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (limit <= SEAT_METER_SEGMENTS) {
                for (i in 0 until segments) {
                    Box(
                        Modifier
                            .weight(1f)
                            .height(8.dp)
                            .clip(CircleShape)
                            .background(ink.copy(alpha = if (i < filled) 0.8f else 0.1f)),
                    )
                }
            } else {
                val share = (used.toFloat() / limit).coerceIn(0f, 1f)
                Box(Modifier.weight(1f).height(8.dp).clip(CircleShape).background(ink.copy(alpha = 0.1f))) {
                    Box(Modifier.fillMaxWidth(share).height(8.dp).clip(CircleShape).background(ink.copy(alpha = 0.8f)))
                }
            }
        }
        if (caption != null) {
            Text(
                text = caption,
                style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
