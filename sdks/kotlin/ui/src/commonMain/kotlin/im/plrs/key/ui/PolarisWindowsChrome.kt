// The Windows 11 (Fluent 2) chrome of the kit (UK-10.5): 32 dp controls at radius 4, overlays at
// radius 8, the ContentDialog on a smoke layer (footer buttons at equal width, the primary first),
// the two-tone focus ring, opaque surfaces (no Mica, K5) and the contrast themes' system colours.
//
// Everything here runs only when the window's variant is Windows; Android and the other desktop
// variants never reach it. The shared screens branch on `window.variant` at the few places a
// measure or a control differs, and call into this file.

package im.plrs.key.ui

import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.getTextLayoutResult
import androidx.compose.ui.semantics.text
import androidx.compose.foundation.text.appendInlineContent
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Typography
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.luminance
import im.plrs.key.ui.brand.KitTypeRole
import im.plrs.key.ui.brand.PolarisKitGlyphs
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

// ── The focus ring ──────────────────────────────────────────────────────────────────────────────

/**
 * The Fluent two-tone focus ring around a control of the current draw size: a [ringInner] line in
 * [inner] (the surface colour) touching the control, and a [ringOuter] line in [outer] (the text
 * colour) around it, so the ring holds 3:1 against the accent fill and the page alike.
 */
internal fun DrawScope.drawFluentFocusRing(shape: Shape, outer: Color, inner: Color) {
    // Concentric: each line's corner radius is the control's plus its distance out, so the ring
    // keeps one gap to the control all the way round (radius + offset).
    fun ring(width: Float, expand: Float, color: Color) {
        val grown = Size(size.width + expand * 2, size.height + expand * 2)
        val ringShape: Shape = if (shape is CornerBasedShape) {
            val r = shape.topStart.toPx(size, this) + expand
            polarisRadiusShape(r.coerceAtLeast(0f).toDp())
        } else {
            shape
        }
        val outline = ringShape.createOutline(grown, layoutDirection, this)
        translate(-expand, -expand) { drawOutline(outline, color, style = Stroke(width)) }
    }
    val i = PolarisFluent.ringInner.toPx()
    val o = PolarisFluent.ringOuter.toPx()
    ring(i, i / 2, inner)
    ring(o, i + o / 2, outer)
}

// ── Type ────────────────────────────────────────────────────────────────────────────────────────

private fun TextStyle.fluent(role: KitTypeRole, weight: Int = role.weight): TextStyle = copy(
    fontSize = role.size.sp,
    lineHeight = role.lineHeight.sp,
    fontWeight = FontWeight(weight),
    letterSpacing = role.tracking.sp,
)

/**
 * [base] with the Windows type scale (`PolarisKitTokens.Windows.Typography`): display 28/36 at 600,
 * title 20/28, body 14/20, button 14/500, no tracking. The family stays the base's.
 */
internal fun windowsTypography(base: Typography): Typography {
    val t = PolarisKitTokens.Windows.Typography
    return base.copy(
        displayLarge = base.displayLarge.fluent(t.display),
        displayMedium = base.displayMedium.fluent(t.display),
        displaySmall = base.displaySmall.fluent(t.display),
        headlineLarge = base.headlineLarge.fluent(t.display),
        headlineMedium = base.headlineMedium.fluent(t.title),
        headlineSmall = base.headlineSmall.fluent(t.title),
        titleLarge = base.titleLarge.fluent(t.title),
        titleMedium = base.titleMedium.fluent(t.label, 600),
        titleSmall = base.titleSmall.fluent(t.label, 600),
        bodyLarge = base.bodyLarge.fluent(t.body),
        bodyMedium = base.bodyMedium.fluent(t.body),
        bodySmall = base.bodySmall.fluent(t.meta),
        labelLarge = base.labelLarge.fluent(t.button),
        labelMedium = base.labelMedium.fluent(t.label),
        labelSmall = base.labelSmall.fluent(t.meta, 500),
    )
}

/** True while a Windows contrast theme is on (the kit draws the system colours). */
@Composable
internal fun fluentContrast(): Boolean = rememberThemeHostFacts()?.highContrast == true

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
    val contrast = fluentContrast()
    val sys = if (contrast) FluentSystemColors.forTheme(dark) else null
    val live = enabled && !busy
    val over = (hovered || pressed) && live
    val accentText = PolarisTheme.accentText
    var (fill, label) = when (kind) {
        FluentButtonKind.Accent -> scheme.primary to scheme.onPrimary
        FluentButtonKind.Standard -> (if (dark) scheme.secondaryContainer else scheme.surfaceContainerLow) to scheme.onSurface
        FluentButtonKind.Subtle -> Color.Transparent to accentText
    }
    var edge: BorderStroke? = if (kind == FluentButtonKind.Standard) BorderStroke(1.dp, scheme.outlineVariant) else null
    if (sys != null) {
        // A contrast theme: Highlight and HighlightText under the pointer (an accent button inverts),
        // GrayText when disabled, never a tint of the label.
        when {
            !live -> {
                fill = if (kind == FluentButtonKind.Subtle) Color.Transparent else sys.buttonFace
                label = sys.grayText
                edge = if (kind == FluentButtonKind.Subtle) null else BorderStroke(1.dp, sys.grayText)
            }
            over && kind == FluentButtonKind.Accent -> { fill = sys.highlightText; label = sys.highlight; edge = BorderStroke(1.dp, sys.highlight) }
            over -> { fill = sys.highlight; label = sys.highlightText; edge = BorderStroke(1.dp, sys.highlightText) }
            kind == FluentButtonKind.Accent -> edge = BorderStroke(1.dp, sys.highlightText)
        }
    }
    // Hover and press lay the label colour over the fill at 8 % and 12 %: no new colours.
    val state = if (sys != null) 0f else when {
        pressed -> 0.12f
        hovered -> 0.08f
        else -> 0f
    }
    val fillNow = if (state > 0f) label.copy(alpha = state).compositeOver(fill.takeIf { it.alpha > 0f } ?: scheme.surface) else fill
    // Links read as links when the accent is plain text colour (ink) or a contrast theme draws them.
    val underline = kind == FluentButtonKind.Subtle &&
        (contrast || kotlin.math.abs(accentText.luminance() - scheme.onSurface.luminance()) < 0.05f)
    Row(
        modifier = modifier
            // A floor, not a fixed height: a larger font scale grows the control instead of cutting its label.
            .heightIn(min = PolarisFluent.controlHeight)
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
        val content = if (live || busy || sys != null) label else label.copy(alpha = 0.4f)
        // The glyph and the busy ring follow the label's colour (they read LocalContentColor).
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides content) {
            if (busy) androidx.compose.material3.CircularProgressIndicator(
                modifier = Modifier.height(16.dp).widthIn(max = 16.dp), strokeWidth = 2.dp, color = content,
            )
            // The new-window glyph (↗) ends the label as a character joined to the last word by a no-break space, so it
            // wraps with the text and stays at the end of the last line (an inline icon may break off onto a line of its own).
            val shown = if (external) androidx.compose.ui.text.AnnotatedString("$text\u00A0\u2197") else androidx.compose.ui.text.AnnotatedString(text)
            // The glyph is decoration: assistive tech reads the plain label (the control says where it goes).
            val layout = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<androidx.compose.ui.text.TextLayoutResult?>(null) }
            Text(
                shown,
                style = MaterialTheme.typography.labelLarge.copy(textDecoration = if (underline) TextDecoration.Underline else null),
                color = content,
                textAlign = TextAlign.Center,
                onTextLayout = { layout.value = it },
                modifier = Modifier.weight(1f, fill = false).then(
                    if (external) Modifier.clearAndSetSemantics {
                        this.text = androidx.compose.ui.text.AnnotatedString(text)
                        getTextLayoutResult { results -> layout.value?.let { results.add(it); true } ?: false }
                    } else Modifier,
                ),
                // A label wraps (the control grows) rather than being cut: a narrow footer or a larger font scale.
            )
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
    // WCAG 1.4.11: at rest the box is found by its 1 dp foot line in onSurfaceVariant (the hairline
    // around it is decoration); focused it is the 2 dp accent line.
    val rest = if (isError) scheme.error else scheme.onSurfaceVariant
    val contrast = fluentContrast()
    val gray = if (contrast) FluentSystemColors.forTheme(dark).grayText else null
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = gray?.takeIf { !enabled } ?: scheme.onSurface)
        Spacer(Modifier.height(PolarisFluent.labelGap))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = gray?.takeIf { !enabled } ?: scheme.onSurface),
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
                        .heightIn(min = PolarisFluent.controlHeight)
                        .clip(shape)
                        .background(fill)
                        .drawWithContent {
                            drawContent()
                            val h = (if (focused) 2.dp else 1.dp).toPx()
                            drawRect(if (focused) line else rest, Offset(0f, size.height - h), Size(size.width, h))
                        }
                        .border(1.dp, if (isError) scheme.error else gray?.takeIf { !enabled } ?: scheme.outlineVariant, shape)
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
 * the smoke (null: the dialog is modal and stays); [onEscape] runs on Escape (the optional dialog's
 * Later; null for a mandatory one). The primary takes focus as the dialog opens, and Tab wraps
 * inside it: first to last and back, never out to the page behind.
 */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
internal fun PolarisFluentContentDialog(
    footer: List<FluentFooterButton>,
    modifier: Modifier = Modifier,
    onDismissOutside: (() -> Unit)? = null,
    onEscape: (() -> Unit)? = onDismissOutside,
    body: @Composable () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val dark = PolarisTheme.current.dark
    val first = remember { FocusRequester() }
    val last = remember { FocusRequester() }
    val initialFocus = LocalPolarisInitialFocus.current
    LaunchedEffect(initialFocus) {
        if (initialFocus) {
            // The buttons are placed on the first frame; a request before that has nothing to land on.
            androidx.compose.runtime.withFrameNanos { }
            runCatching { first.requestFocus() }
        }
    }
    Box(
        modifier
            .fillMaxSize()
            .background(scheme.scrim.copy(alpha = PolarisFluent.smokeAlpha(dark)))
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.Escape && onEscape != null) {
                    onEscape()
                    true
                } else {
                    false
                }
            }
            .focusProperties {
                exit = { dir ->
                    when (dir) {
                        FocusDirection.Next -> first
                        FocusDirection.Previous -> last
                        else -> FocusRequester.Cancel
                    }
                }
            }
            .focusGroup()
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
                .pointerInput(Unit) { detectTapGestures { } },
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
                    footer.forEachIndexed { i, b ->
                        val interaction = remember { MutableInteractionSource() }
                        var m: Modifier = Modifier.weight(1f).fluentFocusRing(interaction)
                        if (i == 0) m = m.focusRequester(first)
                        if (i == footer.lastIndex) m = m.focusRequester(last)
                        PolarisFluentButton(b.kind, b.text, b.onClick, interaction, m)
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
