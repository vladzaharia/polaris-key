// Sign-in with a code: the RFC 8628 device-code flow the identity service runs. The code view
// (UI-KITS.md §4.3, SignInHandoff) shows the product header, "Sign in with a code", the lede with
// the address set inline, the user code at hero size (spelled out for TalkBack, with a copy
// button for the pre-filled link), and a countdown; the SDK polls in the background
// (IdentityClient.waitForSignIn) and the state moves to Done, Expired or Failed.
//
// On Android TV the person signs in on another device: the screen leads with a QR code of the
// pre-filled page and has no "Open sign-in page" (a TV may have no browser), and D-pad focus starts
// on the first real control. Every browser opener is guarded: when none can open the page the
// screen stays put and says so, with the code and the copy button still there.
//
// The QR code is encoded by ZXing's core library (pure Java, no camera) and drawn on a 92 % white
// tile with an 8 dp quiet zone, in both themes, so every scanner reads it.

package im.plrs.key.ui

import android.content.ClipData
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

/**
 * The sign-in state holder: [start] asks for a code, shows it, and waits for the player.
 *
 * Hold it where it outlives the screen (a ViewModel, with `viewModelScope`), so a rotation or a
 * trip through navigation keeps the same code: when the screen comes back, [start] resumes polling
 * that code instead of asking for a new one.
 */
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

    /** The code being followed, so a re-shown screen polls it again. */
    private var prompt: SignInPrompt? = null

    /** The countdown ran out on screen while the poll still ran: a late success still completes. */
    private var expiredOnScreen = false

    /**
     * Start the flow, once. The first call asks for a code; a call after the screen left
     * composition resumes polling the same code (same device code and interval) and the countdown
     * from its expiry. While the flow runs, or after it ended, it does nothing: [restart] asks for
     * a new code.
     */
    public fun start() {
        if (job?.isActive == true) return
        val shown = prompt
        when {
            _ui.value == PolarisSignInUi.Starting -> begin()
            shown != null && (_ui.value is PolarisSignInUi.Showing || expiredOnScreen) -> job = scope.launch { follow(shown) }
        }
    }

    /** Drop the current code and ask for a new one ("Get a new code", "Try again"). */
    public fun restart() {
        job?.cancel()
        prompt = null
        expiredOnScreen = false
        begin()
    }

    /** Stop polling: the player cancelled. */
    public fun cancel() {
        job?.cancel()
        job = null
        prompt = null
    }

    /** Stop polling while the screen is away; [start] resumes the same code. Never changes [ui]. */
    public fun pause() {
        job?.cancel()
        job = null
    }

    private fun begin() {
        _ui.value = PolarisSignInUi.Starting
        job = scope.launch {
            val shown = try {
                actions.begin()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.value = PolarisSignInUi.Failed
                return@launch
            }
            prompt = shown
            _ui.value = PolarisSignInUi.Showing(shown, clock())
            follow(shown)
        }
    }

    /** The countdown and the poll for [shown]; the code expiring on screen leaves the poll running. */
    private suspend fun follow(shown: SignInPrompt): Unit = coroutineScope {
        fun tick() {
            val now = clock()
            val current = _ui.value
            if (current !is PolarisSignInUi.Showing) return
            if (shown.expiresAt - now <= 0) {
                expiredOnScreen = true
                _ui.value = PolarisSignInUi.Expired
            } else {
                _ui.value = current.copy(nowSeconds = now)
            }
        }
        tick()
        val ticker = launch {
            while (isActive) {
                delay(1_000)
                tick()
            }
        }
        val result = try {
            actions.wait(shown)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            SignInResult.Error(e.message ?: "")
        }
        ticker.cancel()
        prompt = null
        expiredOnScreen = false
        _ui.value = when (result) {
            SignInResult.Ready -> PolarisSignInUi.Done
            SignInResult.Expired -> PolarisSignInUi.Expired
            is SignInResult.Error -> PolarisSignInUi.Failed
        }
        if (result == SignInResult.Ready) onSignedIn()
    }
}

// ── Composables ──────────────────────────────────────────────────────────────────────────────

/**
 * The sign-in screen over its state holder. Starts the flow when shown, and resumes the same code
 * when it comes back after a rotation or navigation.
 *
 * @param onUseKey offered on Android TV as "Use a license key instead"; null hides it.
 */
@Composable
public fun PolarisSignIn(
    state: PolarisSignInState,
    modifier: Modifier = Modifier,
    onCancel: () -> Unit = {},
    onUseKey: (() -> Unit)? = null,
) {
    val ui by state.ui.collectAsState()
    LaunchedEffect(state) { state.start() }
    DisposableEffect(state) { onDispose { state.pause() } }
    PolarisSignInScreen(
        ui = ui,
        modifier = modifier,
        onCancel = {
            state.cancel()
            onCancel()
        },
        onRestart = state::restart,
        onUseKey = onUseKey?.let { useKey ->
            {
                state.cancel()
                useKey()
            }
        },
    )
}

/**
 * The stateless sign-in screen.
 *
 * @param onOpenBrowser opens the pre-filled verification page; the default opens it with the
 *   platform's URI handler. Either way a failure (no browser) keeps the screen and says so.
 * @param showQr the TV layout: the QR code leads and "Open sign-in page" is not offered. The
 *   default is true on Android TV only.
 * @param onCopyLink copies the pre-filled verification link; the default puts it on the clipboard.
 * @param onUseKey offered on TV as "Use a license key instead"; null hides it.
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
    onUseKey: (() -> Unit)? = null,
) {
    val copy = PolarisTheme.copy
    when (ui) {
        PolarisSignInUi.Starting -> PolarisMessageLayout(
            modifier = modifier,
            emblem = { PolarisWaitIndicator() },
            title = copy.signInStarting,
            body = null,
            titleStyle = { MaterialTheme.typography.titleMedium },
            actions = { PolarisTextButton(copy.cancel, onCancel, initialFocus = true) },
        )
        is PolarisSignInUi.Showing -> PolarisCodeView(ui, modifier, onOpenBrowser, onCancel, showQr, onCopyLink, onUseKey)
        PolarisSignInUi.Done -> PolarisScreen(modifier = modifier, showLogo = false) {
            PolarisTitle(copy.signInDone, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        PolarisSignInUi.Expired -> PolarisMessageScreen(copy.coreMessage(SIGN_IN_EXPIRED, PolarisMessageKind.Info), modifier) {
            PolarisPrimaryButton(copy.signInNewCode, onRestart, initialFocus = true)
            PolarisTextButton(copy.cancel, onCancel)
        }
        PolarisSignInUi.Failed -> PolarisMessageScreen(copy.coreMessage(SIGN_IN_FAILED, PolarisMessageKind.Danger), modifier) {
            PolarisPrimaryButton(copy.retry, onRestart, initialFocus = true)
            PolarisTextButton(copy.cancel, onCancel)
        }
    }
}

/** core.copy's codes for the sign-in stops. */
internal const val SIGN_IN_EXPIRED: String = "sign-in-expired"
internal const val SIGN_IN_FAILED: String = "sign-in-failed"

/** The code view: content (and on TV the code) on the start side, the code or QR and the controls after. */
@Composable
private fun PolarisCodeView(
    ui: PolarisSignInUi.Showing,
    modifier: Modifier,
    onOpenBrowser: ((String) -> Unit)?,
    onCancel: () -> Unit,
    showQr: Boolean,
    onCopyLink: ((String) -> Unit)?,
    onUseKey: (() -> Unit)?,
) {
    val copy = PolarisTheme.copy
    val theme = PolarisTheme.current
    val uriHandler = LocalUriHandler.current
    val link = ui.prompt.verificationUriComplete
    val address = theme.deviceCodeUrl?.let(::displayHost) ?: displayHost(ui.prompt.verificationUri)
    var noBrowser by rememberSaveable(link) { mutableStateOf(false) }
    val open: () -> Unit = {
        val opened = runCatching { (onOpenBrowser ?: uriHandler::openUri)(link) }.isSuccess
        noBrowser = !opened
    }
    // TalkBack hears the code once, spelled out, when it first appears.
    val view = LocalView.current
    val spoken = copy.format(copy.signInCodeDescription, spelled(ui.prompt.userCode))
    LaunchedEffect(ui.prompt.userCode) {
        @Suppress("DEPRECATION") // the one-off announcement API; a live region would repeat on every tick
        view.announceForAccessibility(spoken)
    }
    val countdown: @Composable () -> Unit = {
        Spacer(Modifier.height(PolarisSpace.controls))
        PolarisCountdown(ui.fractionLeft, copy.format(copy.signInExpiresIn, countdown(ui.secondsLeft)))
    }
    val deviceLine: @Composable () -> Unit = {
        // PX-W13: the label the sign-in page will show (the Worker's echo), so the player can
        // check the page belongs to this device.
        ui.prompt.deviceName?.let { label ->
            Spacer(Modifier.height(PolarisSpace.controls))
            Text(
                text = copy.format(copy.signInDeviceLabel, label),
                style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Paragraph),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    PolarisScaffold(
        modifier = modifier,
        anchor = PolarisAnchor.Top,
        contentAlign = TextAlign.Start,
        content = {
            PolarisProductHeader()
            PolarisTitle(copy.signInTitle)
            Spacer(Modifier.height(PolarisSpace.tight))
            if (showQr) {
                PolarisLede(copy.signInInstructions, address)
                Spacer(Modifier.height(PolarisSpace.controls))
                // The address on its own line, large enough to read from the sofa.
                Text(
                    text = unbroken(address),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(polarisWindow.section))
                PolarisUserCode(ui.prompt.userCode, Modifier.fillMaxWidth())
                countdown()
            } else {
                PolarisLede(copy.signInCodeBody, address)
            }
        },
        detail = {
            if (showQr) {
                PolarisQrCode(link, copy.signInQrDescription, Modifier.size(polarisWindow.qrSize))
                deviceLine()
            } else {
                PolarisUserCode(ui.prompt.userCode, Modifier.fillMaxWidth(), onCopy = link to onCopyLink)
                countdown()
                deviceLine()
            }
        },
        actions = {
            if (noBrowser) {
                PolarisInlineNotice(copy.signInNoBrowser)
                Spacer(Modifier.height(PolarisSpace.controls))
            }
            if (showQr) {
                // A TV may have no browser, so the QR leads and the first control is a real one.
                if (onUseKey != null) {
                    PolarisSecondaryButton(copy.signInUseKey, onUseKey, initialFocus = true)
                    Spacer(Modifier.height(PolarisSpace.controls))
                }
                PolarisTextButton(copy.cancel, onCancel, initialFocus = onUseKey == null)
            } else {
                PolarisPrimaryButton(copy.signInOpenBrowser, onClick = open, initialFocus = true)
                Spacer(Modifier.height(PolarisSpace.controls))
                PolarisTextButton(copy.cancel, onCancel)
            }
        },
    )
}

/** A lede template (`%1$s` for the address) with the address set inline at 600 weight, unbroken. */
@Composable
internal fun PolarisLede(template: String, address: String) {
    val strong = SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
    val text: AnnotatedString = buildAnnotatedString {
        val at = template.indexOf("%1\$s")
        if (at < 0) {
            append(template)
        } else {
            append(template.substring(0, at))
            withStyle(strong) { append(unbroken(address)) }
            append(template.substring(at + 4))
        }
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge.copy(lineBreak = LineBreak.Paragraph),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = LocalPolarisTextAlign.current,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * [address] with a word joiner between its characters, except after a slash: a line may break
 * only after a '/', never inside the host or a path segment.
 */
internal fun unbroken(address: String): String = buildString {
    address.forEachIndexed { i, c ->
        append(c)
        if (i < address.lastIndex && c != '/') append('\u2060')
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

/** A code spelled out for TalkBack: one character at a time, the hyphen as a pause. */
internal fun spelled(code: String): String = code.toCharArray().joinToString(" ") { if (it == '-') "," else it.toString() }

/**
 * The user code at hero size in the kit mono, spelled out character by character for TalkBack.
 *
 * Two groups of four joined by a hyphen, exactly as the page asks for it, with no letter spacing
 * (UI-KITS.md §4.3: no spaced-out letters). It sits on a borderless plate so it reads as output,
 * not as a field, grows with the window (up to 56 sp from 1280 dp wide), and shrinks to fit rather
 * than wrap at a large font scale. With [onCopy] (the link and an optional copier) a ghost copy
 * button sits at the plate's inline end.
 */
@Composable
public fun PolarisUserCode(code: String, modifier: Modifier = Modifier) {
    PolarisUserCode(code, modifier, onCopy = null)
}

@Composable
internal fun PolarisUserCode(code: String, modifier: Modifier, onCopy: Pair<String, ((String) -> Unit)?>?) {
    val copy = PolarisTheme.copy
    val window = polarisWindow
    val size = when {
        window.width >= 1280.dp && !window.compactHeight -> 56.sp
        window.wide || window.tv -> 40.sp
        window.compactHeight -> 32.sp
        else -> 36.sp
    }
    val color = MaterialTheme.colorScheme.onSurface
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = color,
    ) {
        Row(
            Modifier.padding(start = 20.dp, end = if (onCopy != null) 4.dp else 20.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(
                text = code,
                style = TextStyle(
                    fontFamily = PolarisTheme.monoFamily,
                    fontWeight = FontWeight.Medium,
                    fontSize = size,
                    lineHeight = size * 1.25f,
                    letterSpacing = 0.sp,
                    textAlign = TextAlign.Start,
                ),
                color = { color },
                maxLines = 1,
                softWrap = false,
                autoSize = TextAutoSize.StepBased(minFontSize = 16.sp, maxFontSize = size, stepSize = 1.sp),
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = copy.format(copy.signInCodeDescription, spelled(code)) },
            )
            if (onCopy != null) PolarisCopyLinkButton(onCopy.first, onCopy.second)
        }
    }
}

/**
 * The ghost copy button: it puts the pre-filled [link] on the clipboard (for a person who signs in
 * on another device they can paste to), and its label turns to "Link copied" for two seconds.
 */
@Composable
internal fun PolarisCopyLinkButton(link: String, onCopyLink: ((String) -> Unit)?) {
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
    val interaction = remember { MutableInteractionSource() }
    IconButton(
        onClick = {
            if (onCopyLink != null) {
                onCopyLink(link)
            } else {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(copy.signInCopyLink, link))) }
            }
            copied = true
        },
        interactionSource = interaction,
        modifier = Modifier
            .polarisFocusIndication(interaction, PolarisTheme.buttonShape)
            .size(PolarisMinTouchTarget)
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Icon(
            imageVector = if (copied) PolarisCheckIcon else PolarisCopyIcon,
            contentDescription = if (copied) copy.signInLinkCopied else copy.signInCopyLink,
            tint = PolarisTheme.accentText,
            modifier = Modifier.size(20.dp),
        )
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

/** Material's "content copy" glyph, drawn by the kit (the legacy icon set is not used). */
internal val PolarisCopyIcon: ImageVector by lazy {
    materialIcon(name = "Polaris.ContentCopy") {
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

/** Material's "check" glyph, drawn by the kit: the copy button's "Link copied" state. */
internal val PolarisCheckIcon: ImageVector by lazy {
    materialIcon(name = "Polaris.Check") {
        materialPath {
            moveTo(9.0f, 16.17f)
            lineTo(4.83f, 12.0f)
            lineToRelative(-1.42f, 1.41f)
            lineTo(9.0f, 19.0f)
            lineTo(21.0f, 7.0f)
            lineToRelative(-1.41f, -1.41f)
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

/**
 * A QR code of [content] on its own tile: 92 % white with an 8 dp quiet zone (UI-KITS.md §4.3),
 * dark modules, in both themes. Size it with the kit's one QR size (the window's `qrSize`).
 */
@Composable
public fun PolarisQrCode(content: String, contentDescription: String, modifier: Modifier = Modifier) {
    val modules = remember(content) { qrModules(content) }
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
