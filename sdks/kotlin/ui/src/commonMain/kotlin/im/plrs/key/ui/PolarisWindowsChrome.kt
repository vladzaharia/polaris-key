// The Windows 11 (Fluent 2) chrome of the kit (UK-10.5): 32 dp controls at radius 4, overlays at
// radius 8, the ContentDialog on a smoke layer (footer buttons at equal width, the primary first),
// the two-tone focus ring, opaque surfaces (no Mica, K5) and the contrast themes' system colours.
//
// Everything here runs only when the window's variant is Windows; Android and the other desktop
// variants never reach it. The shared screens branch on `window.variant` at the few places a
// measure or a control differs, and call into this file.

package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.KitRadius
import im.plrs.key.ui.brand.PolarisKitTokens

/** True when this window is drawn in the Windows (Fluent) chrome. */
internal val PolarisWindow.fluent: Boolean get() = variant == PolarisPlatformVariant.Windows

/** The Fluent measures, from the generated `PolarisKitTokens.Windows` (4 controls, 8 overlays). */
internal object PolarisFluent {
    val controlHeight: Dp = PolarisKitTokens.Windows.controlHeight.dp
    val controlRadius: Dp = ((PolarisKitTokens.Windows.radiusControl as KitRadius.Fixed).dp).dp
    val overlayRadius: Dp = PolarisKitTokens.Windows.radiusOverlay.dp
    val controlShape: Shape get() = polarisFluentControlShape
    val overlayShape: Shape get() = polarisFluentOverlayShape

    /** The ContentDialog's width and padding (windows.html `.dialog`). */
    val dialogWidth: Dp = 480.dp
    /** The Fluent spacing steps: the gap between buttons, a label and its field, the button and field insets. */
    val gap: Dp = 8.dp
    val labelGap: Dp = 4.dp
    val buttonInset: Dp = 12.dp
    val fieldInset: Dp = 10.dp
    val dialogMargin: Dp = 16.dp
    val dialogPad: Dp = PolarisKitTokens.Windows.cardPad.dp

    /** The focus ring: a 2 dp outer line in the text colour around a 1 dp inner line in the surface colour. */
    val ringOuter: Dp = PolarisKitTokens.Windows.focusWidth.dp
    val ringInner: Dp = PolarisKitTokens.Windows.focusInner.dp

    /** The smoke layer's opacity behind a ContentDialog. */
    fun smokeAlpha(dark: Boolean): Float =
        if (dark) PolarisKitTokens.Windows.scrimDarkOpacity else PolarisKitTokens.Windows.scrimLightOpacity
}

// ── Contrast themes: the system colours ─────────────────────────────────────────────────────────

/**
 * The Win32 system colours of a contrast theme. The desktop host can say that a contrast theme is
 * on (`PolarisHostFacts.highContrast`) but not which one, so the kit draws the two stock themes'
 * values: "High contrast black" when the kit is dark, "High contrast white" otherwise.
 */
/** One system colour from its 0xAARRGGBB value (the stock contrast themes' values; a Long, so no colour literal). */
private fun sys(argb: Long): Color = Color(argb)

internal class FluentSystemColors(
    val window: Color,
    val windowText: Color,
    val grayText: Color,
    val highlight: Color,
    val highlightText: Color,
    val buttonFace: Color,
    val buttonText: Color,
    val hotlight: Color,
) {
    companion object {
        val Black = FluentSystemColors(
            window = sys(0xFF000000), windowText = sys(0xFFFFFFFF), grayText = sys(0xFF3FF23F),
            highlight = sys(0xFF1AEBFF), highlightText = sys(0xFF000000),
            buttonFace = sys(0xFF000000), buttonText = sys(0xFFFFFFFF), hotlight = sys(0xFFFFFF00),
        )

        val White = FluentSystemColors(
            window = sys(0xFFFFFFFF), windowText = sys(0xFF000000), grayText = sys(0xFF600000),
            highlight = sys(0xFF37006E), highlightText = sys(0xFFFFFFFF),
            buttonFace = sys(0xFFFFFFFF), buttonText = sys(0xFF000000), hotlight = sys(0xFF00009F),
        )

        fun forTheme(dark: Boolean): FluentSystemColors = if (dark) Black else White
    }
}

/** The Material scheme of a contrast theme: every surface is Window, every text WindowText, fills Highlight. */
internal fun windowsContrastScheme(dark: Boolean): ColorScheme {
    val c = FluentSystemColors.forTheme(dark)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.highlight, onPrimary = c.highlightText,
        primaryContainer = c.window, onPrimaryContainer = c.windowText,
        inversePrimary = c.highlight,
        secondary = c.buttonText, onSecondary = c.buttonFace,
        secondaryContainer = c.buttonFace, onSecondaryContainer = c.buttonText,
        tertiary = c.hotlight, onTertiary = c.window,
        tertiaryContainer = c.window, onTertiaryContainer = c.windowText,
        background = c.window, onBackground = c.windowText,
        surface = c.window, onSurface = c.windowText,
        surfaceVariant = c.window, onSurfaceVariant = c.windowText,
        surfaceTint = Color.Transparent,
        inverseSurface = c.windowText, inverseOnSurface = c.window,
        error = c.hotlight, onError = c.window,
        errorContainer = c.window, onErrorContainer = c.windowText,
        outline = c.windowText, outlineVariant = c.windowText, scrim = c.window,
        surfaceBright = c.window, surfaceDim = c.window,
        surfaceContainerLowest = c.window, surfaceContainerLow = c.window, surfaceContainer = c.window,
        surfaceContainerHigh = c.window, surfaceContainerHighest = c.window,
    )
}

/** What the host says about itself, when a host or a test pins it; null reads the desktop (see [rememberThemeHostFacts]). */
internal val LocalPolarisHostFacts = staticCompositionLocalOf<PolarisHostFacts?> { null }

/** The host facts the theme reads: the desktop's real reads on the desktop, the defaults on Android. */
@Composable
internal expect fun rememberThemeHostFacts(): PolarisHostFacts

// ── The focus ring ──────────────────────────────────────────────────────────────────────────────

/**
 * The Fluent two-tone focus ring around a control of the current draw size: a [ringInner] line in
 * [inner] (the surface colour) touching the control, and a [ringOuter] line in [outer] (the text
 * colour) around it, so the ring holds 3:1 against the accent fill and the page alike.
 */
internal fun DrawScope.drawFluentFocusRing(shape: Shape, outer: Color, inner: Color) {
    fun ring(width: Float, expand: Float, color: Color) {
        val outline = shape.createOutline(Size(size.width + expand * 2, size.height + expand * 2), layoutDirection, this)
        translate(-expand, -expand) { drawOutline(outline, color, style = Stroke(width)) }
    }
    val i = PolarisFluent.ringInner.toPx()
    val o = PolarisFluent.ringOuter.toPx()
    ring(i, i / 2, inner)
    ring(o, i + o / 2, outer)
}

// ── Buttons ─────────────────────────────────────────────────────────────────────────────────────

internal enum class FluentButtonKind { Accent, Standard, Subtle }

/**
 * A Fluent button: 32 dp tall at radius 4, a 14 sp label centred with 16 dp either side. [Accent]
 * is the filled primary, [Standard] the quiet control with a hairline, [Subtle] the text-only link.
 * The caller puts the focus ring on [modifier] (it must draw outside the clip).
 */
@Composable
internal fun PolarisFluentButton(
    kind: FluentButtonKind,
    text: String,
    onClick: () -> Unit,
    interaction: MutableInteractionSource,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    external: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    val dark = PolarisTheme.current.dark
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val shape = PolarisFluent.controlShape
    val (fill, label) = when (kind) {
        FluentButtonKind.Accent -> scheme.primary to scheme.onPrimary
        FluentButtonKind.Standard -> (if (dark) scheme.secondaryContainer else scheme.surfaceContainerLow) to scheme.onSurface
        FluentButtonKind.Subtle -> Color.Transparent to PolarisTheme.accentText
    }
    // Hover and press lay the label colour over the fill at 8 % and 12 %: no new colours.
    val state = when {
        pressed -> 0.12f
        hovered -> 0.08f
        else -> 0f
    }
    val fillNow = if (state > 0f) label.copy(alpha = state).compositeOver(fill.takeIf { it.alpha > 0f } ?: scheme.surface) else fill
    val live = enabled && !busy
    val edge = if (kind == FluentButtonKind.Standard) BorderStroke(1.dp, scheme.outlineVariant) else null
    Row(
        modifier = modifier
            .height(PolarisFluent.controlHeight)
            .clip(shape)
            .background(fillNow)
            .then(if (edge != null) Modifier.border(edge, shape) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = live,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = PolarisFluent.buttonInset),
        horizontalArrangement = Arrangement.spacedBy(PolarisFluent.gap, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val content = if (live || busy) label else label.copy(alpha = 0.4f)
        // The glyph and the busy ring follow the label's colour (they read LocalContentColor).
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides content) {
            if (busy) androidx.compose.material3.CircularProgressIndicator(
                modifier = Modifier.height(16.dp).widthIn(max = 16.dp), strokeWidth = 2.dp, color = content,
            )
            Text(
                text,
                style = MaterialTheme.typography.labelLarge,
                color = content,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (external) PolarisNewWindowGlyph(Modifier)
        }
    }
}

// ── Text field ──────────────────────────────────────────────────────────────────────────────────

/**
 * The Fluent text field: the label above, a 32 dp box at radius 4 with a hairline, and a 2 dp
 * accent line along the foot while focused. [trailing] sits inside the box at its end.
 */
@Composable
internal fun PolarisFluentTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier,
    placeholder: String?,
    enabled: Boolean,
    isError: Boolean,
    trailing: (@Composable () -> Unit)?,
    focusRequester: FocusRequester?,
    keyboardOptions: KeyboardOptions,
    keyboardActions: KeyboardActions,
) {
    val scheme = MaterialTheme.colorScheme
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = PolarisFluent.controlShape
    val dark = PolarisTheme.current.dark
    val fill = if (dark) scheme.surfaceContainerLow else scheme.surfaceContainerLowest
    val line = if (isError) scheme.error else PolarisTheme.accentText
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface)
        Spacer(Modifier.height(PolarisFluent.labelGap))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = scheme.onSurface),
            cursorBrush = SolidColor(scheme.onSurface),
            interactionSource = interaction,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            modifier = Modifier
                .fillMaxWidth()
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .semantics { contentDescription = label },
            decorationBox = { inner ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(PolarisFluent.controlHeight)
                        .clip(shape)
                        .background(fill)
                        .border(1.dp, if (isError) scheme.error else scheme.outlineVariant, shape)
                        .drawBehind {
                            if (focused) drawRect(line, Offset(0f, size.height - 2.dp.toPx()), Size(size.width, 2.dp.toPx()))
                        }
                        .padding(start = PolarisFluent.fieldInset),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                        }
                        inner()
                    }
                    trailing?.invoke()
                }
            },
        )
    }
}

// ── The ContentDialog ───────────────────────────────────────────────────────────────────────────

/** One button of the dialog's footer. */
internal class FluentFooterButton(val text: String, val kind: FluentButtonKind, val onClick: () -> Unit)

/**
 * A ContentDialog on a smoke layer (windows.html `.smoke` and `.dialog`): the window dims, the dialog
 * sits in the middle at 480 dp wide and radius 8 on an opaque layer, its body padded 24 dp, and its
 * footer a band of buttons at equal width with the primary first. [onDismissOutside] runs on a tap on
 * the smoke (null: the dialog is modal and stays).
 */
@Composable
internal fun PolarisFluentContentDialog(
    footer: List<FluentFooterButton>,
    modifier: Modifier = Modifier,
    onDismissOutside: (() -> Unit)? = null,
    body: @Composable () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val dark = PolarisTheme.current.dark
    Box(
        modifier
            .fillMaxSize()
            .background(scheme.scrim.copy(alpha = PolarisFluent.smokeAlpha(dark)))
            .then(
                if (onDismissOutside != null) {
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismissOutside)
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            // A tap on the dialog is the dialog's, never the smoke's.
            modifier = Modifier
                .padding(PolarisFluent.dialogMargin)
                .widthIn(max = PolarisFluent.dialogWidth)
                .fillMaxWidth()
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {}),
            shape = PolarisFluent.overlayShape,
            color = scheme.surfaceContainerLow,
            contentColor = scheme.onSurface,
            border = BorderStroke(1.dp, scheme.outlineVariant),
            shadowElevation = 16.dp,
        ) {
            Column {
                Box(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(PolarisFluent.dialogPad),
                ) { body() }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(scheme.surfaceDim)
                        .padding(PolarisFluent.dialogPad),
                    horizontalArrangement = Arrangement.spacedBy(PolarisFluent.gap),
                ) {
                    for (b in footer) {
                        val interaction = remember { MutableInteractionSource() }
                        PolarisFluentButton(
                            b.kind, b.text, b.onClick, interaction,
                            Modifier.weight(1f).fluentFocusRing(interaction),
                        )
                    }
                }
            }
        }
    }
}

/** The Fluent focus ring on [this] while [interaction] has focus. */
@Composable
internal fun Modifier.fluentFocusRing(interaction: MutableInteractionSource, shape: Shape = PolarisFluent.controlShape): Modifier {
    val focused by interaction.collectIsFocusedAsState()
    val scheme = MaterialTheme.colorScheme
    val outer = scheme.onSurface
    val inner = scheme.background
    return this.drawBehindContent(focused) { drawFluentFocusRing(shape, outer, inner) }
}

private fun Modifier.drawBehindContent(show: Boolean, draw: DrawScope.() -> Unit): Modifier =
    this.drawWithContent {
        drawContent()
        if (show) draw()
    }
