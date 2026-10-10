// The product's presentation in the kit (plans/HA-13.md §3, Kotlin row; UI-KITS.md §1.2, §3.3).
//
// PolarisTheme reads the SDK's `PresentationSource` (`client.presentationSource`; the kit never
// fetches discovery or the icon itself) and fills only what the integrator left out:
//
//   logo     the integrator's, else the verified presentation icon, else today's monogram tile
//   accent   the integrator's, else (branded) the product's `accent` (`accentDark` on a dark
//            ground), else the colour derived from the icon (PolarisAccent.derive), else today's
//            primary. Neutral (PolarisBranding.None, the native preset) keeps the host's own
//            primary: `host` in the theme rows' accentSource.
//
// The icon is decoded with its bounds read first and sampled down to the hero (at most
// PRESENTATION_ICON_MAX_DIMENSION a side), so a 10 MiB file can never inflate to gigabytes. A
// failed fetch, hash or decode leaves the monogram, never an error.

package im.plrs.key.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import im.plrs.key.core.PRESENTATION_ICON_MAX_DIMENSION
import im.plrs.key.core.Presentation
import im.plrs.key.core.PresentationSource
import im.plrs.key.ui.brand.PolarisAccent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The largest the kit draws the product icon (the welcome's hero), in dp. */
internal const val PRESENTATION_HERO_DP: Int = 120

/** The decoded presentation icon and the accent derived from it. */
internal class PresentationArt(val bitmap: ImageBitmap, val derivedAccent: String?)

/** The source's member, kept current through `subscribe`. */
@Composable
internal fun rememberPresentation(source: PresentationSource?): Presentation? {
    var member by remember(source) { mutableStateOf(runCatching { source?.current() }.getOrNull()) }
    DisposableEffect(source) {
        val off = runCatching { source?.subscribe { member = it } }.getOrNull()
        member = runCatching { source?.current() }.getOrNull()
        onDispose { off?.invoke() }
    }
    return member
}

/** The member's icon, fetched through the source for the hero at this density and decoded; null until then. */
@Composable
internal fun rememberPresentationArt(source: PresentationSource?, member: Presentation?): PresentationArt? {
    val density = LocalDensity.current.density
    val icon = member?.icon
    var art by remember(source, icon) { mutableStateOf<PresentationArt?>(null) }
    LaunchedEffect(source, icon, density) {
        if (source == null || icon == null) return@LaunchedEffect
        val bytes = try {
            source.icon(PRESENTATION_HERO_DP.toDouble(), density.toDouble())
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return@LaunchedEffect
        art = withContext(Dispatchers.Default) { decodePresentationArt(bytes, (PRESENTATION_HERO_DP * density).toInt()) }
    }
    return art
}

/**
 * Verified icon bytes as a bitmap sampled down to about [targetPx], and its derived accent; null when
 * the bytes are no image this platform decodes or their header declares a side over
 * PRESENTATION_ICON_MAX_DIMENSION.
 */
internal fun decodePresentationArt(bytes: ByteArray, targetPx: Int): PresentationArt? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val w = bounds.outWidth
    val h = bounds.outHeight
    if (w < 1 || h < 1 || w > PRESENTATION_ICON_MAX_DIMENSION || h > PRESENTATION_ICON_MAX_DIMENSION) return null
    var sample = 1
    val target = targetPx.coerceAtLeast(1)
    while (w / (sample * 2) >= target && h / (sample * 2) >= target) sample *= 2
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    return PresentationArt(bitmap.asImageBitmap(), deriveAccent(bitmap))
}

/** PolarisAccent.derive over a 32 × 32 thumbnail's RGBA bytes. */
private fun deriveAccent(bitmap: Bitmap): String? {
    val thumb = Bitmap.createScaledBitmap(bitmap, 32, 32, true)
    val argb = IntArray(32 * 32)
    thumb.getPixels(argb, 0, 32, 0, 0, 32, 32)
    val rgba = ByteArray(argb.size * 4)
    for ((i, p) in argb.withIndex()) {
        rgba[i * 4] = (p shr 16 and 0xFF).toByte()
        rgba[i * 4 + 1] = (p shr 8 and 0xFF).toByte()
        rgba[i * 4 + 2] = (p and 0xFF).toByte()
        rgba[i * 4 + 3] = (p ushr 24).toByte()
    }
    return PolarisAccent.derive(rgba)
}

/** The presentation icon as the theme's logo: decorative, the product name is beside it. */
internal fun presentationLogo(art: PresentationArt): @Composable () -> Unit = {
    Image(bitmap = art.bitmap, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
}

/**
 * The accent the theme resolves (UI-KITS.md §3.3's order): the integrator's [integrator], else, when
 * branded, the presentation's accent for [dark] grounds, else the icon's [derived] colour; null keeps
 * today's primary. Neutral ([PolarisBranding.None], the native preset) never takes the product's.
 */
internal fun themeAccent(integrator: Color?, branding: PolarisBranding, presentation: Presentation?, dark: Boolean, derived: String?): Color? {
    if (integrator != null) return integrator
    if (branding == PolarisBranding.None) return null
    return (presentation?.accentFor(dark) ?: derived)?.let(::colorOf)
}
