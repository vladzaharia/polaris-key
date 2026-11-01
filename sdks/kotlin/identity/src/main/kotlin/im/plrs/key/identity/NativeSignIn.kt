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
import im.plrs.key.core.Feature
import im.plrs.key.core.ManageLink
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.JsonText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** Conformance replay only: builds the listener a native start binds (the recorded port, no socket). */
@ConformanceReplayOnly
public var IdentityClient.nativeListenerFactory: (() -> NativeLoopbackListener)?
    get() = nativeListenerFactoryValue
    set(value) {
        nativeListenerFactoryValue = value
    }

private val NOT_THIS_SIGN_IN = setOf(CallbackFailure.Malformed, CallbackFailure.RedirectMismatch, CallbackFailure.StateMismatch)

private fun origin(url: String): String? =
    Regex("([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*).*", RegexOption.DOT_MATCHES_ALL).matchEntire(url)
        ?.let { "${it.groupValues[1].lowercase()}://${it.groupValues[2].lowercase()}" }

private fun returnLocation(base: String, request: String, cancelled: Boolean): String {
    val joiner = if (base.contains('?')) "&" else "?"
    return "$base${joiner}request=${ManageLink.formEncode(request)}" + if (cancelled) "&cancelled=1" else ""
}

/** One started native sign-in; the [SignInSession] it backs is the host's handle. */
internal class NativeFlow(
    private val client: IdentityClient,
    pending: NativePending,
    val authorizeUrl: String,
    val expiresAt: Long,
    private val listener: NativeLoopbackListener?,
    private val returnPage: String?,
    private val opener: AccountOpener?,
    val deviceName: String?,
) {
    val redirectClass: NativeRedirectClass = pending.redirectClass
    val redirectUri: String = pending.redirectUri

    private val lock = Any()
    private var pending: NativePending? = pending
    private var closed = false
    private var arrival: NativeCallback? = null
    private val arrived = CompletableDeferred<Unit>()
    private val settleLock = Mutex()
    private var settled: Result<SignInOutcome>? = null

    @Volatile
    var opened: Boolean = false
        private set

    val outcomeOrNull: SignInOutcome? get() = synchronized(lock) { settled }?.getOrNull()
    val isCancelled: Boolean get() = synchronized(lock) { arrival is NativeCallback.Cancelled && pending == null }

    /** Show the authorize page: the host's opener, else the desktop browser. False when none could. */
    suspend fun open(): Boolean {
        val open = opener ?: DesktopBrowser
        return try {
            open.open(authorizeUrl)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }.also { if (it) opened = true }
    }

    /** SIGN-IN §3.17 "Open browser again": the SAME authorize URL while the request lives. */
    suspend fun reopen(): Boolean {
        if (synchronized(lock) { closed }) return false
        if (client.core.now() >= expiresAt) throw PolarisException(ErrorCode.signInExpired, "the sign-in request has expired; start again.")
        return open()
    }

    private fun view(): NativePending? = synchronized(lock) { pending }

    private fun arrive(result: NativeCallback): Boolean {
        synchronized(lock) {
            if (closed || arrival != null) return false
            arrival = result
        }
        arrived.complete(Unit)
        return true
    }

    /** The listener's callback: `(location, final)` as [NativeListenerReply]. */
    fun onListenerCallback(url: String): NativeListenerReply {
        val p = view() ?: return NativeListenerReply(null, true)
        val result = NativeRedirect.parseCallback(p, url)
        if (result is NativeCallback.Failed && result.reason in NOT_THIS_SIGN_IN) return NativeListenerReply(null, false)
        if (!arrive(result)) return NativeListenerReply(null, true)
        val request = when (result) {
            is NativeCallback.Code -> result.request
            is NativeCallback.Cancelled -> result.request
            is NativeCallback.Failed -> null
        }
        if (request != null && returnPage != null) {
            return NativeListenerReply(returnLocation(returnPage, request, result is NativeCallback.Cancelled), true)
        }
        return NativeListenerReply(null, true)
    }

    /** A scheme or claimed-HTTPS delivery: the URL the OS handed the app. */
    suspend fun handleRedirect(url: String): SignInOutcome {
        val p = view() ?: throw SignInError(ErrorCode.signInFailed, "this sign-in is already finished or was cancelled; start a new one.")
        val result = NativeRedirect.parseCallback(p, url)
        if (result is NativeCallback.Failed && result.reason in NOT_THIS_SIGN_IN) {
            throw SignInError(ErrorCode.signInFailed, "the sign-in redirect was refused (${result.reason.wire}).")
        }
        if (!arrive(result)) throw SignInError(ErrorCode.signInFailed, "this sign-in already received its redirect.")
        return settle()
    }

    /** Redeem the arrived callback, once. A second call answers the same outcome or error. */
    private suspend fun settle(): SignInOutcome = settleLock.withLock {
        synchronized(lock) { settled }?.let { return@withLock it.getOrThrow() }
        val (got, taken) = synchronized(lock) {
            val pair = arrival to pending
            pending = null
            pair
        }
        shut()
        val result: Result<SignInOutcome> = try {
            Result.success(
                when {
                    got is NativeCallback.Cancelled -> SignInOutcome.Cancelled
                    got == null || taken == null -> throw SignInError(ErrorCode.signInFailed, "this sign-in has no redirect to redeem.")
                    got is NativeCallback.Failed -> throw SignInError(ErrorCode.signInFailed, "the sign-in redirect was refused (${got.reason.wire}).")
                    got is NativeCallback.Code -> client.redeemNative(taken, got.code)
                    else -> throw SignInError(ErrorCode.signInFailed, "this sign-in has no redirect to redeem.")
                },
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: SignInError) {
            Result.failure(e)
        }
        synchronized(lock) { settled = result }
        client.nativeActive.compareAndSet(this, null)
        result.getOrThrow()
    }

    private fun shut() {
        synchronized(lock) { closed = true }
        listener?.close()
    }

    /** The person cancelled in the app: drop the pending request and close the listener. */
    fun cancel() {
        synchronized(lock) {
            if (settled != null) return
            pending = null
            if (arrival == null) arrival = NativeCallback.Cancelled(null)
        }
        arrived.complete(Unit)
        shut()
        client.nativeActive.compareAndSet(this, null)
    }

    private fun expire() {
        synchronized(lock) { pending = null }
        shut()
        client.nativeActive.compareAndSet(this, null)
    }

    /**
     * Wait until the redirect arrives and the code is redeemed: `SignedIn`, `Choose`, `Cancelled` or `Expired` (the
     * pushed request lapsed). [once] checks once and may answer `Pending`.
     */
    suspend fun wait(once: Boolean): SignInOutcome {
        while (true) {
            synchronized(lock) { settled }?.let { return it.getOrThrow() }
            if (arrived.isCompleted) return settle()
            val remaining = expiresAt - client.core.now()
            if (remaining <= 0) {
                expire()
                return SignInOutcome.Expired
            }
            if (once) return SignInOutcome.Pending(0)
            withTimeoutOrNull(minOf(remaining, MAX_WAIT_SECONDS) * 1000) { arrived.await() }
        }
    }

    private companion object {
        const val MAX_WAIT_SECONDS = 3600L
    }
}

/**
 * Begin a native redirect sign-in. The class is the first that applies: loopback (unless `loopback = false`, or
 * the host is headless or has no browser to open), a registered scheme, a claimed HTTPS link; none is
 * `redirect-unavailable` (nothing was sent: the caller offers a code). Every endpoint is used only when
 * discovery names it, and the ones the device's headers reach must be on this product.
 */
internal suspend fun IdentityClient.startNative(options: SignInOptions): NativeFlow {
    val native = options.native ?: NativeRedirectOptions()
    if (core.discoveryDocument() == null) {
        try {
            core.discover()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // `requireService` below answers for a product whose discovery is unknown.
        }
    }
    core.requireService(ServiceSlug.identity, Feature.identityRedirectNative)
    val fragment = core.discoveryDocument()?.services?.get(ServiceSlug.identity)
    val endpoints = fragment?.endpoints ?: emptyMap()
    val extras = fragment?.extras ?: emptyMap()
    val requestEndpoint = endpoints["request"]?.takeIf { it.isNotEmpty() }
    val authorize = endpoints["authorize"]?.takeIf { it.isNotEmpty() }
    val token = endpoints["token"]?.takeIf { it.isNotEmpty() }
    val issuer = (extras["issuer"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
    val returnPage = endpoints["signinReturn"]?.takeIf { it.isNotEmpty() }
    if (returnPage != null) {
        // The 303 target is the product's own customer host: the API origin or the issuer's.
        val allowed = setOfNotNull(origin(core.endpoints.baseUrl), issuer?.let(::origin))
        if (origin(returnPage) !in allowed || !returnPage.startsWith("https://")) {
            throw PolarisException(ErrorCode.badResponse, "the return page points outside this product.")
        }
    }
    if (requestEndpoint != null && (authorize == null || token == null || issuer == null)) {
        throw PolarisException(ErrorCode.signInUnavailable, "this product's discovery serves no redirect sign-in.")
    }
    val browserOpens = !native.openBrowser || options.opener != null || opener != null || DesktopBrowser.available()
    val canListen = (native.loopback ?: (!NativeHost.isHeadless() && browserOpens)) && returnPage != null
    val choice = NativeRedirect.chooseClass(
        requestEndpoint, NativeRedirectDiscovery.parse(extras["nativeRedirect"]), canListen, native.registeredSchemes, native.registeredClaimed,
    )
    if (choice is RedirectChoice.Unavailable) {
        throw PolarisException(
            ErrorCode.redirectUnavailable,
            "no native redirect can start here; sign in with a code instead (${choice.reason}).",
        )
    }
    val product = core.endpoints.url("")
    if (requestEndpoint == null || authorize == null || token == null || issuer == null ||
        !token.startsWith(product) || !requestEndpoint.startsWith(product)
    ) {
        throw PolarisException(ErrorCode.badResponse, "an endpoint points outside this product.")
    }
    val choiceAvailable = listOf("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel").all { !endpoints[it].isNullOrEmpty() }
    val label = core.deviceLabel(options.deviceName)
    val entropy = redirectEntropyValue

    var listener: NativeLoopbackListener? = null
    var handedOver = false
    try {
        val redirectUri = when (choice) {
            // Bind first, push second: the port is ours before the Worker learns it.
            RedirectChoice.Loopback -> (nativeListenerFactoryValue?.invoke() ?: LoopbackListener()).also { listener = it }.let { NativeRedirect.loopbackUri(it.port) }
            is RedirectChoice.Scheme -> choice.redirectUri
            is RedirectChoice.Claimed -> choice.redirectUri
            is RedirectChoice.Unavailable -> throw IllegalStateException()
        }
        val pushed = NativeRedirect.pushRequest(
            requestEndpoint = requestEndpoint, authorizeEndpoint = authorize, tokenEndpoint = token, issuer = issuer, clientId = core.product,
            redirectUri = redirectUri, deviceName = label, returnUri = native.returnUri, scope = options.scope, loginHint = options.loginHint,
            nameHint = options.nameHint, purpose = options.purpose?.wire, licenseChoice = options.licenseChoice, choiceAvailable = choiceAvailable,
            state = entropy?.state, codeVerifier = entropy?.codeVerifier,
        )
        val response: PolarisResponse = try {
            core.request(
                pushed.url, method = "POST", headers = mapOf("content-type" to pushed.contentType),
                body = pushed.body.toByteArray(Charsets.UTF_8),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            if (e.code == ErrorCode.localOnly) throw e
            throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
        } catch (e: Exception) {
            throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
        }
        val answer = NativeRedirect.parsePushedAnswer(response.status, JsonText.parseOrNull(response.text))
        when (answer) {
            is PushedAnswer.Refused -> {
                val retry = answer.retryAfterSeconds ?: response.header("retry-after")?.trim()?.takeIf { it.length in 1..9 && it.all(Char::isDigit) }?.toInt()?.coerceAtMost(3600)
                throw SignInError(
                    if (answer.status >= 500) ErrorCode.serverError else answer.error,
                    "the Worker refused the sign-in request (${answer.error}).", retry,
                )
            }
            PushedAnswer.Malformed -> throw PolarisException(ErrorCode.badResponse, "the request endpoint answered without a complete pushed request.")
            is PushedAnswer.Pushed -> {
                val flow = NativeFlow(
                    client = this, pending = pushed.pending,
                    authorizeUrl = NativeRedirect.authorizeUrlFor(authorize, core.product, answer.requestUri),
                    expiresAt = core.now() + answer.expiresIn, listener = listener, returnPage = returnPage,
                    opener = options.opener ?: opener, deviceName = label,
                )
                // One native sign-in waits for a redirect at a time: a new start ends the last.
                nativeActive.getAndSet(flow)?.cancel()
                listener?.start(flow::onListenerCallback)
                handedOver = true
                return flow
            }
        }
    } finally {
        if (!handedOver) listener?.close()
    }
}

/** Redeem a native code at the token endpoint from the pushing device. The label went with the push; the token request does not repeat it. */
internal suspend fun IdentityClient.redeemNative(pending: NativePending, code: String): SignInOutcome {
    val form = IdentityRedirect.tokenForm(pending.clientId, pending.codeVerifier, pending.redirectUri, code, null)
    return redeemForm(pending.tokenEndpoint, form, pending.licenseChoice)
}

/**
 * Conformance replay only: hand a recorded callback to a sign-in built on the recorded pending request, as a
 * scheme delivery would. A recording that redeems a code again after the sign-in settled is played against a
 * fresh one, so the Worker's own refusal of the spent code is what the recording pins.
 */
@ConformanceReplayOnly
public suspend fun IdentityClient.replayNativeCallback(
    redirectUri: String,
    state: String,
    codeVerifier: String,
    issuer: String,
    callbackUrl: String,
    licenseChoice: Boolean,
): SignInOutcome {
    val cls = NativeRedirect.classify(redirectUri) ?: throw IdentityRedirect.invalid("the recorded callback is at no native redirect URI.")
    val base = core.endpoints.url("identity")
    val pending = NativePending(cls, redirectUri, state, codeVerifier, core.product, issuer, "$base/authorize", "$base/token", licenseChoice)
    return NativeFlow(this, pending, "$base/authorize", Long.MAX_VALUE, null, null, null, null).handleRedirect(callbackUrl)
}
