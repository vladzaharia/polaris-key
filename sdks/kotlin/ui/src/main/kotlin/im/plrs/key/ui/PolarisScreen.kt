// The scaffold every kit screen shares, so no screen can drift out of alignment: a full-screen
// surface in the theme's background, the safe-drawing insets (status and navigation bars, display
// cutouts and the IME) applied once, and a layout chosen from the window (PolarisLayout.kt):
//
//   - a phone or a foldable: one centred column, at most 480 dp wide, that scrolls rather than
//     clipping when the font scale leaves too little height;
//   - a tablet or a desktop: the same column, wider, with the title a role up and (on a large
//     window) every text at 1.125x;
//   - a short window (a phone in landscape) or Android TV: two panes when the screen has
//     controls, the content start-aligned on the start side and the controls on the end side,
//     so the primary action never falls below the fold.
//
// The logo (when the theme has one) sits on top and the "Powered by" badge (when enabled) at the
// foot. Plus the building blocks the screens compose: the message screen, the primary and
// secondary buttons (48 dp minimum touch targets, the theme's control shape), the filled text
// field and the section card.

package im.plrs.key.ui

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions

/** The widest a kit screen's column grows: comfortable reading on a tablet, full width on a phone. */
public val PolarisMaxContentWidth: Dp = 480.dp

/** The minimum touch target of every kit control (Material and Android accessibility guidance). */
public val PolarisMinTouchTarget: Dp = 48.dp

/** The widest the two panes grow together (a landscape phone, a TV). */
internal val PolarisTwoPaneMaxWidth: Dp = 1040.dp

/**
 * A full-screen kit scaffold: background, insets, the theme's logo on top, the optional "Powered
 * by" badge at the foot, and a layout chosen from the window (see PolarisLayout.kt).
 *
 * In a tall window [content] and then [actions] stack in one centred scrolling column. In a short
 * one (under 480 dp, a phone in landscape) and on Android TV they sit side by side: [content]
 * start-aligned on the start side, [actions] on the end side, so the controls never fall below
 * the fold. A screen without [actions] is always one column.
 *
 * @param showLogo shows the theme's logo (the host's, or the Pinned K branded) above [content].
 * @param maxContentWidth caps the single column; unspecified (the default) follows the window:
 *   480 dp on a phone, 520 on a tablet, 600 on a large window.
 * @param actions the screen's controls: under [content] in a tall window, beside it in a short
 *   one. Each screen spaces its own controls.
 */
@Composable
public fun PolarisScreen(
    modifier: Modifier = Modifier,
    showLogo: Boolean = true,
    maxContentWidth: Dp = Dp.Unspecified,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val theme = PolarisTheme.current
    val tv = isTelevision()
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            val window = PolarisWindow(maxWidth, maxHeight, tv)
            val twoPane = actions != null && window.twoPane
            val density = LocalDensity.current
            // A large window scales every text in the screen; elsewhere the platform's own
            // (possibly non-linear) font scaling stays untouched.
            val scaled = if (window.textScale == 1f) density else Density(density.density, density.fontScale * window.textScale)
            CompositionLocalProvider(
                LocalPolarisWindow provides window,
                LocalPolarisTextAlign provides if (twoPane) TextAlign.Start else TextAlign.Center,
                LocalDensity provides scaled,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .heightIn(min = maxHeight)
                        .padding(horizontal = 24.dp, vertical = window.verticalPadding),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    val logo = theme.logo?.takeIf { showLogo }
                    if (twoPane && actions != null) {
                        Row(
                            modifier = Modifier.widthIn(max = PolarisTwoPaneMaxWidth).fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(window.section * 2),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1.25f), horizontalAlignment = Alignment.Start) {
                                if (logo != null) {
                                    logo()
                                    Spacer(Modifier.height(window.section))
                                }
                                content()
                            }
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, content = actions)
                        }
                    } else {
                        val width = if (maxContentWidth == Dp.Unspecified) window.columnWidth else maxContentWidth
                        Column(
                            modifier = Modifier.widthIn(max = width).fillMaxWidth(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            if (logo != null) {
                                logo()
                                Spacer(Modifier.height(window.section))
                            }
                            content()
                            if (actions != null) {
                                Spacer(Modifier.height(window.section))
                                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, content = actions)
                            }
                        }
                    }
                    if (theme.showPoweredBy) {
                        Spacer(Modifier.height(40.dp))
                        PolarisPoweredByBadge()
                    }
                }
            }
        }
    }
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

/** The glyph colour of a message kind's icon badge: the status colour on its container. */
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
            Icon(icon, contentDescription = null, modifier = Modifier.size(32.dp))
        }
    }
}

/**
 * A screen title: a TalkBack heading, centred in a column and start-aligned in a content pane.
 * It steps up a role as the window grows (headline small on a phone, medium on a tablet, large on
 * a large window), so it always ranks clearly above the body.
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

/**
 * Secondary copy under a title: centred in a column, start-aligned in a content pane. Its lines
 * are balanced, so a lede never ends on one orphan word (UI-KITS.md §1.5 rule 11).
 */
@Composable
public fun PolarisBody(text: String, modifier: Modifier = Modifier, textAlign: TextAlign = LocalPolarisTextAlign.current) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge.copy(lineBreak = LineBreak.Heading),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = textAlign,
        modifier = modifier.fillMaxWidth(),
    )
}

/** The primary action: full width, 48 dp tall at least, the theme's control shape. */
@Composable
public fun PolarisPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = PolarisTheme.buttonShape,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = PolarisMinTouchTarget),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = LocalContentColor.current,
            )
            Spacer(Modifier.size(ButtonDefaults.IconSpacing))
        }
        Text(text, textAlign = TextAlign.Center)
    }
}

/** A secondary action: an outlined, full-width button. */
@Composable
public fun PolarisSecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = PolarisTheme.buttonShape,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PolarisTheme.accentText),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = PolarisMinTouchTarget),
    ) { Text(text, textAlign = TextAlign.Center) }
}

/** A tertiary action: a text button with a 48 dp touch target. */
@Composable
public fun PolarisTextButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = PolarisTheme.buttonShape,
        colors = ButtonDefaults.textButtonColors(contentColor = PolarisTheme.accentText),
        modifier = modifier.heightIn(min = PolarisMinTouchTarget),
    ) { Text(text, textAlign = TextAlign.Center) }
}

/**
 * A full-screen message: icon badge, title, body and actions, centred in a [PolarisScreen]. The
 * screen every terminal gate state and boot stop uses.
 */
@Composable
public fun PolarisMessageScreen(
    message: PolarisMessageCopy,
    modifier: Modifier = Modifier,
    actions: @Composable ColumnScope.() -> Unit = {},
) {
    // The icon badge is the screen's emblem, so the logo stays off here.
    PolarisScreen(
        modifier = modifier,
        showLogo = false,
        actions = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(PolarisSpace.controls),
                content = actions,
            )
        },
    ) {
        PolarisIconBadge(message.kind.icon(), message.kind.tint().first, message.kind.glyph())
        Spacer(Modifier.height(polarisWindow.section))
        PolarisTitle(message.title)
        Spacer(Modifier.height(PolarisSpace.tight))
        PolarisBody(message.body)
    }
}

/**
 * The kit's text field: the Material 3 filled field (UI-KITS.md §1.5 rule 1; never the outlined
 * or notched one), single line, label inside. Neutral it is the host's stock filled field;
 * branded it takes the brand field shape with the resting indicator removed, and the focused
 * indicator (2 dp, the accent) stays. [error] shows under the field, announced, as Material's
 * supporting text would.
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
            modifier = Modifier.fillMaxWidth().then(if (branded) Modifier.clip(shape) else Modifier),
        )
        if (error != null) {
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall.copy(lineBreak = LineBreak.Heading),
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
            CircularProgressIndicator(modifier = Modifier.size(40.dp), trackColor = track)
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
