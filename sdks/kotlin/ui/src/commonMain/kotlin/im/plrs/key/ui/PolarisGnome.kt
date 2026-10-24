// The GNOME (libadwaita) chrome of the desktop kit (UK-10.6; UI-KITS.md §1.4, the Linux row):
//
//   controls       34 px at radius 8; the suggested action is a pill, and it ends a row of responses
//   AdwDialog      the sheet: radius 12, a soft shadow, a 7 % edge in light, never a drawn dark outline
//   AdwStatusPage  message screens: icon, title, body, then pills stacked and centred, suggested on top
//   AdwAlertDialog responses side by side at equal width, the suggested one last; stacked when narrow
//   opaque         every surface is opaque (no compositor effect is assumed)
//
// Everything here is read only when the window's variant is Gnome; the other variants keep the
// kit's own measures. UK-10.5 (Windows) and UK-10.7 (macOS) add their own files beside this one.

package im.plrs.key.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
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

    /** The widest the stacked pills of a message screen grow. */
    val statusActionWidth: Dp = 320.dp

    /** The dimming behind a dialog: the generated tokens' dark and light scrim opacities. */
    fun scrimAlpha(dark: Boolean): Float =
        if (dark) im.plrs.key.ui.brand.PolarisKitTokens.Gnome.scrimDarkOpacity else im.plrs.key.ui.brand.PolarisKitTokens.Gnome.scrimLightOpacity
}

internal val PolarisWindow.isGnome: Boolean get() = variant == PolarisPlatformVariant.Gnome

/**
 * The shape of a kit button in this window: GNOME draws the suggested action as a pill and every
 * other button at radius 8; the other variants keep the theme's shape.
 */
@Composable
internal fun polarisActionShape(suggested: Boolean): Shape =
    if (polarisWindow.isGnome) {
        if (suggested) CircleShape else polarisRadiusShape(PolarisGnome.controlRadius)
    } else {
        PolarisTheme.buttonShape
    }

/** The padding inside a button: GNOME's 34 px control is its height, so the label adds no vertical padding. */
@Composable
internal fun polarisButtonPadding(): PaddingValues =
    if (polarisWindow.isGnome) PaddingValues(horizontal = 20.dp, vertical = 0.dp) else PaddingValues(horizontal = 24.dp, vertical = 12.dp)

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
internal class PolarisAlertResponse(val label: String, val onClick: () -> Unit, val suggested: Boolean = false)

/**
 * An AdwAlertDialog's card: [title], [body], then the [responses] side by side at equal width with
 * the suggested one last. When they do not fit in the card they stack at full width, the suggested
 * one on top (libadwaita's order). The card is opaque, radius 12.
 */
@Composable
internal fun PolarisAlertCard(title: String, body: String?, responses: List<PolarisAlertResponse>, modifier: Modifier = Modifier) {
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
                for (r in responses) {
                    if (r.suggested) PolarisPrimaryButton(r.label, r.onClick) else PolarisSecondaryButton(r.label, r.onClick)
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
internal fun PolarisReplaceAlert(device: String, thisDevice: String, product: String, onReplace: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val catalog = KitCopy.bundled
    val locale = kitLocale()
    val named = mapOf("device" to CopyArgument.Text(device))
    PolarisAlertCard(
        title = catalog.format("signin.replace.title", locale, named),
        body = catalog.format("signin.replace.consequence", locale, named + mapOf("product" to CopyArgument.Text(product), "thisDevice" to CopyArgument.Text(thisDevice))),
        responses = listOf(
            PolarisAlertResponse(catalog.format("signin.replace.back", locale), onBack),
            PolarisAlertResponse(catalog.format("signin.replace.confirmNamed", locale, named), onReplace, suggested = true),
        ),
        modifier = modifier,
    )
}

/** The Replace alert centred over a dimmed host, as the sign-in sheet places an AdwAlertDialog. */
@Composable
internal fun PolarisReplaceAlertOverlay(device: String, thisDevice: String, product: String, onReplace: () -> Unit, onBack: () -> Unit) {
    // Like the update dialog, the overlay measures its own window: it sits over the host, not inside its surface.
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize().polarisGnomeScrim(), contentAlignment = Alignment.Center) {
        val window = PolarisWindow(maxWidth, maxHeight, isTelevision())
        CompositionLocalProvider(LocalPolarisWindow provides window) {
            PolarisReplaceAlert(device, thisDevice, product, onReplace, onBack, Modifier.padding(PolarisGnome.margin))
        }
    }
}
