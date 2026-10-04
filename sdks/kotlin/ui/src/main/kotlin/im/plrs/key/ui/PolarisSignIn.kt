// Sign-in with a QR code: the RFC 8628 device-code flow the identity service runs. The screen
// shows the verification page, the user code (large, and spelled out for TalkBack), a QR code of
// the pre-filled page for a phone camera, and a countdown to the code's expiry; the SDK polls in
// the background (IdentityClient.waitForSignIn) and the state moves to Done, Expired or Failed.
//
// The QR code is encoded by ZXing's core library (pure Java, no camera) and drawn on a plate of
// its own: always dark modules on a light ground with a four-module quiet zone, in both themes,
// so every scanner reads it.

package im.plrs.key.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import im.plrs.key.identity.SignInPrompt
import im.plrs.key.identity.SignInResult
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.URI

// ── State ────────────────────────────────────────────────────────────────────────────────────

/** Where the sign-in flow is. */
public sealed interface PolarisSignInUi {
    /** Asking the server for a code. */
    public data object Starting : PolarisSignInUi

    /** A code to show; [nowSeconds] ticks for the countdown. */
    public data class Showing(val prompt: SignInPrompt, val nowSeconds: Long) : PolarisSignInUi {
        /** Seconds left before the code expires. */
        val secondsLeft: Long get() = (prompt.expiresAt - nowSeconds).coerceAtLeast(0)

        /** The fraction of the code's life left, 1 → 0. */
        val fractionLeft: Float
            get() = if (prompt.expiresIn <= 0) 0f else (secondsLeft.toFloat() / prompt.expiresIn).coerceIn(0f, 1f)
    }

    public data object Done : PolarisSignInUi
    public data object Expired : PolarisSignInUi
    public data object Failed : PolarisSignInUi
}

/** The SDK calls sign-in makes. [PolarisKeyClient.signInActions] adapts the umbrella client. */
public interface PolarisSignInActions {
    public suspend fun begin(): SignInPrompt
    public suspend fun wait(prompt: SignInPrompt): SignInResult
}

/** The umbrella client's identity service as sign-in actions. */
public fun PolarisKeyClient.signInActions(deviceName: String? = null): PolarisSignInActions {
    val identity = this.identity
    return object : PolarisSignInActions {
        override suspend fun begin(): SignInPrompt = identity.beginSignIn(deviceName)
        override suspend fun wait(prompt: SignInPrompt): SignInResult = identity.waitForSignIn(prompt)
    }
}

/** The sign-in state holder: [start] asks for a code, shows it, and waits for the player. */
public class PolarisSignInState(
    private val actions: PolarisSignInActions,
    private val scope: CoroutineScope,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
    /** Called once when sign-in completes (the SDK has already synced). */
    private val onSignedIn: () -> Unit = {},
) {
    private val _ui = MutableStateFlow<PolarisSignInUi>(PolarisSignInUi.Starting)
    public val ui: StateFlow<PolarisSignInUi> = _ui.asStateFlow()
    private var job: Job? = null

    /** Start (or restart) the flow. */
    public fun start() {
        job?.cancel()
        _ui.value = PolarisSignInUi.Starting
        job = scope.launch {
            val prompt = try {
                actions.begin()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.value = PolarisSignInUi.Failed
                return@launch
            }
            _ui.value = PolarisSignInUi.Showing(prompt, clock())
            val ticker = launch {
                while (isActive) {
                    delay(1_000)
                    _ui.update { if (it is PolarisSignInUi.Showing) it.copy(nowSeconds = clock()) else it }
                }
            }
            val result = try {
                actions.wait(prompt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                SignInResult.Error(e.message ?: "")
            }
            ticker.cancel()
            _ui.value = when (result) {
                SignInResult.Ready -> PolarisSignInUi.Done
                SignInResult.Expired -> PolarisSignInUi.Expired
                is SignInResult.Error -> PolarisSignInUi.Failed
            }
            if (result == SignInResult.Ready) onSignedIn()
        }
    }

    /** Stop polling (the screen was dismissed). */
    public fun cancel() {
        job?.cancel()
        job = null
    }
}

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/** The sign-in screen over its state holder. Starts the flow when first shown. */
@Composable
public fun PolarisSignIn(state: PolarisSignInState, modifier: Modifier = Modifier, onCancel: () -> Unit = {}) {
    val ui by state.ui.collectAsState()
    androidx.compose.runtime.LaunchedEffect(state) { if (state.ui.value == PolarisSignInUi.Starting) state.start() }
    androidx.compose.runtime.DisposableEffect(state) { onDispose { state.cancel() } }
    PolarisSignInScreen(
        ui = ui,
        modifier = modifier,
        onCancel = {
            state.cancel()
            onCancel()
        },
        onRestart = state::start,
    )
}

/**
 * The stateless sign-in screen.
 *
 * @param onOpenBrowser opens the pre-filled verification page; the default opens it with the
 *   platform's URI handler (a browser on the same device).
 */
@Composable
public fun PolarisSignInScreen(
    ui: PolarisSignInUi,
    modifier: Modifier = Modifier,
    onOpenBrowser: ((String) -> Unit)? = null,
    onCancel: () -> Unit = {},
    onRestart: () -> Unit = {},
) {
    val copy = PolarisTheme.copy
    when (ui) {
        PolarisSignInUi.Starting -> PolarisScreen(modifier = modifier) {
            PolarisTitle(copy.signInTitle)
            Spacer(Modifier.height(32.dp))
            PolarisProgress(copy.signInStarting)
            Spacer(Modifier.height(32.dp))
            PolarisTextButton(copy.cancel, onCancel)
        }
        is PolarisSignInUi.Showing -> {
            val uriHandler = LocalUriHandler.current
            val open = onOpenBrowser ?: { uri: String -> uriHandler.openUri(uri) }
            PolarisScreen(modifier = modifier) {
                PolarisTitle(copy.signInTitle)
                Spacer(Modifier.height(8.dp))
                PolarisBody(copy.format(copy.signInInstructions, displayHost(ui.prompt.verificationUri)))
                Spacer(Modifier.height(24.dp))
                PolarisQrCode(
                    content = ui.prompt.verificationUriComplete,
                    contentDescription = copy.signInQrDescription,
                    modifier = Modifier.widthIn(max = 240.dp).fillMaxWidth(0.72f),
                )
                Spacer(Modifier.height(24.dp))
                PolarisUserCode(ui.prompt.userCode)
                Spacer(Modifier.height(20.dp))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    LinearProgressIndicator(
                        progress = { ui.fractionLeft },
                        modifier = Modifier.fillMaxWidth(0.6f),
                        drawStopIndicator = {},
                    )
                    Text(
                        text = copy.format(copy.signInExpiresIn, countdown(ui.secondsLeft)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
                Spacer(Modifier.height(28.dp))
                PolarisPrimaryButton(copy.signInOpenBrowser, onClick = { open(ui.prompt.verificationUriComplete) })
                Spacer(Modifier.height(8.dp))
                PolarisTextButton(copy.cancel, onCancel)
            }
        }
        PolarisSignInUi.Done -> PolarisScreen(modifier = modifier) {
            PolarisTitle(copy.signInDone, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        PolarisSignInUi.Expired, PolarisSignInUi.Failed -> PolarisMessageScreen(
            message = PolarisMessageCopy(
                title = copy.signInTitle,
                body = if (ui == PolarisSignInUi.Expired) copy.signInExpired else copy.signInError,
                kind = if (ui == PolarisSignInUi.Expired) PolarisMessageKind.Info else PolarisMessageKind.Danger,
            ),
            modifier = modifier,
        ) {
            PolarisPrimaryButton(copy.signInNewCode, onRestart)
            PolarisTextButton(copy.cancel, onCancel)
        }
    }
}

/** The host and path a player types: `key.plrs.im/activate`, without the scheme. */
internal fun displayHost(uri: String): String = try {
    val u = URI(uri)
    val host = u.host ?: return uri
    (host + (u.rawPath?.takeIf { it != "/" } ?: "")).trimEnd('/')
} catch (e: Exception) {
    uri
}

/** The user code in a large monospace, spelled out character by character for TalkBack. */
@Composable
public fun PolarisUserCode(code: String, modifier: Modifier = Modifier) {
    val copy = PolarisTheme.copy
    val spelled = code.toCharArray().joinToString(" ") { if (it == '-') "," else it.toString() }
    Surface(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = copy.format(copy.signInCodeDescription, spelled) },
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Text(
            text = code,
            style = MaterialTheme.typography.headlineMedium.copy(
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                letterSpacing = 4.sp,
            ),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
        )
    }
}

/** The modules of a QR code for [content]: a square of booleans, true for dark. */
public fun qrModules(content: String): Array<BooleanArray> {
    val hints = mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 0, 0, hints)
    return Array(matrix.height) { y -> BooleanArray(matrix.width) { x -> matrix[x, y] } }
}

/** A QR code of [content] on its own light plate with a four-module quiet zone. */
@Composable
public fun PolarisQrCode(content: String, contentDescription: String, modifier: Modifier = Modifier) {
    val modules = remember(content) { qrModules(content) }
    val status = PolarisTheme.status
    Box(
        modifier = modifier
            .aspectRatio(1f)
            .clip(MaterialTheme.shapes.small)
            .semantics {
                this.contentDescription = contentDescription
                role = Role.Image
            },
    ) {
        Canvas(Modifier.matchParentSize()) {
            val quiet = 4
            val count = modules.size + quiet * 2
            val cell = size.minDimension / count
            drawRect(color = status.qrPlate, size = Size(cell * count, cell * count))
            for (y in modules.indices) {
                val row = modules[y]
                for (x in row.indices) {
                    if (!row[x]) continue
                    drawRect(
                        color = status.qrModules,
                        topLeft = Offset((x + quiet) * cell, (y + quiet) * cell),
                        // A hair of overlap so neighbouring modules never show a seam.
                        size = Size(cell + 0.5f, cell + 0.5f),
                    )
                }
            }
        }
    }
}
