// The Android actuals of the kit's platform edges (UK-10.2): the code the screens had inline before.

package im.plrs.key.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

private class AndroidClipboard(private val clipboard: Clipboard) : PolarisClipboard {
    override suspend fun setText(label: String, text: String, sensitive: Boolean): Boolean = runCatching {
        val clip = ClipData.newPlainText(label, text)
        if (sensitive && Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        clipboard.setClipEntry(ClipEntry(clip))
    }.isSuccess

    override suspend fun clear(): Boolean = runCatching { clipboard.setClipEntry(null) }.isSuccess

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
internal actual fun PolarisQr(content: String, contentDescription: String, modifier: Modifier) = PolarisQrCode(content, contentDescription, modifier)

@Composable
internal actual fun systemLocaleTag(): String {
    val configuration = LocalConfiguration.current
    return remember(configuration) {
        val locales = configuration.locales
        if (locales.isEmpty) "en" else locales[0].toLanguageTag()
    }
}

/** What this screen is: "tv", "tablet" or "phone". */
@Composable
internal actual fun ownFormFactor(): String {
    val wide = LocalConfiguration.current.smallestScreenWidthDp >= 600
    return when {
        isTelevision() -> "tv"
        wide -> "tablet"
        else -> "phone"
    }
}

@Composable
internal actual fun rememberPolarisAnnouncer(): (String) -> Unit {
    val view = LocalView.current
    return remember(view) {
        { message ->
            @Suppress("DEPRECATION") // the one-off announcement API; a live region would repeat on every tick
            view.announceForAccessibility(message)
        }
    }
}

@Composable
internal actual fun rememberUpdatePrefs(): PolarisUpdatePrefs {
    val prefs = LocalContext.current.getSharedPreferences("pkey_ui_update", Context.MODE_PRIVATE)
    return remember(prefs) {
        PolarisUpdatePrefs(
            skippedVersion = prefs.getString("skipped_version", null),
            saveSkipped = { prefs.edit().putString("skipped_version", it).apply() },
        )
    }
}

@Composable
internal actual fun polarisLocalizedCopy(): PolarisCopy {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    return remember(context, configuration) {
        PolarisCopy.fromResources(context.resources, context.packageName)
    }
}

/**
 * The copy from string resources: the kit's English defaults, or the app's translation of
 * them for the current locale. Fields with no resource keep the English default.
 */
public fun PolarisCopy.Companion.fromResources(resources: Resources, packageName: String): PolarisCopy {
    val defaults = PolarisCopy()
    val values = HashMap<String, String>()
    for (field in FIELDS) {
        @Suppress("DiscouragedApi") // the names are data (FIELDS), so ids cannot be static
        val id = resources.getIdentifier(resourceName(field), "string", packageName)
        if (id != 0) values[field] = resources.getString(id)
    }
    return defaults.with(values)
}

internal actual fun thumbnailArgb32(image: ImageBitmap): IntArray {
    val thumb = Bitmap.createScaledBitmap(image.asAndroidBitmap(), 32, 32, true)
    val argb = IntArray(32 * 32)
    thumb.getPixels(argb, 0, 32, 0, 0, 32, 32)
    return argb
}

internal actual fun polarisPromptDialogProperties(
    dismissible: Boolean,
    scrim: Boolean,
    dismissOnClickOutside: Boolean,
): androidx.compose.ui.window.DialogProperties = androidx.compose.ui.window.DialogProperties(
    dismissOnBackPress = dismissible,
    dismissOnClickOutside = dismissOnClickOutside,
    usePlatformDefaultWidth = false,
)

@Composable
internal actual fun PolarisDialogDim(amount: Float) {
    val dialogWindow = (LocalView.current.parent as? DialogWindowProvider)?.window
    SideEffect { dialogWindow?.setDimAmount(amount) }
}

internal actual fun autoPlatformVariant(): PolarisPlatformVariant = PolarisPlatformVariant.Android

@Composable
internal actual fun rememberScreenReaderOn(): Boolean {
    val manager = LocalContext.current.getSystemService(AccessibilityManager::class.java)
    var on by remember(manager) { mutableStateOf(manager?.isTouchExplorationEnabled == true) }
    DisposableEffect(manager) {
        val listener = AccessibilityManager.TouchExplorationStateChangeListener { on = it }
        manager?.addTouchExplorationStateChangeListener(listener)
        onDispose { manager?.removeTouchExplorationStateChangeListener(listener) }
    }
    return on
}

@Composable
internal actual fun PolarisReturnEffect(awaiting: Boolean, onReturn: () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val current by rememberUpdatedState(onReturn)
    DisposableEffect(owner, awaiting) {
        var left = false
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> left = true

                Lifecycle.Event.ON_RESUME -> if (left) {
                    left = false
                    current()
                }

                else -> Unit
            }
        }
        if (awaiting) owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
}
