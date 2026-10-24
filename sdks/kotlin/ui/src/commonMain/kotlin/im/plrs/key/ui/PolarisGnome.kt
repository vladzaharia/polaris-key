// The GNOME (libadwaita) chrome of the desktop kit (UK-10.6; UI-KITS.md §1.4, the Linux row):
//
//   controls       both actions of a pair are 40 px pills (suggested at the end of a row, first in a stack);
//                  34 px at radius 8 is for entries and auxiliary controls only
//   AdwDialog      the sheet: radius 12, a soft shadow, a 7 % edge in light, never a drawn dark outline
//   AdwStatusPage  message screens: icon, title, body, then pills (at most 240) stacked and centred, suggested on top
//   AdwAlertDialog responses side by side at equal width, the suggested one last; stacked when narrow
//   opaque         every surface is opaque (no compositor effect is assumed)
//
// Everything here is read only when the window's variant is Gnome; the other variants keep the
// kit's own measures. UK-10.5 (Windows) and UK-10.7 (macOS) add their own files beside this one.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Typography
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import im.plrs.key.ui.brand.KitTypeRole
import im.plrs.key.ui.brand.PolarisKitTokens
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The GNOME measures that are not in the generated tokens (those hold the control height and radius). */
internal object PolarisGnome {
    /** An AdwDialog's padding: the generated card padding token. */
    val pad: Dp = im.plrs.key.ui.brand.PolarisKitTokens.Gnome.cardPad.dp

    /** The margin kept around an alert in a narrow window. */
    val margin: Dp = PolarisSpace.controls + 4.dp

    /** Radius of a control (UI-KITS.md §1.4: 34 px controls at radius 8). */
    val controlRadius: Dp = 8.dp

    /** Radius of an AdwDialog and an AdwAlertDialog. */
    val dialogRadius: Dp = 12.dp

    /** The width an AdwDialog takes when the window allows. */
    val dialogWidth: Dp = 460.dp

    /** The widest an AdwAlertDialog grows. */
    val alertWidth: Dp = 420.dp

    /** The edge a dialog carries in light (never in dark). */
    const val EDGE_ALPHA_LIGHT: Float = 0.07f

    /** The widest the stacked pills of a message screen grow (the mockup's 240). */
    val statusActionWidth: Dp = 240.dp

    /** An action pill's height: both actions of a pair are 40 px pills; 34 is for entries and aux controls. */
    val actionHeight: Dp = 40.dp

    /** The focus ring: 2 px, inside the control's edge (the generated tokens' width and offset -2). */
    val focusWidth: Dp = im.plrs.key.ui.brand.PolarisKitTokens.Gnome.focusWidth.dp

    /** The network-offline symbol of the status page. */
    val networkOffline: androidx.compose.ui.graphics.vector.ImageVector by lazy {
        androidx.compose.ui.graphics.vector.ImageVector.Builder(
            name = "PolarisNetworkOffline", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
        ).addPath(
            pathData = androidx.compose.ui.graphics.vector.addPathNodes(
                "M23.64 7c-.45-.34-4.93-4-11.64-4-1.5 0-2.89.19-4.15.48L18.18 13.8 23.64 7zm-6.6 8.22L3.27 1.44 2 2.72l2.05 2.06C1.91 5.76.59 6.82.36 7l11.63 14.49.01.01.01-.01 3.9-4.86 3.32 3.32 1.27-1.27-3.46-3.46z",
            ),
            fill = androidx.compose.ui.graphics.SolidColor(Color.Black), // polaris-lint: allow-colour (the Icon tints it)
        ).build()
    }

    /** The dimming behind a dialog: the generated tokens' dark and light scrim opacities. */
    fun scrimAlpha(dark: Boolean): Float =
        if (dark) im.plrs.key.ui.brand.PolarisKitTokens.Gnome.scrimDarkOpacity else im.plrs.key.ui.brand.PolarisKitTokens.Gnome.scrimLightOpacity
}

internal val PolarisWindow.isGnome: Boolean get() = variant == PolarisPlatformVariant.Gnome

/**
 * The shape of a kit button in this window: GNOME draws both actions of a pair as pills and only an
 * [aux] control (a text button) at radius 8; the other variants keep the theme's shape.
 */
@Composable
internal fun polarisActionShape(suggested: Boolean, aux: Boolean = false): Shape =
    if (polarisWindow.isGnome) {
        // Both actions of a pair are pills; only an auxiliary control (a text button) keeps radius 8.
        if (aux) polarisRadiusShape(PolarisGnome.controlRadius) else CircleShape
    } else {
        PolarisTheme.buttonShape
    }

/** The padding inside a button: GNOME's 34 px control is its height, so the label adds no vertical padding. */
@Composable
internal fun polarisButtonPadding(): PaddingValues =
    if (polarisWindow.isGnome) PaddingValues(horizontal = 16.dp, vertical = 0.dp) else PaddingValues(horizontal = 24.dp, vertical = 12.dp)

/** An AdwDialog's surface: opaque, radius 12, a soft shadow, and in light a 7 % edge (no outline in dark). */
@Composable
internal fun Modifier.polarisGnomeDialogChrome(): Modifier {
    val shape = polarisRadiusShape(PolarisGnome.dialogRadius)
    val dark = PolarisTheme.current.dark
    val edge = if (dark) Modifier else Modifier.border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = PolarisGnome.EDGE_ALPHA_LIGHT), shape)
    return this
        .shadow(if (dark) 24.dp else 16.dp, shape, clip = false, ambientColor = Color.Black.copy(alpha = 0.3f), spotColor = Color.Black.copy(alpha = 0.3f)) // polaris-lint: allow-colour (a shadow is black)
        .then(edge)
}

/**
 * An AdwDialog's colour: the page in light, the raised card tone in dark (a dark dialog on the page
 * colour has no edge to read against, and it draws none), one step under the tonal buttons on it.
 */
@Composable
internal fun polarisGnomeDialogColor(): Color =
    MaterialTheme.colorScheme.let { if (PolarisTheme.current.dark) it.surfaceContainerLow else it.surface }

/** The scrim behind an AdwDialog: the host window dims, it does not blur. */
@Composable
internal fun Modifier.polarisGnomeScrim(): Modifier =
    background(Color.Black.copy(alpha = PolarisGnome.scrimAlpha(PolarisTheme.current.dark))) // polaris-lint: allow-colour (the dim is black at the token's opacity)

/** The status page's actions: stacked, centred, at most 320 wide, the suggested action first. */
internal fun statusActionsModifier(window: PolarisWindow): Modifier =
    if (window.isGnome) Modifier.widthIn(max = PolarisGnome.statusActionWidth) else Modifier

/** One response of an alert, in display order (the suggested one last when side by side). */
internal class PolarisAlertResponse(
    val label: String,
    val onClick: () -> Unit,
    val suggested: Boolean = false,
    /** The response that destroys something: drawn in the error colour (libadwaita's destructive appearance). */
    val destructive: Boolean = false,
    /** The response that takes focus as the alert opens (the safe one). */
    val initialFocus: Boolean = false,
)

/**
 * An AdwAlertDialog's card: [title], [body], then the [responses] side by side at equal width with
 * the suggested one last. When they do not fit in the card they stack at full width, the suggested
 * one on top (libadwaita's order). The card is opaque, radius 12.
 */
@Composable
internal fun PolarisAlertCard(
    title: String,
    body: String?,
    responses: List<PolarisAlertResponse>,
    modifier: Modifier = Modifier,
    /** One requester per response, for a host that traps focus among them. */
    requesters: List<FocusRequester>? = null,
    onFocused: (Int) -> Unit = {},
) {
    val shape = polarisRadiusShape(PolarisGnome.dialogRadius)
    Surface(
        modifier = modifier.widthIn(max = PolarisGnome.alertWidth).fillMaxWidth().polarisGnomeDialogChrome(),
        shape = shape,
        color = polarisGnomeDialogColor(),
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(Modifier.padding(PolarisGnome.pad), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                title,
                style = MaterialTheme.typography.titleLarge.copy(lineBreak = LineBreak.Heading),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            if (body != null) {
                Spacer(Modifier.height(PolarisSpace.tight))
                Text(
                    body,
                    style = MaterialTheme.typography.bodyLarge.copy(lineBreak = LineBreak.Paragraph),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(PolarisGnome.pad))
            PolarisAlertResponses {
                responses.forEachIndexed { i, r ->
                    val m = Modifier
                        .then(if (requesters != null) Modifier.focusRequester(requesters[i]) else Modifier)
                        .onFocusChanged { if (it.hasFocus) onFocused(i) }
                    when {
                        r.destructive -> PolarisGnomeDestructiveButton(r.label, r.onClick, m, r.initialFocus)
                        r.suggested -> PolarisPrimaryButton(r.label, r.onClick, m, initialFocus = r.initialFocus)
                        else -> PolarisSecondaryButton(r.label, r.onClick, m, initialFocus = r.initialFocus)
                    }
                }
            }
        }
    }
}

/**
 * The responses row: equal widths side by side while every label fits at least 96 dp wide, else
 * one column at full width in reverse order (the last, suggested, response on top).
 */
@Composable
private fun PolarisAlertResponses(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPolarisActionRow provides true) {
        Layout(content = content, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
            val gap = PolarisSpace.controls.roundToPx()
            val maxWidth = constraints.maxWidth
            val n = measurables.size.coerceAtLeast(1)
            val equal = (maxWidth - gap * (n - 1)) / n
            val need = measurables.maxOfOrNull { it.maxIntrinsicWidth(Constraints.Infinity) }?.coerceAtLeast(96.dp.roundToPx()) ?: 0
            if (need <= equal) {
                val height = measurables.maxOfOrNull { it.minIntrinsicHeight(equal) } ?: 0
                val placeables = measurables.map { it.measure(Constraints.fixed(equal, height)) }
                layout(maxWidth, height) {
                    placeables.forEachIndexed { i, p -> p.placeRelative(i * (equal + gap), 0) }
                }
            } else {
                val placeables = measurables.map { it.measure(Constraints(minWidth = maxWidth, maxWidth = maxWidth)) }.asReversed()
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
 * The "Replace {device}?" confirm as an AdwAlertDialog (SIGN-IN.md D-80): Back, then the suggested
 * "Replace {device}". Draws the card only; the host places it over a dimmed window.
 */
@Composable
internal fun PolarisReplaceAlert(
    device: String,
    thisDevice: String,
    product: String,
    onReplace: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    requesters: List<FocusRequester>? = null,
    onFocused: (Int) -> Unit = {},
) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val named = mapOf("device" to CopyArgument.Text(device))
    PolarisAlertCard(
        title = catalog.format("signin.replace.title", locale, named),
        body = catalog.format("signin.replace.consequence", locale, named + mapOf("product" to CopyArgument.Text(product), "thisDevice" to CopyArgument.Text(thisDevice))),
        responses = listOf(
            PolarisAlertResponse(catalog.format("signin.replace.back", locale), onBack, initialFocus = true),
            PolarisAlertResponse(catalog.format("signin.replace.confirmNamed", locale, named), onReplace, suggested = true, destructive = true),
        ),
        modifier = modifier,
        requesters = requesters,
        onFocused = onFocused,
    )
}

/**
 * The Replace alert centred over a dimmed host, as the sign-in sheet places an AdwAlertDialog.
 * Escape is Back, Back takes focus as it opens, and Tab cycles between the two responses (focus
 * never reaches the window behind), as libadwaita's modal alert does.
 */
@Composable
internal fun PolarisReplaceAlertOverlay(device: String, thisDevice: String, product: String, onReplace: () -> Unit, onBack: () -> Unit) {
    val requesters = remember { List(2) { FocusRequester() } }
    var focused by remember { mutableIntStateOf(0) }
    // Like the update dialog, the overlay measures its own window: it sits over the host, not inside its surface.
    androidx.compose.foundation.layout.BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .polarisGnomeScrim()
            // The scrim swallows clicks: the window behind is inert while the alert is open.
            .pointerInput(Unit) { detectTapGestures { } }
            .onPreviewKeyEvent { e ->
                when {
                    e.type != KeyEventType.KeyDown -> false
                    e.key == Key.Escape -> { onBack(); true }
                    e.key == Key.Tab -> {
                        val next = if (e.isShiftPressed) (focused + requesters.size - 1) % requesters.size else (focused + 1) % requesters.size
                        runCatching { requesters[next].requestFocus() }
                        true
                    }
                    else -> false
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
        CompositionLocalProvider(LocalPolarisWindow provides window) {
            PolarisGnomeTypeScope(window) {
                PolarisReplaceAlert(device, thisDevice, product, onReplace, onBack, Modifier.padding(PolarisGnome.margin), requesters) { focused = it }
            }
        }
    }
}

/** The destructive response: a 40 px pill in the error colours, with the kit's inset focus ring. */
@Composable
internal fun PolarisGnomeDestructiveButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, initialFocus: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
        contentPadding = polarisButtonPadding(),
        interactionSource = interaction,
        modifier = modifier.polarisFocusIndication(interaction, CircleShape, initialFocus).height(PolarisGnome.actionHeight),
    ) { Text(text, textAlign = TextAlign.Center) }
}

/** The GNOME type scale (15/21 body, 22/28 title, the generated tokens) over the Material roles, kept at the window's text scale. */
@Composable
internal fun PolarisGnomeTypeScope(window: PolarisWindow, content: @Composable () -> Unit) {
    if (!window.isGnome) {
        content()
        return
    }
    val base = MaterialTheme.typography
    val role = PolarisKitTokens.Gnome.Typography
    val f = window.textScale
    fun TextStyle.at(r: KitTypeRole) = copy(
        fontSize = (r.size * f).sp,
        lineHeight = (r.lineHeight * f).sp,
        fontWeight = FontWeight(r.weight),
        letterSpacing = r.tracking.em,
    )
    val typography = Typography(
        displayLarge = base.displayLarge.at(role.display),
        displayMedium = base.displayMedium.at(role.display),
        displaySmall = base.displaySmall.at(role.display),
        headlineLarge = base.headlineLarge.at(role.title),
        headlineMedium = base.headlineMedium.at(role.title),
        headlineSmall = base.headlineSmall.at(role.title),
        titleLarge = base.titleLarge.at(role.title),
        titleMedium = base.titleMedium.at(role.label),
        titleSmall = base.titleSmall.at(role.label),
        bodyLarge = base.bodyLarge.at(role.body),
        bodyMedium = base.bodyMedium.at(role.body),
        bodySmall = base.bodySmall.at(role.meta),
        labelLarge = base.labelLarge.at(role.label),
        labelMedium = base.labelMedium.at(role.label),
        labelSmall = base.labelSmall.at(role.meta),
    )
    MaterialTheme(colorScheme = MaterialTheme.colorScheme, shapes = MaterialTheme.shapes, typography = typography, content = content)
}

/**
 * A GtkEntry: the label above, then a 34 px field at radius 8 with the page's raised tone; focus is
 * the accent in a 2 px outline inside the edge (not a filled Material field with a floating label).
 */
@Composable
internal fun PolarisGnomeEntry(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String?,
    enabled: Boolean,
    isError: Boolean,
    trailing: (@Composable () -> Unit)?,
    focusRequester: FocusRequester?,
    keyboardOptions: KeyboardOptions,
    keyboardActions: KeyboardActions,
) {
    val scheme = MaterialTheme.colorScheme
    val shape = polarisRadiusShape(PolarisGnome.controlRadius)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val outline = when {
        isError -> scheme.error
        focused -> PolarisTheme.focusColor
        else -> scheme.onSurface.copy(alpha = 0.2f)
    }
    Column(Modifier.fillMaxWidth()) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurface,
            modifier = Modifier.padding(bottom = PolarisSpace.tight),
        )
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 34.dp)
                .testTag("polaris.gnome.entry")
                .clip(shape)
                .background(scheme.surfaceContainerHighest)
                .border(if (focused || isError) PolarisGnome.focusWidth else 1.dp, outline, shape)
                .padding(start = PolarisSpace.controls),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f).padding(vertical = PolarisSpace.tight), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty() && placeholder != null) {
                    Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant)
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = if (enabled) scheme.onSurface else scheme.onSurfaceVariant),
                    cursorBrush = SolidColor(PolarisTheme.focusColor),
                    interactionSource = interaction,
                    keyboardOptions = keyboardOptions,
                    keyboardActions = keyboardActions,
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                        .semantics { contentDescription = label },
                )
            }
            if (trailing != null) trailing()
        }
    }
}
