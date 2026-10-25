// The macOS chrome of the Compose desktop kit (UK-10.7): everything the MacOS variant draws that the
// others do not, in one file so it merges beside the Windows (UK-10.5) and GNOME (UK-10.6) chromes.
//
//   - Mac scale: 13 / 22 / 26 pt type (PolarisKitTokens.MacOS.Typography) and 28 pt controls.
//   - The sheet: a kit-drawn inset panel below the title-bar row (52 dp down), rounded on every side
//     (the brand's sheet token, 18; K4), 440 dp wide, with no dimming behind it.
//   - Copy: button, menu and window-title lines read their `macos` variant (title case).
//   - Increase Contrast (PolarisHostFacts.highContrast): hairlines and separators at full contrast.
//   - A 480 x 520 floor: the layout is never smaller than the smallest Mac sheet window.
//
// Each rule is a small branch at its call site (`isMac`); the measures live here.
//
// Window contracts for UK-10.8 (PolarisKeyWindow), recorded here because the kit relies on them:
//   - S6: the sheet floats 52 dp down only when the host window extends its content under the title
//     bar (a full-size content view); the host says so with LocalPolarisMacFullSizeContent. In a plain
//     window the title bar is already above the content, so the sheet floats ~12 dp down.
//   - S7: the window's minimumSize is 480 x 520 dp. Embedded in a smaller host the layout keeps that
//     floor and scrolls (never clips): polarisMacFloor.
//   - S3: the update sheet is window-modal: a click outside does not dismiss it; Escape is "Remind Me Later".

package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.plrs.key.ui.brand.KitTypeRole
import im.plrs.key.ui.brand.PolarisKitTokens

/** The macOS variant. */
internal val PolarisWindow.isMac: Boolean get() = variant == PolarisPlatformVariant.MacOS

/** The host facts the Mac chrome reads: the shared seam's (a pinned value, else the desktop's one read), the defaults on Android. */
@Composable
internal fun rememberMacHostFacts(): PolarisHostFacts = rememberThemeHostFacts() ?: PolarisHostFacts()

/** The macOS measures (UI-KITS.md §1.4 macOS 26; `PolarisKitTokens.MacOS`). */
internal object PolarisMac {
    /** The control height: 28 pt (`.controlSize(.large)`). */
    val controlHeight: Dp = PolarisKitTokens.MacOS.controlHeight.dp

    /** The sheet's corner radius: the brand's token, 18 (K4; §1.4 says "about 24"). */
    val sheetRadius: Dp = PolarisKitTokens.MacOS.radiusSheet.dp

    /** The sheet floats this far below the window's top edge under a full-size content view (the title-bar row). */
    val sheetTop: Dp = 52.dp

    /** In a plain window the title bar is above the content: the sheet floats just below it. */
    val sheetTopPlain: Dp = 12.dp

    /** About 440 pt wide. */
    val sheetWidth: Dp = 440.dp

    /** The smallest window the kit lays out for. */
    val floorWidth: Dp = 480.dp
    val floorHeight: Dp = 520.dp

    /** Buttons are 28 pt tall: the label sits at the control's own height, so no vertical padding. */
    val buttonPadding: PaddingValues = PaddingValues(horizontal = 14.dp, vertical = 0.dp)

    /** The gap between the buttons of a trailing row. */
    val rowGap: Dp = 8.dp

    /** The key field's label gap and insets. */
    val labelGap: Dp = 4.dp
    val fieldInset: Dp = 10.dp
    val fieldInsetTrailing: Dp = 2.dp
    val fieldPadding: Dp = 6.dp

    /** The Welcome's hero buttons: 36 pt tall, at most 320 wide (S5). */
    val heroButtonHeight: Dp = 36.dp
    val heroButtonMaxWidth: Dp = 320.dp
}

/** True while the Welcome's hero buttons are composed: they are 36 pt, not 28 (S5). */
internal val LocalPolarisMacHero = staticCompositionLocalOf { false }

/** The Welcome's title on the Mac: the display role (26 pt), a heading, as the host's start alignment says. */
@Composable
internal fun PolarisMacWelcomeTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.headlineLarge.copy(lineBreak = LineBreak.Heading),
        color = MaterialTheme.colorScheme.onSurface,
        textAlign = LocalPolarisTextAlign.current,
        modifier = Modifier.fillMaxWidth().semantics { heading() },
    )
}

/** The sheet's shape: rounded on every side. */
internal val polarisMacSheetShape: Shape get() = polarisRadiusShape(PolarisMac.sheetRadius)

/** The sheet's hairline: 0.5 dp, 1 dp and full contrast under Increase Contrast. */
@Composable
internal fun polarisMacSheetBorder(): BorderStroke {
    val contrast = rememberMacHostFacts().highContrast
    val scheme = MaterialTheme.colorScheme
    return if (contrast) BorderStroke(1.dp, scheme.onSurface) else BorderStroke(0.5.dp, scheme.outlineVariant)
}

/** Whether the host window extends its content under the title bar (S6); the default is a plain window. */
internal val LocalPolarisMacFullSizeContent = staticCompositionLocalOf { false }

/** How far the sheet floats below the content's top edge: 52 dp under a full-size content view, else ~12 dp. */
@Composable
internal fun polarisMacSheetTop(): Dp = if (LocalPolarisMacFullSizeContent.current) PolarisMac.sheetTop else PolarisMac.sheetTopPlain

/** The sheet's fill: the raised layer in dark (so it lifts off the page it floats over), the sheet layer in light (B3). */
@Composable
internal fun polarisMacSheetColor(): Color =
    MaterialTheme.colorScheme.let { if (PolarisTheme.current.dark) it.surfaceContainerHigh else it.surfaceContainerLow }

/** Dark sheets get a 0.5 dp white 10 % highlight just inside the edge, as AppKit's do (B3). */
internal fun Modifier.polarisMacInnerHighlight(dark: Boolean, radius: Dp = PolarisMac.sheetRadius): Modifier =
    if (!dark) {
        this
    } else {
        drawWithContent {
            drawContent()
            val w = 0.5.dp.toPx()
            val inset = w * 1.5f
            drawRoundRect(
                color = Color.White.copy(alpha = 0.10f), // polaris-lint: allow-colour (the AppKit sheet's inner highlight)
                topLeft = Offset(inset, inset),
                size = Size(size.width - inset * 2, size.height - inset * 2),
                cornerRadius = CornerRadius((radius.toPx() - inset).coerceAtLeast(0f)),
                style = Stroke(w),
            )
        }
    }

/**
 * A bezel for a control: Increase Contrast draws a 1 dp onSurface border on buttons and fields (S8);
 * otherwise [rest] (a 0.5 dp hairline on a secondary button, null on a filled one).
 */
@Composable
internal fun polarisMacControlBorder(rest: BorderStroke? = null): BorderStroke? =
    if (rememberMacHostFacts().highContrast) BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface) else rest

/** The secondary button's bezel hairline (S8): 0.5 dp, strong enough to see on the sheet in both schemes. */
@Composable
internal fun polarisMacBezel(): BorderStroke? =
    polarisMacControlBorder(BorderStroke(0.5.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.28f)))

/** The secondary button's fill: a raised bezel face, so it stays visible on the sheet (B3, S8). */
@Composable
internal fun polarisMacSecondaryColors(): ButtonColors {
    val scheme = MaterialTheme.colorScheme
    val face = if (PolarisTheme.current.dark) scheme.onSurface.copy(alpha = 0.12f).compositeOver(polarisMacSheetColor()) else scheme.surfaceContainerLowest
    return ButtonDefaults.filledTonalButtonColors(containerColor = face, contentColor = scheme.onSurface, disabledContainerColor = face)
}

/**
 * The Mac window floor: the content is never laid out smaller than 480 x 520. A host smaller than that
 * (an embedded one) scrolls the floor-sized content; it never clips (S7).
 */
@Composable
internal fun PolarisMacFloor(content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = maxOf(maxWidth, PolarisMac.floorWidth)
        val h = maxOf(maxHeight, PolarisMac.floorHeight)
        val scrolls = w > maxWidth || h > maxHeight
        Box(
            Modifier.fillMaxSize()
                .then(if (scrolls) Modifier.horizontalScroll(rememberScrollState()).verticalScroll(rememberScrollState()) else Modifier),
        ) {
            Box(Modifier.size(w, h)) { content() }
        }
    }
}

/**
 * Return fires the default action and Escape the cancel (S2/S3): a key handler for the window's
 * content. Either may be null (no default while busy, no cancel on a mandatory prompt).
 */
internal fun Modifier.polarisMacDefaultKeys(onDefault: (() -> Unit)?, onCancel: (() -> Unit)? = null): Modifier =
    onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) {
            false
        } else if ((event.key == Key.Enter || event.key == Key.NumPadEnter) && onDefault != null) {
            onDefault()
            true
        } else if (event.key == Key.Escape && onCancel != null) {
            onCancel()
            true
        } else {
            false
        }
    }

/**
 * The Mac key field (B2): the label above, a white (light) or raised (dark) fill, a 1 dp boundary at
 * least 3:1 against what it sits on (the focused one 2 dp in the accent; Increase Contrast 1 dp
 * onSurface), the key in monospace, the paste control inside at the end.
 */
@Composable
internal fun PolarisMacTextField(
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
    monospace: Boolean,
) {
    val scheme = MaterialTheme.colorScheme
    val dark = PolarisTheme.current.dark
    val shape = PolarisTheme.fieldShape
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val contrast = rememberMacHostFacts().highContrast
    val boundary = when {
        isError -> BorderStroke(1.dp, scheme.error)
        focused -> BorderStroke(2.dp, PolarisTheme.focusColor)
        contrast -> BorderStroke(1.dp, scheme.onSurface)
        else -> BorderStroke(1.dp, scheme.onSurface.copy(alpha = POLARIS_MAC_BOUNDARY_ALPHA))
    }
    val textStyle = MaterialTheme.typography.bodyLarge.copy(
        color = if (enabled) scheme.onSurface else scheme.onSurface.copy(alpha = 0.5f),
        fontFamily = if (monospace) FontFamily.Monospace else MaterialTheme.typography.bodyLarge.fontFamily,
    )
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, modifier = Modifier.padding(bottom = PolarisMac.labelGap))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = textStyle,
            cursorBrush = SolidColor(scheme.onSurface),
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            interactionSource = interaction,
            modifier = Modifier.fillMaxWidth()
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .semantics { contentDescription = label },
            decorationBox = { inner ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 36.dp)
                        .background(if (dark) scheme.surfaceContainerHighest else scheme.surfaceContainerLowest, shape)
                        .border(boundary, shape)
                        .padding(start = PolarisMac.fieldInset, end = if (trailing != null) PolarisMac.fieldInsetTrailing else PolarisMac.fieldInset),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f).padding(vertical = PolarisMac.fieldPadding)) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = textStyle.copy(color = scheme.onSurfaceVariant))
                        }
                        inner()
                    }
                    trailing?.invoke()
                }
            },
        )
    }
}

/** The key field's resting boundary: onSurface at 55 % is at least 3:1 on white and on the dark sheet (B2, WCAG 1.4.11). */
internal const val POLARIS_MAC_BOUNDARY_ALPHA: Float = 0.55f

/** A text button's own 12 dp of horizontal padding: the leading link's label sits on the content edge, its target extends past it. */
private val LEAD_TEXT_INSET: Dp = 12.dp

/**
 * A trailing action row whose children are emitted in visual left-to-right order (Cancel first, the
 * default last), so Tab runs left to right. When [leading] is true the first child is a leading link
 * (Skip): it takes the row's start edge when everything fits, else it sits leading under the row.
 */
@Composable
internal fun PolarisMacActionRow(leading: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content = content, modifier = modifier.fillMaxWidth()) { measurables, constraints ->
        val gap = PolarisMac.rowGap.roundToPx()
        val minWidth = 96.dp.roundToPx()
        val max = constraints.maxWidth
        val lead = if (leading) measurables.firstOrNull() else null
        val rest = if (leading) measurables.drop(1) else measurables
        val restWidths = rest.map { it.maxIntrinsicWidth(Constraints.Infinity).coerceAtLeast(minWidth) }
        val leadWidth = lead?.maxIntrinsicWidth(Constraints.Infinity) ?: 0
        val restTotal = restWidths.sum() + gap * (rest.size - 1).coerceAtLeast(0)
        val fitsOneRow = leadWidth + (if (lead != null && rest.isNotEmpty()) gap else 0) + restTotal <= max
        val height = rest.zip(restWidths).maxOfOrNull { (m, w) -> m.minIntrinsicHeight(w) } ?: 0
        val buttons = rest.zip(restWidths).map { (m, w) -> m.measure(Constraints.fixed(w, height)) }
        val leadPlaceable = lead?.measure(Constraints(maxWidth = max))
        if (fitsOneRow || leadPlaceable == null) {
            val rowHeight = maxOf(height, leadPlaceable?.height ?: 0)
            layout(max, rowHeight) {
                leadPlaceable?.placeRelative(-LEAD_TEXT_INSET.roundToPx(), (rowHeight - leadPlaceable.height) / 2)
                var x = max - restTotal
                for (p in buttons) {
                    p.placeRelative(x, (rowHeight - p.height) / 2)
                    x += p.width + gap
                }
            }
        } else {
            val total = height + gap + leadPlaceable.height
            layout(max, total) {
                // Placed first, as it is composed first, so the reading order stays Skip, Cancel, default.
                leadPlaceable.placeRelative(-LEAD_TEXT_INSET.roundToPx(), height + gap)
                var x = max - restTotal
                for (p in buttons) {
                    p.placeRelative(x, 0)
                    x += p.width + gap
                }
            }
        }
    }
}

/** [this] type scale at Mac scale: 13 pt body and labels, 22 pt titles, 26 pt for the Welcome and display roles. */
internal fun Typography.forMacScale(): Typography {
    val t = PolarisKitTokens.MacOS.Typography
    fun TextStyle.at(role: KitTypeRole) = copy(fontSize = role.size.sp, lineHeight = role.lineHeight.sp)
    return copy(
        displayLarge = displayLarge.at(t.display), displayMedium = displayMedium.at(t.display), displaySmall = displaySmall.at(t.display),
        headlineLarge = headlineLarge.at(t.display), headlineMedium = headlineMedium.at(t.title), headlineSmall = headlineSmall.at(t.title),
        titleLarge = titleLarge.at(t.title), titleMedium = titleMedium.at(t.label), titleSmall = titleSmall.at(t.label),
        bodyLarge = bodyLarge.at(t.body), bodyMedium = bodyMedium.at(t.body), bodySmall = bodySmall.at(t.meta),
        labelLarge = labelLarge.at(t.button), labelMedium = labelMedium.at(t.meta), labelSmall = labelSmall.at(t.meta),
    )
}

/** Increase Contrast: the hairlines and separators (outline, outline variant) at the text colour. */
internal fun ColorScheme.withMacContrast(): ColorScheme = copy(outline = onSurface, outlineVariant = onSurface)

// ── Copy: the macOS variants ────────────────────────────────────────────────────────────────────

/**
 * The PolarisCopy fields that are a button, a menu item or a window title, by catalog key (S4). Only
 * these read the catalog's `macos` variant: a heading or a sentence keeps its sentence case, even
 * when a button elsewhere shares its words (the device-limit heading "Replace a device" is not the
 * "Replace a Device" button).
 */
private val macCopyFieldKeys: Map<String, String> = mapOf(
    "consentLater" to "common.notNow",
    "retry" to "common.tryAgain",
    "playOffline" to "boot.continueOffline",
    "useAnotherLicense" to "status.useAnotherLicense",
    "signIn" to "welcome.signIn",
    "useKey" to "welcome.useKey",
    "activate" to "activate.submit",
    "openInBrowser" to "deviceLimit.openBrowser",
    "signInCopyLink" to "signin.handoff.copyLink",
    "signInUseKey" to "signin.choice.keyInstead",
    "signInOpenBrowser" to "signin.handoff.openBrowser",
    "signInNewCode" to "signInHandoff.newCode",
    "updateNow" to "update.install",
    "updateLater" to "update.later",
    "updateRestartNow" to "update.restartNow",
    "updateAllChanges" to "update.allChanges",
    "updateSkip" to "update.skipVersion",
    "updateSteam" to "update.steam",
)

/** Whether the catalog key [key] is a button, menu item or window title, the roles that read a `macos` variant. */
internal fun isMacVariantRole(key: String): Boolean =
    kitLineRole(key) == KitLineRole.Control || key.startsWith("menu.") || key.startsWith("signin.menu.") || key in macWindowTitleKeys

/** Catalog keys that title a window or menu command rather than head a screen. */
private val macWindowTitleKeys = setOf("common.activateLicense")

/** The `macos` variant of [key] as a PolarisCopy template (`{version}` becomes `%1$s` in order of appearance), or null when there is none. */
private fun macVariantTemplate(key: String): String? {
    val catalog = KitCopy.bundled
    val base = catalog.message(key, "en", null) ?: return null
    val variant = catalog.message(key, "en", CopyVariant.macos) ?: return null
    if (variant == base) return null
    val order = Regex("""\{(\w+)\}""").findAll(base).map { it.groupValues[1] }.distinct().toList()
    return Regex("""\{(\w+)\}""").replace(variant) { m -> "%" + (order.indexOf(m.groupValues[1]) + 1) + "\$s" }
}

/**
 * [this] copy with every button, menu and window-title line that still reads its English default
 * switched to the catalog's `macos` variant, found by catalog key ("Remind Me Later", "Install and
 * Relaunch", "All Changes in %1$s"). A line the host overrode, a translation, or a heading stays as it is.
 */
internal fun PolarisCopy.forMac(): PolarisCopy {
    val defaults = PolarisCopy().asMap()
    val current = asMap()
    val swaps = macCopyFieldKeys.mapNotNull { (field, key) ->
        if (current[field] != defaults[field]) null else macVariantTemplate(key)?.let { field to it }
    }.toMap()
    // UK-10.15 #12: the catalog's macos variant of update.restartWhenReady reads "Install and Relaunch", the verb the
    // primary had before the download: while downloading it must say what the button does. Title case, in code,
    // until the catalog's variant is fixed.
    val untouched = current["updateRestartWhenReady"] == defaults["updateRestartWhenReady"]
    val restart = if (untouched) mapOf("updateRestartWhenReady" to "Restart When Ready") else emptyMap()
    return with(swaps + restart)
}

/** The copy variant of this host's chrome: `macos` on macOS, none elsewhere. */
@Composable
internal fun polarisCopyVariant(): CopyVariant? = remember { if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) CopyVariant.macos else null }
