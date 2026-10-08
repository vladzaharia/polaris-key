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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified

/** The widest a kit screen's column grows on a phone. */
public val PolarisMaxContentWidth: Dp = 480.dp

/** The minimum touch target of every kit control (Material and Android accessibility guidance). */
public val PolarisMinTouchTarget: Dp = 48.dp

/** The widest the two panes grow together. */
internal val PolarisTwoPaneMaxWidth: Dp = 1040.dp

/** The widest a message block grows outside a phone column. */
internal val PolarisMessageBlockWidth: Dp = 560.dp

/** The kit's button height: 56 dp (UI-KITS.md §2.1 Android `controlHeight`), 60 on TV. */
internal val PolarisWindow.controlHeight: Dp get() = if (tv) 60.dp else 56.dp

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
 * (under 480 dp, a phone in landscape), on Android TV and in a wide landscape window the two sit
 * side by side, [content] on the start side and [actions] on the end side, each scrolling on its
 * own. A screen without [actions] is always one column, centred.
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
internal fun PolarisSurface(
    modifier: Modifier = Modifier,
    content: @Composable (window: PolarisWindow, maxHeight: Dp) -> Unit,
) {
    val tv = isTelevision()
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            val window = PolarisWindow(maxWidth, maxHeight, tv)
            val height = maxHeight
            CompositionLocalProvider(LocalPolarisWindow provides window) {
                if (window.textScale == 1f) {
                    content(window, height)
                } else {
                    // A copy of the type scale, not a density override: the platform's own
                    // (non-linear) font scaling keeps applying on top of it.
                    MaterialTheme(
                        colorScheme = MaterialTheme.colorScheme,
                        shapes = MaterialTheme.shapes,
                        typography = MaterialTheme.typography.scaled(window.textScale),
                    ) { content(window, height) }
                }
            }
        }
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
    content: @Composable ColumnScope.() -> Unit,
) {
    val theme = PolarisTheme.current
    PolarisSurface(modifier) { window, maxHeight ->
        val logo = theme.logo?.takeIf { showLogo }
        if (actions != null && window.twoPane) {
            CompositionLocalProvider(LocalPolarisTextAlign provides TextAlign.Start) {
                Box(
                    Modifier
                        .fillMaxSize()
                        // The panes pad themselves (PolarisSpace.controls) inside their scroll.
                        .padding(horizontal = window.horizontalPadding, vertical = (window.verticalPadding - PolarisSpace.controls).coerceAtLeast(0.dp)),
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
                            if (theme.showPoweredBy) {
                                Spacer(Modifier.height(window.section))
                                PolarisPoweredByBadge()
                            }
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
                            top = if (anchor == PolarisAnchor.Center) window.verticalPadding else window.topInset,
                            bottom = window.verticalPadding,
                        ),
                    horizontalAlignment = horizontal,
                ) {
                    if (anchor != PolarisAnchor.Top) Spacer(Modifier.weight(1f))
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
                    if (anchor == PolarisAnchor.Center) {
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
                    if (theme.showPoweredBy) {
                        Spacer(Modifier.height(window.section))
                        PolarisPoweredByBadge(Modifier.align(Alignment.CenterHorizontally))
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

/** The icon a message kind shows. */
internal fun PolarisMessageKind.icon(): ImageVector = when (this) {
    PolarisMessageKind.Info -> Icons.Filled.Info
    PolarisMessageKind.Warning, PolarisMessageKind.Blocked, PolarisMessageKind.Danger -> Icons.Filled.Warning
    PolarisMessageKind.Offline -> Icons.Filled.Refresh
    PolarisMessageKind.Locked -> Icons.Filled.Lock
}

/** The container and text colours of a message kind's notice. */
@Composable
internal fun PolarisMessageKind.tint(): Pair<Color, Color> {
    val status = PolarisTheme.status
    val scheme = MaterialTheme.colorScheme
    return when (this) {
        PolarisMessageKind.Info -> scheme.primaryContainer to scheme.onPrimaryContainer
        PolarisMessageKind.Offline -> scheme.secondaryContainer to scheme.onSecondaryContainer
        PolarisMessageKind.Warning, PolarisMessageKind.Blocked -> status.warningContainer to status.onWarningContainer
        PolarisMessageKind.Danger, PolarisMessageKind.Locked -> status.dangerContainer to status.onDangerContainer
    }
}

/** The glyph colour of a message kind's icon: the status colour on its container. */
@Composable
internal fun PolarisMessageKind.glyph(): Color {
    val status = PolarisTheme.status
    return when (this) {
        PolarisMessageKind.Info -> MaterialTheme.colorScheme.primary
        PolarisMessageKind.Offline -> MaterialTheme.colorScheme.onSecondaryContainer
        PolarisMessageKind.Warning, PolarisMessageKind.Blocked -> status.warning
        PolarisMessageKind.Danger, PolarisMessageKind.Locked -> status.danger
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
 * beside it or in the title. Nothing when the theme has no logo and the copy does not name the
 * product.
 */
@Composable
internal fun PolarisProductIcon(size: Dp, modifier: Modifier = Modifier) {
    val theme = PolarisTheme.current
    val logo = theme.logo
    val shape = PolarisTheme.iconShape
    if (logo != null) {
        Box(modifier.size(size).clip(shape), contentAlignment = Alignment.Center) { logo() }
        return
    }
    val initial = productName(theme.copy)?.trim()?.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar() ?: return
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
 * The product header of a focused step (UI-KITS.md §1.2): the product icon at 32 dp beside the
 * product's name at weight 500, then a section gap. Nothing when there is neither.
 */
@Composable
internal fun PolarisProductHeader() {
    val theme = PolarisTheme.current
    val name = productName(theme.copy)
    if (name == null && theme.logo == null) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        PolarisProductIcon(32.dp)
        if (name != null) {
            Text(
                name,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Medium),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
    Spacer(Modifier.height(polarisWindow.section))
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
    Text(
        text = text,
        style = when {
            window.large -> typography.headlineLarge
            window.wide -> typography.headlineMedium
            else -> typography.headlineSmall
        }.copy(lineBreak = LineBreak.Heading),
        color = MaterialTheme.colorScheme.onSurface,
        textAlign = LocalPolarisTextAlign.current,
        modifier = modifier.fillMaxWidth().semantics { heading() },
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
    val show = focused && (window.tv || keyboard)
    val color = PolarisTheme.focusColor
    val ring = if (window.tv) 3.dp else 2.dp
    val scale by animateFloatAsState(if (window.tv && focused) 1.05f else 1f, label = "PolarisFocusScale")
    val requester = remember { FocusRequester() }
    // The first focus goes in once the control is placed (a request before that has nothing to land on).
    var placed by remember { mutableStateOf(false) }
    if (initialFocus && placed) {
        LaunchedEffect(Unit) {
            if (window.tv || keyboard) runCatching { requester.requestFocus() }
        }
    }
    Modifier
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .drawWithContent {
            drawContent()
            if (show) {
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

/** Full width in a stacked group, sized to the label in a trailing row; 56 dp tall (60 on TV). */
@Composable
private fun Modifier.controlSize(): Modifier {
    val height = polarisWindow.controlHeight
    val row = LocalPolarisActionRow.current
    return (if (row) this else this.fillMaxWidth()).heightIn(min = height)
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
) {
    val interaction = remember { MutableInteractionSource() }
    val shape = PolarisTheme.buttonShape
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = shape,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize(),
    ) {
        if (busy) PolarisBusyRing()
        Text(text, textAlign = TextAlign.Center)
    }
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
) {
    val interaction = remember { MutableInteractionSource() }
    val shape = PolarisTheme.buttonShape
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = shape,
        // A busy secondary keeps its label at full contrast beside the ring (rule 7).
        colors = if (busy) {
            ButtonDefaults.filledTonalButtonColors(
                disabledContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                disabledContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        } else {
            ButtonDefaults.filledTonalButtonColors()
        },
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, shape, initialFocus).controlSize(),
    ) {
        if (busy) PolarisBusyRing()
        Text(text, textAlign = TextAlign.Center)
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
    val shape = PolarisTheme.buttonShape
    val tv = polarisWindow.tv
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = shape,
        colors = ButtonDefaults.textButtonColors(contentColor = PolarisTheme.accentText),
        interactionSource = interaction,
        modifier = modifier
            .polarisFocusIndication(interaction, shape, initialFocus)
            .heightIn(min = if (tv) 60.dp else PolarisMinTouchTarget),
    ) { Text(text, textAlign = TextAlign.Center) }
}

/**
 * A group of actions. Stacked ([row] false): full width, primary first, 12 dp apart. In a
 * trailing row ([row] true): trailing-aligned at equal height, primary last (so the emission order
 * stays primary first), each sized to its label and at least 96 dp wide; when the labels do not
 * fit side by side the group stacks instead (UI-KITS.md §1.5 rule 10).
 */
@Composable
internal fun PolarisActionGroup(row: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (!row) {
        Column(
            modifier = modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
        ) { content() }
        return
    }
    CompositionLocalProvider(LocalPolarisActionRow provides true) {
        Layout(content = content, modifier = modifier.fillMaxWidth()) { measurables, constraints ->
            val gap = PolarisSpace.controls.roundToPx()
            val minWidth = 96.dp.roundToPx()
            val maxWidth = constraints.maxWidth
            val widths = measurables.map { it.maxIntrinsicWidth(Constraints.Infinity).coerceAtLeast(minWidth) }
            val fits = widths.sum() + gap * (measurables.size - 1).coerceAtLeast(0) <= maxWidth
            if (fits) {
                val height = measurables.zip(widths).maxOfOrNull { (m, w) -> m.minIntrinsicHeight(w) } ?: 0
                val placeables = measurables.zip(widths).map { (m, w) -> m.measure(Constraints.fixed(w, height)) }
                layout(maxWidth, height) {
                    var x = maxWidth
                    for (p in placeables) {
                        x -= p.width
                        p.placeRelative(x, 0)
                        x -= gap
                    }
                }
            } else {
                val placeables = measurables.map { it.measure(Constraints(minWidth = maxWidth, maxWidth = maxWidth)) }
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
public fun PolarisMessageScreen(
    message: PolarisMessageCopy,
    modifier: Modifier = Modifier,
    actions: (@Composable () -> Unit)? = null,
) {
    PolarisMessageLayout(
        modifier = modifier,
        emblem = { PolarisIconBadge(message.kind.icon(), message.kind.tint().first, message.kind.glyph()) },
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
        val block = window.compactHeight || window.card
        val align = if (block) TextAlign.Start else TextAlign.Center
        val horizontal = if (block) Alignment.Start else Alignment.CenterHorizontally
        val inner: @Composable ColumnScope.() -> Unit = {
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
                PolarisActionGroup(row = block, content = actions)
            }
            if (PolarisTheme.current.showPoweredBy) {
                Spacer(Modifier.height(window.section))
                PolarisPoweredByBadge()
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
    focusRequester: FocusRequester? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val branded = PolarisTheme.current.branding == PolarisBranding.PolarisKey
    val shape = PolarisTheme.fieldShape
    Column(modifier.fillMaxWidth()) {
        TextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(label) },
            placeholder = placeholder?.let { { Text(it) } },
            singleLine = true,
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

/** The kit's indeterminate wait ring (40 dp, on a visible track), for the waits with no known end. */
@Composable
internal fun PolarisWaitIndicator(modifier: Modifier = Modifier) {
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    Box(modifier) {
        CircularProgressIndicator(modifier = Modifier.size(40.dp), trackColor = track)
    }
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
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleSmall,
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
