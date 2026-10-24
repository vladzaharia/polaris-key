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

package im.plrs.key.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import im.plrs.key.ui.brand.KitTypeRole
import im.plrs.key.ui.brand.PolarisKitTokens
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** The macOS variant. */
internal val PolarisWindow.isMac: Boolean get() = variant == PolarisPlatformVariant.MacOS

/**
 * A host or test pin of the facts the Mac chrome reads (Increase Contrast); null reads the desktop.
 * Mac-private on purpose: the integration repoints [rememberMacHostFacts] at the shared host-facts seam.
 */
internal val LocalPolarisMacHostFacts = staticCompositionLocalOf<PolarisHostFacts?> { null }

/** The desktop's host facts for the Mac chrome: `rememberPolarisHostFacts()` on the desktop, the defaults on Android. */
@Composable
internal expect fun rememberMacDesktopFacts(): PolarisHostFacts

/** The host facts the Mac chrome reads: a pinned value, else the desktop's reads. */
@Composable
internal fun rememberMacHostFacts(): PolarisHostFacts = LocalPolarisMacHostFacts.current ?: rememberMacDesktopFacts()

/**
 * The dialog properties of a prompt window. The Mac sheet dims nothing, so it asks the desktop's
 * `Dialog` for a transparent scrim (Compose Multiplatform draws its own 60 % black one otherwise).
 */
internal expect fun polarisPromptDialogProperties(dismissible: Boolean, scrim: Boolean): androidx.compose.ui.window.DialogProperties

/** The macOS measures (UI-KITS.md §1.4 macOS 26; `PolarisKitTokens.MacOS`). */
internal object PolarisMac {
    /** The control height: 28 pt (`.controlSize(.large)`). */
    val controlHeight: Dp = PolarisKitTokens.MacOS.controlHeight.dp

    /** The sheet's corner radius: the brand's token, 18 (K4; §1.4 says "about 24"). */
    val sheetRadius: Dp = PolarisKitTokens.MacOS.radiusSheet.dp

    /** The sheet floats this far below the window's top edge (the title-bar row). */
    val sheetTop: Dp = 52.dp

    /** About 440 pt wide. */
    val sheetWidth: Dp = 440.dp

    /** The smallest window the kit lays out for. */
    val floorWidth: Dp = 480.dp
    val floorHeight: Dp = 520.dp

    /** Buttons are 28 pt tall: the label sits at the control's own height, so no vertical padding. */
    val buttonPadding: PaddingValues = PaddingValues(horizontal = 14.dp, vertical = 0.dp)

    /** The gap between the buttons of a trailing row. */
    val rowGap: Dp = 8.dp
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

/**
 * The Mac sheet: an opaque panel (the glass material is not available to Compose), inset below the
 * title-bar row, centred, 440 dp wide, rounded on every side, with a soft shadow. It dims nothing:
 * [content] is the whole of it, and the parent stays as it was.
 */
@Composable
internal fun PolarisMacSheet(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(top = PolarisMac.sheetTop), contentAlignment = Alignment.TopCenter) {
        Surface(
            modifier = modifier.widthIn(max = PolarisMac.sheetWidth),
            shape = polarisMacSheetShape,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            shadowElevation = 12.dp,
            border = polarisMacSheetBorder(),
            content = content,
        )
    }
}

/** The 480 x 520 floor: the content is never laid out smaller (the window clips what does not fit). */
internal fun Modifier.polarisMacFloor(): Modifier =
    if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) {
        fillMaxSize().requiredSizeIn(minWidth = PolarisMac.floorWidth, minHeight = PolarisMac.floorHeight)
    } else {
        fillMaxSize()
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

/** The catalog's English `macos` variants, as (base text -> variant), for lines every key of which agrees. */
private val macVariantByBaseText: Map<String, String> by lazy {
    val source = PolarisCopy::class.java.getResourceAsStream("/kit-copy.json") ?: return@lazy emptyMap()
    val root = runCatching { Json.parseToJsonElement(source.bufferedReader().use { it.readText() }) as? JsonObject }.getOrNull() ?: return@lazy emptyMap()
    val en = root["tables"]?.jsonObject?.get("en")?.jsonObject ?: return@lazy emptyMap()
    val variants = root["variants"]?.jsonObject ?: return@lazy emptyMap()
    val seen = HashMap<String, String?>()
    for ((key, perPlatform) in variants) {
        val variant = (perPlatform as? JsonObject)?.get("macos")?.let { (it as? JsonPrimitive)?.content } ?: continue
        val base = (en[key] as? JsonPrimitive)?.content ?: continue
        if (base == variant) continue
        // Two keys with the same text and different variants: neither can be told apart by text.
        seen[base] = if (seen.containsKey(base) && seen[base] != variant) null else variant
    }
    seen.mapNotNull { (base, variant) -> variant?.let { base to it } }.toMap()
}

/**
 * [this] copy with every line that still reads its catalog English text switched to the catalog's
 * `macos` variant ("Remind Me Later", "Install and Relaunch"). A line the host overrode, or a
 * translation, is not the field's English default and stays as it is.
 */
internal fun PolarisCopy.forMac(): PolarisCopy {
    val defaults = PolarisCopy().asMap()
    val swaps = asMap().mapNotNull { (field, text) ->
        if (text != defaults[field]) null else macVariantByBaseText[text]?.let { field to it }
    }.toMap()
    return with(swaps)
}

/** The copy variant of this host's chrome: `macos` on macOS, none elsewhere. */
@Composable
internal fun polarisCopyVariant(): CopyVariant? = remember { if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) CopyVariant.macos else null }
