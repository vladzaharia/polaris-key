// Sign-in with a code: the RFC 8628 device-code flow the identity service runs. The screen shows
// the verification address (with a copy button), the user code (large, and spelled out for
// TalkBack) and a countdown to the code's expiry; the SDK polls in the background
// (IdentityClient.waitForSignIn) and the state moves to Done, Expired or Failed. On Android TV it
// adds a QR code of the pre-filled page for a phone camera (UI-KITS.md §4.3: a QR only on TV).
//
// The QR code is encoded by ZXing's core library (pure Java, no camera) and drawn on a plate of
// its own: always dark modules on a light ground with a four-module quiet zone, in both themes,
// so every scanner reads it.

package im.plrs.key.ui

import android.content.ClipData
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
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
 * The code view follows UI-KITS.md §4.3 (SignInHandoff): the product header, the instructions, the
 * user code at hero size in the kit mono (two groups of four, never letter-spaced), the address
 * with a copy button, and a determinate countdown; Open sign-in page and Cancel are the controls,
 * so a phone in landscape shows them beside the code. The QR code appears only on Android TV,
 * where the person signs in on another device.
 *
 * @param onOpenBrowser opens the pre-filled verification page; the default opens it with the
 *   platform's URI handler (a browser on the same device).
 * @param showQr shows the QR code; the default is true on Android TV only.
 * @param onCopyLink copies the pre-filled verification link; the default puts it on the clipboard.
 */
@Composable
public fun PolarisSignInScreen(
    ui: PolarisSignInUi,
    modifier: Modifier = Modifier,
    onOpenBrowser: ((String) -> Unit)? = null,
    onCancel: () -> Unit = {},
    onRestart: () -> Unit = {},
    showQr: Boolean = isTelevision(),
    onCopyLink: ((String) -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    when (ui) {
        PolarisSignInUi.Starting -> PolarisScreen(
            modifier = modifier,
            showLogo = false,
            actions = { PolarisTextButton(copy.cancel, onCancel) },
        ) {
            PolarisProductHeader()
            PolarisTitle(copy.signInTitle)
            Spacer(Modifier.height(polarisWindow.section))
            PolarisProgress(copy.signInStarting)
        }
        is PolarisSignInUi.Showing -> {
            val uriHandler = LocalUriHandler.current
            val open = onOpenBrowser ?: { uri: String -> uriHandler.openUri(uri) }
            val link = ui.prompt.verificationUriComplete
            PolarisScreen(
                modifier = modifier,
                // The product header carries the logo, beside the product's name.
                showLogo = false,
                actions = {
                    if (showQr) {
                        PolarisQrCode(
                            content = link,
                            contentDescription = copy.signInQrDescription,
                            modifier = Modifier.widthIn(max = 200.dp).fillMaxWidth(0.72f),
                        )
                        Spacer(Modifier.height(polarisWindow.section))
                    }
                    // PX-W13: the label the sign-in page will show (the Worker's echo), so the
                    // player can check the page belongs to this device. It describes the page the
                    // primary opens, so it sits above it.
                    ui.prompt.deviceName?.let { label ->
                        Text(
                            text = copy.format(copy.signInDeviceLabel, label),
                            style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Heading),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(PolarisSpace.controls))
                    }
                    PolarisPrimaryButton(copy.signInOpenBrowser, onClick = { open(link) })
                    Spacer(Modifier.height(PolarisSpace.controls))
                    PolarisTextButton(copy.cancel, onCancel)
                },
            ) {
                PolarisProductHeader()
                PolarisTitle(copy.signInTitle)
                Spacer(Modifier.height(PolarisSpace.tight))
                PolarisBody(
                    if (showQr) copy.format(copy.signInInstructions, unbroken(displayHost(ui.prompt.verificationUri)))
                    else copy.signInCodeInstructions,
                )
                Spacer(Modifier.height(polarisWindow.section))
                PolarisUserCode(ui.prompt.userCode, Modifier.fillMaxWidth())
                if (!showQr) {
                    // On TV the address is in the instructions, and nothing there pastes.
                    Spacer(Modifier.height(PolarisSpace.tight))
                    PolarisLinkRow(displayHost(ui.prompt.verificationUri), link, onCopyLink)
                } else {
                    Spacer(Modifier.height(PolarisSpace.controls))
                }
                PolarisCountdown(ui.fractionLeft, copy.format(copy.signInExpiresIn, countdown(ui.secondsLeft)))
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

/**
 * The product header of a focused step (UI-KITS.md §1.2): the theme's logo at 40 dp beside the
 * product's name, then a section gap. Nothing when the theme has neither.
 */
@Composable
internal fun PolarisProductHeader() {
    val theme = PolarisTheme.current
    val name = theme.copy.productName.takeIf { it != DEFAULT_PRODUCT_NAME }
    val logo = theme.logo
    if (name == null && logo == null) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PolarisSpace.controls)) {
        if (logo != null) {
            // 40 dp: the display cut of a mark is never scaled into the service range (≤ 32).
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { logo() }
        }
        if (name != null) {
            Text(name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
        }
    }
    Spacer(Modifier.height(polarisWindow.section))
}

/** [address] with a word joiner after each slash, so a line never breaks inside it. */
internal fun unbroken(address: String): String = address.replace("/", "/\u2060")

/** The host and path a player types: `key.plrs.im/activate`, without the scheme. */
internal fun displayHost(uri: String): String = try {
    val u = URI(uri)
    val host = u.host ?: return uri
    (host + (u.rawPath?.takeIf { it != "/" } ?: "")).trimEnd('/')
} catch (e: Exception) {
    uri
}

/**
 * The user code at hero size in the kit mono, spelled out character by character for TalkBack.
 *
 * Two groups of four joined by a hyphen, exactly as the page asks for it, with no letter spacing
 * (UI-KITS.md §4.3: no spaced-out letters). It sits on a borderless fill so it reads as output,
 * not as a field, grows with the window, and shrinks to fit rather than wrap at a large font scale.
 */
@Composable
public fun PolarisUserCode(code: String, modifier: Modifier = Modifier) {
    val copy = PolarisTheme.copy
    val window = polarisWindow
    val spelled = code.toCharArray().joinToString(" ") { if (it == '-') "," else it.toString() }
    val size = when {
        window.wide -> 40.sp
        window.compactHeight -> 32.sp
        else -> 36.sp
    }
    val color = MaterialTheme.colorScheme.onSurface
    Surface(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = copy.format(copy.signInCodeDescription, spelled) },
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = color,
    ) {
        Box(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
            BasicText(
                text = code,
                style = TextStyle(
                    fontFamily = PolarisTheme.monoFamily,
                    fontWeight = FontWeight.Medium,
                    fontSize = size,
                    lineHeight = size * 1.25f,
                    letterSpacing = 0.sp,
                    textAlign = TextAlign.Center,
                ),
                color = { color },
                maxLines = 1,
                softWrap = false,
                autoSize = TextAutoSize.StepBased(minFontSize = 16.sp, maxFontSize = size, stepSize = 1.sp),
            )
        }
    }
}

/**
 * The address to type, with a copy button that puts the pre-filled [link] on the clipboard (for a
 * person who signs in on another device they can paste to). The button's label turns to "Link
 * copied" for two seconds, announced.
 */
@Composable
internal fun PolarisLinkRow(display: String, link: String, onCopyLink: ((String) -> Unit)?) {
    val copy = PolarisTheme.copy
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2_000)
            copied = false
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = display,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(PolarisSpace.tight / 2))
        IconButton(
            onClick = {
                if (onCopyLink != null) {
                    onCopyLink(link)
                } else {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(display, link))) }
                }
                copied = true
            },
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Icon(
                imageVector = if (copied) Icons.Filled.Check else PolarisCopyIcon,
                contentDescription = if (copied) copy.signInLinkCopied else copy.signInCopyLink,
                tint = PolarisTheme.accentText,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * The code's countdown (UI-KITS.md §1.5 rule 4): a 20 dp determinate ring, 2 dp stroke, in the
 * accent, draining linearly, beside the time left in tabular figures.
 */
@Composable
internal fun PolarisCountdown(fraction: Float, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(
            progress = { fraction },
            modifier = Modifier.size(20.dp),
            strokeWidth = 2.dp,
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            gapSize = 0.dp,
        )
        Spacer(Modifier.width(PolarisSpace.tight))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Material's "content copy" glyph (core icons have none). */
internal val PolarisCopyIcon: ImageVector by lazy {
    materialIcon(name = "Filled.ContentCopy") {
        materialPath {
            moveTo(16.0f, 1.0f)
            lineTo(4.0f, 1.0f)
            curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
            verticalLineToRelative(14.0f)
            horizontalLineToRelative(2.0f)
            lineTo(4.0f, 3.0f)
            horizontalLineToRelative(12.0f)
            lineTo(16.0f, 1.0f)
            close()
            moveTo(19.0f, 5.0f)
            lineTo(8.0f, 5.0f)
            curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
            verticalLineToRelative(14.0f)
            curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
            horizontalLineToRelative(11.0f)
            curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
            lineTo(21.0f, 7.0f)
            curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
            close()
            moveTo(19.0f, 21.0f)
            lineTo(8.0f, 21.0f)
            lineTo(8.0f, 7.0f)
            horizontalLineToRelative(11.0f)
            verticalLineToRelative(14.0f)
            close()
        }
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
