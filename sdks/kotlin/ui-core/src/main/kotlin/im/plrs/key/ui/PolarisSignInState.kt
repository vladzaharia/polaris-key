// The Compose-free RFC 8628 device-code state holder. Android, desktop and custom renderers share
// its lifecycle: a leaving screen pauses polling without discarding the code, while cancellation
// and restart always obtain a fresh code.
package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.identity.AccountOpener
import im.plrs.key.identity.LinkAcceptResult
import im.plrs.key.identity.LinkOfferResult
import im.plrs.key.identity.NativeRedirectOptions
import im.plrs.key.identity.SignInChannel
import im.plrs.key.identity.SignInError
import im.plrs.key.identity.SignInOptions
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.identity.SignInSession
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

/**
 * What the kit shows for one device-code sign-in: the code to type, the page to type it on and the clock.
 * The poll credential stays inside the SDK's [SignInSession].
 */
public data class PolarisSignInCode(
    /** What the person types on the verification page, e.g. `WDJB-MJHT`. */
    val userCode: String,
    /** The page the person opens and types the code into. */
    val verificationUri: String,
    /** The same page with the code pre-filled: the payload for a QR code or a link. */
    val verificationUriComplete: String,
    /** Seconds the code lives for, as the server advertised it. */
    val expiresIn: Long,
    /** When the code expires on this client's clock (epoch seconds). */
    val expiresAt: Long,
    /** The label the sign-in page shows; null when there is none. */
    val deviceName: String? = null,
)

/** Where the sign-in flow is. */
public sealed interface PolarisSignInUi {
    /** Asking the server for a code. */
    public data object Starting : PolarisSignInUi

    /** A code to show; [nowSeconds] ticks for the countdown. */
    public data class Showing(val code: PolarisSignInCode, val nowSeconds: Long) : PolarisSignInUi {
        /** Seconds left before the code expires. */
        public val secondsLeft: Long get() = (code.expiresAt - nowSeconds).coerceAtLeast(0)

        /** The fraction of the code's life left, 1 → 0. */
        public val fractionLeft: Float
            get() = if (code.expiresIn <= 0) 0f else (secondsLeft.toFloat() / code.expiresIn).coerceIn(0f, 1f)
    }

    /**
     * The system browser has the sign-in (the native redirect, rung 6) and the app waits for it to come back.
     * [opened] is false when no browser could open; [copied] after the link was copied. The link is the authorize
     * page address, held for Copy link only: `toString` leaves it out.
     */
    public class Redirecting(public val opened: Boolean = true, public val copied: Boolean = false, internal val link: String? = null) :
        PolarisSignInUi {
        override fun equals(other: Any?): Boolean = other is Redirecting && other.opened == opened && other.copied == copied && other.link == link
        override fun hashCode(): Int = (opened.hashCode() * 31 + copied.hashCode()) * 31 + (link?.hashCode() ?: 0)
        override fun toString(): String = "Redirecting(opened=$opened, copied=$copied)"
    }

    /** What went wrong with a link attempt the person can read about: the offer stays, or only No thanks is left. */
    public enum class LinkProblem { Stale, Failed, Network }

    /** After a sign-in this device started: add [provider] (its display name) so the next sign-in is automatic. */
    public data class LinkOffer(
        val provider: String,
        /** `global` or `developer`; null when the Worker did not say (read as per developer). */
        val reach: String? = null,
        val busy: Boolean = false,
        val problem: LinkProblem? = null,
    ) : PolarisSignInUi

    /** The identity was linked. */
    public data class LinkDone(val provider: String) : PolarisSignInUi

    /** The identity belongs to another account; the sign-in stands. */
    public data class LinkConflict(val provider: String) : PolarisSignInUi

    public data object Done : PolarisSignInUi
    public data object Expired : PolarisSignInUi
    public data object Failed : PolarisSignInUi

    /** The person pressed Deny, or the provider failed: the Worker's one generic `error` answer. */
    public data object Denied : PolarisSignInUi
}

/**
 * The SDK calls sign-in makes. [wait] returns the session's settled [SignInOutcome] and throws [SignInError]
 * for a refusal, as `SignInSession.wait` does.
 */
public interface PolarisSignInActions {
    public suspend fun begin(): PolarisSignInCode
    public suspend fun wait(code: PolarisSignInCode): SignInOutcome

    /**
     * Start the native redirect sign-in and open the system browser (rung 6). Null where no redirect can start here
     * (`redirect-unavailable`, a television, no redirect configured): the state follows the device code instead.
     */
    public suspend fun beginRedirect(): PolarisRedirectSession? = null

    /** `identity.link.offer()` after a same-device sign-in: the platform provider's entry, or null when there is nothing to offer. */
    public suspend fun linkOffer(): PolarisLinkEntry? = null

    /** `identity.link.accept()`. */
    public suspend fun linkAccept(): LinkAcceptResult = LinkAcceptResult.Unavailable

    /** Not again for this account on this device. */
    public suspend fun linkDecline() {}

    /** Close the offer without remembering anything. */
    public fun linkDismiss() {}
}

/** One native redirect sign-in the kit follows. */
public interface PolarisRedirectSession {
    /** Whether the first open of the browser succeeded. */
    public val opened: Boolean

    /** The authorize page address (no secret in it), for Copy link; null when there is none. */
    public val link: String?

    /** Open the browser again; false when none could. */
    public suspend fun reopen(): Boolean

    /** The settled outcome; throws [SignInError] for a refusal, and the caller's cancellation. */
    public suspend fun wait(): SignInOutcome

    /** End the sign-in. */
    public fun cancel()
}

/** The platform identity the link offer names: its display name and what linking covers. */
public data class PolarisLinkEntry(val provider: String, val reach: String?)

/**
 * What the host gives the kit's native redirect sign-in: the options (Android: `AndroidRedirect.options`) and the
 * browser opener (Android: `AndroidRedirectBrowser`). The defaults suit the JVM desktop: a loopback listener and the
 * system browser. Where no redirect can start, the kit signs in with a code.
 */
public data class PolarisRedirect(val options: NativeRedirectOptions = NativeRedirectOptions(), val opener: AccountOpener? = null)

/** The umbrella client's identity service as sign-in actions: one [SignInSession] per `begin`, waited by its code. */
public fun PolarisKeyClient.signInActions(deviceName: String? = null, redirect: PolarisRedirect? = null): PolarisSignInActions {
    val identity = this.identity
    val sessions = java.util.concurrent.ConcurrentHashMap<PolarisSignInCode, SignInSession>()
    return object : PolarisSignInActions {
        override suspend fun begin(): PolarisSignInCode {
            val session = identity.signIn.start(im.plrs.key.identity.SignInOptions(deviceName = deviceName))
            val code = PolarisSignInCode(
                session.userCode, session.verificationUri, session.verificationUriComplete,
                session.expiresIn, session.expiresAt, session.deviceName,
            )
            sessions[code] = session
            return code
        }

        override suspend fun wait(code: PolarisSignInCode): SignInOutcome {
            val session = sessions[code] ?: throw SignInError(ErrorCode.signInFailed, "no sign-in session for this code.")
            // A paused screen cancels this coroutine and waits again on the same code, so the session stays until it settles.
            return try {
                session.wait().also { sessions.remove(code) }
            } catch (e: SignInError) {
                sessions.remove(code)
                throw e
            }
        }

        @Suppress("ReturnCount")
        override suspend fun beginRedirect(): PolarisRedirectSession? {
            val host = redirect ?: return null
            val session = try {
                identity.signIn.start(
                    SignInOptions(channel = SignInChannel.Redirect, deviceName = deviceName, native = host.options, opener = host.opener),
                )
            } catch (e: PolarisException) {
                if (e.code == ErrorCode.redirectUnavailable) return null
                throw e
            }
            return object : PolarisRedirectSession {
                override val opened: Boolean get() = session.opened
                override val link: String? get() = session.authorizeUrl
                override suspend fun reopen(): Boolean = session.reopen()
                override suspend fun wait(): SignInOutcome = session.wait()
                override fun cancel() = session.cancel()
            }
        }

        @Suppress("ReturnCount")
        override suspend fun linkOffer(): PolarisLinkEntry? {
            // The offer needs a provider this device can ask; without one, accept() would answer Unavailable.
            if (!identity.hasPlatformProvider) return null
            val ok = identity.link.offer() as? LinkOfferResult.Ok ?: return null
            val entry = ok.kinds.firstOrNull { it.kind == "google" } ?: ok.kinds.firstOrNull { it.kind == "apple" } ?: return null
            return PolarisLinkEntry(if (entry.kind == "apple") "Apple" else "Google", entry.reach)
        }

        override suspend fun linkAccept(): LinkAcceptResult = identity.link.accept()
        override suspend fun linkDecline() = identity.link.decline()
        override fun linkDismiss() = identity.link.dismiss()
    }
}

/**
 * The sign-in state holder. [start] asks for a code, shows it and waits for the person. Hold it
 * where it outlives a renderer so a rotation or navigation return resumes the same code.
 */
@Suppress("TooManyFunctions")
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
    private var prompt: PolarisSignInCode? = null

    /** The countdown ran out on screen while the poll still ran: a late success still completes. */
    private var expiredOnScreen = false

    /** The native redirect being followed (rung 6); null on the device-code path. */
    private var redirect: PolarisRedirectSession? = null

    /** The person chose the code over the browser: the next [begin] skips the redirect. */
    private var codeOnly = false

    /**
     * Begin once. The first call obtains a code; after a renderer paused the state, it resumes the
     * same code. A completed, expired or failed flow starts a new sign-in.
     */
    public fun start() {
        if (job?.isActive == true) return
        val shown = prompt
        val now = _ui.value
        val ended = !expiredOnScreen && (now == PolarisSignInUi.Done || now == PolarisSignInUi.Expired || now == PolarisSignInUi.Failed || now == PolarisSignInUi.Denied)
        val waiting = redirect
        when {
            _ui.value == PolarisSignInUi.Starting || ended -> begin()
            waiting != null && _ui.value is PolarisSignInUi.Redirecting -> job = scope.launch { followRedirect(waiting) }
            shown != null && (_ui.value is PolarisSignInUi.Showing || expiredOnScreen) -> job = scope.launch { follow(shown) }
        }
    }

    /** Drop the current code and ask for a new one ("Get a new code" / "Try again"). */
    public fun restart() {
        job?.cancel()
        endRedirect()
        prompt = null
        expiredOnScreen = false
        begin()
    }

    /** Stop polling because the person cancelled; a later [start] always requests a new code. */
    public fun cancel() {
        job?.cancel()
        job = null
        endRedirect()
        // A link offer left open is closed without a decline: the person did not answer it.
        if (_ui.value is PolarisSignInUi.LinkOffer) actions.linkDismiss()
        codeOnly = false
        prompt = null
        expiredOnScreen = false
        _ui.value = PolarisSignInUi.Starting
    }

    /** Open the browser again (rung 6, "Open browser again"). A failed open shows the no-browser step. */
    public fun reopen() {
        val r = redirect ?: return
        scope.launch {
            val opened = attempt { r.reopen() }.getOrDefault(false)
            if (redirect === r && _ui.value is PolarisSignInUi.Redirecting) _ui.value = PolarisSignInUi.Redirecting(opened, link = r.link)
        }
    }

    /** The no-browser step's Copy link was used: the step says so. The text to copy is [redirectLink]. */
    public fun linkCopied() {
        val r = redirect ?: return
        val now = _ui.value as? PolarisSignInUi.Redirecting ?: return
        _ui.value = PolarisSignInUi.Redirecting(now.opened, copied = true, link = r.link)
    }

    /** The authorize page address while a redirect waits, for Copy link; null otherwise. Not a secret, and never logged. */
    public val redirectLink: String? get() = redirect?.link

    /** "Use a code instead": end the browser sign-in and show a code. */
    public fun useCode() {
        if (redirect == null) return
        job?.cancel()
        endRedirect()
        codeOnly = true
        begin()
    }

    /** The link offer's main button: add the identity. */
    public fun linkAccept() {
        val now = _ui.value as? PolarisSignInUi.LinkOffer ?: return
        if (now.busy) return
        _ui.value = now.copy(busy = true, problem = null)
        scope.launch {
            val result = attempt { actions.linkAccept() }.getOrNull()
            when {
                result is LinkAcceptResult.Linked -> _ui.value = PolarisSignInUi.LinkDone(now.provider)

                result is LinkAcceptResult.Refused && result.code == ErrorCode.linkConflict -> _ui.value = PolarisSignInUi.LinkConflict(now.provider)

                // The sign-in is too old: sign in again, and the offer can be made once more.
                result is LinkAcceptResult.Refused && result.code == ErrorCode.stepUpRequired ->
                    _ui.value = now.copy(busy = false, problem = PolarisSignInUi.LinkProblem.Stale)

                // Anything else cannot be fixed by asking again; only No thanks is left, except a lost connection.
                result == null -> _ui.value = now.copy(busy = false, problem = PolarisSignInUi.LinkProblem.Network)

                else -> _ui.value = now.copy(busy = false, problem = PolarisSignInUi.LinkProblem.Failed)
            }
        }
    }

    /** No thanks: the device remembers it for this account, and the sign-in finishes. */
    public fun linkDecline() {
        if (_ui.value !is PolarisSignInUi.LinkOffer) return
        scope.launch {
            if (attempt { actions.linkDecline() }.isFailure) actions.linkDismiss()
            finish()
        }
    }

    /** Done on the link result steps (or after a stale offer that is left): close the offer and finish. */
    public fun linkFinished() {
        if (_ui.value is PolarisSignInUi.LinkDone || _ui.value is PolarisSignInUi.LinkConflict) {
            actions.linkDismiss()
            finish()
        }
    }

    /** A stale offer's "Sign in again": close the offer and start a new sign-in. */
    public fun linkSignInAgain() {
        if (_ui.value !is PolarisSignInUi.LinkOffer) return
        actions.linkDismiss()
        restart()
    }

    private fun endRedirect() {
        val r = redirect ?: return
        redirect = null
        r.cancel()
    }

    private fun finish() {
        prompt = null
        expiredOnScreen = false
        redirect = null
        _ui.value = PolarisSignInUi.Done
        onSignedIn()
    }

    /** Stop polling while the screen is away; [start] resumes the same code and countdown. */
    public fun pause() {
        job?.cancel()
        job = null
    }

    private fun begin() {
        _ui.value = PolarisSignInUi.Starting
        job = scope.launch {
            val viaCode = codeOnly
            codeOnly = false
            val started = if (viaCode) Result.success(null) else attempt { actions.beginRedirect() }
            val session = started.getOrNull()
            when {
                started.isFailure -> _ui.value = PolarisSignInUi.Failed

                session != null -> {
                    redirect = session
                    _ui.value = PolarisSignInUi.Redirecting(session.opened, link = session.link)
                    followRedirect(session)
                }

                else -> beginCode()
            }
        }
    }

    @Suppress("ReturnCount")
    private suspend fun beginCode() {
        val shown = try {
            actions.begin()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _ui.value = PolarisSignInUi.Failed
            return
        }
        prompt = shown
        _ui.value = PolarisSignInUi.Showing(shown, clock())
        follow(shown)
    }

    /** Wait for the browser to bring the sign-in back, then offer the link or finish. */
    @Suppress("ReturnCount")
    private suspend fun followRedirect(r: PolarisRedirectSession) {
        val waited = attempt { r.wait() }
        if (redirect !== r) return
        val settled = waited.getOrElse { e ->
            redirect = null
            _ui.value = if (e is SignInError && e.code == ErrorCode.signInDenied) PolarisSignInUi.Denied else PolarisSignInUi.Failed
            return
        }
        when (settled) {
            is SignInOutcome.SignedIn -> {
                redirect = null
                // Only a sign-in the person started here is offered the link (the SDK checks it again).
                val entry = if (settled.sameDevice) attempt { actions.linkOffer() }.getOrNull() else null
                if (entry != null) _ui.value = PolarisSignInUi.LinkOffer(entry.provider, entry.reach) else finish()
            }

            SignInOutcome.Expired, SignInOutcome.Cancelled -> {
                redirect = null
                _ui.value = PolarisSignInUi.Expired
            }

            is SignInOutcome.Pending, is SignInOutcome.Choose, is SignInOutcome.Activated -> {
                redirect = null
                _ui.value = PolarisSignInUi.Failed
            }
        }
    }

    /** The countdown and poll for [shown]; screen expiry leaves the poll running for a late success. */
    private suspend fun follow(shown: PolarisSignInCode): Unit = coroutineScope {
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
        val settled = try {
            // The kit never asks for a key return, so `Activated` is not expected here (the kit's native redirect slice renders it).
            when (actions.wait(shown)) {
                is SignInOutcome.SignedIn -> PolarisSignInUi.Done
                SignInOutcome.Expired, SignInOutcome.Cancelled -> PolarisSignInUi.Expired
                is SignInOutcome.Pending, is SignInOutcome.Choose, is SignInOutcome.Activated -> PolarisSignInUi.Failed
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is SignInError && e.code == ErrorCode.signInDenied) PolarisSignInUi.Denied else PolarisSignInUi.Failed
        }
        ticker.cancel()
        prompt = null
        expiredOnScreen = false
        _ui.value = settled
        if (settled == PolarisSignInUi.Done) onSignedIn()
    }
}

/** [block]'s result with any failure kept (the kit shows a typed state for it); cancellation always propagates. */
@Suppress("TooGenericExceptionCaught")
private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Result.failure(e)
}
