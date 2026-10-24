// The Android actuals of the sign-in's edges (UK-10.3): the state held by the Activity's ViewModel
// store, and the QR code (ZXing's core library, pure Java, no camera) the TV screen leads with.

package im.plrs.key.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The sign-in state kept by the Activity's ViewModel store, so a rotation keeps the same code (a new
 * one would kill the code the person is typing on their phone) and finishing the Activity releases
 * it. One per Activity; it follows the client it was made for and starts over for a different one.
 */
internal class PolarisSignInViewModel : androidx.lifecycle.ViewModel() {
    private var owner: Any? = null
    var state: PolarisSignInState? = null
        private set

    /** The composition's "signed in" reaction; null while no screen is attached, so nothing stale runs. */
    @Volatile
    var onSignedIn: (() -> Unit)? = null

    /** The state for [client]: the held one, or a fresh one for a new client. */
    fun stateFor(client: Any, actions: PolarisSignInActions): PolarisSignInState {
        val held = state
        if (held != null && owner === client) return held
        held?.cancel()
        owner = client
        return PolarisSignInState(actions, viewModelScope, onSignedIn = { onSignedIn?.invoke() }).also { state = it }
    }

    override fun onCleared() {
        state?.cancel()
        state = null
        owner = null
        onSignedIn = null
    }
}

/** The ViewModelStoreOwner behind [this] context (the Activity), or null. */
private tailrec fun android.content.Context.storeOwner(): androidx.lifecycle.ViewModelStoreOwner? = when (this) {
    is androidx.lifecycle.ViewModelStoreOwner -> this
    is android.content.ContextWrapper -> baseContext.storeOwner()
    else -> null
}

/**
 * The sign-in state for [key] (the client), held by the Activity's ViewModel store (see
 * [PolarisSignInViewModel]); [onSignedIn] runs while this composition is attached.
 */
@Composable
internal actual fun rememberHeldSignIn(key: Any, actions: PolarisSignInActions, onSignedIn: () -> Unit): PolarisSignInState {
    val context = LocalContext.current
    val owner = remember(context) { context.storeOwner() }
    val vm = remember(owner) {
        owner?.let { androidx.lifecycle.ViewModelProvider(it)["polaris-key-sign-in", PolarisSignInViewModel::class.java] }
            ?: PolarisSignInViewModel()
    }
    val latest by androidx.compose.runtime.rememberUpdatedState(onSignedIn)
    DisposableEffect(vm) {
        vm.onSignedIn = { latest() }
        onDispose { vm.onSignedIn = null }
    }
    return remember(vm, key) { vm.stateFor(key, actions) }
}

/** The modules of a QR code for [content]: a square of booleans, true for dark. */
public fun qrModules(content: String): Array<BooleanArray> {
    val hints = mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 0, 0, hints)
    return Array(matrix.height) { y -> BooleanArray(matrix.width) { x -> matrix[x, y] } }
}

/**
 * A QR code of [content] on its own tile: 92 % white with an 8 dp quiet zone (UI-KITS.md §4.3),
 * dark modules, in both themes. Size it with the kit's one QR size (the window's `qrSize`).
 */
@Composable
public fun PolarisQrCode(content: String, contentDescription: String, modifier: Modifier = Modifier) {
    // A link the encoder refuses draws no code (the screen still has the code and Copy link).
    val modules = remember(content) { runCatching { qrModules(content) }.getOrNull() } ?: return
    val status = PolarisTheme.status
    Box(
        modifier = modifier
            .aspectRatio(1f)
            .clip(MaterialTheme.shapes.small)
            .background(status.qrPlate)
            .padding(8.dp)
            .semantics {
                this.contentDescription = contentDescription
                role = Role.Image
            },
    ) {
        Canvas(Modifier.matchParentSize()) {
            val cell = size.minDimension / modules.size
            for (y in modules.indices) {
                val row = modules[y]
                for (x in row.indices) {
                    if (!row[x]) continue
                    drawRect(
                        color = status.qrModules,
                        topLeft = Offset(x * cell, y * cell),
                        // A hair of overlap so neighbouring modules never show a seam.
                        size = Size(cell + 0.5f, cell + 0.5f),
                    )
                }
            }
        }
    }
}
