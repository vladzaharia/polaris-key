// The native redirect sign-in (WIRE-CONTRACT-V5 §12.12; I-15b.5): the app pushes its authorization request,
// opens the system browser at `authorize` with the `request_uri` it got back, and receives the code on a
// redirect it owns: a loopback listener (the JVM desktop default), a registered scheme or a claimed HTTPS
// link. `signIn.start(SignInOptions(channel = Redirect))` with no `redirectUri` begins one;
// `signIn.handleRedirect(url)` takes a scheme or claimed delivery.
//
// The order of a loopback start is the listener's bind, the pushed request, then the browser, so the port
// is held before the Worker learns it. A pending request is used for ONE callback check and one token
// request, then dropped; the verifier, the code and the token are never put in a URL, a log or a message.

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.ManageLink
import im.plrs.key.core.PolarisException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

private const val MILLIS_PER_SECOND = 1000L
private const val MAX_WAIT_SECONDS = 3600L

private val NOT_THIS_SIGN_IN = setOf(CallbackFailure.Malformed, CallbackFailure.RedirectMismatch, CallbackFailure.StateMismatch)
private val KEEP_WAITING = NativeListenerReply(null, false)
private val FINISHED = NativeListenerReply(null, true)

private fun refused(message: String) = SignInError(ErrorCode.signInFailed, message)

private fun returnLocation(base: String, request: String, cancelled: Boolean): String {
    val joiner = if (base.contains('?')) "&" else "?"
    return "$base${joiner}request=${ManageLink.formEncode(request)}" + if (cancelled) "&cancelled=1" else ""
}

/** The delivery is not this sign-in's (another URL, another `state`, not a URL): ignore it and keep waiting. */
private fun foreignReason(result: NativeCallback): CallbackFailure? = (result as? NativeCallback.Failed)?.reason?.takeIf { it in NOT_THIS_SIGN_IN }

private fun returnReply(result: NativeCallback, page: String?): NativeListenerReply {
    val request = (result as? NativeCallback.Code)?.request ?: (result as? NativeCallback.Cancelled)?.request
    return if (request != null && page != null) {
        NativeListenerReply(returnLocation(page, request, result is NativeCallback.Cancelled), true)
    } else {
        FINISHED
    }
}

private fun need(ok: Boolean, message: String) {
    if (!ok) throw refused(message)
}

private suspend fun IdentityClient.outcomeOf(got: NativeCallback?, taken: NativePending?): SignInOutcome = when {
    got is NativeCallback.Cancelled -> SignInOutcome.Cancelled
    got is NativeCallback.Failed -> throw refused("the sign-in redirect was refused (${got.reason.wire}).")
    got is NativeCallback.Code && taken != null -> redeemNative(taken, got.code)
    else -> throw refused("this sign-in has no redirect to redeem.")
}

/** What a started native sign-in hands the host and the return page. */
internal class NativeLinks(val authorizeUrl: String, val expiresAt: Long, val returnPage: String?, val deviceName: String?)

/** The state of one native sign-in between its start and its settling; every transition is under one lock. */
internal class NativeState(pending: NativePending) {
    private val lock = Any()
    private var pending: NativePending? = pending
    private var closed = false
    private var arrival: NativeCallback? = null
    private var settled: Result<SignInOutcome>? = null
    val arrived = CompletableDeferred<Unit>()

    fun pending(): NativePending? = synchronized(lock) { pending }

    fun settledOrNull(): Result<SignInOutcome>? = synchronized(lock) { settled }

    val isClosed: Boolean get() = synchronized(lock) { closed }

    val isCancelled: Boolean get() = synchronized(lock) { arrival is NativeCallback.Cancelled && pending == null }

    /** Record the redirect; false when one already arrived or the sign-in is over. */
    fun arrive(result: NativeCallback): Boolean {
        val accepted = synchronized(lock) { (!closed && arrival == null).also { if (it) arrival = result } }
        if (accepted) arrived.complete(Unit)
        return accepted
    }

    /** Take the arrival and the pending request to redeem them; both are gone afterwards. */
    fun take(): Pair<NativeCallback?, NativePending?> = synchronized(lock) {
        (arrival to pending).also {
            pending = null
            closed = true
        }
    }

    fun settle(result: Result<SignInOutcome>) = synchronized(lock) { settled = result }

    /** The person cancelled in the app; false when the sign-in had already settled. */
    fun cancel(): Boolean {
        val did = synchronized(lock) {
            (settled == null).also {
                if (it) {
                    pending = null
                    closed = true
                    if (arrival == null) arrival = NativeCallback.Cancelled(null)
                }
            }
        }
        if (did) arrived.complete(Unit)
        return did
    }

    fun expire() = synchronized(lock) {
        pending = null
        closed = true
    }
}

/** One started native sign-in; the [SignInSession] it backs is the host's handle. */
internal class NativeFlow(
    private val client: IdentityClient,
    pending: NativePending,
    private val links: NativeLinks,
    private val listener: NativeLoopbackListener?,
    private val opener: AccountOpener?,
) {
    val redirectClass: NativeRedirectClass = pending.redirectClass
    val redirectUri: String = pending.redirectUri
    val authorizeUrl: String get() = links.authorizeUrl
    val expiresAt: Long get() = links.expiresAt
    val deviceName: String? get() = links.deviceName

    private val state = NativeState(pending)
    private val settleLock = Mutex()

    @Volatile
    var opened: Boolean = false
        private set

    val outcomeOrNull: SignInOutcome? get() = state.settledOrNull()?.getOrNull()
    val isCancelled: Boolean get() = state.isCancelled

    /** Show the authorize page: the host's opener, else the desktop browser. False when none could. */
    suspend fun open(): Boolean {
        // An opener that wants the redirect URI (the Android tab) gets it with the URL.
        val target = opener ?: DesktopBrowser
        val shown = runCatching {
            if (target is NativeRedirectOpener) target.open(links.authorizeUrl, redirectUri) else target.open(links.authorizeUrl)
        }
            .onFailure { if (it is CancellationException) throw it }
            .getOrDefault(false)
        if (shown) opened = true
        return shown
    }

    /** SIGN-IN §3.17 "Open browser again": the SAME authorize URL while the request lives. */
    suspend fun reopen(): Boolean {
        if (state.isClosed) return false
        if (client.core.now() >= expiresAt) throw PolarisException(ErrorCode.signInExpired, "the sign-in request has expired; start again.")
        return open()
    }

    /** The listener's callback: where to `303` to, and whether this was the last one. */
    fun onListenerCallback(url: String): NativeListenerReply {
        val pending = state.pending() ?: return FINISHED
        val result = NativeRedirect.parseCallback(pending, url)
        return when {
            foreignReason(result) != null -> KEEP_WAITING
            !state.arrive(result) -> FINISHED
            else -> returnReply(result, links.returnPage)
        }
    }

    /** A scheme or claimed-HTTPS delivery: the URL the OS handed the app. */
    suspend fun handleRedirect(url: String): SignInOutcome {
        val pending = state.pending() ?: throw refused("this sign-in is already finished or was cancelled; start a new one.")
        val result = NativeRedirect.parseCallback(pending, url)
        need(foreignReason(result) == null, "the sign-in redirect was refused (${foreignReason(result)?.wire}).")
        need(state.arrive(result), "this sign-in already received its redirect.")
        return settle()
    }

    /** Redeem the arrived callback, once. A second call answers the same outcome or error. */
    private suspend fun settle(): SignInOutcome = settleLock.withLock {
        state.settledOrNull() ?: redeem().also {
            state.settle(it)
            client.nativeActive.compareAndSet(this, null)
        }
    }.getOrThrow()

    private suspend fun redeem(): Result<SignInOutcome> {
        val (got, taken) = state.take()
        listener?.close()
        return try {
            Result.success(client.outcomeOf(got, taken))
        } catch (e: SignInError) {
            Result.failure(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            // A transport or answer failure at redemption settles the sign-in as failed, so wait() reports it.
            Result.failure(e)
        }
    }

    /** The person cancelled in the app: drop the pending request and close the listener. */
    fun cancel() {
        if (state.cancel()) {
            listener?.close()
            client.nativeActive.compareAndSet(this, null)
        }
    }

    private fun expire(): SignInOutcome {
        state.expire()
        listener?.close()
        client.nativeActive.compareAndSet(this, null)
        return SignInOutcome.Expired
    }

    /**
     * Wait until the redirect arrives and the code is redeemed: `SignedIn`, `Choose`, `Cancelled` or `Expired` (the
     * pushed request lapsed). [once] checks once and may answer `Pending`.
     */
    suspend fun wait(once: Boolean): SignInOutcome {
        var result: SignInOutcome? = null
        while (result == null) result = step(once)
        return result
    }

    private suspend fun step(once: Boolean): SignInOutcome? {
        val done = state.settledOrNull()
        val remaining = expiresAt - client.core.now()
        return when {
            done != null -> done.getOrThrow()

            state.arrived.isCompleted -> settle()

            remaining <= 0 -> expire()

            once -> SignInOutcome.Pending(0)

            else -> {
                withTimeoutOrNull(minOf(remaining, MAX_WAIT_SECONDS) * MILLIS_PER_SECOND) { state.arrived.await() }
                null
            }
        }
    }
}

/** The pending request of a recorded native conversation (replay only). */
@ConformanceReplayOnly
public class ReplayPending(
    public val redirectUri: String,
    public val state: String,
    public val codeVerifier: String,
    public val issuer: String,
    public val licenseChoice: Boolean,
    public val keyReturn: Boolean = false,
)

/**
 * Conformance replay only: hand a recorded callback to a sign-in built on the recorded pending request, as a
 * scheme delivery would. A recording that redeems a code again after the sign-in settled is played against a
 * fresh one, so the Worker's own refusal of the spent code is what the recording pins.
 */
@ConformanceReplayOnly
public suspend fun IdentityClient.replayNativeCallback(recorded: ReplayPending, callbackUrl: String): SignInOutcome {
    val cls = NativeRedirect.classify(recorded.redirectUri) ?: throw IdentityRedirect.invalid("the recorded callback is at no native redirect URI.")
    val base = core.endpoints.url("identity")
    val endpoints = NativeEndpoints("$base/request", "$base/authorize", "$base/token", recorded.issuer, core.product)
    val pending = NativePending(
        cls,
        recorded.redirectUri,
        recorded.state,
        recorded.codeVerifier,
        endpoints,
        recorded.licenseChoice,
        recorded.keyReturn,
    )
    val links = NativeLinks("$base/authorize", Long.MAX_VALUE, null, null)
    return NativeFlow(this, pending, links, null, null).handleRedirect(callbackUrl)
}

/** Conformance replay only: builds the listener a native start binds (the recorded port, no socket). */
@ConformanceReplayOnly
public var IdentityClient.nativeListenerFactory: (() -> NativeLoopbackListener)?
    get() = nativeListenerFactoryValue
    set(value) {
        nativeListenerFactoryValue = value
    }

/** Redeem a native code at the token endpoint from the pushing device. The label went with the push; the token request does not repeat it. */
internal suspend fun IdentityClient.redeemNative(pending: NativePending, code: String): SignInOutcome {
    val form = IdentityRedirect.tokenForm(pending.clientId, pending.codeVerifier, pending.redirectUri, code, null)
    return redeemForm(pending.tokenEndpoint, form, pending.licenseChoice, pending.keyReturn)
}
