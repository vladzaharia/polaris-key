// The Android actuals of the kit's platform edges (UK-10.2): the code the screens had inline before.

package im.plrs.key.ui

import android.content.ClipData
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler

private class AndroidClipboard(private val clipboard: Clipboard) : PolarisClipboard {
    override suspend fun setText(label: String, text: String): Boolean =
        runCatching { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(label, text))) }.isSuccess

    override suspend fun getText(): String? =
        runCatching { clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() }.getOrNull()
}

@Composable
public actual fun rememberPolarisClipboard(): PolarisClipboard {
    val clipboard = LocalClipboard.current
    return remember(clipboard) { AndroidClipboard(clipboard) }
}

@Composable
public actual fun rememberPolarisOpener(): PolarisOpener {
    val handler = LocalUriHandler.current
    return remember(handler) { PolarisOpener { url -> runCatching { handler.openUri(url) }.isSuccess } }
}

@Composable
internal actual fun PolarisBackHandler(enabled: Boolean, onBack: () -> Unit): Modifier = androidBack(enabled, onBack)

@Composable
internal actual fun rememberSystemReduceMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) {
        runCatching { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    }
}

@Composable
internal actual fun isTelevision(): Boolean =
    (LocalConfiguration.current.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION

internal actual fun decodeIcon(bytes: ByteArray, targetPx: Int, maxSide: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val w = bounds.outWidth
    val h = bounds.outHeight
    if (w < 1 || h < 1 || w > maxSide || h > maxSide) return null
    var sample = 1
    val target = targetPx.coerceAtLeast(1)
    while (targetPx > 0 && w / (sample * 2) >= target && h / (sample * 2) >= target) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}

@Composable
internal actual fun PolarisQr(content: String, contentDescription: String, modifier: Modifier) =
    PolarisQrCode(content, contentDescription, modifier)
